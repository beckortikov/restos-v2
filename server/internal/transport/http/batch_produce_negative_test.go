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

// Приготовление заготовки НЕ должно блокироваться нехваткой ингредиентов:
// склад может уйти в минус (контроль остатков выключен). prepared_qty растёт,
// ингредиент уходит в минус.
func TestBatch_ProduceAllowsNegativeStock(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _ := db.Open(testDSN())
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})

	// Заготовка «Плов» (batch) + ингредиент «Рис» 0 на складе, техкарта 100 г/порц.
	ingID, ingName, ingUnit := uuid.NewString(), "Рис", "кг"
	if err := gdb.Create(&models.Ingredient{
		ID: ingID, Name: &ingName, Unit: &ingUnit, RestaurantID: &f.rid,
		Qty: decimal.Zero, PricePerUnit: decimal.MustFromString("10"),
	}).Error; err != nil {
		t.Fatal(err)
	}
	batch := true
	prep := 0
	miID, miName := uuid.NewString(), "Плов"
	if err := gdb.Create(&models.MenuItem{
		ID: miID, Name: &miName, Price: decimal.MustFromString("30"),
		IsBatchCooking: &batch, PreparedQty: &prep, RestaurantID: &f.rid,
	}).Error; err != nil {
		t.Fatal(err)
	}
	gram := "г"
	if err := gdb.Create(&models.TechCardLine{
		ID: uuid.NewString(), MenuItemID: &miID, IngredientID: &ingID, Name: &ingName,
		Qty: decimal.MustFromString("100"), Unit: &gram, RestaurantID: &f.rid,
	}).Error; err != nil {
		t.Fatal(err)
	}

	// Приготовить 5 порций при нулевом сырье → проходит.
	r, b := f.post(t, "/api/v1/menu/items/"+miID+"/batch/produce", tok, uuid.NewString(),
		map[string]any{"qty": 5})
	if r.StatusCode != http.StatusOK && r.StatusCode != http.StatusCreated {
		t.Fatalf("приготовление при нехватке сырья должно проходить, получили %d: %s", r.StatusCode, b)
	}

	// prepared_qty = 5.
	var mi models.MenuItem
	if err := gdb.Where("id = ?", miID).First(&mi).Error; err != nil {
		t.Fatal(err)
	}
	if mi.PreparedQty == nil || *mi.PreparedQty != 5 {
		t.Fatalf("ожидали prepared_qty=5, получили %v", mi.PreparedQty)
	}
	// Рис ушёл в минус: 5 × 100 г = 500 г = 0.5 кг → −0.5.
	var ing models.Ingredient
	if err := gdb.Where("id = ?", ingID).First(&ing).Error; err != nil {
		t.Fatal(err)
	}
	if !ing.Qty.Equal(decimal.MustFromString("-0.5")) {
		t.Fatalf("ожидали остаток Рис = -0.5 кг (минус), получили %s", decimal.Normalize(ing.Qty))
	}
}
