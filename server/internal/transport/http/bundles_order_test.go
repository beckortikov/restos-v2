//go:build integration

package http_test

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// bundleFixture — сет «Комбо №1»: слот «Бургер» (обязателен, 1 из 1, опция
// Бургер за 20000 внутри сета — цена в меню 25000), слот «Напиток» (обязателен,
// 1 из 1, опция Кола за 10000 внутри сета — цена в меню 12000).
type bundleFixture struct {
	bundleID, burgerSlotID, drinkSlotID string
	burgerOptID, drinkOptID             string
	burgerMenuID, drinkMenuID           string
}

// setupBundleFixture создаёt реальные компоненты + сам сет + слоты + опции
// через HTTP (эксплуатирует ровно тот же путь, что владелец в форме блюда).
func setupBundleFixture(t *testing.T, f *e2eFixture, tok string) bundleFixture {
	t.Helper()
	gdb := openTestDB(t)

	burgerID, burgerName := uuid.NewString(), "Бургер"
	if err := gdb.Create(&models.MenuItem{ID: burgerID, Name: &burgerName, Price: decimal.MustFromString("25000"), RestaurantID: &f.rid}).Error; err != nil {
		t.Fatal(err)
	}
	drinkID, drinkName := uuid.NewString(), "Кола"
	if err := gdb.Create(&models.MenuItem{ID: drinkID, Name: &drinkName, Price: decimal.MustFromString("12000"), RestaurantID: &f.rid}).Error; err != nil {
		t.Fatal(err)
	}

	br, bb := f.post(t, "/api/v1/menu/items", tok, uuid.NewString(),
		map[string]any{"name": "Комбо №1", "price": "30000", "is_bundle": true})
	if br.StatusCode != http.StatusCreated {
		t.Fatalf("create bundle: %d %s", br.StatusCode, bb)
	}
	var bundleItem models.MenuItem
	_ = json.Unmarshal(bb, &bundleItem)

	sr1, sb1 := f.post(t, "/api/v1/menu/bundle-slots", tok, uuid.NewString(),
		map[string]any{"bundle_menu_item_id": bundleItem.ID, "label": "Бургер", "min_select": 1, "max_select": 1})
	if sr1.StatusCode != http.StatusCreated {
		t.Fatalf("create burger slot: %d %s", sr1.StatusCode, sb1)
	}
	var burgerSlot models.BundleSlot
	_ = json.Unmarshal(sb1, &burgerSlot)

	sr2, sb2 := f.post(t, "/api/v1/menu/bundle-slots", tok, uuid.NewString(),
		map[string]any{"bundle_menu_item_id": bundleItem.ID, "label": "Напиток", "min_select": 1, "max_select": 1})
	if sr2.StatusCode != http.StatusCreated {
		t.Fatalf("create drink slot: %d %s", sr2.StatusCode, sb2)
	}
	var drinkSlot models.BundleSlot
	_ = json.Unmarshal(sb2, &drinkSlot)

	or1, ob1 := f.post(t, "/api/v1/menu/bundle-slot-options", tok, uuid.NewString(),
		map[string]any{"slot_id": burgerSlot.ID, "option_menu_item_id": burgerID, "price": "20000", "is_default": true})
	if or1.StatusCode != http.StatusCreated {
		t.Fatalf("create burger option: %d %s", or1.StatusCode, ob1)
	}
	var burgerOpt models.BundleSlotOption
	_ = json.Unmarshal(ob1, &burgerOpt)

	or2, ob2 := f.post(t, "/api/v1/menu/bundle-slot-options", tok, uuid.NewString(),
		map[string]any{"slot_id": drinkSlot.ID, "option_menu_item_id": drinkID, "price": "10000", "is_default": true})
	if or2.StatusCode != http.StatusCreated {
		t.Fatalf("create drink option: %d %s", or2.StatusCode, ob2)
	}
	var drinkOpt models.BundleSlotOption
	_ = json.Unmarshal(ob2, &drinkOpt)

	return bundleFixture{
		bundleID: bundleItem.ID, burgerSlotID: burgerSlot.ID, drinkSlotID: drinkSlot.ID,
		burgerOptID: burgerOpt.ID, drinkOptID: drinkOpt.ID,
		burgerMenuID: burgerID, drinkMenuID: drinkID,
	}
}

func bundleSelectionBody(bf bundleFixture) map[string]any {
	return map[string]any{
		"type": "takeaway", "guests_count": 1,
		"items": []map[string]any{
			{
				"qty": "1",
				"bundle_selection": map[string]any{
					"bundle_menu_item_id": bf.bundleID,
					"slots": []map[string]any{
						{"slot_id": bf.burgerSlotID, "option_ids": []string{bf.burgerOptID}},
						{"slot_id": bf.drinkSlotID, "option_ids": []string{bf.drinkOptID}},
					},
				},
			},
		},
	}
}

// Happy path: POST /orders с bundle_selection резолвится в 2 настоящих
// order_items (Бургер+Кола), общий bundle_group_id, цена — из
// bundle_slot_options (20000+10000=30000), НЕ из меню (25000+12000=37000).
func TestBundleOrder_CreateResolves_RealItemsWithBundlePrices(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	bf := setupBundleFixture(t, f, tok)

	r, b := f.post(t, "/api/v1/orders", tok, uuid.NewString(), bundleSelectionBody(bf))
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("create order: %d %s", r.StatusCode, b)
	}
	var order models.Order
	if err := json.Unmarshal(b, &order); err != nil {
		t.Fatal(err)
	}
	if !order.Total.Equal(decimal.MustFromString("30000")) {
		t.Errorf("order.total = %s, want 30000 (цены слотов, не цены меню 37000)", order.Total.String())
	}

	gdb := openTestDB(t)
	var items []models.OrderItem
	if err := gdb.Where("order_id = ?", order.ID).Find(&items).Error; err != nil {
		t.Fatal(err)
	}
	if len(items) != 2 {
		t.Fatalf("order_items count = %d, want 2 (Бургер+Кола)", len(items))
	}

	byMenuID := map[string]models.OrderItem{}
	for _, it := range items {
		if it.MenuItemID != nil {
			byMenuID[*it.MenuItemID] = it
		}
	}
	burgerRow, ok := byMenuID[bf.burgerMenuID]
	if !ok {
		t.Fatalf("нет позиции с menu_item_id бургера — компонент не резолвился в настоящий пункт меню")
	}
	if !burgerRow.Price.Equal(decimal.MustFromString("20000")) {
		t.Errorf("цена бургера в заказе = %s, want 20000 (цена внутри сета, не 25000 из меню)", burgerRow.Price.String())
	}
	if burgerRow.BundleGroupID == nil || *burgerRow.BundleGroupID == "" {
		t.Errorf("у бургера нет bundle_group_id")
	}
	if burgerRow.BundleSlotLabel == nil || *burgerRow.BundleSlotLabel != "Бургер" {
		t.Errorf("bundle_slot_label бургера = %v, want \"Бургер\"", burgerRow.BundleSlotLabel)
	}

	drinkRow, ok := byMenuID[bf.drinkMenuID]
	if !ok {
		t.Fatalf("нет позиции с menu_item_id напитка")
	}
	if !drinkRow.Price.Equal(decimal.MustFromString("10000")) {
		t.Errorf("цена напитка в заказе = %s, want 10000", drinkRow.Price.String())
	}
	if drinkRow.BundleGroupID == nil || *drinkRow.BundleGroupID != *burgerRow.BundleGroupID {
		t.Errorf("bundle_group_id бургера и напитка не совпадают — не один сет")
	}

	// Списание техкарты не должно требовать спецкода: обе позиции — настоящие
	// menu_item_id, deductStockForOrder их найдёт по тому же пути, что обычные.
	// (Явно не проверяем сток здесь — это отдельный, уже покрытый другими
	// тестами путь; важно, что menu_item_id реальный, а это уже проверено выше.)
}

// Обязательный слот без выбора — 400, заказ не создаётся вообще (весь запрос
// в одной транзакции — партиями сет не продаётся).
func TestBundleOrder_MissingRequiredSlot_Rejected(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	bf := setupBundleFixture(t, f, tok)

	body := map[string]any{
		"type": "takeaway", "guests_count": 1,
		"items": []map[string]any{
			{
				"qty": "1",
				"bundle_selection": map[string]any{
					"bundle_menu_item_id": bf.bundleID,
					"slots": []map[string]any{
						{"slot_id": bf.burgerSlotID, "option_ids": []string{bf.burgerOptID}},
						// Напиток пропущен — обязательный слот без выбора.
					},
				},
			},
		},
	}
	r, b := f.post(t, "/api/v1/orders", tok, uuid.NewString(), body)
	if r.StatusCode != http.StatusBadRequest {
		t.Fatalf("ожидали 400 (обязательный слот пуст), получили %d %s", r.StatusCode, b)
	}

	gdb := openTestDB(t)
	var cnt int64
	gdb.Model(&models.Order{}).Where("restaurant_id = ?", f.rid).Count(&cnt)
	if cnt != 0 {
		t.Errorf("заказ создался, несмотря на 400: count=%d", cnt)
	}
}

// Опция, реально принадлежащая ДРУГОМУ слоту — отклоняется (защита от
// подмешивания чужих option_ids в чужой slot_id в запросе).
func TestBundleOrder_OptionFromWrongSlot_Rejected(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	bf := setupBundleFixture(t, f, tok)

	body := map[string]any{
		"type": "takeaway", "guests_count": 1,
		"items": []map[string]any{
			{
				"qty": "1",
				"bundle_selection": map[string]any{
					"bundle_menu_item_id": bf.bundleID,
					"slots": []map[string]any{
						// burgerOptID подставлена в drinkSlotID — опция не из этого слота.
						{"slot_id": bf.drinkSlotID, "option_ids": []string{bf.burgerOptID}},
						{"slot_id": bf.burgerSlotID, "option_ids": []string{bf.burgerOptID}},
					},
				},
			},
		},
	}
	r, b := f.post(t, "/api/v1/orders", tok, uuid.NewString(), body)
	if r.StatusCode != http.StatusBadRequest {
		t.Fatalf("ожидали 400 (опция не из этого слота), получили %d %s", r.StatusCode, b)
	}
}

// Дозаказ через AddItems резолвит сет так же, как Create — и КРИТИЧНО: если в
// заказе уже есть обычная (не из сета) Кола, компонент нового сета НЕ должен
// слиться с ней в одну строку (иначе bundle_group_id потеряется, а qty обычной
// колы вырастет вместо создания отдельной строки сета).
//
// tables_enabled=false (фастфуд-режим): Create НЕ ставит printed_at синхронно
// (бегунок на оплате, не на создании) — без этого loadMergeableItems исключил
// бы строку колы по printed_at ДО того, как дошло бы до проверки bundle_group,
// и тест ничего бы не доказывал про сам bundle-гвард.
func TestBundleOrder_AddItems_DoesNotMergeIntoExistingPlainItem(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb := openTestDB(t)
	if err := gdb.Model(&models.Restaurant{}).Where("id = ?", f.rid).
		Update("tables_enabled", false).Error; err != nil {
		t.Fatal(err)
	}
	bf := setupBundleFixture(t, f, tok)

	// Обычный заказ с обычной колой (НЕ из сета).
	cr, cb := f.post(t, "/api/v1/orders", tok, uuid.NewString(), map[string]any{
		"type": "takeaway", "guests_count": 1,
		"items": []map[string]any{{"menu_item_id": bf.drinkMenuID, "qty": "1"}},
	})
	if cr.StatusCode != http.StatusCreated {
		t.Fatalf("create order: %d %s", cr.StatusCode, cb)
	}
	var order models.Order
	_ = json.Unmarshal(cb, &order)

	// Подтверждаем, что строка колы РЕАЛЬНО осталась «сливаемой» (иначе
	// абляция гварда всё равно ничего бы не доказала).
	var plainDrink models.OrderItem
	if err := gdb.Where("order_id = ? AND menu_item_id = ?", order.ID, bf.drinkMenuID).
		First(&plainDrink).Error; err != nil {
		t.Fatal(err)
	}
	if plainDrink.PrintedAt != nil {
		t.Fatalf("printed_at уже стоит у обычной колы — тест не изолирует bundle-гвард от printed_at-гварда")
	}

	// Дозаказываем сет (тот же напиток внутри сета).
	ar, ab := f.post(t, "/api/v1/orders/"+order.ID+"/items", tok, uuid.NewString(), map[string]any{
		"items": []map[string]any{
			{
				"qty": "1",
				"bundle_selection": map[string]any{
					"bundle_menu_item_id": bf.bundleID,
					"slots": []map[string]any{
						{"slot_id": bf.burgerSlotID, "option_ids": []string{bf.burgerOptID}},
						{"slot_id": bf.drinkSlotID, "option_ids": []string{bf.drinkOptID}},
					},
				},
			},
		},
	})
	if ar.StatusCode != http.StatusOK && ar.StatusCode != http.StatusCreated {
		t.Fatalf("add items: %d %s", ar.StatusCode, ab)
	}

	var items []models.OrderItem
	if err := gdb.Where("order_id = ?", order.ID).Find(&items).Error; err != nil {
		t.Fatal(err)
	}
	// Ожидаем 3 строки: обычная кола (qty=1, без bundle_group_id) + бургер сета
	// + кола сета (qty=1 каждая, СВОЯ строка) — а не 2 (слитая кола qty=2 + бургер).
	if len(items) != 3 {
		t.Fatalf("order_items count = %d, want 3 (обычная кола + 2 компонента сета отдельно); слияние потеряло бы группу сета", len(items))
	}
	drinkRows := 0
	for _, it := range items {
		if it.MenuItemID != nil && *it.MenuItemID == bf.drinkMenuID {
			drinkRows++
			if !it.Qty.Equal(decimal.MustFromString("1")) {
				t.Errorf("строка колы qty=%s, want 1 (слияние задвоило бы qty)", it.Qty.String())
			}
		}
	}
	if drinkRows != 2 {
		t.Fatalf("строк с колой = %d, want 2 (обычная + из сета, раздельно)", drinkRows)
	}
}
