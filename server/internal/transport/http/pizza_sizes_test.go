//go:build integration

package http_test

import (
	"encoding/json"
	"testing"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/db"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// Тесты «пицца-размеров»: библиотека шкал (size_scales), тег заготовки под
// размер (semi_finished_types.size_scale_value_id), per-variant tech-card
// редактор и регрессия на баг MaxPortions/Produce, молча игнорировавших
// строки тех-карты с SemiTypeID (тесто, соус — полуфабрикат) вместо сырья.

// ─── helpers ────────────────────────────────────────────────────────────────

// seedRawIngredient создаёт ингредиент-сырьё с остатком.
func seedRawIngredient(t *testing.T, gdb *gorm.DB, rid, name, unit, qty string) models.Ingredient {
	t.Helper()
	ing := models.Ingredient{
		ID: uuid.NewString(), Name: &name, Unit: &unit, RestaurantID: &rid,
		Qty: decimal.MustFromString(qty), PricePerUnit: decimal.MustFromString("10"),
	}
	if err := gdb.Create(&ing).Error; err != nil {
		t.Fatal(err)
	}
	return ing
}

// seedDoughType создаёт полуфабрикат «тесто» с рецептом из Flour (kg per unit dough).
func seedDoughType(t *testing.T, gdb *gorm.DB, rid, name, outputUnit string, flour models.Ingredient, kgPerUnit string) string {
	t.Helper()
	id := uuid.NewString()
	nm := name
	unit := outputUnit
	if err := gdb.Create(&models.SemiFinishedType{
		ID: id, Name: &nm, OutputUnit: &unit, RestaurantID: &rid,
		YieldPercent: decimal.MustFromString("100"),
	}).Error; err != nil {
		t.Fatal(err)
	}
	flourName := "Flour"
	if flour.Name != nil {
		flourName = *flour.Name
	}
	if err := gdb.Create(&models.SemiRecipeLine{
		ID: uuid.NewString(), SemiTypeID: &id, IngredientID: &flour.ID,
		Name: &flourName, QtyPerUnit: decimal.MustFromString(kgPerUnit), Unit: flour.Unit,
	}).Error; err != nil {
		t.Fatal(err)
	}
	return id
}

// seedBatchDishWithSemiAndIngLine создаёт batch-блюдо с двумя строками тех-карты:
// ингредиентной (сыр) и полуфабрикатной (тесто). Возвращает menuID.
func seedBatchDishWithSemiAndIngLine(t *testing.T, gdb *gorm.DB, rid, dish, semiID string, semiQtyPerPortion string, ing models.Ingredient, ingQtyPerPortion string) string {
	t.Helper()
	batch := true
	prep := 0
	miID := uuid.NewString()
	nm := dish
	if err := gdb.Create(&models.MenuItem{
		ID: miID, Name: &nm, Price: decimal.MustFromString("50"),
		IsBatchCooking: &batch, PreparedQty: &prep, RestaurantID: &rid,
	}).Error; err != nil {
		t.Fatal(err)
	}
	kg := "kg"
	semiName := "Dough"
	if err := gdb.Create(&models.TechCardLine{
		ID: uuid.NewString(), MenuItemID: &miID, SemiTypeID: &semiID,
		Name: &semiName, Qty: decimal.MustFromString(semiQtyPerPortion), Unit: &kg, RestaurantID: &rid,
	}).Error; err != nil {
		t.Fatal(err)
	}
	ingName := "Cheese"
	if ing.Name != nil {
		ingName = *ing.Name
	}
	if err := gdb.Create(&models.TechCardLine{
		ID: uuid.NewString(), MenuItemID: &miID, IngredientID: &ing.ID,
		Name: &ingName, Qty: decimal.MustFromString(ingQtyPerPortion), Unit: ing.Unit, RestaurantID: &rid,
	}).Error; err != nil {
		t.Fatal(err)
	}
	return miID
}

func semiStock(t *testing.T, gdb *gorm.DB, rid, semiID string) decimal.Decimal {
	t.Helper()
	var st models.SemiFinishedStock
	if err := gdb.Where("restaurant_id = ? AND semi_type_id = ?", rid, semiID).First(&st).Error; err != nil {
		return decimal.Zero
	}
	return st.Qty
}

// ─── regression: MaxPortions/Produce must not ignore SemiTypeID lines ──────

// TestBatch_MaxPortions_ConsidersSemiLine — регрессия: раньше строка тех-карты
// с SemiTypeID (тесто) молча пропускалась в MaxPortions, поэтому нехватка
// заготовки никогда не ограничивала «максимум порций» и не попадала в
// blockers/ingredients. Готовим Dough=1kg (хватит на 5 порций при 0.2kg/порц),
// сыра — только на 2 порции (bottleneck) → Max должен быть 2, а не «бесконечность
// от игнорируемой строки заготовки», и полуфабрикат обязан появиться в списке.
func TestBatch_MaxPortions_ConsidersSemiLine(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _ := db.Open(testDSN())
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})

	flour := seedRawIngredient(t, gdb, f.rid, "Flour", "kg", "1000")
	doughID := seedDoughType(t, gdb, f.rid, "Dough", "kg", flour, "0.5")
	cheese := seedRawIngredient(t, gdb, f.rid, "Cheese", "kg", "1") // 1kg / 0.5kg-portion = 2 portions

	// Готовая заготовка теста: 1 kg → 1/0.2 = 5 порций возможно по тесту.
	rp, bp := f.post(t, "/api/v1/semi/prepare", tok, uuid.NewString(),
		map[string]any{"semi_type_id": doughID, "qty": "1"})
	if rp.StatusCode != 200 {
		t.Fatalf("prepare dough: %d %s", rp.StatusCode, bp)
	}

	menuID := seedBatchDishWithSemiAndIngLine(t, gdb, f.rid, "Pizza", doughID, "0.2", cheese, "0.5")

	r, b := f.get(t, "/api/v1/menu/items/"+menuID+"/max-portions", tok)
	if r.StatusCode != 200 {
		t.Fatalf("max-portions: %d %s", r.StatusCode, b)
	}
	var out struct {
		Max         int  `json:"max"`
		HasRecipe   bool `json:"has_recipe"`
		Ingredients []struct {
			IngredientID     string `json:"ingredient_id"`
			SemiTypeID       string `json:"semi_type_id"`
			Name             string `json:"name"`
			PossiblePortions int    `json:"possible_portions"`
			IsBottleneck     bool   `json:"is_bottleneck"`
		} `json:"ingredients"`
		Blockers []struct {
			Name string `json:"name"`
		} `json:"blockers"`
	}
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	if !out.HasRecipe {
		t.Fatalf("ожидали has_recipe=true")
	}
	if len(out.Ingredients) != 2 {
		t.Fatalf("баг регрессия: строка с semi_type_id молча пропущена — ожидали 2 строки (тесто+сыр), получили %+v", out.Ingredients)
	}
	var semiRow, cheeseRow *struct {
		IngredientID     string `json:"ingredient_id"`
		SemiTypeID       string `json:"semi_type_id"`
		Name             string `json:"name"`
		PossiblePortions int    `json:"possible_portions"`
		IsBottleneck     bool   `json:"is_bottleneck"`
	}
	for i := range out.Ingredients {
		if out.Ingredients[i].SemiTypeID == doughID {
			semiRow = &out.Ingredients[i]
		}
		if out.Ingredients[i].IngredientID == cheese.ID {
			cheeseRow = &out.Ingredients[i]
		}
	}
	if semiRow == nil {
		t.Fatalf("строка полуфабриката (тесто) отсутствует в ответе: %+v", out.Ingredients)
	}
	if semiRow.PossiblePortions != 5 {
		t.Errorf("тесто: ожидали possible_portions=5 (1kg/0.2kg), получили %d", semiRow.PossiblePortions)
	}
	if cheeseRow == nil {
		t.Fatalf("строка сыра отсутствует в ответе")
	}
	// Сыр — бутылочное горлышко (2 < 5).
	if out.Max != 2 {
		t.Fatalf("ожидали max=2 (сыр — бутылочное горлышко), получили max=%d, ingredients=%+v", out.Max, out.Ingredients)
	}
	if !cheeseRow.IsBottleneck || semiRow.IsBottleneck {
		t.Errorf("ожидали is_bottleneck на сыре, не на тесте: сыр=%v тесто=%v", cheeseRow.IsBottleneck, semiRow.IsBottleneck)
	}
}

// TestBatch_Produce_ConsumesReadySemiStock_NotRaw — регрессия для Produce:
// раньше строка SemiTypeID молча пропускалась при списании — заготовка
// никогда не расходовалась при партионной готовке. Заготовки достаточно →
// Produce обязан списать именно semi_finished_stock (deductSemiForSale),
// сырьё (мука) трогать НЕ должен (иначе двойное списание при последующей
// продаже уже приготовленной порции).
func TestBatch_Produce_ConsumesReadySemiStock_NotRaw(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _ := db.Open(testDSN())
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})

	flour := seedRawIngredient(t, gdb, f.rid, "Flour", "kg", "1000")
	doughID := seedDoughType(t, gdb, f.rid, "Dough", "kg", flour, "2") // 2kg flour per 1kg dough
	cheese := seedRawIngredient(t, gdb, f.rid, "Cheese", "kg", "100")

	// Prepare 5kg dough → flour 1000 - 5*2 = 990.
	rp, bp := f.post(t, "/api/v1/semi/prepare", tok, uuid.NewString(),
		map[string]any{"semi_type_id": doughID, "qty": "5"})
	if rp.StatusCode != 200 {
		t.Fatalf("prepare dough: %d %s", rp.StatusCode, bp)
	}
	flourAfterPrep := ingQty(t, gdb, flour.ID)
	if !flourAfterPrep.Equal(decimal.MustFromString("990")) {
		t.Fatalf("flour after prepare = %s, want 990", flourAfterPrep.String())
	}

	menuID := seedBatchDishWithSemiAndIngLine(t, gdb, f.rid, "Pizza", doughID, "0.5", cheese, "0.1")

	// Produce 4 порции: нужно 4*0.5 = 2kg dough из 5kg готового остатка.
	r, b := f.post(t, "/api/v1/menu/items/"+menuID+"/batch/produce", tok, uuid.NewString(),
		map[string]any{"qty": 4})
	if r.StatusCode != 200 {
		t.Fatalf("produce: %d %s", r.StatusCode, b)
	}
	var mi models.MenuItem
	if err := gdb.Where("id = ?", menuID).First(&mi).Error; err != nil {
		t.Fatal(err)
	}
	if mi.PreparedQty == nil || *mi.PreparedQty != 4 {
		t.Fatalf("ожидали prepared_qty=4, получили %v", mi.PreparedQty)
	}
	if got := semiStock(t, gdb, f.rid, doughID); !got.Equal(decimal.MustFromString("3")) {
		t.Errorf("баг регрессия: тесто должно списаться с готового остатка (5 - 2 = 3), получили %s", got.String())
	}
	if got := ingQty(t, gdb, flour.ID); !got.Equal(flourAfterPrep) {
		t.Errorf("баг регрессия (двойное списание): мука не должна измениться при Produce (уже списана на Prepare), получили %s хотим %s",
			got.String(), flourAfterPrep.String())
	}
}

// TestBatch_Produce_CascadesSemiToRawWhenNoStock — без готового остатка
// заготовки Produce обязан разузловать полуфабрикатную строку в сырьё
// (cascadeSemiDeduct), а не молча проигнорировать её (это и был баг: раньше
// заготовка вообще нигде не списывалась при партионной готовке).
func TestBatch_Produce_CascadesSemiToRawWhenNoStock(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _ := db.Open(testDSN())
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})

	flour := seedRawIngredient(t, gdb, f.rid, "Flour", "kg", "1000")
	doughID := seedDoughType(t, gdb, f.rid, "Dough", "kg", flour, "2") // 2kg flour per 1kg dough
	cheese := seedRawIngredient(t, gdb, f.rid, "Cheese", "kg", "100")

	menuID := seedBatchDishWithSemiAndIngLine(t, gdb, f.rid, "Pizza", doughID, "0.5", cheese, "0.1")

	// Никакой заготовки не готовили → Produce 2 порции должен каскадом уйти
	// в муку: нужно 2*0.5 = 1kg теста / yield(100%) × 2kg муки = 2kg муки.
	r, b := f.post(t, "/api/v1/menu/items/"+menuID+"/batch/produce", tok, uuid.NewString(),
		map[string]any{"qty": 2})
	if r.StatusCode != 200 {
		t.Fatalf("produce: %d %s", r.StatusCode, b)
	}
	var mi models.MenuItem
	if err := gdb.Where("id = ?", menuID).First(&mi).Error; err != nil {
		t.Fatal(err)
	}
	if mi.PreparedQty == nil || *mi.PreparedQty != 2 {
		t.Fatalf("ожидали prepared_qty=2, получили %v", mi.PreparedQty)
	}
	if got := ingQty(t, gdb, flour.ID); !got.Equal(decimal.MustFromString("998")) {
		t.Fatalf("баг регрессия: без готовой заготовки Produce обязан разузловать в сырьё (1000 - 2 = 998), получили %s — "+
			"строка с semi_type_id молча проигнорирована", got.String())
	}
	if got := semiStock(t, gdb, f.rid, doughID); !got.IsZero() {
		t.Errorf("остаток заготовки должен остаться 0 (её не готовили), получили %s", got.String())
	}
}

// ─── semi_finished_types.size_scale_value_id tagging ───────────────────────

// TestSemiFinishedTypes_SizeScaleValueTag_CRUD — заготовку можно тегировать
// значением шкалы размеров («Тесто-30» → значение «30»), тег можно сменить
// и явно очистить пустой строкой.
func TestSemiFinishedTypes_SizeScaleValueTag_CRUD(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	scale := createSizeScale(t, f, tok, "Пиццы 25/30", "25", "30")
	if len(scale.Values) != 2 {
		t.Fatalf("ожидали 2 значения шкалы, получили %+v", scale.Values)
	}
	v25, v30 := scale.Values[0], scale.Values[1]

	create := map[string]any{
		"name": "Тесто-25", "output_unit": "kg", "size_scale_value_id": v25.ID,
	}
	r, b := f.post(t, "/api/v1/semi/types", tok, uuid.NewString(), create)
	if r.StatusCode != 201 {
		t.Fatalf("create semi type: %d %s", r.StatusCode, b)
	}
	var sft struct {
		ID               string  `json:"id"`
		Name             string  `json:"name"`
		SizeScaleValueID *string `json:"size_scale_value_id"`
	}
	if err := json.Unmarshal(b, &sft); err != nil {
		t.Fatal(err)
	}
	if sft.SizeScaleValueID == nil || *sft.SizeScaleValueID != v25.ID {
		t.Fatalf("ожидали size_scale_value_id=%s, получили %+v", v25.ID, sft.SizeScaleValueID)
	}

	// Список должен содержать тег.
	rl, bl := f.get(t, "/api/v1/semi/types", tok)
	if rl.StatusCode != 200 {
		t.Fatalf("list semi types: %d %s", rl.StatusCode, bl)
	}
	var list struct {
		Data []struct {
			ID               string  `json:"id"`
			SizeScaleValueID *string `json:"size_scale_value_id"`
		} `json:"data"`
	}
	_ = json.Unmarshal(bl, &list)
	found := false
	for _, row := range list.Data {
		if row.ID == sft.ID {
			found = true
			if row.SizeScaleValueID == nil || *row.SizeScaleValueID != v25.ID {
				t.Errorf("в списке ожидали тег %s, получили %+v", v25.ID, row.SizeScaleValueID)
			}
		}
	}
	if !found {
		t.Fatalf("созданный тип не найден в списке: %+v", list.Data)
	}

	// Смена тега на значение «30».
	rp, bp := f.patch(t, "/api/v1/semi/types/"+sft.ID, tok, uuid.NewString(),
		map[string]any{"size_scale_value_id": v30.ID})
	if rp.StatusCode != 200 {
		t.Fatalf("patch semi type: %d %s", rp.StatusCode, bp)
	}
	var patched struct {
		SizeScaleValueID *string `json:"size_scale_value_id"`
	}
	_ = json.Unmarshal(bp, &patched)
	if patched.SizeScaleValueID == nil || *patched.SizeScaleValueID != v30.ID {
		t.Fatalf("ожидали смену тега на %s, получили %+v", v30.ID, patched.SizeScaleValueID)
	}

	// Явная очистка тега пустой строкой.
	rc, bc := f.patch(t, "/api/v1/semi/types/"+sft.ID, tok, uuid.NewString(),
		map[string]any{"size_scale_value_id": ""})
	if rc.StatusCode != 200 {
		t.Fatalf("patch clear tag: %d %s", rc.StatusCode, bc)
	}
	var cleared struct {
		SizeScaleValueID *string `json:"size_scale_value_id"`
	}
	_ = json.Unmarshal(bc, &cleared)
	if cleared.SizeScaleValueID != nil {
		t.Fatalf("ожидали size_scale_value_id=nil после очистки, получили %v", *cleared.SizeScaleValueID)
	}
}

// ─── per-variant tech-card editor: pizza sizes end-to-end ──────────────────

// createSemiType — вспомогательный POST /api/v1/semi/types.
func createSemiType(t *testing.T, f *e2eFixture, tok, name, outputUnit, sizeScaleValueID string) string {
	t.Helper()
	r, b := f.post(t, "/api/v1/semi/types", tok, uuid.NewString(), map[string]any{
		"name": name, "output_unit": outputUnit, "size_scale_value_id": sizeScaleValueID,
	})
	if r.StatusCode != 201 {
		t.Fatalf("create semi type %s: %d %s", name, r.StatusCode, b)
	}
	var out struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(b, &out)
	return out.ID
}

// createTechCardSemiLine — вспомогательный POST /api/v1/menu/tech-cards
// с строкой на полуфабрикат (используется per-variant tech-card editor'ом).
func createTechCardSemiLine(t *testing.T, f *e2eFixture, tok, menuItemID, semiTypeID, name, qty, unit string) {
	t.Helper()
	r, b := f.post(t, "/api/v1/menu/tech-cards", tok, uuid.NewString(), map[string]any{
		"menu_item_id": menuItemID, "semi_type_id": semiTypeID, "name": name, "qty": qty, "unit": unit,
	})
	if r.StatusCode != 201 {
		t.Fatalf("create tech-card line (%s): %d %s", name, r.StatusCode, b)
	}
}

// TestPizzaSizes_PerVariantTechCardUsesMatchingDough — сквозной сценарий
// фичи «размеры пиццы»: шкала «25/30» → 2 варианта продукта («Пепперони 25»,
// «Пепперони 30»), под каждый размер — свой тип теста, тегированный
// соответствующим значением шкалы, и своя строка тех-карты (per-variant
// editor: каждый вариант получает СВОЮ строку на СВОЙ semi_type_id).
// Проверяем, что max-portions/produce для одного варианта используют именно
// его тесто, не путая с тестом другого размера.
func TestPizzaSizes_PerVariantTechCardUsesMatchingDough(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _ := db.Open(testDSN())
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})

	scale := createSizeScale(t, f, tok, "Пиццы 25/30", "25", "30")
	v25, v30 := scale.Values[0], scale.Values[1]

	flour := seedRawIngredient(t, gdb, f.rid, "Flour", "kg", "1000")
	dough25 := seedDoughType(t, gdb, f.rid, "Тесто-25", "kg", flour, "1")
	dough30 := seedDoughType(t, gdb, f.rid, "Тесто-30", "kg", flour, "1")
	// Тегируем каждое тесто своим значением шкалы (UI-подсказка нужного п/ф под размер).
	if r, b := f.patch(t, "/api/v1/semi/types/"+dough25, tok, uuid.NewString(),
		map[string]any{"size_scale_value_id": v25.ID}); r.StatusCode != 200 {
		t.Fatalf("tag dough25: %d %s", r.StatusCode, b)
	}
	if r, b := f.patch(t, "/api/v1/semi/types/"+dough30, tok, uuid.NewString(),
		map[string]any{"size_scale_value_id": v30.ID}); r.StatusCode != 200 {
		t.Fatalf("tag dough30: %d %s", r.StatusCode, b)
	}

	// Продукт с батч-готовкой, чтобы варианты унаследовали is_batch_cooking.
	product := createAttrProduct(t, f, tok, "Пепперони", map[string]any{"is_batch_cooking": true})
	pid := product["id"].(string)

	payload := map[string]any{
		"attributes": []map[string]any{
			{"name": "Размер", "size_scale_id": scale.ID, "values": []map[string]any{}},
		},
		"combos": []map[string]any{
			{"labels": []string{"25"}, "price": "50"},
			{"labels": []string{"30"}, "price": "65"},
		},
	}
	r, b := f.put(t, "/api/v1/menu/items/"+pid+"/attributes", tok, uuid.NewString(), payload)
	if r.StatusCode != 200 {
		t.Fatalf("PUT attributes: %d %s", r.StatusCode, b)
	}
	var state attributesState
	if err := json.Unmarshal(b, &state); err != nil {
		t.Fatal(err)
	}
	var variant25ID, variant30ID string
	for _, v := range state.Variants {
		switch v.Name {
		case "Пепперони 25":
			variant25ID = v.ID
		case "Пепперони 30":
			variant30ID = v.ID
		}
	}
	if variant25ID == "" || variant30ID == "" {
		t.Fatalf("не нашли оба варианта: %+v", state.Variants)
	}

	// Per-variant tech-card editor: своя строка теста под каждый размер.
	createTechCardSemiLine(t, f, tok, variant25ID, dough25, "Тесто-25", "0.25", "kg")
	createTechCardSemiLine(t, f, tok, variant30ID, dough30, "Тесто-30", "0.35", "kg")

	// Готовим по 1 kg каждого теста.
	for _, doughID := range []string{dough25, dough30} {
		rp, bp := f.post(t, "/api/v1/semi/prepare", tok, uuid.NewString(),
			map[string]any{"semi_type_id": doughID, "qty": "1"})
		if rp.StatusCode != 200 {
			t.Fatalf("prepare %s: %d %s", doughID, rp.StatusCode, bp)
		}
	}

	// max-portions для варианта 25 (0.25kg/порц из 1kg) → 4 порции; никак не
	// должен использовать/учитывать тесто-30.
	r25, b25 := f.get(t, "/api/v1/menu/items/"+variant25ID+"/max-portions", tok)
	if r25.StatusCode != 200 {
		t.Fatalf("max-portions 25: %d %s", r25.StatusCode, b25)
	}
	var out25 struct {
		Max int `json:"max"`
	}
	_ = json.Unmarshal(b25, &out25)
	if out25.Max != 4 {
		t.Fatalf("вариант 25: ожидали max=4 (1kg/0.25kg), получили %d", out25.Max)
	}

	// max-portions для варианта 30 (0.35kg/порц из 1kg) → floor(1/0.35)=2.
	r30, b30 := f.get(t, "/api/v1/menu/items/"+variant30ID+"/max-portions", tok)
	if r30.StatusCode != 200 {
		t.Fatalf("max-portions 30: %d %s", r30.StatusCode, b30)
	}
	var out30 struct {
		Max int `json:"max"`
	}
	_ = json.Unmarshal(b30, &out30)
	if out30.Max != 2 {
		t.Fatalf("вариант 30: ожидали max=2 (floor(1/0.35)), получили %d", out30.Max)
	}

	// Produce 2 порции варианта 25 → списывает ИМЕННО тесто-25 (0.5kg), тесто-30 не трогает.
	rprod, bprod := f.post(t, "/api/v1/menu/items/"+variant25ID+"/batch/produce", tok, uuid.NewString(),
		map[string]any{"qty": 2})
	if rprod.StatusCode != 200 {
		t.Fatalf("produce variant25: %d %s", rprod.StatusCode, bprod)
	}
	if got := semiStock(t, gdb, f.rid, dough25); !got.Equal(decimal.MustFromString("0.5")) {
		t.Errorf("тесто-25 после produce 2 порций варианта 25: ожидали 0.5 (1 - 2*0.25), получили %s", got.String())
	}
	if got := semiStock(t, gdb, f.rid, dough30); !got.Equal(decimal.MustFromString("1")) {
		t.Errorf("тесто-30 не должно измениться produce'ом варианта 25, ожидали 1, получили %s", got.String())
	}
	var v25mi models.MenuItem
	if err := gdb.Where("id = ?", variant25ID).First(&v25mi).Error; err != nil {
		t.Fatal(err)
	}
	if v25mi.PreparedQty == nil || *v25mi.PreparedQty != 2 {
		t.Fatalf("вариант 25: ожидали prepared_qty=2, получили %v", v25mi.PreparedQty)
	}
}

// TestPizzaSizes_MaxPortionsUnaffectedByOtherVariantSemiStock — санити:
// GET /max-portions на конкретный вариант обязан читать ТОЛЬКО его
// собственные tech_card_lines (menu_item_id=variant), поэтому нехватка
// теста у одного размера не блокирует другой размер той же пиццы.
func TestPizzaSizes_MaxPortionsUnaffectedByOtherVariantSemiStock(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _ := db.Open(testDSN())
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})

	scale := createSizeScale(t, f, tok, "Пиццы 25/30", "25", "30")
	flour := seedRawIngredient(t, gdb, f.rid, "Flour", "kg", "1000")
	dough25 := seedDoughType(t, gdb, f.rid, "Тесто-25", "kg", flour, "1")
	dough30 := seedDoughType(t, gdb, f.rid, "Тесто-30", "kg", flour, "1")

	product := createAttrProduct(t, f, tok, "Маргарита", map[string]any{"is_batch_cooking": true})
	pid := product["id"].(string)
	payload := map[string]any{
		"attributes": []map[string]any{{"name": "Размер", "size_scale_id": scale.ID, "values": []map[string]any{}}},
		"combos": []map[string]any{
			{"labels": []string{"25"}, "price": "40"},
			{"labels": []string{"30"}, "price": "55"},
		},
	}
	r, b := f.put(t, "/api/v1/menu/items/"+pid+"/attributes", tok, uuid.NewString(), payload)
	if r.StatusCode != 200 {
		t.Fatalf("PUT attributes: %d %s", r.StatusCode, b)
	}
	var state attributesState
	_ = json.Unmarshal(b, &state)
	var variant25ID, variant30ID string
	for _, v := range state.Variants {
		switch v.Name {
		case "Маргарита 25":
			variant25ID = v.ID
		case "Маргарита 30":
			variant30ID = v.ID
		}
	}
	if variant25ID == "" || variant30ID == "" {
		t.Fatalf("не нашли оба варианта: %+v", state.Variants)
	}
	createTechCardSemiLine(t, f, tok, variant25ID, dough25, "Тесто-25", "0.25", "kg")
	createTechCardSemiLine(t, f, tok, variant30ID, dough30, "Тесто-30", "0.35", "kg")

	// Готовим тесто ТОЛЬКО для размера 25. Размер 30 остаётся без остатка.
	rp, bp := f.post(t, "/api/v1/semi/prepare", tok, uuid.NewString(),
		map[string]any{"semi_type_id": dough25, "qty": "2"})
	if rp.StatusCode != 200 {
		t.Fatalf("prepare dough25: %d %s", rp.StatusCode, bp)
	}

	r25, b25 := f.get(t, "/api/v1/menu/items/"+variant25ID+"/max-portions", tok)
	if r25.StatusCode != 200 {
		t.Fatalf("max-portions 25: %d %s", r25.StatusCode, b25)
	}
	var out25 struct {
		Max int `json:"max"`
	}
	_ = json.Unmarshal(b25, &out25)
	if out25.Max != 8 {
		t.Fatalf("вариант 25 (есть остаток): ожидали max=8 (2/0.25), получили %d", out25.Max)
	}

	r30, b30 := f.get(t, "/api/v1/menu/items/"+variant30ID+"/max-portions", tok)
	if r30.StatusCode != 200 {
		t.Fatalf("max-portions 30: %d %s", r30.StatusCode, b30)
	}
	var out30 struct {
		Max      int `json:"max"`
		Blockers []struct {
			Name string `json:"name"`
		} `json:"blockers"`
	}
	_ = json.Unmarshal(b30, &out30)
	if out30.Max != 0 {
		t.Fatalf("вариант 30 (нет остатка теста-30): ожидали max=0, получили %d — max-portions не должен путать тесто соседнего размера", out30.Max)
	}
	if len(out30.Blockers) != 1 {
		t.Fatalf("вариант 30: ожидали 1 blocker (тесто-30 без остатка), получили %+v", out30.Blockers)
	}
}
