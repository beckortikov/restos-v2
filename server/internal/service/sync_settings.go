package service

import (
	"context"
	"errors"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/repo"
)

// SyncSettingsService — конфиг multi-branch sync, редактируемый из UI (ADR-003/004).
// Не tenant-данные (конфиг узла), поэтому Raw + singleton (id=1).
type SyncSettingsService struct {
	r *repo.Repo
}

func NewSyncSettingsService(r *repo.Repo) *SyncSettingsService {
	return &SyncSettingsService{r: r}
}

// Get возвращает конфиг (или дефолты, если ещё не задан).
func (s *SyncSettingsService) Get(ctx context.Context) (*models.SyncSettings, error) {
	var st models.SyncSettings
	err := s.r.Raw().WithContext(ctx).Where("id = 1").First(&st).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return &models.SyncSettings{ID: 1, IntervalSec: 30}, nil
	}
	if err != nil {
		return nil, err
	}
	return &st, nil
}

// UpdateSyncSettingsInput — body PUT /api/v1/settings/sync.
type UpdateSyncSettingsInput struct {
	Enabled      bool   `json:"enabled"`
	CentralURL   string `json:"central_url"`
	Token        string `json:"token"`
	RestaurantID string `json:"restaurant_id"`
	IntervalSec  int    `json:"interval_sec"`
}

// Update сохраняет конфиг (upsert singleton). Enabled/CentralURL/Token/
// RestaurantID применяются в течение одного тика, БЕЗ перезапуска сервера —
// Pusher/Puller перечитывают sync_settings на каждом тике, не один раз при
// старте (ADR-003, продолжение; см. synclog.Pusher.activeConfig /
// service.Puller.activeConfig). Исключение — IntervalSec: частота самого
// тика фиксируется при старте процесса, смена применится со следующего
// перезапуска (сознательно не в объёме, редкая тонкая настройка).
func (s *SyncSettingsService) Update(ctx context.Context, in UpdateSyncSettingsInput) (*models.SyncSettings, error) {
	now := time.Now().UTC()
	interval := in.IntervalSec
	if interval <= 0 {
		interval = 30
	}
	st := &models.SyncSettings{
		ID:           1,
		Enabled:      in.Enabled,
		CentralURL:   strPtrOrNil(in.CentralURL),
		Token:        strPtrOrNil(in.Token),
		RestaurantID: strPtrOrNil(in.RestaurantID),
		IntervalSec:  interval,
		UpdatedAt:    &now,
	}
	// Явный список колонок, НЕ UpdateAll: backfilled_at (маркер «история уже
	// отправлена», Ф6) живёт в этой же строке, но им управляет только Backfill —
	// UpdateAll затирал бы его в NULL при каждом «Сохранить» из UI, и следующий
	// рестарт повторял бы полный забфилл впустую.
	if err := s.r.Raw().WithContext(ctx).
		Clauses(clause.OnConflict{
			Columns: []clause.Column{{Name: "id"}},
			DoUpdates: clause.AssignmentColumns([]string{
				"enabled", "central_url", "token", "restaurant_id", "interval_sec", "updated_at",
			}),
		}).
		Create(st).Error; err != nil {
		return nil, err
	}
	return st, nil
}

// SyncQueueStats — состояние очереди отправки (Фаза О). Нужна оператору:
// после дня без интернета единственный способ убедиться, что всё уехало, —
// это увидеть очередь. Раньше в UI не было ни одной цифры о синке, и
// «отправилось ли?» проверялось только по логам бэка.
type SyncQueueStats struct {
	// Pending — сколько дельт ждёт отправки прямо сейчас.
	Pending int64 `json:"pending"`
	// Failed — в карантине (central не принял, очередь пошла дальше без них).
	Failed int64 `json:"failed"`
	// OldestPendingAt — возраст головы очереди: если он растёт, синк стоит.
	OldestPendingAt *time.Time `json:"oldest_pending_at,omitempty"`
	// LastSyncedAt — когда в последний раз что-то реально уехало.
	LastSyncedAt *time.Time `json:"last_synced_at,omitempty"`
	// LastError — причина последней неудачи (из головы очереди), если есть.
	LastError *string `json:"last_error,omitempty"`
}

// QueueStats считает состояние очереди. Три дешёвых агрегата по sync_log:
// оба COUNT'а покрыты частичным индексом idx_sync_log_pending.
func (s *SyncSettingsService) QueueStats(ctx context.Context) (*SyncQueueStats, error) {
	out := &SyncQueueStats{}
	db := s.r.Raw().WithContext(ctx)

	if err := db.Model(&models.SyncLog{}).
		Where("synced_at IS NULL AND failed_at IS NULL").Count(&out.Pending).Error; err != nil {
		return nil, err
	}
	if err := db.Model(&models.SyncLog{}).
		Where("failed_at IS NOT NULL").Count(&out.Failed).Error; err != nil {
		return nil, err
	}

	var head models.SyncLog
	if err := db.Where("synced_at IS NULL AND failed_at IS NULL").
		Order("created_at ASC").First(&head).Error; err == nil {
		out.OldestPendingAt = &head.CreatedAt
		out.LastError = head.LastError
	} else if !errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, err
	}

	var last models.SyncLog
	if err := db.Where("synced_at IS NOT NULL").
		Order("synced_at DESC").First(&last).Error; err == nil {
		out.LastSyncedAt = last.SyncedAt
	} else if !errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, err
	}
	return out, nil
}

func strPtrOrNil(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
