package service

import (
	"context"
	"time"

	"github.com/restos/restos-v4/server/internal/db/models"
)

// ForTableFilter — фильтры GET /api/v1/reservations/for-table/{table_id}.
type ForTableFilter struct {
	From time.Time
	To   time.Time
}

// ForTable — GET /api/v1/reservations/for-table/{table_id}?from=&to=.
//
// Если from/to пустые — по умолчанию ближайшие 12 часов (для UI «текущая бронь»).
func (s *ReservationsService) ForTable(ctx context.Context, tableID string, f ForTableFilter) ([]models.Reservation, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	if f.From.IsZero() {
		f.From = time.Now().UTC()
	}
	if f.To.IsZero() {
		f.To = f.From.Add(12 * time.Hour)
	}
	var rows []models.Reservation
	if err := scoped.Where("table_id = ?", tableID).
		Where("reserved_at >= ? AND reserved_at < ?", f.From, f.To).
		Order("reserved_at ASC").
		Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}
