package service

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/db/models"
	apperrors "github.com/restos/restos-v4/server/internal/pkg/errors"
)

// Reprint — POST /api/v1/print/jobs/{id}/reprint.
// Клонирует существующий job с новым id, status='pending'. Отличие от /retry:
// retry перезапускает тот же job (failed → pending); reprint создаёт новый job
// (useful для распечатки исторических чеков).
func (s *PrintJobsService) Reprint(ctx context.Context, id string) (*models.PrintJob, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	var src models.PrintJob
	if err := scoped.Where("id = ?", id).First(&src).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apperrors.ErrNotFound
		}
		return nil, err
	}
	now := time.Now().UTC()
	clone := &models.PrintJob{
		ID:           uuid.NewString(),
		Type:         src.Type,
		PrinterID:    src.PrinterID,
		Payload:      append([]byte(nil), src.Payload...),
		OrderID:      src.OrderID,
		Status:       "pending",
		Attempts:     0,
		RestaurantID: src.RestaurantID,
		CreatedAt:    now,
		UpdatedAt:    now,
	}
	scoped2, _ := s.r.ForTenant(ctx)
	if err := scoped2.Session(&gorm.Session{SkipHooks: true}).Create(clone).Error; err != nil {
		return nil, err
	}
	return clone, nil
}

// ActiveByStation — GET /api/v1/print/jobs/active-by-station?station=...
// Возвращает pending jobs для конкретной станции. Фильтр по принтерам станции:
// JOIN на printers.station = ?.
//
// Альтернатива: хранить station в print_jobs напрямую (не делаем — менять схему
// сейчас не хочется). JOIN покрывает 99% случаев.
func (s *PrintJobsService) ActiveByStation(ctx context.Context, station string) ([]models.PrintJob, error) {
	if station == "" {
		return nil, apperrors.Wrap("VALIDATION", "station is required", nil)
	}
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	var rows []models.PrintJob
	if err := scoped.
		Where("status = ?", "pending").
		Where("printer_id IN (?)",
			s.r.Raw().Model(&models.Printer{}).
				Select("id").
				Where("station = ?", station)).
		Order("created_at ASC").
		Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}
