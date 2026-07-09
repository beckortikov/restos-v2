package service

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"github.com/restos/restos-v4/server/internal/audit"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
	apperrors "github.com/restos/restos-v4/server/internal/pkg/errors"
	"github.com/restos/restos-v4/server/internal/pkg/stockcheck"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
	"github.com/restos/restos-v4/server/internal/pkg/units"
	"github.com/restos/restos-v4/server/internal/repo"
)

// ─── Inputs (DTO от HTTP-слоя) ──────────────────────────────────────────────

// CreateOrderInput — body POST /api/v1/orders.
type CreateOrderInput struct {
	TableID     *string           `json:"table_id"`
	Type        string            `json:"type"`         // hall|takeaway|delivery
	GuestsCount *int              `json:"guests_count"` // default 1
	Comment     *string           `json:"comment"`
	ShiftID     *string           `json:"shift_id"`
	Items       []CreateOrderItem `json:"items"`

	// OverrideStopList — менеджер/owner может принудительно создать
	// заказ с позицией в стоп-листе. Без этого флага позиции, помеченные
	// в стоп-листе (manual override или low stock), вернут 409 ITEM_STOPPED.
	OverrideStopList bool `json:"override_stop_list,omitempty"`
}

// CreateOrderItem — позиция при создании заказа.
//   - menu_item_id: что заказали
//   - qty: количество (Decimal, потому что бывают весовые блюда)
//   - modifier_ids: id-шники Modifier'ов (snapshot цены/имени берём из БД)
//   - name/price/unit/unit_size/cogs/modifiers: опциональные override-поля.
//     Если переданы — заменяют snapshot из меню (нужно для comp/discount/custom price).
type CreateOrderItem struct {
	MenuItemID  string                    `json:"menu_item_id"`
	Qty         string                    `json:"qty"`
	ModifierIDs []string                  `json:"modifier_ids"`
	Name        *string                   `json:"name,omitempty"`
	Price       *string                   `json:"price,omitempty"`
	Unit        *string                   `json:"unit,omitempty"`
	UnitSize    *string                   `json:"unit_size,omitempty"`
	COGS        *string                   `json:"cogs,omitempty"`
	Modifiers   *[]OrderItemModifierInput `json:"modifiers,omitempty"`
}

// OrderItemModifierInput — opcional shape для модификатора с overrides.
// Если ModifierID задан — должен валидно ссылаться на Modifier ресторана,
// при этом Name/Price могут переопределить snapshot.
// Если ModifierID не задан — line сохраняется только с custom Name/Price.
type OrderItemModifierInput struct {
	ModifierID *string `json:"modifier_id,omitempty"`
	Name       *string `json:"name,omitempty"`
	Price      *string `json:"price,omitempty"`
}

// AddItemsInput — body POST /api/v1/orders/{id}/items.
type AddItemsInput struct {
	Items []CreateOrderItem `json:"items"`

	// OverrideStopList — менеджер/owner может принудительно создать
	// заказ с позицией в стоп-листе (для исправительных операций).
	OverrideStopList bool `json:"override_stop_list,omitempty"`
}

// ─── Implementation ─────────────────────────────────────────────────────────

// Create создаёт новый заказ с позициями.
//
// Контракт:
//   - В одной транзакции: order + items + item_modifiers.
//   - Цены/имена snapshot'ятся из menu_items на момент создания (заморозка
//     против изменения меню в процессе обслуживания).
//   - Статус по умолчанию — "open" (новый заказ кассы), не "new".
//   - waiter_id берём из Actor.
//   - Events публикуются ТОЛЬКО после commit (через EventBuffer).
//
// Возвращает заказ и буфер событий для публикации в hub.
func (s *OrdersService) Create(ctx context.Context, in CreateOrderInput) (*models.Order, *EventBuffer, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, nil, err
	}
	if len(in.Items) == 0 {
		return nil, nil, apperrors.Wrap("VALIDATION", "order must have at least one item", nil)
	}
	// iiko-style pre-merge: схлопываем входящие позиции с одинаковым ключом
	// (menu_item_id + note + sorted modifier_ids), чтобы не плодить row'ы.
	mergedItems, err := preMergeInputs(in.Items)
	if err != nil {
		return nil, nil, err
	}
	in.Items = mergedItems

	actor, _ := audit.ActorFromContext(ctx)
	buf := NewBuffer()
	var created *models.Order

	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx) // в транзакции; tenant-фильтр выставляем явно ниже

		// Snapshot цен из меню. Один SELECT IN, чтобы не было N+1.
		menuIDs := make([]string, 0, len(in.Items))
		for _, it := range in.Items {
			menuIDs = append(menuIDs, it.MenuItemID)
		}
		var menuItems []models.MenuItem
		if err := tx.Where("restaurant_id = ? AND id IN ?", rid, menuIDs).
			Find(&menuItems).Error; err != nil {
			return err
		}
		menuByID := make(map[string]models.MenuItem, len(menuItems))
		for _, m := range menuItems {
			menuByID[m.ID] = m
		}

		// v2.0.90 — stop-list backend-gate (БАГ #3). Если позиция в стопе и
		// клиент не передал override_stop_list (или роль не достаточная) — 409.
		if err := validateStopListForItems(ctx, tx, rid, in.Items, menuByID, in.OverrideStopList); err != nil {
			return err
		}

		// Phase 19: stock + tech-card валидация (порт v1 lib/stock-check.ts).
		// Если есть нехватки — откатываемся с INSUFFICIENT_STOCK (409) или
		// VALIDATION (400 — нет техкарты) ошибкой.
		if err := validateStockForItems(ctx, tx, rid, in.Items, menuByID); err != nil {
			return err
		}

		// Modifiers — тоже один select. Объединяем modifier_ids + modifiers[].modifier_id.
		modIDs := collectModifierIDs(in.Items)
		var modifiers []models.Modifier
		if len(modIDs) > 0 {
			if err := tx.Where("id IN ?", modIDs).Find(&modifiers).Error; err != nil {
				return err
			}
		}
		modByID := make(map[string]models.Modifier, len(modifiers))
		for _, m := range modifiers {
			modByID[m.ID] = m
		}

		// Готовим Order. Total пересчитаем после items.
		guests := 1
		if in.GuestsCount != nil {
			guests = *in.GuestsCount
		}
		typ := in.Type
		if typ == "" {
			typ = "hall"
		}
		status := "open"
		now := time.Now().UTC()

		// Per-restaurant per-day order_number. Atomic UPSERT в order_counters
		// возвращает следующий номер. Дата берётся в timezone ресторана,
		// fallback Asia/Dushanbe (см. restaurant.timezone, default из core.go).
		var rTz string
		if err := tx.Model(&models.Restaurant{}).
			Select("COALESCE(timezone, 'Asia/Dushanbe')").
			Where("id = ?", rid).
			Scan(&rTz).Error; err != nil || rTz == "" {
			rTz = "Asia/Dushanbe"
		}
		var nextNum int
		if err := tx.Raw(`
			INSERT INTO order_counters (restaurant_id, date, last_number, updated_at)
			VALUES (?, (now() AT TIME ZONE ?)::date, 1, now())
			ON CONFLICT (restaurant_id, date)
			DO UPDATE SET last_number = order_counters.last_number + 1, updated_at = now()
			RETURNING last_number
		`, rid, rTz).Scan(&nextNum).Error; err != nil {
			return err
		}

		// v2.2.0: копируем service_percent из ресторана. Иначе order создаётся
		// с 0 и pre-check не показывает «Обслуживание» (поле скрыто в layout
		// при ServiceAmount==0). Раньше pre-bill пересчитывал percent на лету,
		// но проверка `if !order.ServicePercent.IsZero()` отказывала когда
		// percent действительно 0 → ничего не считалось.
		//
		// Обслуживание — только для зала. Заказы «С собой» (takeaway) и
		// доставка обслуживанием не облагаются, поэтому процент = 0.
		var restServicePercent decimal.Decimal
		if typ == "hall" {
			_ = tx.Model(&models.Restaurant{}).
				Select("COALESCE(service_percent, 0)").
				Where("id = ?", rid).
				Scan(&restServicePercent).Error
		}

		order := &models.Order{
			ID:             uuid.NewString(),
			OrderNumber:    nextNum,
			RestaurantID:   &rid,
			TableID:        in.TableID,
			ShiftID:        in.ShiftID,
			Type:           &typ,
			Status:         &status,
			GuestsCount:    &guests,
			Comment:        in.Comment,
			ServicePercent: restServicePercent,
			CreatedAt:      now,
			UpdatedAt:      now,
		}
		if actor.UserID != "" {
			waiter := actor.UserID
			order.WaiterID = &waiter
		}
		if err := tx.Create(order).Error; err != nil {
			return err
		}

		// items + modifiers + accumulate total
		total := decimal.Zero
		for _, it := range in.Items {
			oi, lineTotal, err := buildOrderItem(it, menuByID, modByID, &order.ID, now, tx)
			if err != nil {
				return err
			}
			total = decimal.Add(total, lineTotal)
			_ = oi
		}

		// Финализируем total. Service-percent и т.п. — в close_order.
		order.Total = decimal.Normalize(total)
		order.TotalWithService = order.Total
		if err := tx.Save(order).Error; err != nil {
			return err
		}

		// Runner-jobs на кухню/бар — для свежесозданных items.
		var createdItems []models.OrderItem
		if err := tx.Where("order_id = ?", order.ID).Find(&createdItems).Error; err != nil {
			return err
		}
		if err := s.enqueueRunners(tx, rid, order, createdItems, now); err != nil {
			return err
		}

		// Sync table.status → occupied.
		// Идемпотентно: если стол уже occupied (вторая группа за тем же столом),
		// current_order_id первой группы НЕ перетираем — только bump updated_at.
		// Это критично для feature "2 группы за одним столом" в POS.
		if order.TableID != nil && *order.TableID != "" {
			var t models.Table
			if err := tx.Where("id = ? AND restaurant_id = ?", *order.TableID, rid).
				First(&t).Error; err == nil {
				updates := map[string]any{"updated_at": now}
				if t.Status == nil || *t.Status != "occupied" {
					updates["status"] = "occupied"
					updates["current_order_id"] = order.ID
					updates["opened_at"] = now
				}
				if err := tx.Model(&models.Table{}).
					Where("id = ?", t.ID).
					Updates(updates).Error; err != nil {
					return err
				}
				buf.Add(EventTableUpdated, map[string]any{"id": *order.TableID})
			}
		}

		created = order
		buf.Add(EventOrderCreated, map[string]any{
			"id":     order.ID,
			"total":  order.Total.String(),
			"status": *order.Status,
		})
		return nil
	})
	if err != nil {
		return nil, nil, err
	}
	s.publish(ctx, rid, buf)
	return created, buf, nil
}

// AddItems добавляет позиции в существующий открытый заказ.
//
// Используется когда официант «дозаказывает» — например, второе блюдо после
// первого. Заказ должен быть в статусе open|new.
func (s *OrdersService) AddItems(ctx context.Context, orderID string, in AddItemsInput) (*models.Order, *EventBuffer, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, nil, err
	}
	if len(in.Items) == 0 {
		return nil, nil, apperrors.Wrap("VALIDATION", "items required", nil)
	}
	// iiko-style pre-merge на входе: повторные позиции с одинаковым ключом
	// сливаются в одну до операции. (Merge с уже существующими DB-rows —
	// внутри транзакции ниже.)
	mergedItems, err := preMergeInputs(in.Items)
	if err != nil {
		return nil, nil, err
	}
	in.Items = mergedItems
	buf := NewBuffer()
	var updated *models.Order

	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)

		// Order with FOR UPDATE — блокируем строку, чтобы не было гонки с close.
		var order models.Order
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("restaurant_id = ? AND id = ?", rid, orderID).
			First(&order).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return apperrors.ErrNotFound
			}
			return err
		}
		// Дозаказ запрещён только для закрытого/оплаченного заказа — как v1
		// addItemsToOrder, который блокировал лишь status==='done'. Любой
		// активный статус ОК; отменённый «оживляем», ready/served сбрасываем в
		// cooking ниже (порт v1). Раньше тут было `!= open && != new` → официант
		// не мог дозаказать в cancelled (после отмены всех позиций заказ авто-
		// отменяется) / ready / served — отбивалось 409 «order is not open».
		if order.Status != nil && *order.Status == "closed" {
			return apperrors.Wrap("CONFLICT", "order is closed", nil)
		}
		wasCancelled := order.Status != nil && *order.Status == "cancelled"

		// Загружаем меню/мод-ы аналогично Create.
		menuIDs := make([]string, 0, len(in.Items))
		for _, it := range in.Items {
			menuIDs = append(menuIDs, it.MenuItemID)
		}
		var menuItems []models.MenuItem
		if err := tx.Where("restaurant_id = ? AND id IN ?", rid, menuIDs).Find(&menuItems).Error; err != nil {
			return err
		}
		menuByID := make(map[string]models.MenuItem, len(menuItems))
		for _, m := range menuItems {
			menuByID[m.ID] = m
		}

		// v2.0.90 — stop-list backend-gate (БАГ #3).
		if err := validateStopListForItems(ctx, tx, rid, in.Items, menuByID, in.OverrideStopList); err != nil {
			return err
		}

		// Phase 19: тех/stock-валидация для доп. позиций.
		if err := validateStockForItems(ctx, tx, rid, in.Items, menuByID); err != nil {
			return err
		}

		modIDs := collectModifierIDs(in.Items)
		var modifiers []models.Modifier
		if len(modIDs) > 0 {
			if err := tx.Where("id IN ?", modIDs).Find(&modifiers).Error; err != nil {
				return err
			}
		}
		modByID := make(map[string]models.Modifier, len(modifiers))
		for _, m := range modifiers {
			modByID[m.ID] = m
		}

		now := time.Now().UTC()
		extra := decimal.Zero
		// Items, которые нужно прогнать через runner-эмит:
		//   - свежесозданные (qty_printed = 0, delta = qty)
		//   - merged-в-printed (qty_printed > 0, delta = qty - qty_printed)
		// enqueueRunners сам пропускает строки с delta <= 0.
		var runnerItems []models.OrderItem

		// iiko-style merge: подгребаем существующие mergeable rows этого заказа.
		// Mergeable = same menu_item_id, same note, same sorted modifier set,
		// not cancelled, not served, not printed (после печати на кухню — не
		// сливаем, повар должен видеть дозаказ отдельной строкой).
		existingRows, existingMods, err := loadMergeableItems(tx, order.ID)
		if err != nil {
			return err
		}
		for _, it := range in.Items {
			key, qty, err := mergeKeyForInput(it)
			if err != nil {
				return err
			}
			if existing := pickMergeable(existingRows, existingMods, it, key); existing != nil {
				// Merge: bump qty, не INSERT'им новой строки.
				// printed_at и qty_printed НЕ трогаем — runner-эмиттер сам посчитает
				// delta = newQty - existing.QtyPrinted и допечатает остаток.
				newQty := decimal.Add(existing.Qty, qty)
				if err := tx.Model(&models.OrderItem{}).
					Where("id = ?", existing.ID).
					Updates(map[string]any{
						"qty":        newQty,
						"updated_at": now,
					}).Error; err != nil {
					return err
				}
				// Пересчёт line-total: price * deltaQty + сумма модификаторов * deltaQty.
				eff := effectivePortions(existing.Unit, qty, existing.UnitSize)
				lineTotal := decimal.Mul(existing.Price, eff)
				for _, m := range existingMods[existing.ID] {
					lineTotal = decimal.Add(lineTotal, decimal.Mul(m.Price, eff))
				}
				extra = decimal.Add(extra, decimal.Normalize(lineTotal))
				// Обновим in-memory представление, чтобы повторный input с тем же
				// ключом тоже слился в эту же строку.
				existing.Qty = newQty
				// Передаём в runner — он напечатает только delta поверх qty_printed.
				runnerItems = append(runnerItems, *existing)
				continue
			}
			oi, lineTotal, err := buildOrderItem(it, menuByID, modByID, &order.ID, now, tx)
			if err != nil {
				return err
			}
			runnerItems = append(runnerItems, *oi)
			extra = decimal.Add(extra, lineTotal)
			// Добавим в pool, чтобы следующий input с тем же ключом смержился.
			existingRows = append(existingRows, oi)
			if mods := snapshotModifiersForItem(tx, oi.ID); len(mods) > 0 {
				existingMods[oi.ID] = mods
			}
		}

		order.Total = decimal.Normalize(decimal.Add(order.Total, extra))
		order.TotalWithService = order.Total
		order.UpdatedAt = now
		// Возврат заказа в работу при дозаказе (порт v1 addItemsToOrder):
		//   cancelled      → снимаем отмену, заказ снова активен (open);
		//   ready / served → возвращаем в cooking, т.к. новым позициям нужна кухня.
		if order.Status != nil {
			switch *order.Status {
			case "cancelled":
				openStatus := "open"
				order.Status = &openStatus
				order.CancelledAt = nil
				order.CancelledBy = nil
				order.CancelReason = nil
				order.ReadyAt = nil
			case "ready", "served":
				cooking := "cooking"
				order.Status = &cooking
				order.ReadyAt = nil
			}
		}
		if err := tx.Save(&order).Error; err != nil {
			return err
		}
		// Авто-отмена освободила стол — при «оживлении» заказа занимаем обратно.
		if wasCancelled && order.TableID != nil && *order.TableID != "" {
			if err := tx.Model(&models.Table{}).
				Where("id = ? AND restaurant_id = ?", *order.TableID, rid).
				Updates(map[string]any{
					"status":           "occupied",
					"current_order_id": order.ID,
					"opened_at":        now,
					"updated_at":       now,
				}).Error; err != nil {
				return err
			}
			buf.Add(EventTableUpdated, map[string]any{"id": *order.TableID})
		}
		// Runner-jobs: и свежесозданные, и merged-в-printed (с delta).
		// enqueueRunners сам считает qty - qty_printed на каждой строке.
		if err := s.enqueueRunners(tx, rid, &order, runnerItems, now); err != nil {
			return err
		}
		updated = &order
		buf.Add(EventOrderItemAdded, map[string]any{
			"order_id": order.ID,
			"added":    len(in.Items),
			"total":    order.Total.String(),
		})
		// Триггерим reload UI — после merge старые items могли изменить qty.
		buf.Add(EventOrderUpdated, map[string]any{
			"id":     order.ID,
			"action": "items.added",
		})
		return nil
	})
	if err != nil {
		return nil, nil, err
	}
	s.publish(ctx, rid, buf)
	return updated, buf, nil
}

// ─── iiko-style merge helpers ───────────────────────────────────────────────

// mergeKeyForInput возвращает каноничный ключ для input-позиции:
// "<menu_item_id>|<note>|<sorted modifier_ids joined ',' >".
// Также возвращает Qty (parsed) для удобства caller'а.
// Если у input есть override-поля price/name/cogs/unit или Modifiers[] с
// custom name/price — merge невозможен (ключ помечается уникальным uuid),
// потому что snapshot не будет идентичен существующей строке.
func mergeKeyForInput(it CreateOrderItem) (string, decimal.Decimal, error) {
	qty, err := decimal.FromString(it.Qty)
	if err != nil {
		return "", decimal.Zero, apperrors.Wrap("VALIDATION", "bad qty: "+it.Qty, err)
	}
	// Override-поля делают позицию «уникальной» — не сливаем.
	if it.Price != nil || it.Name != nil || it.COGS != nil || it.Unit != nil || it.UnitSize != nil {
		return "uniq:" + uuid.NewString(), qty, nil
	}
	if it.Modifiers != nil && len(*it.Modifiers) > 0 {
		for _, m := range *it.Modifiers {
			if m.Name != nil || m.Price != nil {
				return "uniq:" + uuid.NewString(), qty, nil
			}
		}
	}
	mids := make([]string, 0, len(it.ModifierIDs))
	mids = append(mids, it.ModifierIDs...)
	if it.Modifiers != nil {
		for _, m := range *it.Modifiers {
			if m.ModifierID != nil && *m.ModifierID != "" {
				mids = append(mids, *m.ModifierID)
			}
		}
	}
	sort.Strings(mids)
	return it.MenuItemID + "|" + strings.Join(mids, ","), qty, nil
}

// preMergeInputs схлопывает повторные input-позиции с одинаковым merge-ключом.
// Note=v4 на input-уровне передаётся в `it.Note`? — Нет, шапка CreateOrderItem
// note нет. Note вешается отдельным эндпоинтом setItemNote после INSERT, поэтому
// для merge-ключа на входе note всегда пустая. Это согласуется с фронтом
// (note прописывается строго после создания).
func preMergeInputs(items []CreateOrderItem) ([]CreateOrderItem, error) {
	if len(items) <= 1 {
		return items, nil
	}
	byKey := make(map[string]int, len(items)) // key -> index in out
	out := make([]CreateOrderItem, 0, len(items))
	for _, it := range items {
		key, qty, err := mergeKeyForInput(it)
		if err != nil {
			return nil, err
		}
		if idx, ok := byKey[key]; ok && !strings.HasPrefix(key, "uniq:") {
			// Складываем qty в существующую строку.
			prevQty, err := decimal.FromString(out[idx].Qty)
			if err != nil {
				return nil, err
			}
			out[idx].Qty = decimal.Add(prevQty, qty).String()
			continue
		}
		byKey[key] = len(out)
		out = append(out, it)
	}
	return out, nil
}

// loadMergeableItems вытягивает все order_items этого заказа, по которым
// допустим merge (cancelled_at=NULL, served_at=NULL, printed_at=NULL).
//
// `printed_at IS NULL` намеренно: после печати на кухню дозаказ создаётся
// отдельной строкой, чтобы повар увидел его как новую runner-строку. Iiko-
// style. См. v2.0.66 revert (раньше пробовали мержить с delta-runner, но
// кассирский UX оказался запутаннее, чем кухонный профит).
func loadMergeableItems(tx *gorm.DB, orderID string) ([]*models.OrderItem, map[string][]models.OrderItemModifier, error) {
	var rows []models.OrderItem
	if err := tx.Where("order_id = ? AND cancelled_at IS NULL AND served_at IS NULL AND printed_at IS NULL", orderID).
		Find(&rows).Error; err != nil {
		return nil, nil, err
	}
	out := make([]*models.OrderItem, len(rows))
	ids := make([]string, len(rows))
	for i := range rows {
		out[i] = &rows[i]
		ids[i] = rows[i].ID
	}
	modsByItem := make(map[string][]models.OrderItemModifier)
	if len(ids) > 0 {
		var mods []models.OrderItemModifier
		if err := tx.Where("order_item_id IN ?", ids).Find(&mods).Error; err != nil {
			return nil, nil, err
		}
		for _, m := range mods {
			if m.OrderItemID != nil {
				modsByItem[*m.OrderItemID] = append(modsByItem[*m.OrderItemID], m)
			}
		}
	}
	return out, modsByItem, nil
}

func snapshotModifiersForItem(tx *gorm.DB, itemID string) []models.OrderItemModifier {
	var mods []models.OrderItemModifier
	_ = tx.Where("order_item_id = ?", itemID).Find(&mods).Error
	return mods
}

// pickMergeable ищет в pool существующую строку, в которую можно влить input.
// Сравнение:
//   - menu_item_id равен
//   - note input ("") должен совпасть с note существующей (NULL или "")
//   - sorted modifier_ids set совпадает (по modifier_id)
//   - override-полей на input нет (это уже отфильтровано в mergeKeyForInput
//     через "uniq:"-ключ — такие сюда не приходят).
func pickMergeable(
	pool []*models.OrderItem,
	mods map[string][]models.OrderItemModifier,
	input CreateOrderItem,
	key string,
) *models.OrderItem {
	if strings.HasPrefix(key, "uniq:") {
		return nil
	}
	// inputMids — то, что входит в ключ.
	inputMids := make([]string, 0, len(input.ModifierIDs))
	inputMids = append(inputMids, input.ModifierIDs...)
	if input.Modifiers != nil {
		for _, m := range *input.Modifiers {
			if m.ModifierID != nil && *m.ModifierID != "" {
				inputMids = append(inputMids, *m.ModifierID)
			}
		}
	}
	sort.Strings(inputMids)
	for _, row := range pool {
		if row.MenuItemID == nil || *row.MenuItemID != input.MenuItemID {
			continue
		}
		// note на input уровне у позиций нет (см. preMergeInputs); считаем
		// merge возможным только если у существующей строки note тоже пуст.
		if row.Note != nil && strings.TrimSpace(*row.Note) != "" {
			continue
		}
		existingMids := make([]string, 0)
		for _, m := range mods[row.ID] {
			if m.ModifierID != nil && *m.ModifierID != "" {
				existingMids = append(existingMids, *m.ModifierID)
			} else {
				// custom-модификатор без modifier_id → не сливаем.
				existingMids = nil
				break
			}
		}
		if existingMids == nil {
			continue
		}
		sort.Strings(existingMids)
		if !stringSliceEqual(existingMids, inputMids) {
			continue
		}
		return row
	}
	return nil
}

func stringSliceEqual(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// collectModifierIDs — собирает все modifier_id из ModifierIDs и Modifiers[]
// для batch-загрузки snapshot'ов из БД.
func collectModifierIDs(items []CreateOrderItem) []string {
	out := []string{}
	for _, it := range items {
		out = append(out, it.ModifierIDs...)
		if it.Modifiers != nil {
			for _, m := range *it.Modifiers {
				if m.ModifierID != nil && *m.ModifierID != "" {
					out = append(out, *m.ModifierID)
				}
			}
		}
	}
	return out
}

// buildOrderItem — общая логика создания OrderItem + его модификаторов.
// Применяет override-поля из input поверх snapshot'а из меню.
// Возвращает созданный item и его line-total (включая модификаторы * qty).
func buildOrderItem(
	it CreateOrderItem,
	menuByID map[string]models.MenuItem,
	modByID map[string]models.Modifier,
	orderID *string,
	now time.Time,
	tx *gorm.DB,
) (*models.OrderItem, decimal.Decimal, error) {
	qty, err := decimal.FromString(it.Qty)
	if err != nil {
		return nil, decimal.Zero, apperrors.Wrap("VALIDATION", "bad qty: "+it.Qty, err)
	}
	if !decimal.IsPositive(qty) {
		return nil, decimal.Zero, apperrors.Wrap("VALIDATION", "qty must be > 0", nil)
	}
	mi, ok := menuByID[it.MenuItemID]
	if !ok {
		return nil, decimal.Zero, apperrors.Wrap("VALIDATION", "menu item not found: "+it.MenuItemID, nil)
	}
	itemID := uuid.NewString()
	oi := &models.OrderItem{
		ID:         itemID,
		OrderID:    orderID,
		MenuItemID: &mi.ID,
		Name:       mi.Name,
		Qty:        qty,
		Price:      mi.Price,
		COGS:       mi.COGS,
		Unit:       mi.Unit,
		UnitSize:   mi.UnitSize,
		CreatedAt:  now,
		UpdatedAt:  now,
	}
	// Shallow-merge override полей.
	if it.Name != nil {
		n := *it.Name
		oi.Name = &n
	}
	if it.Price != nil {
		d, err := decimal.FromString(*it.Price)
		if err != nil {
			return nil, decimal.Zero, apperrors.Wrap("VALIDATION", "bad price", err)
		}
		// Override цены разрешён ТОЛЬКО там, где цену нельзя взять из меню:
		//  - весовой товар (unit != 'piece') — цена = вес × цена/кг, вес с весов;
		//  - позиция со свободной ценой (меню-цена 0) — кассир вбивает вручную.
		// Для обычного штучного блюда с фикс-ценой клиентскую цену игнорируем и
		// оставляем mi.Price — иначе крафтом запроса можно продать блюдо по любой
		// цене. Признаки берём из МЕНЮ (mi.*), а не из клиентского override —
		// чтобы нельзя было прислать unit:"kg" на штучное блюдо и открыть дыру.
		isWeight := mi.Unit != nil && *mi.Unit != "piece"
		isOpenPrice := mi.Price.IsZero()
		if isWeight || isOpenPrice {
			oi.Price = d
		}
	}
	if it.Unit != nil {
		u := *it.Unit
		oi.Unit = &u
	}
	if it.UnitSize != nil {
		d, err := decimal.FromString(*it.UnitSize)
		if err != nil {
			return nil, decimal.Zero, apperrors.Wrap("VALIDATION", "bad unit_size", err)
		}
		oi.UnitSize = d
	}
	if it.COGS != nil {
		d, err := decimal.FromString(*it.COGS)
		if err != nil {
			return nil, decimal.Zero, apperrors.Wrap("VALIDATION", "bad cogs", err)
		}
		oi.COGS = d
	}
	// Себестоимость из тех-карты, если вручную не задана (ни в меню, ни в заказе).
	// Иначе COGS в ОПиУ = 0, хотя ингредиенты в тех-карте имеют цену.
	if it.COGS == nil && oi.COGS.IsZero() {
		if c := techCardCogs(tx, mi); c.IsPositive() {
			oi.COGS = c
		}
	}
	if err := tx.Create(oi).Error; err != nil {
		return nil, decimal.Zero, err
	}
	eff := effectivePortions(oi.Unit, qty, oi.UnitSize)
	lineTotal := decimal.Normalize(decimal.Mul(oi.Price, eff))

	// Модификаторы: сначала из ModifierIDs (legacy), затем Modifiers[] (overrides).
	for _, mid := range it.ModifierIDs {
		m, ok := modByID[mid]
		if !ok {
			return nil, decimal.Zero, apperrors.Wrap("VALIDATION", "modifier not found: "+mid, nil)
		}
		modCopy := m
		oim := &models.OrderItemModifier{
			ID:          uuid.NewString(),
			OrderItemID: &itemID,
			ModifierID:  &modCopy.ID,
			Name:        modCopy.Name,
			Price:       modCopy.Price,
			UpdatedAt:   now,
		}
		if err := tx.Create(oim).Error; err != nil {
			return nil, decimal.Zero, err
		}
		lineTotal = decimal.Add(lineTotal, decimal.Mul(modCopy.Price, eff))
	}
	if it.Modifiers != nil {
		for _, mi := range *it.Modifiers {
			oim := &models.OrderItemModifier{
				ID:          uuid.NewString(),
				OrderItemID: &itemID,
				UpdatedAt:   now,
			}
			// Если modifier_id задан — валидируем и берём snapshot.
			if mi.ModifierID != nil && *mi.ModifierID != "" {
				m, ok := modByID[*mi.ModifierID]
				if !ok {
					return nil, decimal.Zero, apperrors.Wrap("VALIDATION", "modifier not found: "+*mi.ModifierID, nil)
				}
				modCopy := m
				oim.ModifierID = &modCopy.ID
				oim.Name = modCopy.Name
				oim.Price = modCopy.Price
			}
			// Overrides.
			if mi.Name != nil {
				n := *mi.Name
				oim.Name = &n
			}
			if mi.Price != nil {
				d, err := decimal.FromString(*mi.Price)
				if err != nil {
					return nil, decimal.Zero, apperrors.Wrap("VALIDATION", "bad modifier price", err)
				}
				oim.Price = d
			}
			if err := tx.Create(oim).Error; err != nil {
				return nil, decimal.Zero, err
			}
			lineTotal = decimal.Add(lineTotal, decimal.Mul(oim.Price, eff))
		}
	}
	return oi, lineTotal, nil
}

// validateStockForItems — Phase 19. Порт v1 lib/stock-check.ts.
//
// Принимает текущую транзакцию + рестораный id + входящие items.
// Возвращает VALIDATION-ошибку, если есть нехватки. nil = ОК.
//
// Контракт (см. matrix в pkg/stockcheck):
//   - tech_cards_enabled=false  → skip (silent OK).
//   - tech_cards_enabled=true && enforce_stock_check=false → tech-card-only.
//   - tech_cards_enabled=true && enforce_stock_check=true  → strict (+reservations).
//
// Из БД подгружается:
//   - restaurants.tech_cards_enabled, enforce_stock_check
//   - tech_card_lines + ingredients (через JOIN-аналог)
//   - active orders (status in 'new','cooking') для reserve-расчёта в strict
func validateStockForItems(
	ctx context.Context,
	tx *gorm.DB,
	rid string,
	items []CreateOrderItem,
	menuByID map[string]models.MenuItem,
) error {
	// 1. Читаем настройки ресторана.
	var rest models.Restaurant
	if err := tx.Where("id = ?", rid).First(&rest).Error; err != nil {
		return err
	}
	// tech_cards_enabled default=true в схеме. Если nil — считаем true.
	techEnabled := rest.TechCardsEnabled == nil || *rest.TechCardsEnabled
	if !techEnabled {
		return nil // skip validation
	}
	mode := stockcheck.ModeTechCardOnly
	if rest.EnforceStockCheck != nil && *rest.EnforceStockCheck {
		mode = stockcheck.ModeStrict
	}

	// 2. Сводим items в stockcheck.OrderItem.
	scItems := make([]stockcheck.OrderItem, 0, len(items))
	menuIDs := make([]string, 0, len(items))
	for _, it := range items {
		qty, err := decimal.FromString(it.Qty)
		if err != nil {
			return apperrors.Wrap("VALIDATION", "bad qty: "+it.Qty, err)
		}
		name := ""
		if mi, ok := menuByID[it.MenuItemID]; ok && mi.Name != nil {
			name = *mi.Name
		}
		if it.Name != nil {
			name = *it.Name
		}
		scItems = append(scItems, stockcheck.OrderItem{
			MenuItemID: it.MenuItemID,
			Name:       name,
			Qty:        qty,
		})
		menuIDs = append(menuIDs, it.MenuItemID)
	}

	// 3. menu meta (batch / prepared_qty).
	menuMeta := make(map[string]stockcheck.MenuMeta, len(menuByID))
	for id, m := range menuByID {
		mm := stockcheck.MenuMeta{Unit: m.Unit, UnitSize: m.UnitSize}
		if m.IsBatchCooking != nil {
			mm.IsBatchCooking = *m.IsBatchCooking
		}
		if m.PreparedQty != nil {
			mm.PreparedQty = *m.PreparedQty
		}
		menuMeta[id] = mm
	}

	// 4. tech_card_lines для всех меню-id ОДНИМ select'ом.
	var lines []models.TechCardLine
	if err := tx.Where("restaurant_id = ? AND menu_item_id IN ?", rid, menuIDs).
		Find(&lines).Error; err != nil {
		return err
	}

	// Загрузим ingredients, на которые ссылаются эти строки.
	ingIDs := make(map[string]struct{}, len(lines))
	for _, l := range lines {
		if l.IngredientID != nil && *l.IngredientID != "" {
			ingIDs[*l.IngredientID] = struct{}{}
		}
	}
	ingByID := make(map[string]*stockcheck.IngredientInfo, len(ingIDs))
	if len(ingIDs) > 0 {
		ids := make([]string, 0, len(ingIDs))
		for k := range ingIDs {
			ids = append(ids, k)
		}
		var ings []models.Ingredient
		if err := tx.Where("id IN ?", ids).Find(&ings).Error; err != nil {
			return err
		}
		for _, i := range ings {
			info := &stockcheck.IngredientInfo{
				Qty:            i.Qty,
				WastePercent:   i.WastePercent,
				IsFood:         i.IsFood == nil || *i.IsFood,
				Unit:           i.Unit,
				UnitWeight:     i.UnitWeight,
				UnitWeightUnit: i.UnitWeightUnit,
			}
			if i.Name != nil {
				info.Name = *i.Name
			}
			ingByID[i.ID] = info
		}
	}

	tclByMenu := make(map[string][]stockcheck.TechLine)
	for _, l := range lines {
		if l.MenuItemID == nil {
			continue
		}
		name := ""
		if l.Name != nil {
			name = *l.Name
		}
		tl := stockcheck.TechLine{
			IngredientID: l.IngredientID,
			Qty:          l.Qty,
			Name:         name,
			Unit:         l.Unit,
		}
		if l.IngredientID != nil {
			if info, ok := ingByID[*l.IngredientID]; ok {
				tl.Ingredient = info
			}
		}
		tclByMenu[*l.MenuItemID] = append(tclByMenu[*l.MenuItemID], tl)
	}

	opts := stockcheck.Opts{
		Mode:      mode,
		MenuByID:  menuMeta,
		TclByMenu: tclByMenu,
	}

	// 5. Если strict — считаем reservedByIngredient + reservedBatchByMenu.
	if mode == stockcheck.ModeStrict {
		resIng, resBatch, err := computeReservations(tx, rid)
		if err != nil {
			return err
		}
		opts.ReservedByIngredient = resIng
		opts.ReservedBatchByMenu = resBatch
	}

	shortages := stockcheck.ComputeShortages(scItems, opts)
	if len(shortages) == 0 {
		return nil
	}
	// «не настроена техкарта» — VALIDATION (configuration). Реальные
	// нехватки склада — INSUFFICIENT_STOCK (CONFLICT/409).
	allTechCardMissing := true
	for _, s := range shortages {
		if !strings.Contains(s, "не настроена техкарта") {
			allTechCardMissing = false
			break
		}
	}
	if allTechCardMissing {
		return apperrors.Wrap("VALIDATION", formatShortages(shortages), nil)
	}
	return apperrors.Wrap("INSUFFICIENT_STOCK", formatShortages(shortages), nil)
}

// validateStopListForItems — БАГ #3 backend-gate стоп-листа.
//
// Позиция считается «в стопе» если:
//   - menu_items.stop_list_override = true (manual), ИЛИ
//   - её tech_card_line ссылается на ингредиент с qty <= min_qty (auto).
//
// Если override_stop_list=true И actor.Role ∈ {manager, owner} — разрешаем
// (но логируем в audit_log через стандартный hook на mutation order). Иначе 409.
func validateStopListForItems(
	ctx context.Context,
	tx *gorm.DB,
	rid string,
	items []CreateOrderItem,
	menuByID map[string]models.MenuItem,
	overrideStopList bool,
) error {
	// 1. Собираем manual-override menu_item_id.
	manualBlocked := make(map[string]bool, len(items))
	autoBlocked := make(map[string]bool, len(items))
	itemNames := make(map[string]string, len(items))

	menuIDs := make([]string, 0, len(items))
	for _, it := range items {
		menuIDs = append(menuIDs, it.MenuItemID)
		if mi, ok := menuByID[it.MenuItemID]; ok {
			if mi.StopListOverride != nil && *mi.StopListOverride {
				manualBlocked[it.MenuItemID] = true
			}
			if mi.Name != nil {
				itemNames[it.MenuItemID] = *mi.Name
			}
		}
	}

	// 2. Auto-stop через low-stock ingredient → tech_card_line.
	//    Только в строгом режиме (учёт по техкартам + контроль остатков): иначе
	//    склад не учитывается / может уходить в минус, и авто-стоп не должен
	//    блокировать продажу (ручной override — отдельно, он блокирует всегда).
	//    Согласовано со стоп-листом и stockcheck (v3.9.108).
	var rest models.Restaurant
	if err := tx.Select("tech_cards_enabled, enforce_stock_check").Where("id = ?", rid).First(&rest).Error; err != nil {
		return err
	}
	techEnabled := rest.TechCardsEnabled == nil || *rest.TechCardsEnabled
	enforce := rest.EnforceStockCheck != nil && *rest.EnforceStockCheck
	var lowIngs []models.Ingredient
	if techEnabled && enforce {
		if err := tx.Where("restaurant_id = ? AND qty <= min_qty", rid).
			Find(&lowIngs).Error; err != nil {
			return err
		}
	}
	if len(lowIngs) > 0 {
		lowSet := make(map[string]bool, len(lowIngs))
		for _, i := range lowIngs {
			lowSet[i.ID] = true
		}
		var lines []models.TechCardLine
		if err := tx.Where("restaurant_id = ? AND menu_item_id IN ?", rid, menuIDs).
			Find(&lines).Error; err != nil {
			return err
		}
		for _, l := range lines {
			if l.MenuItemID == nil || l.IngredientID == nil {
				continue
			}
			// Заготовочные блюда НЕ стопятся по остатку сырья — их доступность
			// определяется prepared_qty (проверяется отдельно в
			// validateStockForItems). Иначе блюдо с готовыми порциями ложно
			// отклонялось как ITEM_STOPPED при нулевом сырье.
			if mi, ok := menuByID[*l.MenuItemID]; ok && mi.IsBatchCooking != nil && *mi.IsBatchCooking {
				continue
			}
			if lowSet[*l.IngredientID] {
				autoBlocked[*l.MenuItemID] = true
			}
		}
	}

	// 3. Собираем «нарушители».
	type blocked struct {
		ID     string `json:"item_id"`
		Name   string `json:"item_name"`
		Reason string `json:"reason"` // "manual" | "auto"
	}
	var hits []blocked
	for _, it := range items {
		switch {
		case manualBlocked[it.MenuItemID]:
			hits = append(hits, blocked{ID: it.MenuItemID, Name: itemNames[it.MenuItemID], Reason: "manual"})
		case autoBlocked[it.MenuItemID]:
			hits = append(hits, blocked{ID: it.MenuItemID, Name: itemNames[it.MenuItemID], Reason: "auto"})
		}
	}
	if len(hits) == 0 {
		return nil
	}

	// 4. Override path.
	if overrideStopList {
		actor, _ := audit.ActorFromContext(ctx)
		if actor.Role == "manager" || actor.Role == "owner" {
			// audit идёт через стандартный GORM hook на Order.AfterCreate.
			return nil
		}
		return apperrors.Wrap("FORBIDDEN", "override_stop_list requires manager or owner role", nil)
	}

	// 5. Reject.
	names := make([]string, 0, len(hits))
	for _, h := range hits {
		nm := h.Name
		if nm == "" {
			nm = h.ID
		}
		names = append(names, nm)
	}
	msg := fmt.Sprintf("позиции в стоп-листе: %s", strings.Join(names, ", "))
	return apperrors.Wrap("ITEM_STOPPED", msg, nil)
}

// computeReservations — собирает резервации от уже открытых не-deducted заказов.
// Заказ считается «активным» если status in ('open','new','cooking','ready')
// (stock ещё не списан — он списывается на close). Совпадает с v1
// fetchActiveReservations (supabase-queries.ts:1338-1500).
func computeReservations(tx *gorm.DB, rid string) (
	map[string]decimal.Decimal, map[string]decimal.Decimal, error,
) {
	// Берём order_items по живым заказам этого ресторана.
	type row struct {
		MenuItemID string          `gorm:"column:menu_item_id"`
		Qty        decimal.Decimal `gorm:"column:qty"`
	}
	var rows []row
	if err := tx.Table("order_items AS oi").
		Select("oi.menu_item_id, oi.qty").
		Joins("JOIN orders o ON o.id = oi.order_id").
		Where("o.restaurant_id = ? AND o.status IN ?", rid, []string{"open", "new", "cooking", "ready"}).
		Where("oi.cancelled_at IS NULL").
		Scan(&rows).Error; err != nil {
		return nil, nil, err
	}
	if len(rows) == 0 {
		return map[string]decimal.Decimal{}, map[string]decimal.Decimal{}, nil
	}

	// Уникальные menu_item_id для batch / tech_card lookup.
	menuIDs := make(map[string]struct{}, len(rows))
	for _, r := range rows {
		if r.MenuItemID != "" {
			menuIDs[r.MenuItemID] = struct{}{}
		}
	}
	ids := make([]string, 0, len(menuIDs))
	for k := range menuIDs {
		ids = append(ids, k)
	}

	// Menu meta — для batch detection.
	var mis []models.MenuItem
	if err := tx.Where("id IN ?", ids).Find(&mis).Error; err != nil {
		return nil, nil, err
	}
	miByID := make(map[string]models.MenuItem, len(mis))
	for _, m := range mis {
		miByID[m.ID] = m
	}

	// Tech card lines.
	var lines []models.TechCardLine
	if err := tx.Where("restaurant_id = ? AND menu_item_id IN ?", rid, ids).Find(&lines).Error; err != nil {
		return nil, nil, err
	}
	tclByMenu := make(map[string][]models.TechCardLine)
	ingIDset := make(map[string]struct{})
	for _, l := range lines {
		if l.MenuItemID != nil {
			tclByMenu[*l.MenuItemID] = append(tclByMenu[*l.MenuItemID], l)
		}
		if l.IngredientID != nil && *l.IngredientID != "" {
			ingIDset[*l.IngredientID] = struct{}{}
		}
	}

	// Единицы склада ингредиентов (+ per-unit фактор) — резерв копим в единице
	// склада, как и stock.
	ingIDs := make([]string, 0, len(ingIDset))
	for k := range ingIDset {
		ingIDs = append(ingIDs, k)
	}
	ingConvByID, err := loadIngStockConv(tx, ingIDs)
	if err != nil {
		return nil, nil, err
	}

	reservedIng := make(map[string]decimal.Decimal)
	reservedBatch := make(map[string]decimal.Decimal)
	for _, r := range rows {
		mi := miByID[r.MenuItemID]
		if mi.IsBatchCooking != nil && *mi.IsBatchCooking {
			cur := reservedBatch[r.MenuItemID]
			reservedBatch[r.MenuItemID] = decimal.Add(cur, r.Qty)
			continue
		}
		for _, line := range tclByMenu[r.MenuItemID] {
			if line.IngredientID == nil || *line.IngredientID == "" {
				continue
			}
			key := *line.IngredientID
			add := decimal.Mul(line.Qty, effectivePortions(mi.Unit, r.Qty, mi.UnitSize))
			// Приводим резерв в единицу склада ингредиента (как stock в stockcheck),
			// с учётом per-unit фактора (штучный склад vs весовой рецепт).
			add = ingConvByID[key].toStock(add, deref(line.Unit))
			cur := reservedIng[key]
			reservedIng[key] = decimal.Add(cur, add)
		}
	}
	return reservedIng, reservedBatch, nil
}

// formatShortages — собирает русскоязычное сообщение.
// Зеркало v1 supabase-queries.ts: «Недостаточно ингредиентов (N): a; b; c и ещё M...»
func formatShortages(shortages []string) string {
	n := len(shortages)
	head := shortages
	suffix := ""
	if n > 3 {
		head = shortages[:3]
		suffix = "; и ещё " + itoa(n-3) + "..."
	}
	msg := "Недостаточно ингредиентов (" + itoa(n) + "): "
	for i, s := range head {
		if i > 0 {
			msg += "; "
		}
		msg += s
	}
	msg += suffix
	return msg
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

// techCardCogs — себестоимость блюда по тех-карте: Σ (расход × цена ингредиента)
// с конвертацией единиц (units.Convert) и учётом waste (1/(1-waste/100)).
// Зеркало фронтового calcCogsFromTechCard (lib/queries/_mappers.ts). Semi-строки
// не учитываются (как и на фронте). 0 — если тех-карты/цен нет.
func techCardCogs(tx *gorm.DB, mi models.MenuItem) decimal.Decimal {
	if mi.RestaurantID == nil {
		return decimal.Zero
	}
	var lines []models.TechCardLine
	if err := tx.Where("restaurant_id = ? AND menu_item_id = ?", *mi.RestaurantID, mi.ID).
		Find(&lines).Error; err != nil {
		return decimal.Zero
	}
	ids := make([]string, 0, len(lines))
	for _, l := range lines {
		if l.IngredientID != nil && *l.IngredientID != "" {
			ids = append(ids, *l.IngredientID)
		}
	}
	if len(ids) == 0 {
		return decimal.Zero
	}
	var ings []models.Ingredient
	if err := tx.Where("id IN ?", ids).Find(&ings).Error; err != nil {
		return decimal.Zero
	}
	byID := make(map[string]models.Ingredient, len(ings))
	for _, i := range ings {
		byID[i.ID] = i
	}
	hundred := decimal.FromInt(100)
	one := decimal.FromInt(1)
	total := decimal.Zero
	for _, l := range lines {
		if l.IngredientID == nil {
			continue
		}
		ing, ok := byID[*l.IngredientID]
		if !ok {
			continue
		}
		qty := l.Qty
		if ing.WastePercent.IsPositive() {
			divisor := decimal.Sub(one, decimal.DivRound(ing.WastePercent, hundred))
			if divisor.IsPositive() {
				qty = decimal.DivRound(qty, divisor)
			}
		}
		qtyStock := units.ConvertToStock(qty, deref(l.Unit), deref(ing.Unit), ing.UnitWeight, deref(ing.UnitWeightUnit))
		total = decimal.Add(total, decimal.Mul(qtyStock, ing.PricePerUnit))
	}
	return decimal.Normalize(total)
}
