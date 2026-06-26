//go:build integration

package http_test

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/db"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// Интеграционные тесты на проблемы с тех-картами и списанием, описанные
// пользователем (скрины: «Шашлык» + ингредиент «Гуш»). Все три — КРАСНЫЕ:
// фиксируют целевое поведение, сейчас падают.
//
// Запуск:  go test -tags integration ./internal/transport/http/...
// (нужен тестовый Postgres — RESTOS_TEST_DSN или дефолт restos_v4_test:5432)

// ─── ПРОБЛЕМА 1: цена с накладной не садится в склад ────────────────────────
//
// «При закупке цена с накладной в склад не садится».
// CreateReceipt пишет price_per_unit в stock_receipt_lines, но НИКОГДА не
// обновляет ingredients.price_per_unit. Из-за этого «Стоимость склада»
// (qty * ingredients.price_per_unit) считается по старой цене.
func TestBug_Problem1_ReceiptPriceWritesToIngredient(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _ := db.Open(testDSN())
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})

	// Ингредиент «Гуш», стартовая цена 0.
	ingName := "Гуш"
	ingUnit := "кг"
	ingID := uuid.NewString()
	if err := gdb.Create(&models.Ingredient{
		ID: ingID, Name: &ingName, Unit: &ingUnit, RestaurantID: &f.rid,
		Qty: decimal.Zero, PricePerUnit: decimal.Zero,
	}).Error; err != nil {
		t.Fatal(err)
	}

	// Закупка: 3 кг по 100 за кг.
	resp, body := f.post(t, "/api/v1/stock/receipts", tok, uuid.NewString(), map[string]any{
		"payment_type": "paid",
		"lines": []map[string]any{
			{"ingredient_id": ingID, "name": ingName, "qty": "3", "unit": "кг", "price_per_unit": "100"},
		},
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("receipt create: %d %s", resp.StatusCode, body)
	}

	// Перечитываем ингредиент: цена должна стать 100.
	var ing models.Ingredient
	if err := gdb.Where("id = ?", ingID).First(&ing).Error; err != nil {
		t.Fatal(err)
	}
	if !ing.PricePerUnit.Equal(decimal.MustFromString("100")) {
		t.Fatalf("КРАСНЫЙ Problem 1: после закупки по 100 ожидали price_per_unit=100, получили %s "+
			"(цена с накладной не записалась в ingredients)", decimal.Normalize(ing.PricePerUnit).String())
	}
	// Контроль: qty всё-таки приросло на 3 (хук stock_movements работает).
	if !ing.Qty.Equal(decimal.MustFromString("3")) {
		t.Fatalf("ожидали qty=3 после прихода, получили %s", decimal.Normalize(ing.Qty).String())
	}
}

// TestBug_Problem1_ReceiptWeightedAverage — средневзвешенная себестоимость.
// Было 3 кг по 80; приход +3 кг по 100 → (3·80 + 3·100)/6 = 90/кг, остаток 6 кг.
func TestBug_Problem1_ReceiptWeightedAverage(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _ := db.Open(testDSN())
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})

	ingName := "Гуш"
	ingUnit := "кг"
	ingID := uuid.NewString()
	if err := gdb.Create(&models.Ingredient{
		ID: ingID, Name: &ingName, Unit: &ingUnit, RestaurantID: &f.rid,
		Qty: decimal.MustFromString("3"), PricePerUnit: decimal.MustFromString("80"),
	}).Error; err != nil {
		t.Fatal(err)
	}

	resp, body := f.post(t, "/api/v1/stock/receipts", tok, uuid.NewString(), map[string]any{
		"payment_type": "paid",
		"lines": []map[string]any{
			{"ingredient_id": ingID, "name": ingName, "qty": "3", "unit": "кг", "price_per_unit": "100"},
		},
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("receipt create: %d %s", resp.StatusCode, body)
	}

	var ing models.Ingredient
	if err := gdb.Where("id = ?", ingID).First(&ing).Error; err != nil {
		t.Fatal(err)
	}
	if !ing.PricePerUnit.Equal(decimal.MustFromString("90")) {
		t.Fatalf("ожидали средневзвешенную цену 90, получили %s", decimal.Normalize(ing.PricePerUnit).String())
	}
	if !ing.Qty.Equal(decimal.MustFromString("6")) {
		t.Fatalf("ожидали qty=6, получили %s", decimal.Normalize(ing.Qty).String())
	}
}

// TestBug_Problem1_ReceiptGramsToKgStock — приход в граммах при складе в кг:
// и количество, и цена должны лечь в единицу склада. Склад пуст; приход
// 3000 г по 0.1/г = всего 300 → 3 кг по 100/кг.
func TestBug_Problem1_ReceiptGramsToKgStock(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _ := db.Open(testDSN())
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})

	ingName := "Гуш"
	ingUnit := "кг"
	ingID := uuid.NewString()
	if err := gdb.Create(&models.Ingredient{
		ID: ingID, Name: &ingName, Unit: &ingUnit, RestaurantID: &f.rid,
		Qty: decimal.Zero, PricePerUnit: decimal.Zero,
	}).Error; err != nil {
		t.Fatal(err)
	}

	resp, body := f.post(t, "/api/v1/stock/receipts", tok, uuid.NewString(), map[string]any{
		"payment_type": "paid",
		"lines": []map[string]any{
			{"ingredient_id": ingID, "name": ingName, "qty": "3000", "unit": "г", "price_per_unit": "0.1"},
		},
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("receipt create: %d %s", resp.StatusCode, body)
	}

	var ing models.Ingredient
	if err := gdb.Where("id = ?", ingID).First(&ing).Error; err != nil {
		t.Fatal(err)
	}
	if !ing.Qty.Equal(decimal.MustFromString("3")) {
		t.Fatalf("ожидали qty=3 кг (из 3000 г), получили %s", decimal.Normalize(ing.Qty).String())
	}
	if !ing.PricePerUnit.Equal(decimal.MustFromString("100")) {
		t.Fatalf("ожидали 100/кг (300 / 3 кг), получили %s", decimal.Normalize(ing.PricePerUnit).String())
	}
}

// ─── ПРОБЛЕМА 3a: max-portions не конвертирует кг↔г ─────────────────────────
//
// «Если товар кг, но в тех-карте граммовый расход — пишет, что не хватает».
// BatchCookingService.MaxPortions делит ing.Qty (кг) на l.Qty (г) без
// конвертации: DivRound(3, 300) = 0 → «Максимум: 0 порций» (скрин).
func TestBug_Problem3_MaxPortions_KgStock_GramsRecipe(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	menuID := seedBatchShashlyk(t, f)

	resp, body := f.get(t, "/api/v1/menu/items/"+menuID+"/max-portions", tok)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("max-portions: %d %s", resp.StatusCode, body)
	}
	var out struct {
		Max         int  `json:"max"`
		HasRecipe   bool `json:"has_recipe"`
		Ingredients []struct {
			Name       string `json:"name"`
			Unit       string `json:"unit"`
			RecipeUnit string `json:"recipe_unit"`
		} `json:"ingredients"`
		Blockers []struct {
			Name string `json:"name"`
		} `json:"blockers"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatal(err)
	}

	// 3 кг = 3000 г, рецепт 300 г/порц → должно хватать на 10 порций.
	if out.Max != 10 {
		t.Fatalf("ожидали max=10 (3кг/300г), получили max=%d, blockers=%+v", out.Max, out.Blockers)
	}
	if len(out.Blockers) != 0 {
		t.Fatalf("ожидали 0 блокеров, получили %+v", out.Blockers)
	}
	// Problem 2: блюдо с техкартой должно помечаться has_recipe=true + полный список.
	if !out.HasRecipe {
		t.Fatalf("Problem 2: ожидали has_recipe=true для блюда с техкартой")
	}
	if len(out.Ingredients) != 1 || out.Ingredients[0].Unit != "кг" || out.Ingredients[0].RecipeUnit != "г" {
		t.Fatalf("Problem 2: ожидали 1 ингредиент с unit=кг recipe_unit=г, получили %+v", out.Ingredients)
	}
}

// ─── ПРОБЛЕМА 3b: produce списывает граммы как килограммы ────────────────────
//
// «После приготовления со склада списывается» — но в неверном объёме.
// Produce списывает l.Qty*qty = 300*1 = 300 «единиц» из остатка в кг (3 кг),
// уводя склад в -297 вместо 3 − 0.3 = 2.7 кг.
func TestBug_Problem3_Produce_DeductsConvertedUnits(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	menuID := seedBatchShashlyk(t, f)
	gdb, _ := db.Open(testDSN())
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})

	resp, body := f.post(t, "/api/v1/menu/items/"+menuID+"/batch/produce", tok, uuid.NewString(),
		map[string]any{"qty": 1})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("produce: %d %s", resp.StatusCode, body)
	}

	var ing models.Ingredient
	if err := gdb.Where("restaurant_id = ? AND name = ?", f.rid, "Гуш").First(&ing).Error; err != nil {
		t.Fatal(err)
	}
	// 3 кг − 300 г(=0.3 кг) = 2.7 кг.
	if !ing.Qty.Equal(decimal.MustFromString("2.7")) {
		t.Fatalf("КРАСНЫЙ Problem 3b: после приготовления 1 порции (300 г) из 3 кг ожидали 2.7 кг, "+
			"получили %s (Produce списывает граммы как килограммы)", decimal.Normalize(ing.Qty).String())
	}
}

// seedBatchShashlyk создаёт ингредиент «Гуш» (3 кг) + заготовочное блюдо
// «Шашлык» с тех-картой «Гуш 300 г». Возвращает menu_item_id.
func seedBatchShashlyk(t *testing.T, f *e2eFixture) string {
	t.Helper()
	gdb, _ := db.Open(testDSN())
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})

	ingName := "Гуш"
	ingUnit := "кг"
	ingID := uuid.NewString()
	if err := gdb.Create(&models.Ingredient{
		ID: ingID, Name: &ingName, Unit: &ingUnit, RestaurantID: &f.rid,
		Qty: decimal.MustFromString("3"), // 3 кг на складе
	}).Error; err != nil {
		t.Fatal(err)
	}

	batch := true
	miName := "Шашлык"
	miID := uuid.NewString()
	if err := gdb.Create(&models.MenuItem{
		ID: miID, Name: &miName, Price: decimal.MustFromString("20"),
		IsBatchCooking: &batch, RestaurantID: &f.rid,
	}).Error; err != nil {
		t.Fatal(err)
	}

	tclName := ingName
	gramUnit := "г"
	if err := gdb.Create(&models.TechCardLine{
		ID: uuid.NewString(), MenuItemID: &miID, IngredientID: &ingID,
		Name: &tclName, Qty: decimal.MustFromString("300"), // 300 ГРАММ на порцию
		Unit: &gramUnit, RestaurantID: &f.rid,
	}).Error; err != nil {
		t.Fatal(err)
	}
	return miID
}
