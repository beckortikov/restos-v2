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

// Полный happy-path сборки сета: сет-пункт меню (is_bundle=true) → слот
// («Бургер», 1 из N) → опции слота, ссылающиеся на НАСТОЯЩИЕ пункты меню со
// своей ценой ВНУТРИ сета. Список слота отдаёт то, что создали.
func TestBundles_CreateSlotsAndOptions_HappyPath(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb := openTestDB(t)

	// Компоненты — настоящие пункты меню (не сами по себе сеты).
	burgerID, friesID := uuid.NewString(), uuid.NewString()
	burgerName, friesName := "Бургер", "Картошка"
	if err := gdb.Create(&models.MenuItem{
		ID: burgerID, Name: &burgerName, Price: decimal.MustFromString("25000"), RestaurantID: &f.rid,
	}).Error; err != nil {
		t.Fatal(err)
	}
	if err := gdb.Create(&models.MenuItem{
		ID: friesID, Name: &friesName, Price: decimal.MustFromString("10000"), RestaurantID: &f.rid,
	}).Error; err != nil {
		t.Fatal(err)
	}

	// Сам сет — обычный POST /menu/items с is_bundle=true (эксплуатирует
	// то же MenuItemInput.IsBundle, что и владелец в форме).
	br, bb := f.post(t, "/api/v1/menu/items", tok, uuid.NewString(),
		map[string]any{"name": "Комбо №1", "price": "40000", "is_bundle": true})
	if br.StatusCode != http.StatusCreated {
		t.Fatalf("create bundle item: %d %s", br.StatusCode, bb)
	}
	var bundleItem models.MenuItem
	if err := json.Unmarshal(bb, &bundleItem); err != nil {
		t.Fatal(err)
	}
	if !bundleItem.IsBundle {
		t.Fatalf("ожидали is_bundle=true у созданного пункта меню")
	}

	// Слот «Бургер» — обязательный, 1 из 1.
	sr, sb := f.post(t, "/api/v1/menu/bundle-slots", tok, uuid.NewString(),
		map[string]any{"bundle_menu_item_id": bundleItem.ID, "label": "Бургер", "is_required": true, "min_select": 1, "max_select": 1})
	if sr.StatusCode != http.StatusCreated {
		t.Fatalf("create slot: %d %s", sr.StatusCode, sb)
	}
	var slot models.BundleSlot
	if err := json.Unmarshal(sb, &slot); err != nil {
		t.Fatal(err)
	}

	// Опция слота: Бургер по цене 20000 ВНУТРИ сета (дешевле его же цены
	// в меню 25000 — так и задумано, скидка живёт на компоненте).
	or, ob := f.post(t, "/api/v1/menu/bundle-slot-options", tok, uuid.NewString(),
		map[string]any{"slot_id": slot.ID, "option_menu_item_id": burgerID, "price": "20000", "is_default": true})
	if or.StatusCode != http.StatusCreated {
		t.Fatalf("create option: %d %s", or.StatusCode, ob)
	}
	var opt models.BundleSlotOption
	if err := json.Unmarshal(ob, &opt); err != nil {
		t.Fatal(err)
	}
	if !opt.Price.Equal(decimal.MustFromString("20000")) {
		t.Errorf("цена опции = %s, want 20000", opt.Price.String())
	}

	// Список слота по bundle_menu_item_id — вернул наш слот.
	lr, lb := f.get(t, "/api/v1/menu/bundle-slots?bundle_menu_item_id="+bundleItem.ID, tok)
	if lr.StatusCode != http.StatusOK {
		t.Fatalf("list slots: %d %s", lr.StatusCode, lb)
	}
	var slotsEnv struct {
		Data []models.BundleSlot `json:"data"`
	}
	_ = json.Unmarshal(lb, &slotsEnv)
	if len(slotsEnv.Data) != 1 || slotsEnv.Data[0].ID != slot.ID {
		t.Fatalf("list slots: got %d, want 1 (slot %s)", len(slotsEnv.Data), slot.ID)
	}

	// Список опций по slot_id — вернул нашу опцию.
	lr2, lb2 := f.get(t, "/api/v1/menu/bundle-slot-options?slot_id="+slot.ID, tok)
	if lr2.StatusCode != http.StatusOK {
		t.Fatalf("list options: %d %s", lr2.StatusCode, lb2)
	}
	var optsEnv struct {
		Data []models.BundleSlotOption `json:"data"`
	}
	_ = json.Unmarshal(lb2, &optsEnv)
	if len(optsEnv.Data) != 1 || optsEnv.Data[0].ID != opt.ID {
		t.Fatalf("list options: got %d, want 1 (option %s)", len(optsEnv.Data), opt.ID)
	}
}

// Необязательный слот (min_select=0, is_required=false — ровно zero-value
// обоих Go-полей) должен сохраниться КАК ЕСТЬ, а не стать обязательным.
// Ablation-verified regression: BundleSlot.IsRequired/MinSelect несут
// gorm-тег default:true/default:1 — GORM Create() подменяет явный
// false/0 (совпадающий с zero-value поля) значением из тега и пишет
// подмену обратно в структуру (см. память "GORM zero-value default-tag
// gotcha"), если сервис не форсирует map-based Update поверх Create.
func TestBundles_CreateOptionalSlot_MinSelectZero(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb := openTestDB(t)

	friesID := uuid.NewString()
	friesName := "Картошка"
	if err := gdb.Create(&models.MenuItem{
		ID: friesID, Name: &friesName, Price: decimal.MustFromString("14000"), RestaurantID: &f.rid,
	}).Error; err != nil {
		t.Fatal(err)
	}
	br, bb := f.post(t, "/api/v1/menu/items", tok, uuid.NewString(),
		map[string]any{"name": "Комбо №2", "price": "40000", "is_bundle": true})
	if br.StatusCode != http.StatusCreated {
		t.Fatalf("create bundle item: %d %s", br.StatusCode, bb)
	}
	var bundleItem models.MenuItem
	_ = json.Unmarshal(bb, &bundleItem)

	sr, sb := f.post(t, "/api/v1/menu/bundle-slots", tok, uuid.NewString(),
		map[string]any{"bundle_menu_item_id": bundleItem.ID, "label": "Гарнир (по желанию)", "is_required": false, "min_select": 0, "max_select": 1})
	if sr.StatusCode != http.StatusCreated {
		t.Fatalf("create slot: %d %s", sr.StatusCode, sb)
	}
	var slot models.BundleSlot
	if err := json.Unmarshal(sb, &slot); err != nil {
		t.Fatal(err)
	}
	if slot.IsRequired {
		t.Errorf("ответ API: IsRequired=true, want false (min_select=0 — необязательный слот)")
	}
	if slot.MinSelect != 0 {
		t.Errorf("ответ API: MinSelect=%d, want 0", slot.MinSelect)
	}

	// То, что реально легло в БД, а не только то, что вернул API-ответ —
	// именно тут GORM Create() без форс-Update молча подменял значения.
	var fromDB models.BundleSlot
	if err := gdb.Where("id = ?", slot.ID).First(&fromDB).Error; err != nil {
		t.Fatal(err)
	}
	if fromDB.IsRequired {
		t.Errorf("в БД IsRequired=true, want false")
	}
	if fromDB.MinSelect != 0 {
		t.Errorf("в БД MinSelect=%d, want 0", fromDB.MinSelect)
	}
}

// Слот на пункте меню, который НЕ помечен is_bundle=true — 400, а не тихое
// создание мусорного слота на обычном блюде.
func TestBundles_Slot_RequiresBundleFlagOnMenuItem(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	_, menuItemID, _, _ := seedForWrite(t, f) // обычное блюдо, is_bundle=false по умолчанию

	r, b := f.post(t, "/api/v1/menu/bundle-slots", tok, uuid.NewString(),
		map[string]any{"bundle_menu_item_id": menuItemID, "label": "Бургер"})
	if r.StatusCode != http.StatusBadRequest {
		t.Fatalf("ожидали 400 (не is_bundle), получили %d %s", r.StatusCode, b)
	}
}

// Опция слота не может ссылаться на другой сет — резолвинг заказа не умеет
// рекурсию, блокируем на входе а не молча ломаем заказ позже.
func TestBundles_Option_RejectsNestedBundle(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)

	br, bb := f.post(t, "/api/v1/menu/items", tok, uuid.NewString(),
		map[string]any{"name": "Комбо №1", "price": "40000", "is_bundle": true})
	if br.StatusCode != http.StatusCreated {
		t.Fatalf("create outer bundle: %d %s", br.StatusCode, bb)
	}
	var outer models.MenuItem
	_ = json.Unmarshal(bb, &outer)

	br2, bb2 := f.post(t, "/api/v1/menu/items", tok, uuid.NewString(),
		map[string]any{"name": "Комбо №2", "price": "35000", "is_bundle": true})
	if br2.StatusCode != http.StatusCreated {
		t.Fatalf("create inner bundle: %d %s", br2.StatusCode, bb2)
	}
	var inner models.MenuItem
	_ = json.Unmarshal(bb2, &inner)

	sr, sb := f.post(t, "/api/v1/menu/bundle-slots", tok, uuid.NewString(),
		map[string]any{"bundle_menu_item_id": outer.ID, "label": "Вложенный сет"})
	if sr.StatusCode != http.StatusCreated {
		t.Fatalf("create slot: %d %s", sr.StatusCode, sb)
	}
	var slot models.BundleSlot
	_ = json.Unmarshal(sb, &slot)

	or, ob := f.post(t, "/api/v1/menu/bundle-slot-options", tok, uuid.NewString(),
		map[string]any{"slot_id": slot.ID, "option_menu_item_id": inner.ID, "price": "35000"})
	if or.StatusCode != http.StatusBadRequest {
		t.Fatalf("ожидали 400 (вложенный сет), получили %d %s", or.StatusCode, ob)
	}
}

// min_select > max_select — невалидная конфигурация слота, 400.
func TestBundles_Slot_RejectsInvalidBounds(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)

	br, bb := f.post(t, "/api/v1/menu/items", tok, uuid.NewString(),
		map[string]any{"name": "Комбо №1", "price": "40000", "is_bundle": true})
	if br.StatusCode != http.StatusCreated {
		t.Fatalf("create bundle: %d %s", br.StatusCode, bb)
	}
	var bundleItem models.MenuItem
	_ = json.Unmarshal(bb, &bundleItem)

	r, b := f.post(t, "/api/v1/menu/bundle-slots", tok, uuid.NewString(),
		map[string]any{"bundle_menu_item_id": bundleItem.ID, "label": "Напиток", "min_select": 3, "max_select": 1})
	if r.StatusCode != http.StatusBadRequest {
		t.Fatalf("ожидали 400 (min>max), получили %d %s", r.StatusCode, b)
	}
}

// Удаление слота каскадно удаляет его опции — не осиротевшие строки.
func TestBundles_DeleteSlot_CascadesOptions(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb := openTestDB(t)

	colaID, colaName := uuid.NewString(), "Кола"
	if err := gdb.Create(&models.MenuItem{ID: colaID, Name: &colaName, Price: decimal.MustFromString("12000"), RestaurantID: &f.rid}).Error; err != nil {
		t.Fatal(err)
	}
	br, bb := f.post(t, "/api/v1/menu/items", tok, uuid.NewString(),
		map[string]any{"name": "Комбо №1", "price": "40000", "is_bundle": true})
	if br.StatusCode != http.StatusCreated {
		t.Fatalf("create bundle: %d %s", br.StatusCode, bb)
	}
	var bundleItem models.MenuItem
	_ = json.Unmarshal(bb, &bundleItem)

	sr, sb := f.post(t, "/api/v1/menu/bundle-slots", tok, uuid.NewString(),
		map[string]any{"bundle_menu_item_id": bundleItem.ID, "label": "Напиток"})
	if sr.StatusCode != http.StatusCreated {
		t.Fatalf("create slot: %d %s", sr.StatusCode, sb)
	}
	var slot models.BundleSlot
	_ = json.Unmarshal(sb, &slot)

	or, ob := f.post(t, "/api/v1/menu/bundle-slot-options", tok, uuid.NewString(),
		map[string]any{"slot_id": slot.ID, "option_menu_item_id": colaID, "price": "10000"})
	if or.StatusCode != http.StatusCreated {
		t.Fatalf("create option: %d %s", or.StatusCode, ob)
	}
	var opt models.BundleSlotOption
	_ = json.Unmarshal(ob, &opt)

	dr, db := f.del(t, "/api/v1/menu/bundle-slots/"+slot.ID, tok, uuid.NewString())
	if dr.StatusCode != http.StatusNoContent && dr.StatusCode != http.StatusOK {
		t.Fatalf("delete slot: %d %s", dr.StatusCode, db)
	}

	var cnt int64
	gdb.Model(&models.BundleSlotOption{}).Where("id = ?", opt.ID).Count(&cnt)
	if cnt != 0 {
		t.Errorf("опция слота пережила удаление слота: count=%d", cnt)
	}
}

// Изоляция арендаторов: ресторан Б не видит и не может изменить/удалить
// слоты/опции ресторана А по прямому id.
func TestBundles_TenantIsolation(t *testing.T) {
	fA := setupE2E(t)
	tokA := fA.login(t)
	gdb := openTestDB(t)

	burgerID, burgerName := uuid.NewString(), "Бургер"
	if err := gdb.Create(&models.MenuItem{ID: burgerID, Name: &burgerName, Price: decimal.MustFromString("25000"), RestaurantID: &fA.rid}).Error; err != nil {
		t.Fatal(err)
	}
	br, bb := fA.post(t, "/api/v1/menu/items", tokA, uuid.NewString(),
		map[string]any{"name": "Комбо №1", "price": "40000", "is_bundle": true})
	if br.StatusCode != http.StatusCreated {
		t.Fatalf("create bundle: %d %s", br.StatusCode, bb)
	}
	var bundleItem models.MenuItem
	_ = json.Unmarshal(bb, &bundleItem)
	sr, sb := fA.post(t, "/api/v1/menu/bundle-slots", tokA, uuid.NewString(),
		map[string]any{"bundle_menu_item_id": bundleItem.ID, "label": "Бургер"})
	if sr.StatusCode != http.StatusCreated {
		t.Fatalf("create slot: %d %s", sr.StatusCode, sb)
	}
	var slotA models.BundleSlot
	_ = json.Unmarshal(sb, &slotA)
	or, ob := fA.post(t, "/api/v1/menu/bundle-slot-options", tokA, uuid.NewString(),
		map[string]any{"slot_id": slotA.ID, "option_menu_item_id": burgerID, "price": "20000"})
	if or.StatusCode != http.StatusCreated {
		t.Fatalf("create option: %d %s", or.StatusCode, ob)
	}
	var optA models.BundleSlotOption
	_ = json.Unmarshal(ob, &optA)

	// Второй ресторан, свой логин.
	fB := setupE2E(t)
	tokB := fB.login(t)

	// Чужой слот не виден по фильтру bundle_menu_item_id (tenant-скоуп режет).
	lr, lb := fB.get(t, "/api/v1/menu/bundle-slots?bundle_menu_item_id="+bundleItem.ID, tokB)
	if lr.StatusCode != http.StatusOK {
		t.Fatalf("list (tenant B): %d %s", lr.StatusCode, lb)
	}
	var env struct {
		Data []models.BundleSlot `json:"data"`
	}
	_ = json.Unmarshal(lb, &env)
	if len(env.Data) != 0 {
		t.Errorf("ресторан Б увидел слот ресторана А: %d записей", len(env.Data))
	}

	// Патч чужого слота — 404, не 200.
	pr, pb := fB.patch(t, "/api/v1/menu/bundle-slots/"+slotA.ID, tokB, uuid.NewString(),
		map[string]any{"label": "Взлом"})
	if pr.StatusCode != http.StatusNotFound {
		t.Fatalf("patch чужого слота: %d %s, want 404", pr.StatusCode, pb)
	}

	// Патч чужой опции — тоже 404.
	pr2, pb2 := fB.patch(t, "/api/v1/menu/bundle-slot-options/"+optA.ID, tokB, uuid.NewString(),
		map[string]any{"price": "1"})
	if pr2.StatusCode != http.StatusNotFound {
		t.Fatalf("patch чужой опции: %d %s, want 404", pr2.StatusCode, pb2)
	}

	// Удаление чужого слота — тоже 404, сам слот А остаётся цел.
	dr, db := fB.del(t, "/api/v1/menu/bundle-slots/"+slotA.ID, tokB, uuid.NewString())
	if dr.StatusCode != http.StatusNotFound {
		t.Fatalf("delete чужого слота: %d %s, want 404", dr.StatusCode, db)
	}
	var stillThere int64
	gdb.Model(&models.BundleSlot{}).Where("id = ?", slotA.ID).Count(&stillThere)
	if stillThere != 1 {
		t.Errorf("слот ресторана А пропал после чужой попытки удаления: count=%d", stillThere)
	}
}
