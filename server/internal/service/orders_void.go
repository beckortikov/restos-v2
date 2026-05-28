package service

import (
	"context"
	"errors"
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

// CancelOrderInput — body POST /api/v1/orders/{id}/cancel.
type CancelOrderInput struct {
	Reason string `json:"reason"`
}

// VoidItemInput — body POST /api/v1/orders/{id}/items/{itemId}/void.
type VoidItemInput struct {
	Reason     string `json:"reason"`
	ApprovedBy string `json:"approved_by"` // user_id manager'а
}

// Cancel отменяет открытый заказ целиком.
//
// Контракт:
//   - status переходит из {open,new,bill_requested} → cancelled.
//   - cancelled_total = snapshot текущего total (для отчётности).
//   - Если заказ уже closed — CONFLICT.
//   - Stock back-deduction НЕ делаем: на момент cancel stock ещё не списан
//     (списание происходит в close_order). Если заказ был с ингредиентами на
//     полпути (cooking → ready), backfill stock — отдельная фича Phase 4.
func (s *OrdersService) Cancel(ctx context.Context, orderID string, in CancelOrderInput) (*models.Order, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	if in.Reason == "" {
		return nil, apperrors.Wrap("VALIDATION", "reason is required", nil)
	}
	actor, _ := audit.ActorFromContext(ctx)

	var cancelled *models.Order
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
		if order.Status != nil && *order.Status == "closed" {
			return apperrors.Wrap("CONFLICT", "cannot cancel closed order", nil)
		}
		if order.Status != nil && *order.Status == "cancelled" {
			return apperrors.Wrap("CONFLICT", "order already cancelled", nil)
		}

		now := time.Now().UTC()
		cstatus := "cancelled"
		reason := in.Reason
		canceller := actor.UserID
		ctotal := order.Total
		order.Status = &cstatus
		order.CancelledAt = &now
		order.CancelledBy = &canceller
		order.CancelReason = &reason
		order.CancelledTotal = &ctotal
		order.UpdatedAt = now
		if err := tx.Save(&order).Error; err != nil {
			return err
		}

		// Cancel-runner на станции — для всех не-отменённых items заказа.
		var liveItems []models.OrderItem
		if err := tx.Where("order_id = ? AND cancelled_at IS NULL", order.ID).
			Find(&liveItems).Error; err != nil {
			return err
		}
		if err := s.enqueueCancelRunners(tx, rid, &order, liveItems, in.Reason, now); err != nil {
			return err
		}

		cancelled = &order
		return nil
	})
	if err != nil {
		return nil, err
	}
	if s.pub != nil {
		buf := NewBuffer()
		buf.Add(EventOrderCancelled, map[string]any{"id": cancelled.ID, "reason": in.Reason})
		s.pub.Flush(ctx, rid, buf)
	}
	return cancelled, nil
}

// VoidItem отменяет одну позицию открытого заказа.
//
// Контракт:
//   - Заказ должен быть open|new|bill_requested.
//   - order_items.cancelled_at/by/reason проставляются.
//   - В order_voids создаётся запись для аудита (с снапшотом name/qty/price).
//   - order.total пересчитывается (минус price*qty).
//   - approved_by — манагер, который разрешил. Сохраняем оба user_id.
func (s *OrdersService) VoidItem(ctx context.Context, orderID, itemID string, in VoidItemInput) (*models.OrderItem, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	if in.Reason == "" {
		return nil, apperrors.Wrap("VALIDATION", "reason is required", nil)
	}
	actor, _ := audit.ActorFromContext(ctx)

	var voided *models.OrderItem
	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)

		// 1. Lock order.
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
			return apperrors.Wrap("CONFLICT", "cannot void item in closed/cancelled order", nil)
		}

		// 2. Item with FK isolation (order_items не имеет restaurant_id, проверяем order_id).
		var item models.OrderItem
		if err := tx.Where("id = ? AND order_id = ?", itemID, orderID).
			First(&item).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return apperrors.ErrNotFound
			}
			return err
		}
		if item.CancelledAt != nil {
			return apperrors.Wrap("CONFLICT", "item already voided", nil)
		}

		now := time.Now().UTC()
		reason := in.Reason
		canceller := actor.UserID
		item.CancelledAt = &now
		item.CancelledBy = &canceller
		item.CancelReason = &reason
		item.UpdatedAt = now
		if err := tx.Save(&item).Error; err != nil {
			return err
		}

		// 3. Audit-friendly запись в order_voids (видна Manager-у).
		voidID := uuid.NewString()
		oid := orderID
		var itemQtyInt int
		if !item.Qty.IsZero() {
			f, _ := item.Qty.Float64()
			itemQtyInt = int(f) // schema хранит int — округление в большую сторону не делаем
		}
		approvedBy := in.ApprovedBy
		createdBy := actor.UserID
		v := &models.OrderVoid{
			ID:           voidID,
			OrderID:      &oid,
			ItemName:     item.Name,
			ItemQty:      &itemQtyInt,
			ItemPrice:    item.Price,
			Reason:       &reason,
			ApprovedBy:   &approvedBy,
			CreatedBy:    &createdBy,
			RestaurantID: &rid,
			CreatedAt:    now,
		}
		if err := tx.Create(v).Error; err != nil {
			return err
		}

		// 4. Recompute order.total: вычесть line_total.
		lineTotal := decimal.Normalize(decimal.Mul(item.Price, item.Qty))
		order.Total = decimal.Normalize(decimal.Sub(order.Total, lineTotal))
		order.TotalWithService = order.Total
		order.UpdatedAt = now
		if err := tx.Save(&order).Error; err != nil {
			return err
		}

		// 5. Cancel-runner на станцию — повар видит «отменить готовку».
		// Эмитим всегда: если повар ещё не начал — просто игнорирует, если
		// начал — успеет остановиться. Лишний бумажный квиток < риска
		// испорченной готовки. Heuristic по item.PrintedAt появится в Phase 5
		// вместе с kitchen_status.
		if err := s.enqueueCancelRunners(tx, rid, &order, []models.OrderItem{item}, in.Reason, now); err != nil {
			return err
		}

		voided = &item
		return nil
	})
	if err != nil {
		return nil, err
	}
	if s.pub != nil {
		buf := NewBuffer()
		buf.Add(EventOrderItemVoided, map[string]any{
			"order_id": orderID,
			"item_id":  itemID,
			"reason":   in.Reason,
		})
		s.pub.Flush(ctx, rid, buf)
	}
	return voided, nil
}
