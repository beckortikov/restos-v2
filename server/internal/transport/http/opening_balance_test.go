//go:build integration

package http_test

import (
	"net/http"
	"testing"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/db"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// Начальный остаток: вводим стартовый остаток → ingredients.qty растёт +
// автопроводка в капитал «взнос собственника» на стоимость (qty × цена).
func TestStock_OpeningBalance(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _ := db.Open(testDSN())
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})

	ingID, ingName, ingUnit := uuid.NewString(), "Мука", "кг"
	if err := gdb.Create(&models.Ingredient{
		ID: ingID, Name: &ingName, Unit: &ingUnit, RestaurantID: &f.rid,
		Qty: decimal.Zero, PricePerUnit: decimal.MustFromString("50"),
	}).Error; err != nil {
		t.Fatal(err)
	}

	r, b := f.post(t, "/api/v1/stock/opening-balance", tok, uuid.NewString(), map[string]any{
		"lines": []map[string]any{{"ingredient_id": ingID, "qty": "10"}},
	})
	if r.StatusCode != http.StatusOK {
		t.Fatalf("opening-balance: %d %s", r.StatusCode, b)
	}

	// Остаток вырос до 10.
	var ing models.Ingredient
	if err := gdb.Where("id = ?", ingID).First(&ing).Error; err != nil {
		t.Fatal(err)
	}
	if !ing.Qty.Equal(decimal.MustFromString("10")) {
		t.Fatalf("ожидали qty=10 после начального остатка, получили %s", decimal.Normalize(ing.Qty))
	}

	// Автопроводка в капитал на 10×50=500.
	var eqs []models.EquityEntry
	if err := gdb.Where("restaurant_id = ? AND category = ?", f.rid, "opening_inventory").Find(&eqs).Error; err != nil {
		t.Fatal(err)
	}
	if len(eqs) != 1 || !eqs[0].Amount.Equal(decimal.MustFromString("500")) {
		t.Fatalf("ожидали 1 проводку капитала на 500, получили %+v", eqs)
	}
}

// Себестоимость можно ввести (закуп по другой цене): она обновляет
// ingredient.price_per_unit и идёт в стоимость склада/капитал.
func TestStock_OpeningBalance_CustomCost(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _ := db.Open(testDSN())
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})

	ingID, ingName, ingUnit := uuid.NewString(), "Сахар", "кг"
	if err := gdb.Create(&models.Ingredient{
		ID: ingID, Name: &ingName, Unit: &ingUnit, RestaurantID: &f.rid,
		Qty: decimal.Zero, PricePerUnit: decimal.MustFromString("50"), // текущая 50
	}).Error; err != nil {
		t.Fatal(err)
	}

	// Заводим 10 по цене 60 (закуп был дороже).
	r, b := f.post(t, "/api/v1/stock/opening-balance", tok, uuid.NewString(), map[string]any{
		"lines": []map[string]any{{"ingredient_id": ingID, "qty": "10", "price": "60"}},
	})
	if r.StatusCode != http.StatusOK {
		t.Fatalf("opening-balance: %d %s", r.StatusCode, b)
	}
	var ing models.Ingredient
	gdb.Where("id = ?", ingID).First(&ing)
	if !ing.PricePerUnit.Equal(decimal.MustFromString("60")) {
		t.Fatalf("себестоимость должна обновиться до 60, получили %s", decimal.Normalize(ing.PricePerUnit))
	}
	var eqs []models.EquityEntry
	gdb.Where("restaurant_id = ? AND category = ?", f.rid, "opening_inventory").Find(&eqs)
	if len(eqs) != 1 || !eqs[0].Amount.Equal(decimal.MustFromString("600")) {
		t.Fatalf("ожидали проводку капитала на 600 (10×60), получили %+v", eqs)
	}
}
