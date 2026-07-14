package service

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"github.com/restos/restos-v4/server/internal/audit"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
	apperrors "github.com/restos/restos-v4/server/internal/pkg/errors"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
	"github.com/restos/restos-v4/server/internal/repo"
)

// ═══════════════════════════════════════════════════════════════════════════
// Splits — management lifecycle: list/equal/by-items/pay/cancel/check-and-close
// ═══════════════════════════════════════════════════════════════════════════

// ListSplits — GET /api/v1/orders/{id}/splits.
func (s *OrdersService) ListSplits(ctx context.Context, orderID string) ([]models.OrderSplit, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	var rows []models.OrderSplit
	if err := scoped.Where("order_id = ?", orderID).
		Order("split_number ASC").
		Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}

// SplitEqualInput — body POST /orders/{id}/splits/equal.
type SplitEqualInput struct {
	Count int `json:"count"`
}

// SplitByItemsInput — body POST /orders/{id}/splits/by-items.
type SplitByItemsInput struct {
	Groups []SplitPart `json:"groups"`
}

// SplitEqual — alias for Split(mode=equal). Replaces existing splits in tx.
func (s *OrdersService) SplitEqual(ctx context.Context, orderID string, in SplitEqualInput) (*SplitResult, error) {
	if in.Count < 2 {
		return nil, apperrors.Wrap("VALIDATION", "count must be >= 2", nil)
	}
	if err := s.clearUnpaidSplits(ctx, orderID); err != nil {
		return nil, err
	}
	return s.Split(ctx, orderID, SplitInput{Mode: "equal", Count: in.Count})
}

// SplitByItems — alias for Split(mode=by_items). Replaces existing splits in tx.
func (s *OrdersService) SplitByItems(ctx context.Context, orderID string, in SplitByItemsInput) (*SplitResult, error) {
	if len(in.Groups) < 2 {
		return nil, apperrors.Wrap("VALIDATION", "groups must have >= 2 parts", nil)
	}
	if err := s.clearUnpaidSplits(ctx, orderID); err != nil {
		return nil, err
	}
	return s.Split(ctx, orderID, SplitInput{Mode: "by_items", Splits: in.Groups})
}

// clearUnpaidSplits — внутренний helper: если у заказа уже есть splits (но
// никто не оплатил) — удаляем и сбрасываем is_split, чтобы Split() мог снова
// создать их с нуля. Если хоть один paid — CONFLICT.
func (s *OrdersService) clearUnpaidSplits(ctx context.Context, orderID string) error {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return err
	}
	return s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)
		var splits []models.OrderSplit
		if err := tx.Where("restaurant_id = ? AND order_id = ?", rid, orderID).
			Find(&splits).Error; err != nil {
			return err
		}
		if len(splits) == 0 {
			return nil
		}
		for _, sp := range splits {
			if sp.Status != nil && *sp.Status == "paid" {
				return apperrors.Wrap("CONFLICT", "cannot rebuild splits: some are already paid", nil)
			}
		}
		if err := tx.Where("restaurant_id = ? AND order_id = ?", rid, orderID).
			Delete(&models.OrderSplit{}).Error; err != nil {
			return err
		}
		no := false
		zero := 0
		if err := tx.Model(&models.Order{}).
			Where("restaurant_id = ? AND id = ?", rid, orderID).
			Updates(map[string]any{
				"is_split":    &no,
				"split_count": &zero,
				"updated_at":  time.Now().UTC(),
			}).Error; err != nil {
			return err
		}
		return nil
	})
}

// PaySplitInput — body POST /splits/{split_id}/pay.
type PaySplitInput struct {
	PaymentMethod string  `json:"payment_method"`
	AccountID     string  `json:"account_id"`
	AccountName   *string `json:"account_name,omitempty"`
	CashierID     *string `json:"cashier_id,omitempty"`
}

// PaySplitResult — что вернули клиенту.
type PaySplitResult struct {
	Split       models.OrderSplit         `json:"split"`
	Operation   models.FinancialOperation `json:"operation"`
	OrderClosed bool                      `json:"order_closed"`
	Order       *models.Order             `json:"order,omitempty"`
}

// PaySplit — оплачивает один split, создаёт FinancialOperation type='in',
// инкрементит баланс счёта. Когда ВСЕ splits оплачены — параллельно закрывает
// родительский заказ (зеркало /orders/{id}/close, но FO только один — на total).
func (s *OrdersService) PaySplit(ctx context.Context, splitID string, in PaySplitInput) (*PaySplitResult, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	if in.PaymentMethod == "" || in.AccountID == "" {
		return nil, apperrors.Wrap("VALIDATION", "payment_method and account_id are required", nil)
	}
	actor, _ := audit.ActorFromContext(ctx)

	var result PaySplitResult
	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)

		// 1. Lock split.
		var sp models.OrderSplit
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("restaurant_id = ? AND id = ?", rid, splitID).
			First(&sp).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return apperrors.ErrNotFound
			}
			return err
		}
		if sp.Status != nil && *sp.Status == "paid" {
			return apperrors.Wrap("CONFLICT", "split already paid", nil)
		}

		// 2. Lock account.
		var acc models.FinancialAccount
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("restaurant_id = ? AND id = ?", rid, in.AccountID).
			First(&acc).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return apperrors.Wrap("VALIDATION", "account not found", nil)
			}
			return err
		}

		// 2b. Требуем открытую смену — как и /close. Продажа (в т.ч. через
		// разделение счёта) без открытой смены не допускается.
		var shift models.CashShift
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("restaurant_id = ? AND status = ?", rid, "open").
			Order("opened_at DESC").
			First(&shift).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return apperrors.Wrap("CONFLICT", "shift is not open", nil)
			}
			return err
		}

		now := time.Now().UTC()
		paid := "paid"
		pm := in.PaymentMethod
		accID := in.AccountID
		paidBy := actor.UserID
		if in.CashierID != nil && *in.CashierID != "" {
			paidBy = *in.CashierID
		}
		sp.Status = &paid
		sp.PaymentMethod = &pm
		sp.AccountID = &accID
		if in.AccountName != nil {
			sp.AccountName = in.AccountName
		} else {
			sp.AccountName = acc.Name
		}
		sp.PaidAt = &now
		sp.PaidBy = &paidBy
		if err := tx.Save(&sp).Error; err != nil {
			return err
		}

		// 3. Inc balance.
		newBal := decimal.Normalize(decimal.Add(acc.Balance, sp.Total))
		if err := tx.Model(&acc).
			Updates(map[string]any{"balance": newBal, "updated_at": now}).Error; err != nil {
			return err
		}

		// 4. Financial operation type=in revenue.
		opType := "in"
		opCat := "revenue"
		opActivity := "operational"
		opDate := now.Format("2006-01-02")
		opDesc := "split:" + sp.ID
		opAuto := true
		opSourceRef := "split:" + sp.ID
		op := models.FinancialOperation{
			ID:           uuid.NewString(),
			Type:         &opType,
			Amount:       sp.Total,
			Category:     &opCat,
			Activity:     &opActivity,
			AccountID:    &accID,
			AccountName:  acc.Name,
			Date:         &opDate,
			Description:  &opDesc,
			IsAuto:       &opAuto,
			SourceRef:    &opSourceRef,
			RestaurantID: &rid,
			ShiftID:      &shift.ID,
			CreatedAt:    now,
			UpdatedAt:    now,
		}
		if err := tx.Create(&op).Error; err != nil {
			return err
		}
		result.Split = sp
		result.Operation = op

		// Агрегаты смены: выручка split'а попадает в кассовую смену (как /close),
		// иначе экран смены не покажет продажи через разделение счёта.
		switch in.PaymentMethod {
		case "cash":
			shift.CashRevenue = decimal.Add(shift.CashRevenue, sp.Total)
		case "card":
			shift.CardRevenue = decimal.Add(shift.CardRevenue, sp.Total)
		}
		shift.UpdatedAt = now
		if err := tx.Save(&shift).Error; err != nil {
			return err
		}

		// 5. Check if all splits paid → close order.
		if sp.OrderID == nil {
			return nil
		}
		orderID := *sp.OrderID
		var unpaid int64
		if err := tx.Model(&models.OrderSplit{}).
			Where("restaurant_id = ? AND order_id = ? AND (status IS NULL OR status <> ?)", rid, orderID, "paid").
			Count(&unpaid).Error; err != nil {
			return err
		}
		if unpaid > 0 {
			return nil
		}

		// Все оплачены — закрываем заказ.
		var order models.Order
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("restaurant_id = ? AND id = ?", rid, orderID).
			First(&order).Error; err != nil {
			return err
		}
		if order.Status != nil && *order.Status == "closed" {
			// Уже закрыт — нечего делать.
			result.OrderClosed = true
			result.Order = &order
			return nil
		}
		closed := "closed"
		order.Status = &closed
		order.ClosedAt = &now
		order.PaymentMethod = &pm
		order.TotalWithService = decimal.Normalize(decimal.Add(order.Total, order.TipAmount))
		order.UpdatedAt = now
		if err := tx.Save(&order).Error; err != nil {
			return err
		}

		// Счётчик заказов смены +1 (на полное закрытие заказа, не на каждый split)
		// и пересчёт среднего чека — как в /close.
		oc := 1
		if shift.OrdersCount != nil {
			oc = *shift.OrdersCount + 1
		}
		shift.OrdersCount = &oc
		shTotal := decimal.Add(shift.CashRevenue, shift.CardRevenue)
		shift.AvgCheck = decimal.Normalize(decimal.DivRound(shTotal, decimal.FromInt(int64(oc))))
		shift.UpdatedAt = now
		if err := tx.Save(&shift).Error; err != nil {
			return err
		}

		// Stock deduct (идемпотентно — мы проверяем по description).
		ref := "order:" + order.ID
		var existing int64
		if err := tx.Model(&models.StockMovement{}).
			Where("restaurant_id = ? AND description = ?", rid, ref).
			Count(&existing).Error; err != nil {
			return err
		}
		if existing == 0 {
			if err := s.deductStockForOrder(tx, rid, &order, ref, now); err != nil {
				return err
			}
		}
		result.OrderClosed = true
		result.Order = &order
		return nil
	})
	if err != nil {
		return nil, err
	}
	if s.pub != nil {
		buf := NewBuffer()
		buf.Add(EventOrderUpdated, map[string]any{
			"id":     result.Split.ID,
			"action": "split.paid",
		})
		if result.OrderClosed && result.Order != nil {
			buf.Add(EventOrderClosed, map[string]any{
				"id":                 result.Order.ID,
				"total_with_service": result.Order.TotalWithService.String(),
			})
		}
		s.pub.Flush(ctx, rid, buf)
	}
	return &result, nil
}

// CancelSplitsResult — что вернули клиенту.
type CancelSplitsResult struct {
	Order   models.Order `json:"order"`
	Removed int          `json:"removed"`
}

// CancelSplits — удаляет все unpaid splits заказа, сбрасывает is_split.
// Если есть paid splits — CONFLICT.
func (s *OrdersService) CancelSplits(ctx context.Context, orderID string) (*CancelSplitsResult, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	var res CancelSplitsResult
	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)
		var order models.Order
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("restaurant_id = ? AND id = ?", rid, orderID).
			First(&order).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return apperrors.ErrNotFound
			}
			return err
		}
		var splits []models.OrderSplit
		if err := tx.Where("restaurant_id = ? AND order_id = ?", rid, orderID).
			Find(&splits).Error; err != nil {
			return err
		}
		for _, sp := range splits {
			if sp.Status != nil && *sp.Status == "paid" {
				return apperrors.Wrap("CONFLICT", "cannot cancel splits: some are already paid", nil)
			}
		}
		if r := tx.Where("restaurant_id = ? AND order_id = ?", rid, orderID).
			Delete(&models.OrderSplit{}); r.Error != nil {
			return r.Error
		} else {
			res.Removed = int(r.RowsAffected)
		}
		no := false
		zero := 0
		order.IsSplit = &no
		order.SplitCount = &zero
		order.UpdatedAt = time.Now().UTC()
		if err := tx.Save(&order).Error; err != nil {
			return err
		}
		res.Order = order
		return nil
	})
	if err != nil {
		return nil, err
	}
	if s.pub != nil {
		buf := NewBuffer()
		buf.Add(EventOrderUpdated, map[string]any{
			"id":     orderID,
			"action": "splits.cancelled",
		})
		s.pub.Flush(ctx, rid, buf)
	}
	return &res, nil
}

// CheckAndCloseResult — что вернули.
type CheckAndCloseResult struct {
	OrderID     string        `json:"order_id"`
	PaidCount   int           `json:"paid_count"`
	UnpaidCount int           `json:"unpaid_count"`
	Closed      bool          `json:"closed"`
	Order       *models.Order `json:"order,omitempty"`
}

// CheckAndClose — если у заказа все splits оплачены и сам он ещё не закрыт →
// закрывает (status=closed, closed_at=now). Иначе просто возвращает счётчики.
func (s *OrdersService) CheckAndClose(ctx context.Context, orderID string) (*CheckAndCloseResult, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	var res CheckAndCloseResult
	res.OrderID = orderID
	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)
		var order models.Order
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("restaurant_id = ? AND id = ?", rid, orderID).
			First(&order).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return apperrors.ErrNotFound
			}
			return err
		}
		var splits []models.OrderSplit
		if err := tx.Where("restaurant_id = ? AND order_id = ?", rid, orderID).
			Find(&splits).Error; err != nil {
			return err
		}
		for _, sp := range splits {
			if sp.Status != nil && *sp.Status == "paid" {
				res.PaidCount++
			} else {
				res.UnpaidCount++
			}
		}
		if order.Status != nil && *order.Status == "closed" {
			res.Closed = true
			res.Order = &order
			return nil
		}
		if len(splits) == 0 || res.UnpaidCount > 0 {
			res.Order = &order
			return nil
		}
		now := time.Now().UTC()
		closed := "closed"
		order.Status = &closed
		order.ClosedAt = &now
		order.TotalWithService = decimal.Normalize(decimal.Add(order.Total, order.TipAmount))
		order.UpdatedAt = now
		if err := tx.Save(&order).Error; err != nil {
			return err
		}
		ref := "order:" + order.ID
		var existing int64
		if err := tx.Model(&models.StockMovement{}).
			Where("restaurant_id = ? AND description = ?", rid, ref).
			Count(&existing).Error; err != nil {
			return err
		}
		if existing == 0 {
			if err := s.deductStockForOrder(tx, rid, &order, ref, now); err != nil {
				return err
			}
		}
		res.Closed = true
		res.Order = &order
		return nil
	})
	if err != nil {
		return nil, err
	}
	if res.Closed && res.Order != nil && s.pub != nil {
		buf := NewBuffer()
		buf.Add(EventOrderClosed, map[string]any{"id": res.Order.ID})
		s.pub.Flush(ctx, rid, buf)
	}
	return &res, nil
}

// ═══════════════════════════════════════════════════════════════════════════
// Voids — list + standalone create
// ═══════════════════════════════════════════════════════════════════════════

// ListVoidsByOrder — GET /api/v1/orders/{id}/voids.
func (s *OrdersService) ListVoidsByOrder(ctx context.Context, orderID string) ([]models.OrderVoid, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	var rows []models.OrderVoid
	if err := scoped.Where("order_id = ?", orderID).
		Order("created_at ASC").
		Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}

// ListVoidsByOrders — GET /api/v1/voids?order_ids=id1,id2.
func (s *OrdersService) ListVoidsByOrders(ctx context.Context, orderIDs []string) ([]models.OrderVoid, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	if len(orderIDs) == 0 {
		return []models.OrderVoid{}, nil
	}
	var rows []models.OrderVoid
	if err := scoped.Where("order_id IN ?", orderIDs).
		Order("created_at ASC").
		Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}

// CreateVoidInput — body POST /api/v1/voids (standalone).
type CreateVoidInput struct {
	OrderID        string  `json:"order_id"`
	ItemName       string  `json:"item_name"`
	ItemQty        int     `json:"item_qty"`
	ItemPrice      string  `json:"item_price"`
	Reason         string  `json:"reason"`
	ApprovedBy     *string `json:"approved_by,omitempty"`
	ApprovedByName *string `json:"approved_by_name,omitempty"`
	CreatedBy      *string `json:"created_by,omitempty"`
	CreatedByName  *string `json:"created_by_name,omitempty"`
}

// CreateVoid — биллинговое списание позиции: пишет запись в order_voids И
// уменьшает order.total на price×qty (как делал v1 createVoid в
// restos/lib/supabase-queries.ts). Без этого пересчёта скаляр order.total
// оставался завышенным: карта/официант (читают order.total) показывали старую
// сумму, а диалог оплаты (считает из visibleReceiptItems по order_voids) —
// уменьшенную. cancelled_at на самом order_item НЕ ставим — позицию из чека
// исключает фильтр по order_voids (см. restos/lib/helpers.ts visibleReceiptItems).
func (s *OrdersService) CreateVoid(ctx context.Context, in CreateVoidInput) (*models.OrderVoid, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	if in.OrderID == "" {
		return nil, apperrors.Wrap("VALIDATION", "order_id is required", nil)
	}
	if in.Reason == "" {
		return nil, apperrors.Wrap("VALIDATION", "reason is required", nil)
	}
	price, err := decimal.FromString(in.ItemPrice)
	if err != nil {
		return nil, apperrors.Wrap("VALIDATION", "bad item_price", err)
	}
	actor, _ := audit.ActorFromContext(ctx)
	createdBy := actor.UserID
	if in.CreatedBy != nil && *in.CreatedBy != "" {
		createdBy = *in.CreatedBy
	}
	qty := in.ItemQty
	now := time.Now().UTC()
	oid := in.OrderID
	itemName := in.ItemName
	reason := in.Reason
	v := &models.OrderVoid{
		ID:             uuid.NewString(),
		OrderID:        &oid,
		ItemName:       &itemName,
		ItemQty:        &qty,
		ItemPrice:      price,
		Reason:         &reason,
		ApprovedBy:     in.ApprovedBy,
		ApprovedByName: in.ApprovedByName,
		CreatedBy:      &createdBy,
		CreatedByName:  in.CreatedByName,
		RestaurantID:   &rid,
		CreatedAt:      now,
	}

	var tableID *string
	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)

		// Lock order (если ещё открыт). Закрытый/отменённый — total не трогаем,
		// но запись в order_voids всё равно создаём (исторический аудит).
		var order models.Order
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("restaurant_id = ? AND id = ?", rid, oid).
			First(&order).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return apperrors.ErrNotFound
			}
			return err
		}

		// Защита от произвольной item_price: для уменьшения total берём СЕРВЕРНУЮ
		// цену совпадающей позиции заказа (по имени), а не клиентскую item_price.
		// Иначе крафтом запроса можно было занизить total на любую сумму.
		var oi models.OrderItem
		matched := tx.Where("order_id = ? AND name = ? AND cancelled_at IS NULL", oid, itemName).
			Order("created_at ASC").First(&oi).Error == nil
		if matched {
			v.ItemPrice = oi.Price // audit-запись — серверная цена, не клиентская
		}

		if err := tx.Create(v).Error; err != nil {
			return err
		}

		// total уменьшаем ТОЛЬКО если позиция реально есть на открытом заказе —
		// нельзя «списать» несуществующую позицию и произвольно занизить сумму.
		mutable := order.Status == nil || (*order.Status != "closed" && *order.Status != "cancelled")
		if mutable && matched {
			lineTotal := decimal.Normalize(decimal.Mul(oi.Price, decimal.FromInt(int64(qty))))
			newTotal := decimal.Sub(order.Total, lineTotal)
			if decimal.IsNegative(newTotal) {
				newTotal = decimal.Zero
			}
			order.Total = decimal.Normalize(newTotal)
			order.TotalWithService = order.Total
			order.UpdatedAt = now
			if err := tx.Save(&order).Error; err != nil {
				return err
			}
			tableID = order.TableID
		}
		return nil
	})
	if err != nil {
		return nil, err
	}

	if s.pub != nil {
		buf := NewBuffer()
		buf.Add(EventOrderItemVoided, map[string]any{
			"order_id": oid,
			"reason":   reason,
		})
		if tableID != nil {
			buf.Add(EventTableUpdated, map[string]any{"id": *tableID})
		}
		s.pub.Flush(ctx, rid, buf)
	}
	return v, nil
}

// ═══════════════════════════════════════════════════════════════════════════
// Order item lifecycle
// ═══════════════════════════════════════════════════════════════════════════

// CancelItemInput — body POST /orders/{id}/items/{itemId}/cancel.
type CancelItemInput struct {
	Qty    *string `json:"qty,omitempty"`
	Reason *string `json:"reason,omitempty"`
}

// CancelItem — мягкая отмена позиции (waiter pre-payment).
// В отличие от VoidItem: не требует approved_by, не пишет в order_voids,
// но обновляет cancelled_at/by/reason и пересчитывает order.total.
func (s *OrdersService) CancelItem(ctx context.Context, orderID, itemID string, in CancelItemInput) (*models.OrderItem, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	if err := s.requirePerm(ctx, "orders.void"); err != nil {
		return nil, err
	}
	actor, _ := audit.ActorFromContext(ctx)

	var out *models.OrderItem
	var voidedOrderNumber int
	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)
		var order models.Order
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("restaurant_id = ? AND id = ?", rid, orderID).
			First(&order).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return apperrors.ErrNotFound
			}
			return err
		}
		if order.Status != nil && (*order.Status == "closed" || *order.Status == "cancelled") {
			return apperrors.Wrap("CONFLICT", "cannot cancel item in closed/cancelled order", nil)
		}
		voidedOrderNumber = order.OrderNumber
		var item models.OrderItem
		if err := tx.Where("id = ? AND order_id = ?", itemID, orderID).
			First(&item).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return apperrors.ErrNotFound
			}
			return err
		}
		if item.CancelledAt != nil {
			return apperrors.Wrap("CONFLICT", "item already cancelled", nil)
		}
		now := time.Now().UTC()
		reason := ""
		if in.Reason != nil {
			reason = *in.Reason
		}
		canceller := actor.UserID

		// Partial-cancel: если qty задан и qty < item.qty → split строку.
		// Создаём отдельный cancelled row на qtyToCancel, исходную уменьшаем
		// на эту же дельту. Если qty не задан или >= item.qty — обычная
		// полная отмена (старое поведение).
		var qtyToCancel decimal.Decimal
		fullCancel := true
		if in.Qty != nil && strings.TrimSpace(*in.Qty) != "" {
			q, err := decimal.FromString(*in.Qty)
			if err != nil {
				return apperrors.Wrap("VALIDATION", "bad qty: "+*in.Qty, err)
			}
			if !decimal.IsPositive(q) {
				return apperrors.Wrap("VALIDATION", "qty must be > 0", nil)
			}
			// Если qty < item.qty — partial. Иначе full.
			if q.Cmp(item.Qty) < 0 {
				qtyToCancel = q
				fullCancel = false
			} else {
				qtyToCancel = item.Qty
			}
		} else {
			qtyToCancel = item.Qty
		}

		// Загрузим модификаторы (нужны для line-total и для split-копирования).
		var itemMods []models.OrderItemModifier
		if err := tx.Where("order_item_id = ?", item.ID).Find(&itemMods).Error; err != nil {
			return err
		}
		modSum := decimal.Zero
		for _, m := range itemMods {
			modSum = decimal.Add(modSum, m.Price)
		}
		// Per-unit стоимость строки = price + сумма модификаторов.
		perUnit := decimal.Add(item.Price, modSum)
		lineDelta := decimal.Normalize(decimal.Mul(perUnit, effectivePortions(item.Unit, qtyToCancel, item.UnitSize)))

		if fullCancel {
			item.CancelledAt = &now
			item.CancelledBy = &canceller
			item.CancelReason = &reason
			item.UpdatedAt = now
			if err := tx.Save(&item).Error; err != nil {
				return err
			}
		} else {
			// 1) Создаём новый cancelled-row копию.
			split := models.OrderItem{
				ID:           uuid.NewString(),
				OrderID:      item.OrderID,
				MenuItemID:   item.MenuItemID,
				Name:         item.Name,
				Note:         item.Note,
				Qty:          qtyToCancel,
				Price:        item.Price,
				COGS:         item.COGS,
				Unit:         item.Unit,
				UnitSize:     item.UnitSize,
				CancelledAt:  &now,
				CancelledBy:  &canceller,
				CancelReason: &reason,
				// printed_at / served_at не копируем — отменяемая часть была
				// «непропечатанной» (иначе фронт обычно не даёт partial).
				CreatedAt: item.CreatedAt,
				UpdatedAt: now,
			}
			if err := tx.Create(&split).Error; err != nil {
				return err
			}
			// 2) Уменьшаем оригинальный row.
			item.Qty = decimal.Sub(item.Qty, qtyToCancel)
			item.UpdatedAt = now
			if err := tx.Model(&models.OrderItem{}).
				Where("id = ?", item.ID).
				Updates(map[string]any{
					"qty":        item.Qty,
					"updated_at": now,
				}).Error; err != nil {
				return err
			}
			// Модификаторы на split НЕ копируем — line-total split'а считается по
			// per-unit оригинала (включающему модификаторы), runner'у тоже
			// достаточно факта отмены X штук.
			item = split
		}

		// Recompute order total + cancelled_total.
		order.Total = decimal.Normalize(decimal.Sub(order.Total, lineDelta))
		order.TotalWithService = order.Total
		// cancelled_total — аккумулятор отменённой суммы (используется Z-отчётом,
		// P&L и Owner Dashboard). Растёт и при full-cancel, и при partial.
		prevCancelled := decimal.Zero
		if order.CancelledTotal != nil {
			prevCancelled = *order.CancelledTotal
		}
		newCancelled := decimal.Normalize(decimal.Add(prevCancelled, lineDelta))
		order.CancelledTotal = &newCancelled
		order.UpdatedAt = now
		if err := tx.Save(&order).Error; err != nil {
			return err
		}
		// Cancel runner — для повара. Передаём отменённый row (split при partial,
		// оригинал при full).
		if err := s.enqueueCancelRunners(tx, rid, &order, []models.OrderItem{item}, reason, now); err != nil {
			return err
		}

		// Auto-cancel order when last live item gone (v2.1.1).
		if fullCancel {
			var liveCount int64
			if err := tx.Model(&models.OrderItem{}).
				Where("order_id = ? AND cancelled_at IS NULL", order.ID).
				Count(&liveCount).Error; err != nil {
				return err
			}
			if liveCount == 0 && (order.Status == nil || (*order.Status != "cancelled" && *order.Status != "closed")) {
				cstatus := "cancelled"
				autoReason := "Все позиции отменены"
				cancellerID := actor.UserID
				order.Status = &cstatus
				order.CancelledAt = &now
				order.CancelledBy = &cancellerID
				order.CancelReason = &autoReason
				order.UpdatedAt = now
				if err := tx.Save(&order).Error; err != nil {
					return err
				}
				if order.TableID != nil && *order.TableID != "" {
					var activeCount int64
					if err := tx.Model(&models.Order{}).
						Where("restaurant_id = ? AND table_id = ?", rid, *order.TableID).
						Where("status IN ?", []string{"new", "open", "cooking", "ready", "served", "bill_requested"}).
						Where("id <> ?", order.ID).
						Count(&activeCount).Error; err != nil {
						return err
					}
					if activeCount == 0 {
						if err := tx.Model(&models.Table{}).
							Where("id = ? AND restaurant_id = ?", *order.TableID, rid).
							Updates(map[string]any{
								"status":           "free",
								"current_order_id": nil,
								"opened_at":        nil,
								"updated_at":       now,
							}).Error; err != nil {
							return err
						}
					}
				}
			}
		}
		out = &item
		return nil
	})
	if err != nil {
		return nil, err
	}
	if s.pub != nil {
		buf := NewBuffer()
		// Обогащаем событие данными позиции — KDS показывает отменённое блюдо
		// карточкой (с именем/кол-вом) и баннером «Блюдо «X» отменено · Заказ #N».
		voidPayload := map[string]any{
			"order_id":     orderID,
			"item_id":      itemID,
			"action":       "cancel",
			"order_number": voidedOrderNumber,
		}
		if out != nil {
			voidPayload["name"] = deref(out.Name)
			voidPayload["qty"] = out.Qty.String()
		}
		buf.Add(EventOrderItemVoided, voidPayload)
		// Дублируем как order.updated — UI слушает этот канал, чтобы
		// перечитать заказ после partial-cancel/merge.
		buf.Add(EventOrderUpdated, map[string]any{
			"id":     orderID,
			"action": "item.cancel",
		})
		s.pub.Flush(ctx, rid, buf)
	}
	return out, nil
}

// MarkItemServed — sets served_at=now.
func (s *OrdersService) MarkItemServed(ctx context.Context, orderID, itemID string) (*models.OrderItem, error) {
	return s.setItemServed(ctx, orderID, itemID, true)
}

// UnmarkItemServed — clears served_at.
func (s *OrdersService) UnmarkItemServed(ctx context.Context, orderID, itemID string) (*models.OrderItem, error) {
	return s.setItemServed(ctx, orderID, itemID, false)
}

func (s *OrdersService) setItemServed(ctx context.Context, orderID, itemID string, served bool) (*models.OrderItem, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	var out *models.OrderItem
	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)
		// Order belongs to tenant.
		var cnt int64
		if err := tx.Model(&models.Order{}).
			Where("restaurant_id = ? AND id = ?", rid, orderID).
			Count(&cnt).Error; err != nil {
			return err
		}
		if cnt == 0 {
			return apperrors.ErrNotFound
		}
		var item models.OrderItem
		if err := tx.Where("id = ? AND order_id = ?", itemID, orderID).
			First(&item).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return apperrors.ErrNotFound
			}
			return err
		}
		now := time.Now().UTC()
		if served {
			item.ServedAt = &now
		} else {
			item.ServedAt = nil
		}
		item.UpdatedAt = now
		if err := tx.Save(&item).Error; err != nil {
			return err
		}
		out = &item
		return nil
	})
	if err != nil {
		return nil, err
	}
	if s.pub != nil {
		buf := NewBuffer()
		action := "item.served"
		if !served {
			action = "item.unserved"
		}
		buf.Add(EventOrderUpdated, map[string]any{
			"order_id": orderID,
			"item_id":  itemID,
			"action":   action,
		})
		s.pub.Flush(ctx, rid, buf)
	}
	return out, nil
}

// ClaimPrintInput — body для claim-print эндпоинтов.
type ClaimPrintInput struct {
	Station   string `json:"station,omitempty"`
	ClaimedBy string `json:"claimed_by"`
}

// ClaimPrintResult — что вернули.
type ClaimPrintResult struct {
	Claimed bool             `json:"claimed"`
	Item    models.OrderItem `json:"item"`
}

// ClaimPrint — атомарно ставит print_claimed_at=now если оно NULL.
// Если station указан — проверяем что menu_item.station совпадает.
func (s *OrdersService) ClaimPrint(ctx context.Context, orderID, itemID string, in ClaimPrintInput) (*ClaimPrintResult, error) {
	return s.claimPrintGeneric(ctx, orderID, itemID, in, false)
}

// ReleasePrint — clears print_claimed_at.
func (s *OrdersService) ReleasePrint(ctx context.Context, orderID, itemID string) (*models.OrderItem, error) {
	return s.releasePrintGeneric(ctx, orderID, itemID, false)
}

// ClaimCancelPrint — то же для cancel_print_claimed_at.
func (s *OrdersService) ClaimCancelPrint(ctx context.Context, orderID, itemID string, in ClaimPrintInput) (*ClaimPrintResult, error) {
	return s.claimPrintGeneric(ctx, orderID, itemID, in, true)
}

// ReleaseCancelPrint — clears cancel_print_claimed_at.
func (s *OrdersService) ReleaseCancelPrint(ctx context.Context, orderID, itemID string) (*models.OrderItem, error) {
	return s.releasePrintGeneric(ctx, orderID, itemID, true)
}

func (s *OrdersService) claimPrintGeneric(ctx context.Context, orderID, itemID string, in ClaimPrintInput, cancel bool) (*ClaimPrintResult, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	if in.ClaimedBy == "" {
		return nil, apperrors.Wrap("VALIDATION", "claimed_by is required", nil)
	}
	colAt := "print_claimed_at"
	colBy := "print_claimed_by"
	if cancel {
		colAt = "cancel_print_claimed_at"
		colBy = "cancel_print_claimed_by"
	}

	var out ClaimPrintResult
	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)
		var cnt int64
		if err := tx.Model(&models.Order{}).
			Where("restaurant_id = ? AND id = ?", rid, orderID).
			Count(&cnt).Error; err != nil {
			return err
		}
		if cnt == 0 {
			return apperrors.ErrNotFound
		}
		// Atomic UPDATE ... WHERE col IS NULL.
		now := time.Now().UTC()
		res := tx.Model(&models.OrderItem{}).
			Where("id = ? AND order_id = ? AND "+colAt+" IS NULL", itemID, orderID).
			Updates(map[string]any{
				colAt:        now,
				colBy:        in.ClaimedBy,
				"updated_at": now,
			})
		if res.Error != nil {
			return res.Error
		}
		out.Claimed = res.RowsAffected == 1

		// Reload item для отдачи.
		var item models.OrderItem
		if err := tx.Where("id = ? AND order_id = ?", itemID, orderID).
			First(&item).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return apperrors.ErrNotFound
			}
			return err
		}
		// Если station указан — провалидируем по menu_item.
		if in.Station != "" && item.MenuItemID != nil {
			var mi models.MenuItem
			if err := tx.Where("restaurant_id = ? AND id = ?", rid, *item.MenuItemID).
				First(&mi).Error; err == nil {
				if mi.Station != nil && *mi.Station != in.Station {
					return apperrors.Wrap("VALIDATION", "station mismatch for this item", nil)
				}
			}
		}
		out.Item = item
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &out, nil
}

func (s *OrdersService) releasePrintGeneric(ctx context.Context, orderID, itemID string, cancel bool) (*models.OrderItem, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	colAt := "print_claimed_at"
	colBy := "print_claimed_by"
	if cancel {
		colAt = "cancel_print_claimed_at"
		colBy = "cancel_print_claimed_by"
	}

	var out *models.OrderItem
	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)
		var cnt int64
		if err := tx.Model(&models.Order{}).
			Where("restaurant_id = ? AND id = ?", rid, orderID).
			Count(&cnt).Error; err != nil {
			return err
		}
		if cnt == 0 {
			return apperrors.ErrNotFound
		}
		now := time.Now().UTC()
		if err := tx.Model(&models.OrderItem{}).
			Where("id = ? AND order_id = ?", itemID, orderID).
			Updates(map[string]any{
				colAt:        gorm.Expr("NULL"),
				colBy:        gorm.Expr("NULL"),
				"updated_at": now,
			}).Error; err != nil {
			return err
		}
		var item models.OrderItem
		if err := tx.Where("id = ? AND order_id = ?", itemID, orderID).
			First(&item).Error; err != nil {
			return err
		}
		out = &item
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// ═══════════════════════════════════════════════════════════════════════════
// Order operations: reopen, move-table
// ═══════════════════════════════════════════════════════════════════════════

// ReopenOrderInput — body POST /orders/{id}/reopen.
type ReopenOrderInput struct {
	Reason *string `json:"reason,omitempty"`
}

// Reopen — закрытый заказ возвращается в "served".
//
// Финансовый след закрытия СТОРНИРУЕТСЯ (v3.16.31): revenue-FO удаляются,
// балансы счетов возвращаются, агрегаты смены (cash/card_revenue,
// orders_count, avg_check) уменьшаются. Иначе смена продолжала показывать
// выручку по заказу, который больше не закрыт, а повторный /close после
// редактирования не постил новую сумму (idempotency по source_ref).
// stock_movements остаются — блюда физически приготовлены; повторный /close
// не спишет склад второй раз (идемпотентность по description=order:{id}).
func (s *OrdersService) Reopen(ctx context.Context, orderID string, in ReopenOrderInput) (*models.Order, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	// Переоткрытие закрытого = редактирование заказа — по праву orders.edit
	// (по умолчанию выключено; выдаётся в матрице доступов).
	if err := s.requirePerm(ctx, "orders.edit"); err != nil {
		return nil, err
	}
	var out *models.Order
	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)
		var order models.Order
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("restaurant_id = ? AND id = ?", rid, orderID).
			First(&order).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return apperrors.ErrNotFound
			}
			return err
		}
		if order.Status == nil || *order.Status != "closed" {
			return apperrors.Wrap("CONFLICT", "only closed orders can be reopened", nil)
		}
		now := time.Now().UTC()

		if err := s.reverseCloseFinancials(tx, rid, &order, now); err != nil {
			return err
		}

		served := "served"
		order.Status = &served
		order.ClosedAt = nil
		order.UpdatedAt = now
		if err := tx.Save(&order).Error; err != nil {
			return err
		}
		out = &order
		return nil
	})
	if err != nil {
		return nil, err
	}
	if s.pub != nil {
		buf := NewBuffer()
		buf.Add(EventOrderUpdated, map[string]any{"id": orderID, "action": "reopen"})
		s.pub.Flush(ctx, rid, buf)
	}
	return out, nil
}

// reverseCloseFinancials — сторно финансового следа Close при reopen:
// удаляет revenue-FO заказа (source_ref=order:{id}), возвращает балансы
// счетов и уменьшает агрегаты смены, в которую выручка была запощена.
// После этого повторный /close пройдёт check alreadyPosted и запостит
// выручку заново — уже по новой сумме.
func (s *OrdersService) reverseCloseFinancials(tx *gorm.DB, rid string, order *models.Order, now time.Time) error {
	opSourceRef := "order:" + order.ID
	var revOps []models.FinancialOperation
	if err := tx.Where("restaurant_id = ? AND source_ref = ? AND category = ?", rid, opSourceRef, "revenue").
		Find(&revOps).Error; err != nil {
		return err
	}
	if len(revOps) == 0 {
		return nil
	}

	// 1. Дебетуем счета — зеркало creditAccount из Close.
	for _, op := range revOps {
		if op.AccountID == nil || *op.AccountID == "" {
			continue
		}
		if err := tx.Model(&models.FinancialAccount{}).
			Where("restaurant_id = ? AND id = ?", rid, *op.AccountID).
			Updates(map[string]any{
				"balance":    gorm.Expr("balance - ?", op.Amount),
				"updated_at": now,
			}).Error; err != nil {
			return err
		}
	}

	// 2. Агрегаты смены, куда выручка была запощена (FO.ShiftID, не текущая).
	shiftID := ""
	if revOps[0].ShiftID != nil {
		shiftID = *revOps[0].ShiftID
	}
	if shiftID == "" && order.ShiftID != nil {
		shiftID = *order.ShiftID
	}
	if shiftID != "" {
		var shift models.CashShift
		err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("restaurant_id = ? AND id = ?", rid, shiftID).
			First(&shift).Error
		switch {
		case err == nil:
			// Метод платежа per-сумма: payments JSON (split), иначе
			// order.payment_method на всю сумму revenue-FO. Симметрично
			// тому, как Close инкрементил агрегаты.
			type pay struct {
				Method string
				Amount decimal.Decimal
			}
			var pays []pay
			if len(order.Payments) > 0 {
				var arr []struct {
					Method string `json:"method"`
					Amount string `json:"amount"`
				}
				if jsonUnmarshal(order.Payments, &arr) == nil {
					for _, p := range arr {
						if a, perr := decimal.FromString(p.Amount); perr == nil {
							pays = append(pays, pay{Method: p.Method, Amount: decimal.Normalize(a)})
						}
					}
				}
			}
			if len(pays) == 0 {
				m := ""
				if order.PaymentMethod != nil {
					m = *order.PaymentMethod
				}
				total := decimal.Zero
				for _, op := range revOps {
					total = decimal.Add(total, op.Amount)
				}
				pays = append(pays, pay{Method: m, Amount: total})
			}
			for _, p := range pays {
				switch p.Method {
				case "cash":
					shift.CashRevenue = decimal.Normalize(decimal.Sub(shift.CashRevenue, p.Amount))
				case "card":
					shift.CardRevenue = decimal.Normalize(decimal.Sub(shift.CardRevenue, p.Amount))
				}
			}
			cnt := 0
			if shift.OrdersCount != nil {
				cnt = *shift.OrdersCount
			}
			if cnt > 0 {
				cnt--
			}
			shift.OrdersCount = &cnt
			if cnt > 0 {
				total := decimal.Add(shift.CashRevenue, shift.CardRevenue)
				shift.AvgCheck = decimal.Normalize(decimal.DivRound(total, decimal.FromInt(int64(cnt))))
			} else {
				shift.AvgCheck = decimal.Zero
			}
			shift.UpdatedAt = now
			if err := tx.Save(&shift).Error; err != nil {
				return err
			}
		case errors.Is(err, gorm.ErrRecordNotFound):
			// Смена удалена — сторнируем только FO и балансы.
		default:
			return err
		}
	}

	// 3. Удаляем revenue-FO (через хуки — попадает в audit_log). После этого
	// alreadyPosted-check в Close снова false → выручка запостится заново.
	for i := range revOps {
		if err := tx.Delete(&revOps[i]).Error; err != nil {
			return err
		}
	}
	return nil
}

// MoveTableInput — body POST /orders/{id}/table.
type MoveTableInput struct {
	NewTableID string `json:"new_table_id"`
}

// MoveTable — clearer alias для Transfer(table_id=).
func (s *OrdersService) MoveTable(ctx context.Context, orderID string, in MoveTableInput) (*models.Order, error) {
	if in.NewTableID == "" {
		return nil, apperrors.Wrap("VALIDATION", "new_table_id is required", nil)
	}
	tid := in.NewTableID
	return s.Transfer(ctx, orderID, TransferInput{TableID: &tid})
}

// ═══════════════════════════════════════════════════════════════════════════
// Background jobs: auto-ready, cleanup-orphans
// ═══════════════════════════════════════════════════════════════════════════

// AutoReadyResult — что вернули.
type AutoReadyResult struct {
	OrderIDs []string `json:"order_ids"`
	Updated  int      `json:"updated"`
}

// AutoReadyCheck — ищет заказы status='cooking' с expected_ready_at < now,
// переводит их в 'ready', ready_at=now. Возвращает список обновлённых.
func (s *OrdersService) AutoReadyCheck(ctx context.Context) (*AutoReadyResult, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	var res AutoReadyResult
	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)
		now := time.Now().UTC()
		var orders []models.Order
		if err := tx.Where("restaurant_id = ? AND status = ? AND expected_ready_at IS NOT NULL AND expected_ready_at < ?",
			rid, "cooking", now).
			Find(&orders).Error; err != nil {
			return err
		}
		for _, o := range orders {
			ready := "ready"
			if err := tx.Model(&models.Order{}).
				Where("id = ?", o.ID).
				Updates(map[string]any{
					"status":     &ready,
					"ready_at":   now,
					"updated_at": now,
				}).Error; err != nil {
				return err
			}
			res.OrderIDs = append(res.OrderIDs, o.ID)
		}
		res.Updated = len(res.OrderIDs)
		return nil
	})
	if err != nil {
		return nil, err
	}
	if s.pub != nil && res.Updated > 0 {
		buf := NewBuffer()
		for _, id := range res.OrderIDs {
			buf.Add(EventOrderUpdated, map[string]any{"id": id, "action": "auto-ready"})
		}
		s.pub.Flush(ctx, rid, buf)
	}
	return &res, nil
}

// CleanupOrphansResult — что вернули.
type CleanupOrphansResult struct {
	Cancelled int      `json:"cancelled"`
	OrderIDs  []string `json:"order_ids"`
}

// SetItemNoteInput — body PATCH /orders/{id}/items/{itemId}/note.
// note=nil или пустая строка после trim → очищает комментарий.
type SetItemNoteInput struct {
	Note *string `json:"note"`
}

// SetItemNote — обновляет комментарий к позиции заказа. Используется
// официантом для передачи кухне особых пожеланий («без лука», «medium-rare»).
// Печатается в runner и пре-чеке.
func (s *OrdersService) SetItemNote(ctx context.Context, orderID, itemID string, in SetItemNoteInput) (*models.OrderItem, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	// Normalize: trim, empty → nil.
	var v *string
	if in.Note != nil {
		t := strings.TrimSpace(*in.Note)
		if t != "" {
			v = &t
		}
	}

	var out *models.OrderItem
	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)
		// Verify order belongs to tenant.
		var cnt int64
		if err := tx.Model(&models.Order{}).
			Where("restaurant_id = ? AND id = ?", rid, orderID).
			Count(&cnt).Error; err != nil {
			return err
		}
		if cnt == 0 {
			return apperrors.ErrNotFound
		}
		var item models.OrderItem
		if err := tx.Where("id = ? AND order_id = ?", itemID, orderID).
			First(&item).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return apperrors.ErrNotFound
			}
			return err
		}
		now := time.Now().UTC()
		item.Note = v
		item.UpdatedAt = now
		if err := tx.Model(&models.OrderItem{}).
			Where("id = ?", item.ID).
			Updates(map[string]any{
				"note":       v,
				"updated_at": now,
			}).Error; err != nil {
			return err
		}
		out = &item
		return nil
	})
	if err != nil {
		return nil, err
	}
	if s.pub != nil {
		buf := NewBuffer()
		buf.Add(EventOrderUpdated, map[string]any{
			"order_id": orderID,
			"item_id":  itemID,
			"action":   "item.note_updated",
		})
		s.pub.Flush(ctx, rid, buf)
	}
	return out, nil
}

// CleanupOrphanOrders — отменяет заказы со status in ('new','cooking','ready')
// старше 24ч (по updated_at). Reason='stale'.
func (s *OrdersService) CleanupOrphanOrders(ctx context.Context) (*CleanupOrphansResult, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	actor, _ := audit.ActorFromContext(ctx)
	var res CleanupOrphansResult
	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)
		cutoff := time.Now().UTC().Add(-24 * time.Hour)
		var orders []models.Order
		if err := tx.Where("restaurant_id = ? AND status IN ? AND updated_at < ?",
			rid, []string{"new", "cooking", "ready", "open"}, cutoff).
			Find(&orders).Error; err != nil {
			return err
		}
		now := time.Now().UTC()
		cancelled := "cancelled"
		reason := "stale"
		canceller := actor.UserID
		for _, o := range orders {
			oCopy := o
			oCopy.Status = &cancelled
			oCopy.CancelledAt = &now
			oCopy.CancelledBy = &canceller
			oCopy.CancelReason = &reason
			ctotal := o.Total
			oCopy.CancelledTotal = &ctotal
			oCopy.UpdatedAt = now
			if err := tx.Save(&oCopy).Error; err != nil {
				return err
			}
			res.OrderIDs = append(res.OrderIDs, o.ID)
		}
		res.Cancelled = len(res.OrderIDs)
		return nil
	})
	if err != nil {
		return nil, err
	}
	if s.pub != nil && res.Cancelled > 0 {
		buf := NewBuffer()
		for _, id := range res.OrderIDs {
			buf.Add(EventOrderCancelled, map[string]any{"id": id, "reason": "stale"})
		}
		s.pub.Flush(ctx, rid, buf)
	}
	return &res, nil
}
