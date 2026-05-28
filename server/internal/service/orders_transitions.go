// orders_transitions — Phase 18 F16/F19:
//   - PatchOrder (partial PATCH /orders/{id}) для не-терминальных полей
//     (guests_count, comment, customer_id).
//   - StartCooking / MarkReady / MarkServed — специализированные эндпоинты
//     для переходов статуса. Заменяют no-op'ы на frontend.
package service

import (
	"context"
	"errors"
	"time"

	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/db/models"
	apperrors "github.com/restos/restos-v4/server/internal/pkg/errors"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
	"github.com/restos/restos-v4/server/internal/repo"
)

// OrderPatchInput — body PATCH /api/v1/orders/{id}.
// Только не-терминальные поля. Переходы статуса — через специализированные эндпоинты.
type OrderPatchInput struct {
	GuestsCount *int    `json:"guests_count,omitempty"`
	Comment     *string `json:"comment,omitempty"`
	CustomerID  *string `json:"customer_id,omitempty"`
}

// PatchOrder — частичное обновление заказа. Допустимо только для status NOT IN
// ('closed', 'cancelled').
func (s *OrdersService) PatchOrder(ctx context.Context, id string, in OrderPatchInput) (*models.Order, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	var out models.Order
	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)
		var order models.Order
		if err := tx.Where("restaurant_id = ? AND id = ?", rid, id).First(&order).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return apperrors.ErrNotFound
			}
			return err
		}
		if order.Status != nil && (*order.Status == "closed" || *order.Status == "cancelled") {
			return apperrors.Wrap("CONFLICT", "order is terminal (closed/cancelled)", nil)
		}
		updates := map[string]any{"updated_at": time.Now().UTC()}
		if in.GuestsCount != nil {
			updates["guests_count"] = *in.GuestsCount
		}
		if in.Comment != nil {
			updates["comment"] = *in.Comment
		}
		if in.CustomerID != nil {
			updates["customer_id"] = *in.CustomerID
		}
		if len(updates) == 1 {
			out = order
			return nil
		}
		if err := tx.Model(&order).Updates(updates).Error; err != nil {
			return err
		}
		if err := tx.Where("restaurant_id = ? AND id = ?", rid, id).First(&out).Error; err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// StartCookingInput — body POST /api/v1/orders/{id}/start-cooking.
type StartCookingInput struct {
	CashierID *string `json:"cashier_id,omitempty"`
}

// StartCooking — переход new/open → cooking. Сохраняет kitchen_started_at=now.
func (s *OrdersService) StartCooking(ctx context.Context, id string, in StartCookingInput) (*models.Order, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	_ = in // cashier_id принимается, но не пишется в order (нет колонки)
	var out models.Order
	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)
		var order models.Order
		if err := tx.Where("restaurant_id = ? AND id = ?", rid, id).First(&order).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return apperrors.ErrNotFound
			}
			return err
		}
		if order.Status != nil && (*order.Status == "closed" || *order.Status == "cancelled") {
			return apperrors.Wrap("CONFLICT", "order is terminal", nil)
		}
		now := time.Now().UTC()
		cooking := "cooking"
		if err := tx.Model(&order).Updates(map[string]any{
			"status":             cooking,
			"kitchen_started_at": now,
			"updated_at":         now,
		}).Error; err != nil {
			return err
		}
		if err := tx.Where("restaurant_id = ? AND id = ?", rid, id).First(&out).Error; err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	if s.pub != nil {
		buf := NewBuffer()
		buf.Add(EventOrderUpdated, map[string]any{"id": id, "action": "cooking"})
		s.pub.Flush(ctx, rid, buf)
	}
	return &out, nil
}

// MarkReady — переход cooking → ready. Сохраняет ready_at=now.
func (s *OrdersService) MarkReady(ctx context.Context, id string) (*models.Order, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	var out models.Order
	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)
		var order models.Order
		if err := tx.Where("restaurant_id = ? AND id = ?", rid, id).First(&order).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return apperrors.ErrNotFound
			}
			return err
		}
		if order.Status != nil && (*order.Status == "closed" || *order.Status == "cancelled") {
			return apperrors.Wrap("CONFLICT", "order is terminal", nil)
		}
		now := time.Now().UTC()
		ready := "ready"
		if err := tx.Model(&order).Updates(map[string]any{
			"status":     ready,
			"ready_at":   now,
			"updated_at": now,
		}).Error; err != nil {
			return err
		}
		if err := tx.Where("restaurant_id = ? AND id = ?", rid, id).First(&out).Error; err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	if s.pub != nil {
		buf := NewBuffer()
		buf.Add(EventOrderUpdated, map[string]any{"id": id, "action": "ready"})
		s.pub.Flush(ctx, rid, buf)
	}
	return &out, nil
}

// MarkServed — переход ready → served.
func (s *OrdersService) MarkServed(ctx context.Context, id string) (*models.Order, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	var out models.Order
	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)
		var order models.Order
		if err := tx.Where("restaurant_id = ? AND id = ?", rid, id).First(&order).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return apperrors.ErrNotFound
			}
			return err
		}
		if order.Status != nil && (*order.Status == "closed" || *order.Status == "cancelled") {
			return apperrors.Wrap("CONFLICT", "order is terminal", nil)
		}
		served := "served"
		if err := tx.Model(&order).Updates(map[string]any{
			"status":     served,
			"updated_at": time.Now().UTC(),
		}).Error; err != nil {
			return err
		}
		if err := tx.Where("restaurant_id = ? AND id = ?", rid, id).First(&out).Error; err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	if s.pub != nil {
		buf := NewBuffer()
		buf.Add(EventOrderUpdated, map[string]any{"id": id, "action": "served"})
		s.pub.Flush(ctx, rid, buf)
	}
	return &out, nil
}
