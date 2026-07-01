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

// Update сохраняет конфиг (upsert singleton). Применяется после перезапуска
// сервера (пушер/пуллер читают конфиг при старте).
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
	if err := s.r.Raw().WithContext(ctx).
		Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "id"}}, UpdateAll: true}).
		Create(st).Error; err != nil {
		return nil, err
	}
	return st, nil
}

func strPtrOrNil(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
