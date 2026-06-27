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

// Баг: в ОПиУ COGS=0, хотя в тех-карте есть ингредиенты с ценой, а ручную
// себестоимость не задавали. Фикс: order_item.cogs считается из тех-карты,
// когда ручная себестоимость = 0.
//
// Соус: 100/кг на складе. Тех-карта: 100 г → 0.1 кг × 100 = 10 себестоимость.
func TestCogs_ComputedFromTechCard(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _ := db.Open(testDSN())
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})

	ingID := uuid.NewString()
	ingName, ingUnit := "Соус", "кг"
	if err := gdb.Create(&models.Ingredient{
		ID: ingID, Name: &ingName, Unit: &ingUnit, RestaurantID: &f.rid,
		Qty: decimal.MustFromString("10"), MinQty: decimal.Zero,
		PricePerUnit: decimal.MustFromString("100"),
	}).Error; err != nil {
		t.Fatal(err)
	}
	miID := uuid.NewString()
	miName := "Блюдо"
	if err := gdb.Create(&models.MenuItem{
		ID: miID, Name: &miName, Price: decimal.MustFromString("50"),
		COGS: decimal.Zero, RestaurantID: &f.rid, // себестоимость вручную НЕ задана
	}).Error; err != nil {
		t.Fatal(err)
	}
	tcl := ingName
	gram := "г"
	if err := gdb.Create(&models.TechCardLine{
		ID: uuid.NewString(), MenuItemID: &miID, IngredientID: &ingID,
		Name: &tcl, Qty: decimal.MustFromString("100"), Unit: &gram, RestaurantID: &f.rid,
	}).Error; err != nil {
		t.Fatal(err)
	}

	r, b := f.post(t, "/api/v1/orders", tok, uuid.NewString(),
		map[string]any{"items": []map[string]any{{"menu_item_id": miID, "qty": "1"}}})
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("create order: %d %s", r.StatusCode, b)
	}
	var ord models.Order
	_ = json.Unmarshal(b, &ord)

	var oi models.OrderItem
	if err := gdb.Where("order_id = ? AND menu_item_id = ?", ord.ID, miID).First(&oi).Error; err != nil {
		t.Fatal(err)
	}
	if !oi.COGS.Equal(decimal.MustFromString("10")) {
		t.Fatalf("order_item.cogs из тех-карты: получили %s, ожидали 10 (100 г × 100/кг)",
			decimal.Normalize(oi.COGS).String())
	}
}
