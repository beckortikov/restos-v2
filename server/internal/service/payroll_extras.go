package service

import (
	"context"
	"errors"
	"time"

	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
	apperrors "github.com/restos/restos-v4/server/internal/pkg/errors"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
)

// Active — GET /api/v1/time-entries/active?user_id=...
// Текущая открытая запись для пользователя (clock_out IS NULL). 404 если нет.
func (s *TimeEntriesService) Active(ctx context.Context, userID string) (*models.TimeEntry, error) {
	if userID == "" {
		return nil, apperrors.Wrap("VALIDATION", "user_id is required", nil)
	}
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	var t models.TimeEntry
	if err := scoped.Where("user_id = ? AND clock_out IS NULL", userID).
		Order("clock_in DESC").
		First(&t).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apperrors.ErrNotFound
		}
		return nil, err
	}
	return &t, nil
}

// TimeEntryPatchInput — body PATCH /api/v1/time-entries/{id}.
type TimeEntryPatchInput struct {
	ClockIn      *string `json:"clock_in,omitempty"`  // RFC3339
	ClockOut     *string `json:"clock_out,omitempty"` // RFC3339
	BreakMinutes *int    `json:"break_minutes,omitempty"`
	Role         *string `json:"role,omitempty"`
	Note         *string `json:"note,omitempty"`
}

// Patch — PATCH /api/v1/time-entries/{id}. Ручная коррекция менеджером.
func (s *TimeEntriesService) Patch(ctx context.Context, id string, in TimeEntryPatchInput) (*models.TimeEntry, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	var existing models.TimeEntry
	if err := scoped.Where("id = ?", id).First(&existing).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apperrors.ErrNotFound
		}
		return nil, err
	}
	updates := map[string]any{}
	if in.ClockIn != nil {
		t, err := time.Parse(time.RFC3339, *in.ClockIn)
		if err != nil {
			return nil, apperrors.Wrap("VALIDATION", "bad clock_in", err)
		}
		updates["clock_in"] = t
		existing.ClockIn = &t
	}
	if in.ClockOut != nil {
		t, err := time.Parse(time.RFC3339, *in.ClockOut)
		if err != nil {
			return nil, apperrors.Wrap("VALIDATION", "bad clock_out", err)
		}
		updates["clock_out"] = t
		existing.ClockOut = &t
		closed := "closed"
		updates["status"] = closed
	}
	if in.Note != nil {
		updates["note"] = *in.Note
	}
	if in.BreakMinutes != nil {
		updates["break_minutes"] = *in.BreakMinutes
		br := *in.BreakMinutes
		existing.BreakMinutes = &br
	}
	// Role не маппится в time_entries (нет колонки), игнорим — поле есть в DTO
	// для FE-совместимости, фактически в этой таблице роль не хранится.
	_ = in.Role

	// Пересчитываем total_hours если оба поля известны.
	if existing.ClockIn != nil && existing.ClockOut != nil {
		br := 0
		if existing.BreakMinutes != nil {
			br = *existing.BreakMinutes
		}
		dur := existing.ClockOut.Sub(*existing.ClockIn) - time.Duration(br)*time.Minute
		total := decimal.DivRound(decimal.FromInt(int64(dur.Minutes())), decimal.FromInt(60))
		updates["total_hours"] = total
	}
	if len(updates) == 0 {
		return &existing, nil
	}
	scoped2, _ := s.r.ForTenant(ctx)
	if err := scoped2.Model(&existing).Updates(updates).Error; err != nil {
		return nil, err
	}
	scoped3, _ := s.r.ForTenant(ctx)
	var out models.TimeEntry
	if err := scoped3.Where("id = ?", id).First(&out).Error; err != nil {
		return nil, err
	}
	return &out, nil
}

// WaiterStats — стата официанта за сегодня.
type WaiterStats struct {
	OrdersCount   int             `json:"orders_count"`
	ServedCount   int             `json:"served_count"`
	Revenue       decimal.Decimal `json:"revenue"`
	ServiceEarned decimal.Decimal `json:"service_earned"`
	HoursWorked   decimal.Decimal `json:"hours_worked"`
}

// TodayStats — GET /api/v1/waiters/{id}/today-stats.
func (s *TimeEntriesService) TodayStats(ctx context.Context, waiterID string) (*WaiterStats, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	// Start of day в UTC (упрощение — точная TZ ресторана будет в Phase 11).
	now := time.Now().UTC()
	dayStart := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	dayEnd := dayStart.Add(24 * time.Hour)

	out := &WaiterStats{}

	// Orders (открытые/закрытые этого официанта сегодня).
	var orderAgg struct {
		Cnt     int             `gorm:"column:cnt"`
		Revenue decimal.Decimal `gorm:"column:revenue"`
	}
	if err := s.r.Raw().WithContext(ctx).
		Model(&models.Order{}).
		Select("COUNT(*) AS cnt, COALESCE(SUM(total_with_service), 0) AS revenue").
		Where("restaurant_id = ? AND waiter_id = ? AND created_at >= ? AND created_at < ?",
			rid, waiterID, dayStart, dayEnd).
		Find(&orderAgg).Error; err != nil {
		return nil, err
	}
	out.OrdersCount = orderAgg.Cnt
	out.Revenue = decimal.Normalize(orderAgg.Revenue)

	// Served (закрытые) + service_earned (SUM service_amount по закрытым).
	var servedAgg struct {
		Cnt           int             `gorm:"column:cnt"`
		ServiceEarned decimal.Decimal `gorm:"column:service_earned"`
	}
	if err := s.r.Raw().WithContext(ctx).
		Model(&models.Order{}).
		Select("COUNT(*) AS cnt, COALESCE(SUM(service_amount), 0) AS service_earned").
		Where("restaurant_id = ? AND waiter_id = ? AND status = ? AND created_at >= ? AND created_at < ?",
			rid, waiterID, "closed", dayStart, dayEnd).
		Find(&servedAgg).Error; err != nil {
		return nil, err
	}
	out.ServedCount = servedAgg.Cnt
	out.ServiceEarned = decimal.Normalize(servedAgg.ServiceEarned)

	// Hours worked — суммируем total_hours для всех time_entries официанта сегодня,
	// плюс открытая запись (если есть) — её часы до сейчас.
	var entries []models.TimeEntry
	if err := s.r.Raw().WithContext(ctx).
		Where("restaurant_id = ? AND user_id = ? AND clock_in >= ?",
			rid, waiterID, dayStart).
		Find(&entries).Error; err != nil {
		return nil, err
	}
	hours := decimal.Zero
	for _, e := range entries {
		if e.ClockOut != nil {
			hours = decimal.Add(hours, e.TotalHours)
			continue
		}
		// Открытая запись — считаем от clock_in до сейчас.
		if e.ClockIn == nil {
			continue
		}
		br := 0
		if e.BreakMinutes != nil {
			br = *e.BreakMinutes
		}
		dur := time.Since(*e.ClockIn) - time.Duration(br)*time.Minute
		if dur < 0 {
			continue
		}
		partial := decimal.DivRound(decimal.FromInt(int64(dur.Minutes())), decimal.FromInt(60))
		hours = decimal.Add(hours, partial)
	}
	out.HoursWorked = decimal.Normalize(hours)
	return out, nil
}
