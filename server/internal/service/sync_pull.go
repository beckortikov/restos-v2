package service

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"

	"github.com/rs/zerolog/log"
)

// Puller — сторона ФИЛИАЛА (down-sync, ADR-003 Фаза 2). Периодически тянет с
// центрального узла дельты, адресованные этому филиалу (входящие перемещения),
// и применяет их ЛОКАЛЬНО через ApplyPulled (insert-if-absent). После этого
// пользователь филиала может принять перемещение у себя.
//
// Симметричен Pusher: тот шлёт свои дельты вверх, этот тянет адресованные вниз.
type Puller struct {
	svc          *SyncService
	client       *http.Client
	centralURL   string
	token        string
	restaurantID string // какой это филиал (за чьими входящими тянем)
}

func NewPuller(svc *SyncService, centralURL, token, restaurantID string) *Puller {
	return &Puller{
		svc:          svc,
		client:       &http.Client{Timeout: 30 * time.Second},
		centralURL:   centralURL,
		token:        token,
		restaurantID: restaurantID,
	}
}

// PullOnce тянет и применяет один батч. Возвращает число применённых дельт.
func (p *Puller) PullOnce(ctx context.Context) (int, error) {
	u := p.centralURL + "/api/v1/sync/pull?restaurant_id=" + url.QueryEscape(p.restaurantID)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return 0, err
	}
	if p.token != "" {
		req.Header.Set("Authorization", "Bearer "+p.token)
	}
	resp, err := p.client.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return 0, fmt.Errorf("sync pull %d: %s", resp.StatusCode, b)
	}
	var in IngestInput
	if err := json.NewDecoder(resp.Body).Decode(&in); err != nil {
		return 0, err
	}
	if len(in.Entries) == 0 {
		return 0, nil
	}
	// insert-if-absent: не перезатираем локальный статус (received).
	res, err := p.svc.ApplyPulled(ctx, in)
	if err != nil {
		return 0, err
	}
	return res.Applied, nil
}

// Run гоняет PullOnce по таймеру до отмены ctx.
func (p *Puller) Run(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	log.Info().Str("central", p.centralURL).Str("restaurant", p.restaurantID).Msg("sync puller started")
	for {
		select {
		case <-ctx.Done():
			log.Info().Msg("sync puller stopped")
			return
		case <-ticker.C:
			if _, err := p.PullOnce(ctx); err != nil {
				log.Warn().Err(err).Msg("sync pull failed")
			}
		}
	}
}
