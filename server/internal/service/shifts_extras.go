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

// Active — GET /api/v1/shifts/active.
// Возвращает самую свежую open-смену для ресторана с подгружённым
// account_name; 404 если нет.
func (s *ShiftsService) Active(ctx context.Context) (*ShiftWithAccount, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	var shift models.CashShift
	if err := scoped.Where("status = ?", "open").
		Order("opened_at DESC").
		First(&shift).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apperrors.ErrNotFound
		}
		return nil, err
	}
	enriched, err := s.enrichWithAccountNames(ctx, []models.CashShift{shift})
	if err != nil {
		return nil, err
	}
	return &enriched[0], nil
}

// ShiftRevenue — простая агрегированная статистика смены (read-only).
type ShiftRevenue struct {
	CashRevenue decimal.Decimal `json:"cash_revenue"`
	CardRevenue decimal.Decimal `json:"card_revenue"`
	OrdersCount int             `json:"orders_count"`
	AvgCheck    decimal.Decimal `json:"avg_check"`
}

// Revenue — GET /api/v1/shifts/{id}/revenue.
// Берёт уже денормализованные агрегаты из cash_shifts (заполнены close_order).
func (s *ShiftsService) Revenue(ctx context.Context, shiftID string) (*ShiftRevenue, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	var shift models.CashShift
	if err := scoped.Where("id = ?", shiftID).First(&shift).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apperrors.ErrNotFound
		}
		return nil, err
	}
	out := &ShiftRevenue{
		CashRevenue: shift.CashRevenue,
		CardRevenue: shift.CardRevenue,
		AvgCheck:    shift.AvgCheck,
	}
	if shift.OrdersCount != nil {
		out.OrdersCount = *shift.OrdersCount
	}
	return out, nil
}

// Operations — GET /api/v1/shifts/{id}/operations.
// Тонкий доступ к списку операций смены без header'а.
func (s *ShiftsService) Operations(ctx context.Context, shiftID string) ([]models.CashShiftOperation, error) {
	// Сначала проверим, что смена принадлежит ресторану (ForTenant).
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	var shift models.CashShift
	if err := scoped.Where("id = ?", shiftID).First(&shift).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apperrors.ErrNotFound
		}
		return nil, err
	}
	var ops []models.CashShiftOperation
	if err := s.r.Raw().WithContext(ctx).
		Where("shift_id = ?", shiftID).
		Order("created_at ASC").
		Find(&ops).Error; err != nil {
		return nil, err
	}
	return ops, nil
}

// ShiftExpenseInput — body POST /api/v1/shifts/{id}/expenses.
// type: cash_in | cash_out | expense (alias к cash_out).
type ShiftExpenseInput struct {
	Type        string  `json:"type"`
	Amount      string  `json:"amount"`
	Description *string `json:"description,omitempty"`
}

// AddExpense — POST /api/v1/shifts/{id}/expenses.
// Тонкая обёртка над AddOperation: принимает 'expense' как алиас 'cash_out'.
func (s *ShiftsService) AddExpense(ctx context.Context, shiftID string, in ShiftExpenseInput) (*models.CashShiftOperation, error) {
	typ := in.Type
	if typ == "expense" {
		typ = "cash_out"
	}
	if typ != "cash_in" && typ != "cash_out" {
		return nil, apperrors.Wrap("VALIDATION", "type must be cash_in, cash_out or expense", nil)
	}
	desc := ""
	if in.Description != nil {
		desc = *in.Description
	}
	return s.AddOperation(ctx, shiftID, ShiftOperationInput{
		Type:        typ,
		Amount:      in.Amount,
		Description: desc,
	})
}

// DeleteExpense — DELETE /api/v1/shifts/{id}/expenses/{op_id}.
// Удаляет операцию только если смена открыта.
func (s *ShiftsService) DeleteExpense(ctx context.Context, shiftID, opID string) error {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return err
	}
	return s.r.Raw().WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var shift models.CashShift
		if err := tx.Where("restaurant_id = ? AND id = ?", rid, shiftID).
			First(&shift).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return apperrors.ErrNotFound
			}
			return err
		}
		if shift.Status == nil || *shift.Status != "open" {
			return apperrors.Wrap("CONFLICT", "shift is not open", nil)
		}
		res := tx.Where("id = ? AND shift_id = ?", opID, shiftID).
			Delete(&models.CashShiftOperation{})
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected == 0 {
			return apperrors.ErrNotFound
		}
		return nil
	})
}

// DeleteOperation — DELETE /api/v1/cash-shift-operations/{id}.
// Резолвит shift_id из самой операции, применяет tenant-проверку через
// смену-родителя. Удаление разрешено только если смена открыта.
func (s *ShiftsService) DeleteOperation(ctx context.Context, opID string) error {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return err
	}
	return s.r.Raw().WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var op models.CashShiftOperation
		if err := tx.Where("id = ?", opID).First(&op).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return apperrors.ErrNotFound
			}
			return err
		}
		if op.ShiftID == nil {
			return apperrors.ErrNotFound
		}
		var shift models.CashShift
		if err := tx.Where("restaurant_id = ? AND id = ?", rid, *op.ShiftID).
			First(&shift).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return apperrors.ErrNotFound
			}
			return err
		}
		if shift.Status == nil || *shift.Status != "open" {
			return apperrors.Wrap("CONFLICT", "shift is not open", nil)
		}
		res := tx.Where("id = ?", opID).Delete(&models.CashShiftOperation{})
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected == 0 {
			return apperrors.ErrNotFound
		}
		return nil
	})
}

// ─── Z-report ──────────────────────────────────────────────────────────────

// ZReportRevenueByMethod — выручка в разрезе payment_method.
type ZReportRevenueByMethod struct {
	PaymentMethod string          `json:"payment_method"`
	OrdersCount   int             `json:"orders_count"`
	Total         decimal.Decimal `json:"total"`
}

// ZReportShift — header агрегатов.
type ZReportShift struct {
	ID             string           `json:"id"`
	Status         *string          `json:"status"`
	OpeningBalance decimal.Decimal  `json:"opening_balance"`
	ClosingBalance decimal.Decimal  `json:"closing_balance"`
	ExpectedCash   *decimal.Decimal `json:"expected_cash"`
	CashRevenue    decimal.Decimal  `json:"cash_revenue"`
	CardRevenue    decimal.Decimal  `json:"card_revenue"`
	OrdersCount    int              `json:"orders_count"`
	AvgCheck       decimal.Decimal  `json:"avg_check"`
	OpenedAt       time.Time        `json:"opened_at"`
	ClosedAt       *time.Time       `json:"closed_at"`
	OpenedBy       *string          `json:"opened_by"`
	ClosedBy       *string          `json:"closed_by"`
}

// ZReport — body GET /api/v1/shifts/{id}/zreport.
type ZReport struct {
	Shift           ZReportShift                `json:"shift"`
	RevenueByMethod []ZReportRevenueByMethod    `json:"revenue_by_method"`
	Operations      []models.CashShiftOperation `json:"operations"`
	Discrepancy     decimal.Decimal             `json:"discrepancy"`
}

// ZReport — GET /api/v1/shifts/{id}/zreport.
func (s *ShiftsService) ZReport(ctx context.Context, shiftID string) (*ZReport, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	var shift models.CashShift
	if err := scoped.Where("id = ?", shiftID).First(&shift).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apperrors.ErrNotFound
		}
		return nil, err
	}

	out := &ZReport{
		Shift: ZReportShift{
			ID:             shift.ID,
			Status:         shift.Status,
			OpeningBalance: shift.OpeningBalance,
			ClosingBalance: shift.ClosingBalance,
			ExpectedCash:   shift.ExpectedCash,
			CashRevenue:    shift.CashRevenue,
			CardRevenue:    shift.CardRevenue,
			AvgCheck:       shift.AvgCheck,
			OpenedAt:       shift.OpenedAt,
			ClosedAt:       shift.ClosedAt,
			OpenedBy:       shift.OpenedBy,
			ClosedBy:       shift.ClosedBy,
		},
	}
	if shift.OrdersCount != nil {
		out.Shift.OrdersCount = *shift.OrdersCount
	}

	// Operations.
	var ops []models.CashShiftOperation
	if err := s.r.Raw().WithContext(ctx).
		Where("shift_id = ?", shiftID).
		Order("created_at ASC").
		Find(&ops).Error; err != nil {
		return nil, err
	}
	out.Operations = ops

	// Revenue по способу оплаты — из orders (закрытых) в этой смене.
	type aggRow struct {
		PaymentMethod *string         `gorm:"column:payment_method"`
		OrdersCount   int             `gorm:"column:orders_count"`
		Total         decimal.Decimal `gorm:"column:total"`
	}
	var aggs []aggRow
	if err := s.r.Raw().WithContext(ctx).
		Model(&models.Order{}).
		Select("payment_method, COUNT(*) AS orders_count, COALESCE(SUM(total_with_service), 0) AS total").
		Where("restaurant_id = ? AND shift_id = ? AND status = ?", rid, shiftID, "closed").
		Group("payment_method").
		Order("payment_method ASC").
		Find(&aggs).Error; err != nil {
		return nil, err
	}
	for _, a := range aggs {
		pm := ""
		if a.PaymentMethod != nil {
			pm = *a.PaymentMethod
		}
		out.RevenueByMethod = append(out.RevenueByMethod, ZReportRevenueByMethod{
			PaymentMethod: pm,
			OrdersCount:   a.OrdersCount,
			Total:         decimal.Normalize(a.Total),
		})
	}

	// Расхождение = closing - expected (если expected заполнен).
	if shift.ExpectedCash != nil {
		out.Discrepancy = decimal.Normalize(decimal.Sub(shift.ClosingBalance, *shift.ExpectedCash))
	}
	return out, nil
}
