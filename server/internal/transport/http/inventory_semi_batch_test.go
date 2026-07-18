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

// Н1: инвентаризация полуфабрикатов и готовых заготовок. Раньше считались только
// ингредиенты — усадка п/ф и заготовок не измерялась. Проверяем: остаток
// обновляется до факта, стоимость недостачи проводится в списание.
func TestInventory_SemiAndBatch(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb := openTestDB(t)

	// Полуфабрикат: 10 при цене 5.
	semiID, sn, su := uuid.NewString(), "Тесто", "кг"
	if err := gdb.Create(&models.SemiFinishedStock{
		ID: semiID, Name: &sn, Unit: &su, Qty: decimal.MustFromString("10"),
		PricePerUnit: decimal.MustFromString("5"), RestaurantID: &f.rid,
	}).Error; err != nil {
		t.Fatal(err)
	}
	// Заготовка блюда: prepared_qty 8, cogs 20.
	batchID, bn := uuid.NewString(), "Пицца-заготовка"
	pq := 8
	if err := gdb.Create(&models.MenuItem{
		ID: batchID, Name: &bn, PreparedQty: &pq, COGS: decimal.MustFromString("20"), RestaurantID: &f.rid,
	}).Error; err != nil {
		t.Fatal(err)
	}

	// Инвентаризация: п/ф факт 7 (недостача 3×5=15), заготовка факт 5 (недостача 3×20=60).
	r, b := f.post(t, "/api/v1/stock/inventory", tok, uuid.NewString(), map[string]any{
		"lines": []map[string]any{
			{"ingredient_id": semiID, "kind": "semi", "actual_qty": "7"},
			{"ingredient_id": batchID, "kind": "batch", "actual_qty": "5"},
		},
	})
	if r.StatusCode != http.StatusCreated && r.StatusCode != http.StatusOK {
		t.Fatalf("create: %d %s", r.StatusCode, b)
	}
	var chk models.InventoryCheck
	if err := json.Unmarshal(b, &chk); err != nil {
		t.Fatal(err)
	}
	if r, b := f.post(t, "/api/v1/stock/inventory/"+chk.ID+"/apply", tok, uuid.NewString(), map[string]any{}); r.StatusCode != http.StatusOK {
		t.Fatalf("apply: %d %s", r.StatusCode, b)
	}

	// Остатки обновились до факта.
	var semi models.SemiFinishedStock
	gdb.Where("id = ?", semiID).First(&semi)
	if !semi.Qty.Equal(decimal.MustFromString("7")) {
		t.Errorf("semi qty после инвент = %s, want 7", semi.Qty)
	}
	var mi models.MenuItem
	gdb.Where("id = ?", batchID).First(&mi)
	if mi.PreparedQty == nil || *mi.PreparedQty != 5 {
		t.Errorf("batch prepared_qty после инвент = %v, want 5", mi.PreparedQty)
	}

	// Недостача 15+60=75 зафиксирована списанием (в ОПиУ строкой «Списания»).
	var wos []models.StockWriteoff
	gdb.Where("restaurant_id = ? AND reason = ?", f.rid, "inventory_shortage").Find(&wos)
	total := decimal.Zero
	for _, w := range wos {
		total = decimal.Add(total, w.TotalCost)
	}
	if !decimal.Normalize(total).Equal(decimal.MustFromString("75")) {
		t.Errorf("недостача = %s, want 75 (п/ф 15 + заготовка 60)", decimal.Normalize(total))
	}
}
