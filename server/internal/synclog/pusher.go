package synclog

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/rs/zerolog/log"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/repo"
)

// Pusher — сторона ФИЛИАЛА (Фаза 2 multi-branch, ADR-003). Читает неотправленные
// строки sync_log и POST'ит их батчами на центральный узел (/api/v1/sync/ingest),
// затем помечает synced_at. Работает в фоне по таймеру.
//
// Конфликтов почти нет (партиционирование по restaurant_id), поэтому пуш —
// односторонний и простой: отправил → пометил. Повтор безопасен (ingest
// идемпотентен по row_id).
type Pusher struct {
	r          *repo.Repo
	client     *http.Client
	centralURL string // напр. http://central.tailnet:3001
	token      string // Bearer к центральному узлу
	batchSize  int
}

func NewPusher(r *repo.Repo, centralURL, token string) *Pusher {
	return &Pusher{
		r:          r,
		client:     &http.Client{Timeout: 30 * time.Second},
		centralURL: centralURL,
		token:      token,
		batchSize:  200,
	}
}

// wire-типы = контракт POST /api/v1/sync/ingest (дублируем локально, чтобы не
// импортировать service и не создавать цикл).
type wireEntry struct {
	Entity  string          `json:"entity"`
	RowID   string          `json:"row_id"`
	Op      string          `json:"op"`
	Payload json.RawMessage `json:"payload"`
}
type wireBatch struct {
	Entries []wireEntry `json:"entries"`
}

// PushOnce отправляет один батч неотправленных дельт. Возвращает число
// отправленных строк (0 = нечего слать).
func (p *Pusher) PushOnce(ctx context.Context) (int, error) {
	var rows []models.SyncLog
	if err := p.r.Raw().WithContext(ctx).
		Where("synced_at IS NULL").
		Order("created_at ASC").
		Limit(p.batchSize).
		Find(&rows).Error; err != nil {
		return 0, err
	}
	if len(rows) == 0 {
		return 0, nil
	}

	batch := wireBatch{Entries: make([]wireEntry, len(rows))}
	ids := make([]string, len(rows))
	for i, r := range rows {
		batch.Entries[i] = wireEntry{Entity: r.Entity, RowID: r.RowID, Op: r.Op, Payload: json.RawMessage(r.Payload)}
		ids[i] = r.ID
	}

	body, err := json.Marshal(batch)
	if err != nil {
		return 0, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.centralURL+"/api/v1/sync/ingest", bytes.NewReader(body))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Idempotency-Key", uuid.NewString())
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
		return 0, fmt.Errorf("sync ingest %d: %s", resp.StatusCode, b)
	}

	// Помечаем отправленные. Идемпотентно: даже если пометка не удастся,
	// повторная отправка безопасна (ingest upsert'ит).
	now := time.Now().UTC()
	if err := p.r.Raw().WithContext(ctx).
		Model(&models.SyncLog{}).
		Where("id IN ?", ids).
		Update("synced_at", now).Error; err != nil {
		return len(rows), err
	}
	return len(rows), nil
}

// Run гоняет PushOnce по таймеру до отмены ctx. Ошибки логируются, цикл живёт.
func (p *Pusher) Run(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	log.Info().Str("central", p.centralURL).Dur("interval", interval).Msg("sync pusher started")
	for {
		select {
		case <-ctx.Done():
			log.Info().Msg("sync pusher stopped")
			return
		case <-ticker.C:
			for {
				n, err := p.PushOnce(ctx)
				if err != nil {
					log.Warn().Err(err).Msg("sync push failed")
					break
				}
				if n < p.batchSize {
					break // разобрали очередь
				}
			}
		}
	}
}
