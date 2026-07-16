//go:build integration

package http_test

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/db"
	"github.com/restos/restos-v4/server/internal/db/models"
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
