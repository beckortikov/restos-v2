package synclog

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/rs/zerolog/log"
	"gorm.io/gorm"

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
	r         *repo.Repo
	client    *http.Client
	batchSize int
	fallback  FallbackConfig
}

// FallbackConfig — boot-конфиг из env/CLI-флагов (RESTOS_SYNC_*). Используется,
// ТОЛЬКО пока строки sync_settings нет в БД — headless-запуски (env-филиал без
// UI-оператора, CI) конфигурируются флагами и строку могут не иметь вообще
// (документировано в docs/deploy/multi-branch-sync.md, «Два пути конфигурации»:
// env используются, если в sync_settings пусто). Как только строка появляется
// (UI / JoinNetwork / материализация после автозабфилла) — БД побеждает всегда,
// включая enabled=false.
type FallbackConfig struct {
	CentralURL string
	Token      string
	Enabled    bool
}

func NewPusher(r *repo.Repo, fallback FallbackConfig) *Pusher {
	return &Pusher{
		r:         r,
		client:    &http.Client{Timeout: 30 * time.Second},
		batchSize: 200,
		fallback:  fallback,
	}
}

// activeConfig — читает АКТУАЛЬНЫЙ sync_settings на КАЖДОМ тике, а не один
// раз при старте процесса (ADR-003, продолжение — код приглашения подключает
// филиал без перезапуска приложения). Не через service.SyncSettingsService —
// synclog НЕ импортирует service (см. wire-типы выше в файле: та же причина,
// не создавать цикл), поэтому Raw-запрос напрямую, как уже принято в этом файле.
//
// Заодно синхронизирует глобальный recorder-флаг (Record() в этом же пакете
// молча no-op'ит, если !enabled) — единая точка, оба конца проблемы «настройки
// применяются только после рестарта» чинятся одним и тем же чтением.
func (p *Pusher) activeConfig(ctx context.Context) (centralURL, token string, enabled bool, err error) {
	var st models.SyncSettings
	err = p.r.Raw().WithContext(ctx).Where("id = 1").First(&st).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		SetEnabled(p.fallback.Enabled)
		return p.fallback.CentralURL, p.fallback.Token, p.fallback.Enabled, nil
	}
	if err != nil {
		return "", "", false, err
	}
	SetEnabled(st.Enabled)
	if st.CentralURL != nil {
		centralURL = *st.CentralURL
	}
	if st.Token != nil {
		token = *st.Token
	}
	return centralURL, token, st.Enabled, nil
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
// отправленных строк (0 = нечего слать, либо sync выключен/не настроен).
func (p *Pusher) PushOnce(ctx context.Context) (int, error) {
	centralURL, token, enabled, err := p.activeConfig(ctx)
	if err != nil {
		return 0, err
	}
	if !enabled || centralURL == "" {
		return 0, nil
	}

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
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, centralURL+"/api/v1/sync/ingest", bytes.NewReader(body))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Idempotency-Key", uuid.NewString())
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

// Run гоняет PushOnce по таймеру до отмены ctx. Запускается БЕЗУСЛОВНО (даже
// если sync ещё не настроен) — activeConfig на каждом тике сам решает, есть
// ли что делать; так подключение по коду приглашения подхватывается без
// перезапуска процесса. Ошибки логируются, цикл живёт.
func (p *Pusher) Run(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	log.Info().Dur("interval", interval).Msg("sync pusher started")
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
