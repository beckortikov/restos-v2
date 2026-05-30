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
	"github.com/restos/restos-v4/server/internal/pkg/stockcheck"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
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

		// Phase 19: stock + tech-card валидация (порт v1 lib/stock-check.ts).
		// Если есть нехватки — откатываемся с VALIDATION-ошибкой.
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

		order := &models.Order{
			ID:           uuid.NewString(),
			OrderNumber:  nextNum,
			RestaurantID: &rid,
			TableID:      in.TableID,
			ShiftID:      in.ShiftID,
			Type:         &typ,
			Status:       &status,
			GuestsCount:  &guests,
			Comment:      in.Comment,
			CreatedAt:    now,
			UpdatedAt:    now,
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
		if order.Status == nil || (*order.Status != "open" && *order.Status != "new") {
			return apperrors.Wrap("CONFLICT", "order is not open", nil)
		}

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
		// Запомним свежесозданные items для последующего runner-эмита.
		var newItems []models.OrderItem
		for _, it := range in.Items {
			oi, lineTotal, err := buildOrderItem(it, menuByID, modByID, &order.ID, now, tx)
			if err != nil {
				return err
			}
			newItems = append(newItems, *oi)
			extra = decimal.Add(extra, lineTotal)
		}

		order.Total = decimal.Normalize(decimal.Add(order.Total, extra))
		order.TotalWithService = order.Total
		order.UpdatedAt = now
		if err := tx.Save(&order).Error; err != nil {
			return err
		}
		// Runner-jobs только на свежедобавленные items (старые уже напечатаны).
		if err := s.enqueueRunners(tx, rid, &order, newItems, now); err != nil {
			return err
		}
		updated = &order
		buf.Add(EventOrderItemAdded, map[string]any{
			"order_id": order.ID,
			"added":    len(in.Items),
			"total":    order.Total.String(),
		})
		return nil
	})
	if err != nil {
		return nil, nil, err
	}
	s.publish(ctx, rid, buf)
	return updated, buf, nil
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
		oi.Price = d
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
	if err := tx.Create(oi).Error; err != nil {
		return nil, decimal.Zero, err
	}
	lineTotal := decimal.Normalize(decimal.Mul(oi.Price, qty))

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
		lineTotal = decimal.Add(lineTotal, decimal.Mul(modCopy.Price, qty))
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
			lineTotal = decimal.Add(lineTotal, decimal.Mul(oim.Price, qty))
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
		mm := stockcheck.MenuMeta{}
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
				Qty:          i.Qty,
				WastePercent: i.WastePercent,
				IsFood:       i.IsFood == nil || *i.IsFood,
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
	return apperrors.Wrap("VALIDATION", formatShortages(shortages), nil)
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
	for _, l := range lines {
		if l.MenuItemID != nil {
			tclByMenu[*l.MenuItemID] = append(tclByMenu[*l.MenuItemID], l)
		}
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
			add := decimal.Mul(line.Qty, r.Qty)
			key := *line.IngredientID
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
