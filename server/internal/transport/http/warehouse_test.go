//go:build integration

package http_test

import (
	"encoding/json"
	"testing"

	"github.com/google/uuid"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// Мультисклад Ф1: GET /warehouses отдаёт 3 фиксированных склада (создаются
// лениво через ensureWarehouses — тестовый ресторан появился после миграции),
// а новый товар-еда автоматически привязывается к складу «Продукты».
func TestWarehouses_ListThree_AndNewIngredientAutoAssigned(t *testing.T) {
	f := setupE2E(t)
	gdb, _, _, _ := seedForWrite(t, f)
	tok := f.login(t)

	r, b := f.get(t, "/api/v1/warehouses", tok)
	if r.StatusCode != 200 {
		t.Fatalf("list %d: %s", r.StatusCode, b)
	}
	var env struct {
		Data []struct {
			Kind string `json:"kind"`
		} `json:"data"`
	}
	_ = json.Unmarshal(b, &env)
	if len(env.Data) != 3 {
		t.Fatalf("складов = %d, ожидали 3", len(env.Data))
	}
	kinds := map[string]bool{}
	for _, w := range env.Data {
		kinds[w.Kind] = true
	}
	for _, k := range []string{"products", "purchased", "supplies"} {
		if !kinds[k] {
			t.Errorf("нет склада kind=%s", k)
		}
	}

	// Новый товар-еда → склад «Продукты».
	cr, cb := f.post(t, "/api/v1/stock/ingredients", tok, uuid.NewString(), map[string]any{
		"name": "Помидор", "unit": "kg", "is_food": true,
	})
	if cr.StatusCode != 201 && cr.StatusCode != 200 {
		t.Fatalf("create ingredient %d: %s", cr.StatusCode, cb)
	}
	var ing struct {
		WarehouseID *string `json:"warehouse_id"`
	}
	_ = json.Unmarshal(cb, &ing)
	if ing.WarehouseID == nil {
		t.Fatalf("новый товар без склада (warehouse_id nil)")
	}
	var w models.Warehouse
	if err := gdb.First(&w, "id = ?", *ing.WarehouseID).Error; err != nil {
		t.Fatal(err)
	}
	if w.Kind == nil || *w.Kind != "products" {
		t.Errorf("товар-еда привязан к kind=%v, ожидали products", w.Kind)
	}
}

// Ф1 2b: движение товара централизованно наследует warehouse_id склада товара
// (BeforeCreate-хук на StockMovement) — без явного указания в месте создания.
// Это защита от регрессии авто-списания: продажа/приёмка/списание знают склад.
func TestStockMovement_InheritsWarehouseFromIngredient(t *testing.T) {
	f := setupE2E(t)
	gdb, _, _, _ := seedForWrite(t, f)
	tok := f.login(t)

	_, cb := f.post(t, "/api/v1/stock/ingredients", tok, uuid.NewString(), map[string]any{
		"name": "Лук", "unit": "kg", "is_food": true,
	})
	var ing struct {
		ID          string  `json:"id"`
		WarehouseID *string `json:"warehouse_id"`
	}
	_ = json.Unmarshal(cb, &ing)
	if ing.WarehouseID == nil {
		t.Fatal("товар без склада")
	}

	// Движение БЕЗ warehouse_id (эмулирует любое место: deduct/writeoff/receipt).
	// receipt +1 (не в минус — чтобы не зацепить guard enforce_stock_check).
	tp := "receipt"
	mv := &models.StockMovement{
		ID: uuid.NewString(), Type: &tp, IngredientID: &ing.ID,
		Qty: decimal.MustFromString("1"), RestaurantID: &f.rid,
	}
	if err := gdb.Create(mv).Error; err != nil {
		t.Fatal(err)
	}

	var saved models.StockMovement
	if err := gdb.First(&saved, "id = ?", mv.ID).Error; err != nil {
		t.Fatal(err)
	}
	if saved.WarehouseID == nil || *saved.WarehouseID != *ing.WarehouseID {
		t.Errorf("движение warehouse_id = %v, ожидали %v (склад товара)", saved.WarehouseID, ing.WarehouseID)
	}

	// transfer сам задаёт склад — хук не перезатирает.
	tt := "transfer"
	other := uuid.NewString()
	mv2 := &models.StockMovement{
		ID: uuid.NewString(), Type: &tt, IngredientID: &ing.ID,
		Qty: decimal.Zero, WarehouseID: &other, RestaurantID: &f.rid,
	}
	if err := gdb.Create(mv2).Error; err != nil {
		t.Fatal(err)
	}
	var saved2 models.StockMovement
	_ = gdb.First(&saved2, "id = ?", mv2.ID).Error
	if saved2.WarehouseID == nil || *saved2.WarehouseID != other {
		t.Errorf("явный warehouse_id перезатёрт хуком: %v, ожидали %s", saved2.WarehouseID, other)
	}
}
