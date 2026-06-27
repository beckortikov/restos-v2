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

// Баланс должен сам (на бэке) считать денежные средства (счета) и стоимость
// склада (Σ остаток × цена), а фронт — только показывать. Раньше эти суммы
// считались на фронте.
func TestBalance_AutoCashAndInventory(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _ := db.Open(testDSN())
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})

	accName, accType := "Касса", "cash"
	if err := gdb.Create(&models.FinancialAccount{
		ID: uuid.NewString(), Name: &accName, Type: &accType, RestaurantID: &f.rid,
		Balance: decimal.MustFromString("500"),
	}).Error; err != nil {
		t.Fatal(err)
	}
	ingName, ingUnit := "Гуш", "кг"
	if err := gdb.Create(&models.Ingredient{
		ID: uuid.NewString(), Name: &ingName, Unit: &ingUnit, RestaurantID: &f.rid,
		Qty: decimal.MustFromString("3"), PricePerUnit: decimal.MustFromString("100"),
	}).Error; err != nil {
		t.Fatal(err)
	}
	// Полуфабрикат: 2 × 50 = 100 → входит в стоимость склада.
	semiName := "Бульон"
	if err := gdb.Create(&models.SemiFinishedStock{
		ID: uuid.NewString(), Name: &semiName, RestaurantID: &f.rid,
		Qty: decimal.MustFromString("2"), PricePerUnit: decimal.MustFromString("50"),
	}).Error; err != nil {
		t.Fatal(err)
	}
	// Долг поставщику 200.
	supName := "Поставщик"
	if err := gdb.Create(&models.Supplier{
		ID: uuid.NewString(), Name: &supName, RestaurantID: &f.rid,
		CurrentDebt: decimal.MustFromString("200"),
	}).Error; err != nil {
		t.Fatal(err)
	}

	resp, b := f.get(t, "/api/v1/finance/balance", tok)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("balance: %d %s", resp.StatusCode, b)
	}
	var out struct {
		CashTotal      decimal.Decimal `json:"cash_total"`
		InventoryValue decimal.Decimal `json:"inventory_value"`
		SupplierDebt   decimal.Decimal `json:"supplier_debt"`
		Accounts       []struct {
			Name string `json:"name"`
		} `json:"accounts"`
	}
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	if !out.CashTotal.Equal(decimal.MustFromString("500")) {
		t.Fatalf("cash_total = %s, ожидали 500", decimal.Normalize(out.CashTotal).String())
	}
	// Склад = ингредиенты (3×100=300) + полуфабрикаты (2×50=100) = 400.
	if !out.InventoryValue.Equal(decimal.MustFromString("400")) {
		t.Fatalf("inventory_value = %s, ожидали 400 (ингредиенты 300 + п/ф 100)", decimal.Normalize(out.InventoryValue).String())
	}
	if !out.SupplierDebt.Equal(decimal.MustFromString("200")) {
		t.Fatalf("supplier_debt = %s, ожидали 200", decimal.Normalize(out.SupplierDebt).String())
	}
	if len(out.Accounts) != 1 {
		t.Fatalf("accounts: ожидали 1 счёт, получили %d", len(out.Accounts))
	}
}
