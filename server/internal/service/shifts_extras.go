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

// ZReportSalesByWaiter — per-waiter breakdown (frame «16. Официанты»).
type ZReportSalesByWaiter struct {
	WaiterID    string          `json:"waiter_id"`
	Name        string          `json:"name"`
	OrdersCount int             `json:"orders_count"`
	Total       decimal.Decimal `json:"total"`
	AvgCheck    decimal.Decimal `json:"avg_check"`
}

// ZReportSalesByCategory — sales по категории меню.
type ZReportSalesByCategory struct {
	Name  string          `json:"name"`
	Qty   int             `json:"qty"`
	Total decimal.Decimal `json:"total"`
}

// ZReportSalesByOrderType — sales по типу заказа (hall/takeaway/delivery).
type ZReportSalesByOrderType struct {
	Type        string          `json:"type"`
	OrdersCount int             `json:"orders_count"`
	Total       decimal.Decimal `json:"total"`
}

// ZReport — body GET /api/v1/shifts/{id}/zreport.
type ZReport struct {
	Shift            ZReportShift                `json:"shift"`
	RevenueByMethod  []ZReportRevenueByMethod    `json:"revenue_by_method"`
	SalesByWaiter    []ZReportSalesByWaiter      `json:"sales_by_waiter"`
	SalesByCategory  []ZReportSalesByCategory    `json:"sales_by_category"`
	SalesByOrderType []ZReportSalesByOrderType   `json:"sales_by_order_type"`
	GuestsCount      int                         `json:"guests_count"`
	Operations       []models.CashShiftOperation `json:"operations"`
	Discrepancy      decimal.Decimal             `json:"discrepancy"`
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

	// ─── Sales by waiter ──────────────────────────────────────────────
	type waiterRow struct {
		WaiterID    *string         `gorm:"column:waiter_id"`
		OrdersCount int             `gorm:"column:orders_count"`
		Total       decimal.Decimal `gorm:"column:total"`
	}
	var waiterRows []waiterRow
	if err := s.r.Raw().WithContext(ctx).
		Model(&models.Order{}).
		Select("waiter_id, COUNT(*) AS orders_count, COALESCE(SUM(total_with_service), 0) AS total").
		Where("restaurant_id = ? AND shift_id = ? AND status = ? AND waiter_id IS NOT NULL", rid, shiftID, "closed").
		Group("waiter_id").
		Order("total DESC").
		Find(&waiterRows).Error; err == nil && len(waiterRows) > 0 {
		// Подгрузим имена.
		ids := make([]string, 0, len(waiterRows))
		for _, r := range waiterRows {
			if r.WaiterID != nil {
				ids = append(ids, *r.WaiterID)
			}
		}
		nameMap := map[string]string{}
		if len(ids) > 0 {
			var users []struct {
				ID   string `gorm:"column:id"`
				Name string `gorm:"column:name"`
			}
			s.r.Raw().WithContext(ctx).Table("users").Select("id, name").Where("id IN ?", ids).Find(&users)
			for _, u := range users {
				nameMap[u.ID] = u.Name
			}
		}
		for _, r := range waiterRows {
			if r.WaiterID == nil {
				continue
			}
			avg := decimal.Zero
			if r.OrdersCount > 0 {
				avg = decimal.Normalize(decimal.DivRound(r.Total, decimal.FromInt(int64(r.OrdersCount))))
			}
			name := nameMap[*r.WaiterID]
			if name == "" {
				name = "—"
			}
			out.SalesByWaiter = append(out.SalesByWaiter, ZReportSalesByWaiter{
				WaiterID:    *r.WaiterID,
				Name:        name,
				OrdersCount: r.OrdersCount,
				Total:       decimal.Normalize(r.Total),
				AvgCheck:    avg,
			})
		}
	}

	// ─── Sales by category ────────────────────────────────────────────
	// Категория хранится прямо в order_items.menu_item_id → menu_items.category.
	// Используем JOIN, чтобы категории читались как есть даже если меню изменилось.
	type catRow struct {
		Name  *string         `gorm:"column:name"`
		Qty   int             `gorm:"column:qty"`
		Total decimal.Decimal `gorm:"column:total"`
	}
	var catRows []catRow
	if err := s.r.Raw().WithContext(ctx).
		Table("order_items AS oi").
		Select("COALESCE(NULLIF(mi.category, ''), 'Без категории') AS name, COUNT(oi.id) AS qty, COALESCE(SUM(oi.qty * oi.price), 0) AS total").
		Joins("JOIN orders o ON o.id = oi.order_id").
		Joins("LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id").
		Where("o.restaurant_id = ? AND o.shift_id = ? AND o.status = ? AND oi.cancelled_at IS NULL", rid, shiftID, "closed").
		Group("COALESCE(NULLIF(mi.category, ''), 'Без категории')").
		Order("total DESC").
		Find(&catRows).Error; err == nil {
		for _, r := range catRows {
			name := "Без категории"
			if r.Name != nil && *r.Name != "" {
				name = *r.Name
			}
			out.SalesByCategory = append(out.SalesByCategory, ZReportSalesByCategory{
				Name:  name,
				Qty:   r.Qty,
				Total: decimal.Normalize(r.Total),
			})
		}
	}

	// ─── Sales by order type ──────────────────────────────────────────
	type typeRow struct {
		Type        *string         `gorm:"column:type"`
		OrdersCount int             `gorm:"column:orders_count"`
		Total       decimal.Decimal `gorm:"column:total"`
	}
	var typeRows []typeRow
	if err := s.r.Raw().WithContext(ctx).
		Model(&models.Order{}).
		Select("type, COUNT(*) AS orders_count, COALESCE(SUM(total_with_service), 0) AS total").
		Where("restaurant_id = ? AND shift_id = ? AND status = ?", rid, shiftID, "closed").
		Group("type").
		Order("total DESC").
		Find(&typeRows).Error; err == nil {
		for _, r := range typeRows {
			t := "hall"
			if r.Type != nil && *r.Type != "" {
				t = *r.Type
			}
			out.SalesByOrderType = append(out.SalesByOrderType, ZReportSalesByOrderType{
				Type:        t,
				OrdersCount: r.OrdersCount,
				Total:       decimal.Normalize(r.Total),
			})
		}
	}

	// ─── Guests count ─────────────────────────────────────────────────
	var guests struct {
		N int `gorm:"column:n"`
	}
	if err := s.r.Raw().WithContext(ctx).
		Model(&models.Order{}).
		Select("COALESCE(SUM(GREATEST(guests_count, 1)), 0) AS n").
		Where("restaurant_id = ? AND shift_id = ? AND status = ?", rid, shiftID, "closed").
		Scan(&guests).Error; err == nil {
		out.GuestsCount = guests.N
	}

	return out, nil
}
