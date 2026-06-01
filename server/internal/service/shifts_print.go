package service

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/escpos"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
	apperrors "github.com/restos/restos-v4/server/internal/pkg/errors"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
	"github.com/restos/restos-v4/server/internal/repo"
)

// PrintZResult — единый ответ для печати X/Z отчёта.
type PrintZResult struct {
	JobID  string `json:"job_id"`
	Status string `json:"status"`
}

// PrintZ — POST /api/v1/shifts/{id}/print-z.
//
// Собирает агрегаты смены (Z-отчёт), строит ESC/POS layout через
// escpos.ZReportLayout и кладёт PrintJob type='z_report' в очередь.
// Реальная отправка на принтер — асинхронным воркером.
//
// Не меняет статус смены: смена должна быть уже закрыта (Z = финальный отчёт).
// Для промежуточного отчёта используем PrintX.
func (s *ShiftsService) PrintZ(ctx context.Context, shiftID string) (*PrintZResult, error) {
	return s.printReport(ctx, shiftID, "z_report", true)
}

// PrintX — POST /api/v1/shifts/{id}/print-x.
//
// Промежуточный отчёт (без обнуления). Работает и для открытой, и для
// закрытой смены. Type job = 'x_report'.
func (s *ShiftsService) PrintX(ctx context.Context, shiftID string) (*PrintZResult, error) {
	return s.printReport(ctx, shiftID, "x_report", false)
}

func (s *ShiftsService) printReport(ctx context.Context, shiftID, jobType string, isZ bool) (*PrintZResult, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}

	// 1. Подтянем агрегаты через ZReport (общий метод покрывает оба отчёта).
	zr, err := s.ZReport(ctx, shiftID)
	if err != nil {
		return nil, err
	}

	// 2. Restaurant header.
	var rest models.Restaurant
	if err := s.r.Raw().WithContext(ctx).Where("id = ?", rid).First(&rest).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apperrors.ErrNotFound
		}
		return nil, err
	}

	// 3. Имя кассира — closed_by для Z, opened_by для X (best-effort).
	var cashierName string
	var userIDRef *string
	if isZ && zr.Shift.ClosedBy != nil {
		userIDRef = zr.Shift.ClosedBy
	} else if zr.Shift.OpenedBy != nil {
		userIDRef = zr.Shift.OpenedBy
	}
	if userIDRef != nil && *userIDRef != "" {
		var u struct {
			Name string `gorm:"column:name"`
		}
		_ = s.r.Raw().WithContext(ctx).Table("users").
			Select("name").Where("id = ?", *userIDRef).Scan(&u).Error
		cashierName = u.Name
	}

	// 4. Build ReportInput. shift_number — короткий идентификатор (последние 6 hex).
	shiftNumber := zr.Shift.ID
	if len(shiftNumber) > 6 {
		shiftNumber = shiftNumber[len(shiftNumber)-6:]
	}
	shiftNumber = fmt.Sprintf("%s (%s)", shiftNumber, zr.Shift.OpenedAt.Format("02.01.2006"))

	in := escpos.ReportInput{
		RestaurantName: rest.Name,
		ShiftNumber:    shiftNumber,
		OpenedAt:       zr.Shift.OpenedAt,
		OpeningBalance: zr.Shift.OpeningBalance,
		CashRevenue:    zr.Shift.CashRevenue,
		CardRevenue:    zr.Shift.CardRevenue,
		OrdersCount:    zr.Shift.OrdersCount,
		AvgCheck:       zr.Shift.AvgCheck,
		ClosingBalance: zr.Shift.ClosingBalance,
		CashierName:    cashierName,
	}
	if zr.Shift.ClosedAt != nil {
		in.ClosedAt = *zr.Shift.ClosedAt
	}
	if zr.Shift.ExpectedCash != nil {
		in.ExpectedCash = *zr.Shift.ExpectedCash
	} else {
		in.ExpectedCash = decimal.Zero
	}

	var payload []byte
	if isZ {
		payload = escpos.ZReportLayout(in)
	} else {
		payload = escpos.XReportLayout(in)
	}

	// 5. Enqueue print_job.
	now := time.Now().UTC()
	pj := &models.PrintJob{
		ID:           uuid.NewString(),
		Type:         jobType,
		Payload:      payload,
		Status:       "pending",
		RestaurantID: &rid,
		CreatedAt:    now,
		UpdatedAt:    now,
	}

	var res PrintZResult
	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)
		if err := tx.Session(&gorm.Session{SkipHooks: true}).Create(pj).Error; err != nil {
			return err
		}
		res.JobID = pj.ID
		res.Status = pj.Status
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &res, nil
}

// ─── Previous-shift summary (delta-chip) ───────────────────────────────────

// PreviousSummary — выжимка предыдущей закрытой смены того же ресторана.
// Возвращается внутри ZReport как поле `previous`; nil — если предыдущей нет.
type PreviousSummary struct {
	Revenue     decimal.Decimal `json:"revenue"`
	OrdersCount int             `json:"orders_count"`
	AvgCheck    decimal.Decimal `json:"avg_check"`
	GuestsCount int             `json:"guests_count"`
	ClosedAt    *time.Time      `json:"closed_at,omitempty"`
}

// loadPreviousSummary — находит ближайшую закрытую смену перед текущей и
// собирает её агрегаты (revenue = cash + card; guests count — SUM по
// заказам с GREATEST(guests_count, 1)).
//
// Возвращает (nil, nil), если предыдущей смены нет (первая смена ресторана).
func (s *ShiftsService) loadPreviousSummary(ctx context.Context, current *models.CashShift) (*PreviousSummary, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}

	// Ищем ближайшую закрытую смену с closed_at < current.opened_at.
	var prev models.CashShift
	q := s.r.Raw().WithContext(ctx).
		Where("restaurant_id = ? AND status = ? AND id != ?", rid, "closed", current.ID).
		Where("closed_at IS NOT NULL AND closed_at < ?", current.OpenedAt).
		Order("closed_at DESC").
		Limit(1)
	if err := q.First(&prev).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}

	out := &PreviousSummary{
		Revenue:  decimal.Normalize(decimal.Add(prev.CashRevenue, prev.CardRevenue)),
		AvgCheck: decimal.Normalize(prev.AvgCheck),
		ClosedAt: prev.ClosedAt,
	}
	if prev.OrdersCount != nil {
		out.OrdersCount = *prev.OrdersCount
	}

	// Гости — суммируем по orders предыдущей смены (как в ZReport).
	var guests struct {
		N int `gorm:"column:n"`
	}
	if err := s.r.Raw().WithContext(ctx).
		Model(&models.Order{}).
		Select("COALESCE(SUM(GREATEST(guests_count, 1)), 0) AS n").
		Where("restaurant_id = ? AND shift_id = ? AND status = ?", rid, prev.ID, "closed").
		Scan(&guests).Error; err == nil {
		out.GuestsCount = guests.N
	}

	return out, nil
}
