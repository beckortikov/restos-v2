//go:build integration

package http_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/db"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// Мультисклад: товар при создании сразу попадает на СВОЙ склад —
// покупной → «Покупные товары», еда → «Продукты», хозтовар → «Хозтовары».
func TestWarehouseRouting_OnCreate(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, err := db.Open(testDSN())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if s, e := gdb.DB(); e == nil {
			_ = s.Close()
		}
	})

	// warehouseKindOf — вид склада, на котором лежит ингредиент.
	warehouseKindOf := func(t *testing.T, ingID string) string {
		t.Helper()
		var ing models.Ingredient
		if err := gdb.Where("id = ?", ingID).First(&ing).Error; err != nil {
			t.Fatal(err)
		}
		if ing.WarehouseID == nil {
			t.Fatalf("ingredient %s: warehouse_id = NULL (не привязан к складу)", ingID)
		}
		var w models.Warehouse
		if err := gdb.Where("id = ?", *ing.WarehouseID).First(&w).Error; err != nil {
			t.Fatal(err)
		}
		if w.Kind == nil {
			t.Fatal("warehouse kind = NULL")
		}
		return *w.Kind
	}

	// 1) Покупной товар → его складской ингредиент на складе 'purchased'.
	r, b := f.post(t, "/api/v1/menu/items", tok, uuid.NewString(), map[string]any{
		"name": "Кола-WH", "category": "Напитки", "price": "15",
		"is_purchased": true, "purchase_price": "10", "purchase_unit": "шт", "purchase_min_qty": "0",
	})
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("создать покупной: %d %s", r.StatusCode, b)
	}
	var created struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(b, &created)
	var line models.TechCardLine
	if err := gdb.Where("menu_item_id = ?", created.ID).First(&line).Error; err != nil {
		t.Fatal(err)
	}
	if k := warehouseKindOf(t, *line.IngredientID); k != "purchased" {
		t.Errorf("покупной товар: склад %q, ожидали 'purchased'", k)
	}

	// 2) Обычный продукт (еда) через POST /stock/ingredients → 'products'.
	r, b = f.post(t, "/api/v1/stock/ingredients", tok, uuid.NewString(), map[string]any{
		"name": "Мука-WH", "category": "Бакалея", "qty": "0", "min_qty": "0",
		"unit": "кг", "price_per_unit": "5", "is_food": true,
	})
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("создать продукт: %d %s", r.StatusCode, b)
	}
	var food struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(b, &food)
	if k := warehouseKindOf(t, food.ID); k != "products" {
		t.Errorf("продукт (еда): склад %q, ожидали 'products'", k)
	}

	// 3) Хозтовар (is_food=false) → 'supplies'.
	r, b = f.post(t, "/api/v1/stock/ingredients", tok, uuid.NewString(), map[string]any{
		"name": "Салфетки-WH", "category": "Хозтовары", "qty": "0", "min_qty": "0",
		"unit": "шт", "price_per_unit": "1", "is_food": false,
	})
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("создать хозтовар: %d %s", r.StatusCode, b)
	}
	var supply struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(b, &supply)
	if k := warehouseKindOf(t, supply.ID); k != "supplies" {
		t.Errorf("хозтовар: склад %q, ожидали 'supplies'", k)
	}

	// 4) Хук напрямую (эмуляция import/seed): ингредиент без warehouse_id →
	//    привязывается по is_food. Склады уже существуют (созданы выше).
	nonFood := false
	nm := "Плёнка-WH"
	direct := &models.Ingredient{ID: uuid.NewString(), Name: &nm, IsFood: &nonFood, RestaurantID: &f.rid}
	if err := gdb.Create(direct).Error; err != nil {
		t.Fatal(err)
	}
	if k := warehouseKindOf(t, direct.ID); k != "supplies" {
		t.Errorf("хук (не-еда): склад %q, ожидали 'supplies'", k)
	}
}

// У каждого склада свой отчёт движений: GET /stock/movements?warehouse_id=X
// возвращает только движения этого склада.
func TestWarehouseMovements_FilterByWarehouse(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, err := db.Open(testDSN())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if s, e := gdb.DB(); e == nil {
			_ = s.Close()
		}
	})

	// Продукт с qty>0 → приходное движение на складе «Продукты».
	rf, bf := f.post(t, "/api/v1/stock/ingredients", tok, uuid.NewString(), map[string]any{
		"name": "Мука-MV", "category": "Бакалея", "qty": "10", "min_qty": "0",
		"unit": "кг", "price_per_unit": "5", "is_food": true,
	})
	if rf.StatusCode != http.StatusCreated {
		t.Fatalf("создать продукт: %d %s", rf.StatusCode, bf)
	}
	var food struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(bf, &food)

	// Хозтовар с qty>0 → движение на складе «Хозтовары».
	rs, bs := f.post(t, "/api/v1/stock/ingredients", tok, uuid.NewString(), map[string]any{
		"name": "Салфетки-MV", "category": "Хоз", "qty": "20", "min_qty": "0",
		"unit": "шт", "price_per_unit": "1", "is_food": false,
	})
	if rs.StatusCode != http.StatusCreated {
		t.Fatalf("создать хозтовар: %d %s", rs.StatusCode, bs)
	}
	var supply struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(bs, &supply)

	whID := func(kind string) string {
		var w models.Warehouse
		if err := gdb.Where("restaurant_id = ? AND kind = ?", f.rid, kind).First(&w).Error; err != nil {
			t.Fatal(err)
		}
		return w.ID
	}
	prodWH, supWH := whID("products"), whID("supplies")

	// ingredientIDs — id ингредиентов в движениях склада + проверка, что каждое
	// движение действительно на этом складе.
	ingredientIDs := func(t *testing.T, warehouseID string) map[string]bool {
		t.Helper()
		_, body := f.get(t, "/api/v1/stock/movements?warehouse_id="+warehouseID, tok)
		var env struct {
			Data []struct {
				IngredientID *string `json:"ingredient_id"`
				WarehouseID  *string `json:"warehouse_id"`
			} `json:"data"`
		}
		if err := json.Unmarshal(body, &env); err != nil {
			t.Fatal(err)
		}
		ids := map[string]bool{}
		for _, d := range env.Data {
			if d.WarehouseID == nil || *d.WarehouseID != warehouseID {
				t.Errorf("движение просочилось: warehouse_id=%v, фильтр=%s", d.WarehouseID, warehouseID)
			}
			if d.IngredientID != nil {
				ids[*d.IngredientID] = true
			}
		}
		return ids
	}

	prod := ingredientIDs(t, prodWH)
	if !prod[food.ID] {
		t.Error("склад «Продукты»: нет движения продукта")
	}
	if prod[supply.ID] {
		t.Error("склад «Продукты»: просочилось движение хозтовара")
	}
	sup := ingredientIDs(t, supWH)
	if !sup[supply.ID] {
		t.Error("склад «Хозтовары»: нет движения хозтовара")
	}
	if sup[food.ID] {
		t.Error("склад «Хозтовары»: просочилось движение продукта")
	}
}

// End-to-end: покупной товар лежит на складе «Покупные товары» (новая
// маршрутизация) → продажа отражается в финансах КОРРЕКТНО (revenue-финоперация
// на сумму продажи) и списывает остаток именно с этого склада. Гарантия, что
// привязка к складу не ломает финучёт.
func TestWarehouse_PurchasedSale_FinanceCorrect(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, err := db.Open(testDSN())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if s, e := gdb.DB(); e == nil {
			_ = s.Close()
		}
	})

	// Счёт «Касса» + открытая смена.
	accID := uuid.NewString()
	accName, accType := "Касса", "cash"
	if err := gdb.Create(&models.FinancialAccount{
		ID: accID, Name: &accName, Type: &accType, RestaurantID: &f.rid, Balance: decimal.Zero,
	}).Error; err != nil {
		t.Fatal(err)
	}
	r, b := f.post(t, "/api/v1/shifts", tok, uuid.NewString(), map[string]any{"opening_balance": "0", "account_id": accID})
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("open shift %d: %s", r.StatusCode, b)
	}
	var shift models.CashShift
	_ = json.Unmarshal(b, &shift)

	// Покупной товар: цена 25, закупка 10 → его ингредиент на складе 'purchased'.
	r, b = f.post(t, "/api/v1/menu/items", tok, uuid.NewString(), map[string]any{
		"name": "Сок-FIN", "category": "Напитки", "price": "25",
		"is_purchased": true, "purchase_price": "10", "purchase_unit": "шт", "purchase_min_qty": "0",
	})
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("create purchased %d: %s", r.StatusCode, b)
	}
	var mi struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(b, &mi)

	// Backing-ингредиент + подтверждаем склад 'purchased'; кладём остаток 5.
	var line models.TechCardLine
	if err := gdb.Where("menu_item_id = ?", mi.ID).First(&line).Error; err != nil {
		t.Fatal(err)
	}
	ingID := *line.IngredientID
	var ing models.Ingredient
	if err := gdb.Where("id = ?", ingID).First(&ing).Error; err != nil {
		t.Fatal(err)
	}
	if ing.WarehouseID == nil {
		t.Fatal("покупной ингредиент без склада")
	}
	purchasedWH := *ing.WarehouseID
	var w models.Warehouse
	if err := gdb.Where("id = ?", purchasedWH).First(&w).Error; err != nil {
		t.Fatal(err)
	}
	if w.Kind == nil || *w.Kind != "purchased" {
		t.Fatalf("склад покупного = %v, ожидали 'purchased'", w.Kind)
	}
	if err := gdb.Model(&models.Ingredient{}).Where("id = ?", ingID).Update("qty", decimal.MustFromString("5")).Error; err != nil {
		t.Fatal(err)
	}

	// Заказ на 1 порцию + закрытие (нал, счёт, смена).
	r, b = f.post(t, "/api/v1/orders", tok, uuid.NewString(),
		map[string]any{"items": []map[string]any{{"menu_item_id": mi.ID, "qty": "1"}}})
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("create order %d: %s", r.StatusCode, b)
	}
	var ord models.Order
	_ = json.Unmarshal(b, &ord)
	r, b = f.post(t, fmt.Sprintf("/api/v1/orders/%s/close", ord.ID), tok, uuid.NewString(),
		map[string]any{"payment_method": "cash", "account_id": accID, "shift_id": shift.ID})
	if r.StatusCode != http.StatusOK {
		t.Fatalf("close order %d: %s", r.StatusCode, b)
	}

	// (1) revenue-финоперация на сумму продажи (25) — отражение в ДДС/ОПиУ.
	var rev models.FinancialOperation
	if err := gdb.Where("restaurant_id = ? AND source_ref = ? AND type = ? AND category = ?",
		f.rid, "order:"+ord.ID, "in", "revenue").First(&rev).Error; err != nil {
		t.Fatalf("нет revenue-финоперации для продажи покупного: %v", err)
	}
	if !rev.Amount.Equal(decimal.MustFromString("25")) {
		t.Errorf("revenue amount = %s, ожидали 25", decimal.Normalize(rev.Amount).String())
	}

	// (2) остаток покупного списался со склада: 5 → 4.
	if err := gdb.Where("id = ?", ingID).First(&ing).Error; err != nil {
		t.Fatal(err)
	}
	if !ing.Qty.Equal(decimal.MustFromString("4")) {
		t.Errorf("остаток покупного = %s, ожидали 4 (продажа списала 1)", decimal.Normalize(ing.Qty).String())
	}

	// (3) движение списания продажи ушло именно со склада «Покупные товары».
	var mv models.StockMovement
	if err := gdb.Where("ingredient_id = ? AND qty < 0", ingID).Order("created_at desc").First(&mv).Error; err != nil {
		t.Fatalf("нет движения списания продажи: %v", err)
	}
	if mv.WarehouseID == nil || *mv.WarehouseID != purchasedWH {
		t.Errorf("движение списания warehouse_id=%v, ожидали склад 'purchased' %s", mv.WarehouseID, purchasedWH)
	}
}
