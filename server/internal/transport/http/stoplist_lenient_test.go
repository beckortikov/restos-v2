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

// БАГ A: в lenient-режиме (учёт по техкартам ВКЛ, контроль остатков ВЫКЛ)
// покупной товар с низким остатком НЕ должен авто-стопиться — его можно
// продавать (склад уходит в минус), а ручной стоп при этом снимается.
func TestStopList_Lenient_NoAutoStopForPurchased(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _ := db.Open(testDSN())
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})
	enableTechCards(t, gdb, f.rid) // tech ON, enforce OFF → lenient

	// Покупной товар (обычное блюдо) + сырьё на нуле (low) через техкарту.
	ingID, ingName, ingUnit := uuid.NewString(), "Кола-сырьё", "шт"
	if err := gdb.Create(&models.Ingredient{
		ID: ingID, Name: &ingName, Unit: &ingUnit, RestaurantID: &f.rid,
		Qty: decimal.Zero, MinQty: decimal.Zero,
	}).Error; err != nil {
		t.Fatal(err)
	}
	miID, miName := uuid.NewString(), "Кола"
	if err := gdb.Create(&models.MenuItem{
		ID: miID, Name: &miName, Price: decimal.MustFromString("15"), RestaurantID: &f.rid,
	}).Error; err != nil {
		t.Fatal(err)
	}
	one := "шт"
	if err := gdb.Create(&models.TechCardLine{
		ID: uuid.NewString(), MenuItemID: &miID, IngredientID: &ingID,
		Name: &ingName, Qty: decimal.MustFromString("1"), Unit: &one, RestaurantID: &f.rid,
	}).Error; err != nil {
		t.Fatal(err)
	}

	// 1) Не в стоп-листе (авто-стоп выключен в lenient).
	if names := stopListNames(t, f, tok); hasName(names, "Кола") {
		t.Fatalf("lenient: покупной с низким остатком не должен авто-стопиться, а он в стопе: %v", names)
	}
	// 2) Заказ проходит (склад в минус разрешён).
	r, b := f.post(t, "/api/v1/orders", tok, uuid.NewString(),
		map[string]any{"items": []map[string]any{{"menu_item_id": miID, "qty": "1"}}})
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("lenient: заказ покупного должен проходить, получили %d: %s", r.StatusCode, b)
	}

	// 3) Ручной стоп → в списке; снятие override → ушёл из списка.
	yes := map[string]any{"override": true}
	if rr, bb := f.post(t, "/api/v1/stop-list/"+miID+"/override", tok, uuid.NewString(), yes); rr.StatusCode != http.StatusOK {
		t.Fatalf("override on: %d %s", rr.StatusCode, bb)
	}
	if names := stopListNames(t, f, tok); !hasName(names, "Кола") {
		t.Fatalf("после ручного стопа «Кола» должна быть в списке: %v", names)
	}
	no := map[string]any{"override": false}
	if rr, bb := f.post(t, "/api/v1/stop-list/"+miID+"/override", tok, uuid.NewString(), no); rr.StatusCode != http.StatusOK {
		t.Fatalf("override off: %d %s", rr.StatusCode, bb)
	}
	if names := stopListNames(t, f, tok); hasName(names, "Кола") {
		t.Fatalf("после снятия ручного стопа «Кола» должна уйти из списка, а она там: %v", names)
	}
}

// БАГ B: удалённое (is_deleted=true) блюдо НЕ должно оставаться в стоп-листе,
// даже если у него остался stop_list_override=true.
func TestStopList_DeletedItemExcluded(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _ := db.Open(testDSN())
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})

	yes := true
	delName, liveName := "Удалёнка", "Живое"
	if err := gdb.Create(&models.MenuItem{
		ID: uuid.NewString(), Name: &delName, Price: decimal.MustFromString("10"),
		StopListOverride: &yes, IsDeleted: true, RestaurantID: &f.rid,
	}).Error; err != nil {
		t.Fatal(err)
	}
	if err := gdb.Create(&models.MenuItem{
		ID: uuid.NewString(), Name: &liveName, Price: decimal.MustFromString("10"),
		StopListOverride: &yes, IsDeleted: false, RestaurantID: &f.rid,
	}).Error; err != nil {
		t.Fatal(err)
	}

	names := stopListNames(t, f, tok)
	if hasName(names, "Удалёнка") {
		t.Fatalf("удалённое блюдо не должно быть в стоп-листе: %v", names)
	}
	if !hasName(names, "Живое") {
		t.Fatalf("неудалённый ручной стоп должен оставаться: %v", names)
	}
}
