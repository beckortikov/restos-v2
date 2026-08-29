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

// CancelOrderInput — body POST /api/v1/orders/{id}/cancel.
type CancelOrderInput struct {
	Reason string `json:"reason"`
}

// VoidItemInput — body POST /api/v1/orders/{id}/items/{itemId}/void.
type VoidItemInput struct {
	Reason     string `json:"reason"`
	ApprovedBy string `json:"approved_by"` // user_id manager'а
	// Qty — partial-void (v2.2.4 fix). Если nil/пусто или >= item.Qty —
	// full void (как раньше). Если < item.Qty — split row: создаём
	// cancelled-копию на Qty, оригинал уменьшается. Симметрично CancelItem.
	// Android waiter PWA шлёт qty="1" при тапе «−» на multi-qty позиции
	// (8 ош → 7), раньше backend это игнорировал и отменял весь row,
	// затем v2.1.1 invariant отменял весь заказ как «пустой».
	Qty *string `json:"qty,omitempty"`
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
	if err := s.requirePerm(ctx, "orders.cancel"); err != nil {
		return nil, err
	}
	if in.Reason == "" {
		return nil, apperrors.Wrap("VALIDATION", "reason is required", nil)
	}
	actor, _ := audit.ActorFromContext(ctx)

	var cancelled *models.Order
	buf := NewBuffer()
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
		// Sync-дельта (ADR-003 Фаза 5) — заказ стал терминальным (cancelled).
		if err := recordOrderSync(tx, &order, "insert"); err != nil {
			return err
		}

		// v3.9.25 (вариант 1): отменяем ещё НЕ напечатанные runner-задачи этого
		// заказа — они не должны выйти на принтер. Без этого отменённый «с собой»
		// заказ всё равно печатался, когда исходный runner ещё висел в pending.
		if err := tx.Model(&models.PrintJob{}).
			Where("order_id = ? AND status = ? AND printed_at IS NULL", order.ID, "pending").
			Updates(map[string]any{"status": "cancelled", "updated_at": now}).Error; err != nil {
			return err
		}

		// Cancel-runner печатаем ТОЛЬКО для позиций, которые кухня уже видела
		// (printed_at != null). Если заказ ещё не печатался — отменять на кухне
		// нечего, ничего не печатаем (вариант 1).
		var liveItems []models.OrderItem
		if err := tx.Where("order_id = ? AND cancelled_at IS NULL AND printed_at IS NOT NULL", order.ID).
			Find(&liveItems).Error; err != nil {
			return err
		}
		if err := s.enqueueCancelRunners(tx, rid, &order, liveItems, in.Reason, now); err != nil {
			return err
		}

		// Если на столе больше нет активных заказов — освобождаем.
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
						"waiter_id":        nil,
						"opened_at":        nil,
						"updated_at":       now,
					}).Error; err != nil {
					return err
				}
				buf.Add(EventTableUpdated, map[string]any{"id": *order.TableID})
			} else {
				// Переключаем current_order_id на следующий старейший активный заказ этого стола
				var nextActive models.Order
				if err := tx.Where("restaurant_id = ? AND table_id = ?", rid, *order.TableID).
					Where("status IN ?", []string{"new", "open", "cooking", "ready", "served", "bill_requested"}).
					Where("id <> ?", order.ID).
					Order("created_at ASC").
					First(&nextActive).Error; err == nil {
					if err := tx.Model(&models.Table{}).
						Where("id = ? AND restaurant_id = ?", *order.TableID, rid).
						Updates(map[string]any{
							"current_order_id": nextActive.ID,
							"waiter_id":        nextActive.WaiterID,
							"updated_at":       now,
						}).Error; err != nil {
						return err
					}
					buf.Add(EventTableUpdated, map[string]any{"id": *order.TableID})
				}
			}
		}

		cancelled = &order
		return nil
	})
	if err != nil {
		return nil, err
	}
	if s.pub != nil {
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
	if err := s.requirePerm(ctx, "orders.void"); err != nil {
		return nil, err
	}
	if in.Reason == "" {
		return nil, apperrors.Wrap("VALIDATION", "reason is required", nil)
	}
	actor, _ := audit.ActorFromContext(ctx)

	var voided *models.OrderItem
	var voidedOrderNumber int
	autoCancelled := false
	buf := NewBuffer()
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
		voidedOrderNumber = order.OrderNumber

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
		// Захватываем ДО возможного partial-split ниже (item может стать split-row).
		origItemID := item.ID
		origMenuItemID := item.MenuItemID
		origUnit := item.Unit
		origUnitSize := item.UnitSize

		now := time.Now().UTC()
		reason := in.Reason
		canceller := actor.UserID

		// v2.2.4: partial-void через split. Логика симметрична CancelItem.
		var qtyToVoid decimal.Decimal
		fullVoid := true
		if in.Qty != nil && strings.TrimSpace(*in.Qty) != "" {
			q, perr := decimal.FromString(*in.Qty)
			if perr != nil {
				return apperrors.Wrap("VALIDATION", "bad qty: "+*in.Qty, perr)
			}
			if !decimal.IsPositive(q) {
				return apperrors.Wrap("VALIDATION", "qty must be > 0", nil)
			}
			if q.Cmp(item.Qty) < 0 {
				qtyToVoid = q
				fullVoid = false
			} else {
				qtyToVoid = item.Qty
			}
		} else {
			qtyToVoid = item.Qty
		}
		// Компонент сета — только целиком (см. тот же гвард и обоснование в
		// CancelItem/orders_extras.go): компоненты всегда qty=1, partial не
		// имеет смысла и оставил бы сет в подвешенном состоянии.
		if item.BundleGroupID != nil && !fullVoid {
			return apperrors.Wrap("VALIDATION", "нельзя частично отменить компонент сета — отмените сет целиком", nil)
		}

		if fullVoid {
			item.CancelledAt = &now
			item.CancelledBy = &canceller
			item.CancelReason = &reason
			item.UpdatedAt = now
			if err := tx.Save(&item).Error; err != nil {
				return err
			}
		} else {
			// Split: новая cancelled-row на qtyToVoid; оригинал уменьшается.
			split := models.OrderItem{
				ID:           uuid.NewString(),
				OrderID:      item.OrderID,
				MenuItemID:   item.MenuItemID,
				Name:         item.Name,
				Note:         item.Note,
				Qty:          qtyToVoid,
				Price:        item.Price,
				COGS:         item.COGS,
				Unit:         item.Unit,
				UnitSize:     item.UnitSize,
				CancelledAt:  &now,
				CancelledBy:  &canceller,
				CancelReason: &reason,
				CreatedAt:    item.CreatedAt,
				UpdatedAt:    now,
			}
			if err := tx.Create(&split).Error; err != nil {
				return err
			}
			item.Qty = decimal.Sub(item.Qty, qtyToVoid)
			item.UpdatedAt = now
			if err := tx.Model(&models.OrderItem{}).
				Where("id = ?", item.ID).
				Updates(map[string]any{"qty": item.Qty, "updated_at": now}).Error; err != nil {
				return err
			}
			// Дальнейшие шаги (order_voids, total, runner) работают со split-row.
			item = split
		}

		// 2b. Возврат склада — только если это void ВНУТРИ переоткрытого закрытого
		// заказа (см. миграцию 096 + returnStockForVoidedItem). Живой void ДО
		// первой оплаты стока не касается — как и раньше.
		if order.ReopenedAt != nil && origMenuItemID != nil {
			if err := s.returnStockForVoidedItem(tx, rid, orderID, origItemID, *origMenuItemID, origUnit, origUnitSize, qtyToVoid, now); err != nil {
				return err
			}
		}

		// 3. Audit-friendly запись в order_voids (видна Manager-у).
		voidID := uuid.NewString()
		oid := orderID
		var itemQtyInt int
		if !qtyToVoid.IsZero() {
			f, _ := qtyToVoid.Float64()
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

		// 3b. Сет — каскад: остальные компоненты того же bundle_group_id
		// отменяются вместе (см. cascadeCancelBundleSiblings). fullVoid уже
		// гарантирован проверкой выше. Каждый каскадный компонент тоже получает
		// свою запись order_voids — иначе менеджер увидит в журнале voids только
		// одну позицию, хотя фактически отменился весь сет.
		var cascadeItems []models.OrderItem
		cascadeTotal := decimal.Zero
		if item.BundleGroupID != nil {
			var cerr error
			cascadeItems, cascadeTotal, cerr = cascadeCancelBundleSiblings(
				tx, order.ID, *item.BundleGroupID, item.ID, canceller, in.Reason, now)
			if cerr != nil {
				return cerr
			}
			for _, ci := range cascadeItems {
				ciQtyInt := 0
				if f, _ := ci.Qty.Float64(); f > 0 {
					ciQtyInt = int(f)
				}
				cascadeReason := "автоматически вместе с сетом: " + reason
				if err := tx.Create(&models.OrderVoid{
					ID: uuid.NewString(), OrderID: &oid, ItemName: ci.Name,
					ItemQty: &ciQtyInt, ItemPrice: ci.Price, Reason: &cascadeReason,
					ApprovedBy: &approvedBy, CreatedBy: &createdBy,
					RestaurantID: &rid, CreatedAt: now,
				}).Error; err != nil {
					return err
				}
			}
		}

		// 4. Recompute order.total: вычесть line_total (основная позиция + каскад).
		lineTotal := decimal.Normalize(decimal.Mul(item.Price, effectivePortions(item.Unit, item.Qty, item.UnitSize)))
		totalDelta := decimal.Add(lineTotal, cascadeTotal)
		order.Total = decimal.Normalize(decimal.Sub(order.Total, totalDelta))
		order.TotalWithService = order.Total
		order.UpdatedAt = now
		if err := tx.Save(&order).Error; err != nil {
			return err
		}

		// 5. Cancel-runner на станцию — повар видит «отменить готовку». Каскадные
		// компоненты сета — туда же, повар должен увидеть ОТМЕНУ по всему сету.
		// Эмитим всегда: если повар ещё не начал — просто игнорирует, если
		// начал — успеет остановиться. Лишний бумажный квиток < риска
		// испорченной готовки. Heuristic по item.PrintedAt появится в Phase 5
		// вместе с kitchen_status.
		runnerCancelItems := append([]models.OrderItem{item}, cascadeItems...)
		if err := s.enqueueCancelRunners(tx, rid, &order, runnerCancelItems, in.Reason, now); err != nil {
			return err
		}

		// 6. Auto-cancel order when last live item gone (v2.1.1).
		// Симптом до фикса: заказ остаётся status=new с пустыми items,
		// стол висит «Занят», takeaway-заказ виден в списке как «0 поз».
		var liveCount int64
		if err := tx.Model(&models.OrderItem{}).
			Where("order_id = ? AND cancelled_at IS NULL", order.ID).
			Count(&liveCount).Error; err != nil {
			return err
		}
		if liveCount == 0 && (order.Status == nil || (*order.Status != "cancelled" && *order.Status != "closed")) {
			cstatus := "cancelled"
			reason := "Все позиции отменены"
			canceller := actor.UserID
			cTotal := decimal.Zero
			order.Status = &cstatus
			order.CancelledAt = &now
			order.CancelledBy = &canceller
			order.CancelReason = &reason
			order.CancelledTotal = &cTotal
			order.UpdatedAt = now
			if err := tx.Save(&order).Error; err != nil {
				return err
			}
			// Sync-дельта (ADR-003 Фаза 5) — заказ стал терминальным (auto-cancel).
			if err := recordOrderSync(tx, &order, "insert"); err != nil {
				return err
			}

			// Освобождаем стол, если на нём больше нет активных заказов.
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
							"waiter_id":        nil,
							"opened_at":        nil,
							"updated_at":       now,
						}).Error; err != nil {
						return err
					}
					buf.Add(EventTableUpdated, map[string]any{"id": *order.TableID})
				} else {
					// Переключаем current_order_id на следующий старейший активный заказ этого стола
					var nextActive models.Order
					if err := tx.Where("restaurant_id = ? AND table_id = ?", rid, *order.TableID).
						Where("status IN ?", []string{"new", "open", "cooking", "ready", "served", "bill_requested"}).
						Where("id <> ?", order.ID).
						Order("created_at ASC").
						First(&nextActive).Error; err == nil {
						if err := tx.Model(&models.Table{}).
							Where("id = ? AND restaurant_id = ?", *order.TableID, rid).
							Updates(map[string]any{
								"current_order_id": nextActive.ID,
								"waiter_id":        nextActive.WaiterID,
								"updated_at":       now,
							}).Error; err != nil {
							return err
						}
						buf.Add(EventTableUpdated, map[string]any{"id": *order.TableID})
					}
				}
			}
			autoCancelled = true
		}

		voided = &item
		return nil
	})
	if err != nil {
		return nil, err
	}
	if s.pub != nil {
		// Обогащаем событие данными позиции — KDS рисует отменённую карточку и
		// баннер «Блюдо «X» отменено · Заказ #N» (см. service/kds.go).
		voidPayload := map[string]any{
			"order_id":     orderID,
			"item_id":      itemID,
			"reason":       in.Reason,
			"order_number": voidedOrderNumber,
		}
		if voided != nil {
			voidPayload["name"] = deref(voided.Name)
			voidPayload["qty"] = voided.Qty.String()
		}
		buf.Add(EventOrderItemVoided, voidPayload)
		if autoCancelled {
			buf.Add(EventOrderCancelled, map[string]any{
				"id":     orderID,
				"reason": "Все позиции отменены",
			})
		}
		s.pub.Flush(ctx, rid, buf)
	}
	return voided, nil
}
