package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"

	"github.com/rs/zerolog/log"
	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/repo"
)

// Puller — сторона ФИЛИАЛА (down-sync, ADR-003 Фаза 2). Периодически тянет с
// центрального узла дельты, адресованные этому филиалу (входящие перемещения),
// и применяет их ЛОКАЛЬНО через ApplyPulled (insert-if-absent). После этого
// пользователь филиала может принять перемещение у себя.
//
// Симметричен Pusher: тот шлёт свои дельты вверх, этот тянет адресованные вниз.
type Puller struct {
	svc      *SyncService
	client   *http.Client
	r        *repo.Repo
	fallback PullerFallback
}

// PullerFallback — boot-конфиг из env/CLI-флагов (RESTOS_SYNC_*), применяется,
// только пока строки sync_settings нет в БД (headless env-филиал без UI). Как
// только строка есть — БД побеждает всегда. Симметрично synclog.FallbackConfig,
// см. подробное обоснование там.
type PullerFallback struct {
	CentralURL   string
	Token        string
	RestaurantID string
	Enabled      bool
}

func NewPuller(svc *SyncService, r *repo.Repo, fallback PullerFallback) *Puller {
	return &Puller{svc: svc, client: &http.Client{Timeout: 30 * time.Second}, r: r, fallback: fallback}
}

// activeConfig — читает АКТУАЛЬНЫЙ sync_settings на КАЖДОМ тике, а не один
// раз при старте процесса (ADR-003, продолжение — код приглашения подключает
// филиал без перезапуска приложения). Прямой First, а не SyncSettingsService.Get —
// Get() маскирует отсутствие строки под дефолтную (enabled=false) и не даёт
// отличить «строки нет → env-fallback» от «строка есть, выключено → выключено».
func (p *Puller) activeConfig(ctx context.Context) (centralURL, token, restaurantID string, enabled bool, err error) {
	var st models.SyncSettings
	err = p.r.Raw().WithContext(ctx).Where("id = 1").First(&st).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return p.fallback.CentralURL, p.fallback.Token, p.fallback.RestaurantID, p.fallback.Enabled, nil
	}
	if err != nil {
		return "", "", "", false, err
	}
	if st.CentralURL != nil {
		centralURL = *st.CentralURL
	}
	if st.Token != nil {
		token = *st.Token
	}
	if st.RestaurantID != nil {
		restaurantID = *st.RestaurantID
	}
	return centralURL, token, restaurantID, st.Enabled, nil
}

// PullOnce тянет и применяет один батч. Возвращает число применённых дельт
// (0 = нечего тянуть, либо sync выключен/не настроен).
func (p *Puller) PullOnce(ctx context.Context) (int, error) {
	centralURL, token, restaurantID, enabled, err := p.activeConfig(ctx)
	if err != nil {
		return 0, err
	}
	if !enabled || centralURL == "" || restaurantID == "" {
		return 0, nil
	}

	u := centralURL + "/api/v1/sync/pull?restaurant_id=" + url.QueryEscape(restaurantID)
	// Курсор по зеркальным расходам (Фаза Р): сообщаем центру самую свежую
	// зеркальную проводку, которая у нас уже есть. Без него центр отдавал бы
	// их все и на каждом тике — они, в отличие от каталога сети, копятся без
	// предела. Нет ни одной — параметр не шлём, получаем всё.
	//
	// Именно updated_at, а не created_at: отмена расхода на центре меняет
	// только его, и курсор по дате создания её бы не пропустил.
	var lastMirror *time.Time
	var last models.FinancialOperation
	if err := p.r.Raw().WithContext(ctx).
		Where("paid_by_restaurant_id IS NOT NULL").
		Order("updated_at DESC").First(&last).Error; err == nil {
		lastMirror = &last.UpdatedAt
	} else if !errors.Is(err, gorm.ErrRecordNotFound) {
		return 0, err
	}
	if lastMirror != nil {
		u += "&mirror_since=" + url.QueryEscape(lastMirror.Format(time.RFC3339Nano))
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return 0, err
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
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
	// restaurantID — для merge сетевого меню в menu_items этого филиала.
	res, err := p.svc.ApplyPulled(ctx, in, restaurantID)
	if err != nil {
		return 0, err
	}
	return res.Applied, nil
}

// Run гоняет PullOnce по таймеру до отмены ctx. Запускается БЕЗУСЛОВНО (даже
// если sync ещё не настроен) — activeConfig на каждом тике сам решает, есть
// ли что делать; так подключение по коду приглашения подхватывается без
// перезапуска процесса.
func (p *Puller) Run(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	log.Info().Dur("interval", interval).Msg("sync puller started")
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
