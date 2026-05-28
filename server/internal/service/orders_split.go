package service

import (
	"context"
	"encoding/json"
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

// SplitInput — body POST /api/v1/orders/{id}/split.
//
// Один из двух режимов:
//   - mode="equal", count=N → делим total на N равных частей.
//   - mode="by_items", splits=[{item_ids:[...]}, ...] → распределяем позиции
//     заказа по N split'ам. Все item_ids должны быть из этого заказа и не
//     повторяться между splits. Items, не указанные ни в одном split, остаются
//     в исходном заказе.
type SplitInput struct {
	Mode   string      `json:"mode"`
	Count  int         `json:"count,omitempty"`  // для equal
	Splits []SplitPart `json:"splits,omitempty"` // для by_items
}

// SplitPart — одна часть by_items split'а.
//
// Поддерживаются два формата:
//   - "item_ids":["uuid1","uuid2"]                       — целиком указанные позиции
//   - "items":[{"order_item_id":"uuid","qty":"0.5"},...] — частичные доли, qty опционально
//
// Если задано Items — оно имеет приоритет; ItemIDs игнорируется.
type SplitPart struct {
	ItemIDs []string             `json:"item_ids,omitempty"`
	Items   []SplitPartItemInput `json:"items,omitempty"`
}

// SplitPartItemInput — позиция в split-части с опциональным частичным qty.
//
// Если Qty не задан — позиция уходит в эту часть целиком (по полному item.qty).
// Если Qty < item.qty — текущее поведение: рассчитываем сумму как qty*price,
// но НЕ модифицируем исходный order_item. Для частичных qty фронт обязан
// гарантировать, что суммарный qty по всем частям ≤ item.qty.
//
// TODO(split): полноценный «разрез» одного order_item на N частей (с уменьшением
// исходного qty и созданием нового item) — реализовать после согласования UX.
type SplitPartItemInput struct {
	OrderItemID string  `json:"order_item_id"`
	Qty         *string `json:"qty,omitempty"`
}

// SplitResult — что вернули клиенту: order + созданные splits.
type SplitResult struct {
	Order  models.Order        `json:"order"`
	Splits []models.OrderSplit `json:"splits"`
}

// Split реализует split. Транзакционно. Только для open|new|bill_requested.
func (s *OrdersService) Split(ctx context.Context, orderID string, in SplitInput) (*SplitResult, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	if in.Mode != "equal" && in.Mode != "by_items" {
		return nil, apperrors.Wrap("VALIDATION", "mode must be equal|by_items", nil)
	}
	if in.Mode == "equal" && in.Count < 2 {
		return nil, apperrors.Wrap("VALIDATION", "count must be >= 2 for equal split", nil)
	}
	if in.Mode == "by_items" && len(in.Splits) < 2 {
		return nil, apperrors.Wrap("VALIDATION", "splits must have >= 2 parts for by_items", nil)
	}
	actor, _ := audit.ActorFromContext(ctx)

	var result *SplitResult
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
			return apperrors.Wrap("CONFLICT", "cannot split closed/cancelled order", nil)
		}
		if order.IsSplit != nil && *order.IsSplit {
			return apperrors.Wrap("CONFLICT", "order is already split", nil)
		}

		// 2. Грузим items (для by_items: проверка ownership и подсчёт total).
		var items []models.OrderItem
		if err := tx.Where("order_id = ? AND cancelled_at IS NULL", orderID).
			Find(&items).Error; err != nil {
			return err
		}
		itemByID := make(map[string]models.OrderItem, len(items))
		for _, it := range items {
			itemByID[it.ID] = it
		}

		now := time.Now().UTC()
		paidBy := actor.UserID
		var splits []models.OrderSplit

		switch in.Mode {
		case "equal":
			// Делим total на N равных частей. Остаток (если есть) — на последнюю часть.
			n := in.Count
			share := decimal.Normalize(decimal.DivRound(order.Total, decimal.FromInt(int64(n))))
			sum := decimal.Zero
			for i := 0; i < n; i++ {
				partTotal := share
				if i == n-1 {
					// Последняя часть = order.Total - sum (компенсирует rounding).
					partTotal = decimal.Normalize(decimal.Sub(order.Total, sum))
				}
				splitNum := i + 1
				splits = append(splits, models.OrderSplit{
					ID:           uuid.NewString(),
					OrderID:      &orderID,
					SplitNumber:  &splitNum,
					SplitType:    ptrString("equal"),
					Subtotal:     partTotal,
					Total:        partTotal,
					Status:       ptrString("pending"),
					PaidBy:       &paidBy,
					RestaurantID: &rid,
					CreatedAt:    now,
				})
				sum = decimal.Add(sum, share)
			}

		case "by_items":
			// Каждая часть — список item_ids ИЛИ items с qty.
			// Для item_ids: позиция уходит в эту часть целиком; дубли запрещены.
			// Для items: позиция может появиться в нескольких частях (частичный qty);
			// проверяем суммарный qty ≤ item.qty.
			seen := make(map[string]bool)               // item_id → встречен (для item_ids)
			usedQty := make(map[string]decimal.Decimal) // item_id → накопленный qty (для items)
			for partIdx, part := range in.Splits {
				hasIDs := len(part.ItemIDs) > 0
				hasItems := len(part.Items) > 0
				if !hasIDs && !hasItems {
					return apperrors.Wrap("VALIDATION", "split part must have at least one item", nil)
				}
				partTotal := decimal.Zero
				partItems := make([]map[string]any, 0)
				// items имеет приоритет над item_ids, если оба заданы.
				if hasItems {
					for _, line := range part.Items {
						if line.OrderItemID == "" {
							return apperrors.Wrap("VALIDATION", "order_item_id is required", nil)
						}
						it, ok := itemByID[line.OrderItemID]
						if !ok {
							return apperrors.Wrap("VALIDATION", "item not in this order: "+line.OrderItemID, nil)
						}
						q := it.Qty
						if line.Qty != nil {
							parsed, err := decimal.FromString(*line.Qty)
							if err != nil {
								return apperrors.Wrap("VALIDATION", "bad qty for "+line.OrderItemID, err)
							}
							q = parsed
						}
						prev := usedQty[line.OrderItemID]
						sum := decimal.Add(prev, q)
						if sum.Cmp(it.Qty) > 0 {
							return apperrors.Wrap("VALIDATION", "split qty exceeds order item qty for "+line.OrderItemID, nil)
						}
						usedQty[line.OrderItemID] = sum
						lineAmt := decimal.Normalize(decimal.Mul(it.Price, q))
						partTotal = decimal.Add(partTotal, lineAmt)
						itName := ""
						if it.Name != nil {
							itName = *it.Name
						}
						partItems = append(partItems, map[string]any{
							"id":    it.ID,
							"name":  itName,
							"qty":   q.String(),
							"price": it.Price.String(),
							"line":  lineAmt.String(),
						})
					}
				} else {
					for _, iid := range part.ItemIDs {
						it, ok := itemByID[iid]
						if !ok {
							return apperrors.Wrap("VALIDATION", "item not in this order: "+iid, nil)
						}
						if seen[iid] {
							return apperrors.Wrap("VALIDATION", "item appears in multiple split parts: "+iid, nil)
						}
						seen[iid] = true
						line := decimal.Normalize(decimal.Mul(it.Price, it.Qty))
						partTotal = decimal.Add(partTotal, line)
						itName := ""
						if it.Name != nil {
							itName = *it.Name
						}
						partItems = append(partItems, map[string]any{
							"id":    iid,
							"name":  itName,
							"qty":   it.Qty.String(),
							"price": it.Price.String(),
							"line":  line.String(),
						})
					}
				}
				itemsJSON, _ := json.Marshal(partItems)
				splitNum := partIdx + 1
				splits = append(splits, models.OrderSplit{
					ID:           uuid.NewString(),
					OrderID:      &orderID,
					SplitNumber:  &splitNum,
					SplitType:    ptrString("by_items"),
					Items:        itemsJSON,
					Subtotal:     decimal.Normalize(partTotal),
					Total:        decimal.Normalize(partTotal),
					Status:       ptrString("pending"),
					PaidBy:       &paidBy,
					RestaurantID: &rid,
					CreatedAt:    now,
				})
			}
		}

		// 3. Insert splits и обновляем order.
		for i := range splits {
			if err := tx.Create(&splits[i]).Error; err != nil {
				return err
			}
		}
		yes := true
		n := len(splits)
		order.IsSplit = &yes
		order.SplitCount = &n
		order.UpdatedAt = now
		if err := tx.Save(&order).Error; err != nil {
			return err
		}

		result = &SplitResult{Order: order, Splits: splits}
		return nil
	})
	if err != nil {
		return nil, err
	}
	if s.pub != nil {
		buf := NewBuffer()
		buf.Add(EventOrderUpdated, map[string]any{
			"id":     result.Order.ID,
			"action": "split",
			"mode":   in.Mode,
			"parts":  len(result.Splits),
		})
		s.pub.Flush(ctx, rid, buf)
	}
	return result, nil
}

// ─── Transfer ─────────────────────────────────────────────────────────────

// TransferInput — body POST /api/v1/orders/{id}/transfer.
//
// Можно передать любые комбинации (но как минимум одно поле).
type TransferInput struct {
	TableID  *string `json:"table_id,omitempty"`
	WaiterID *string `json:"waiter_id,omitempty"`
}

// Transfer — перенос заказа на другой стол / другого официанта.
//
// Контракт:
//   - Только open|new|bill_requested.
//   - Если table_id задан — проверяем, что стол принадлежит ресторану.
//   - Если waiter_id задан — проверяем, что юзер ресторана и существует.
//     (Полное role-validation Phase 5+.)
func (s *OrdersService) Transfer(ctx context.Context, orderID string, in TransferInput) (*models.Order, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	if in.TableID == nil && in.WaiterID == nil {
		return nil, apperrors.Wrap("VALIDATION", "at least one of table_id or waiter_id is required", nil)
	}

	var updated *models.Order
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
			return apperrors.Wrap("CONFLICT", "cannot transfer closed/cancelled order", nil)
		}

		now := time.Now().UTC()
		updates := map[string]any{"updated_at": now}

		if in.TableID != nil {
			// Проверка ownership стола.
			var cnt int64
			if err := tx.Model(&models.Table{}).
				Where("restaurant_id = ? AND id = ?", rid, *in.TableID).
				Count(&cnt).Error; err != nil {
				return err
			}
			if cnt == 0 {
				return apperrors.Wrap("VALIDATION", "table not found in this restaurant", nil)
			}
			updates["table_id"] = *in.TableID
		}
		if in.WaiterID != nil {
			var cnt int64
			if err := tx.Model(&models.User{}).
				Where("restaurant_id = ? AND id = ?", rid, *in.WaiterID).
				Count(&cnt).Error; err != nil {
				return err
			}
			if cnt == 0 {
				return apperrors.Wrap("VALIDATION", "waiter not found in this restaurant", nil)
			}
			updates["waiter_id"] = *in.WaiterID
		}

		if err := tx.Model(&order).Updates(updates).Error; err != nil {
			return err
		}
		// Перечитываем для актуальных полей.
		if err := tx.Where("id = ?", orderID).First(&order).Error; err != nil {
			return err
		}
		updated = &order
		return nil
	})
	if err != nil {
		return nil, err
	}
	if s.pub != nil {
		buf := NewBuffer()
		buf.Add(EventOrderUpdated, map[string]any{
			"id":     updated.ID,
			"action": "transfer",
		})
		s.pub.Flush(ctx, rid, buf)
	}
	return updated, nil
}

// ptrString — мелкий хелпер. Локально, чтобы не вынимать в pkg.
func ptrString(s string) *string { return &s }
