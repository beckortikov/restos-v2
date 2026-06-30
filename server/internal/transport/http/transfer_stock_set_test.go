//go:build integration

package http_test

import (
	"net/http"
	"testing"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// #1 Перенос на ЗАНЯТЫЙ другим активным заказом стол → 409 (закрытая дыра).
// На свободный стол — проходит.
func TestTransfer_TargetOccupied_Conflict(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb := openTestDB(t)

	open, free, occ := "open", "free", "occupied"
	tA, tB, tC := uuid.NewString(), uuid.NewString(), uuid.NewString()
	n1, n2, n3 := 901, 902, 903
	for _, tb := range []*models.Table{
		{ID: tA, Number: &n1, Status: &occ, RestaurantID: &f.rid},
		{ID: tB, Number: &n2, Status: &occ, RestaurantID: &f.rid},
		{ID: tC, Number: &n3, Status: &free, RestaurantID: &f.rid},
	} {
		if err := gdb.Create(tb).Error; err != nil {
			t.Fatal(err)
		}
	}
	o1, o2 := uuid.NewString(), uuid.NewString()
	if err := gdb.Create(&models.Order{ID: o1, Status: &open, TableID: &tA, RestaurantID: &f.rid}).Error; err != nil {
		t.Fatal(err)
	}
	if err := gdb.Create(&models.Order{ID: o2, Status: &open, TableID: &tB, RestaurantID: &f.rid}).Error; err != nil {
		t.Fatal(err)
	}

	r, b := f.post(t, "/api/v1/orders/"+o1+"/transfer", tok, uuid.NewString(), map[string]any{"table_id": tB})
	if r.StatusCode != http.StatusConflict {
		t.Fatalf("ожидали 409 при переносе на занятый стол, получили %d %s", r.StatusCode, b)
	}

	r2, b2 := f.post(t, "/api/v1/orders/"+o1+"/transfer", tok, uuid.NewString(), map[string]any{"table_id": tC})
	if r2.StatusCode != http.StatusOK {
		t.Fatalf("перенос на свободный стол должен пройти, получили %d %s", r2.StatusCode, b2)
	}
}

// #4 Начальный остаток: повторный ввод УСТАНАВЛИВАЕТ остаток, а не складывает.
func TestOpeningBalance_SetsNotStacks(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb := openTestDB(t)

	ingID, n, u := uuid.NewString(), "Сахар-ОБ", "кг"
	if err := gdb.Create(&models.Ingredient{
		ID: ingID, Name: &n, Unit: &u, RestaurantID: &f.rid,
		Qty: decimal.Zero, PricePerUnit: decimal.MustFromString("50"),
	}).Error; err != nil {
		t.Fatal(err)
	}
	apply := func(qty string) {
		r, b := f.post(t, "/api/v1/stock/opening-balance", tok, uuid.NewString(), map[string]any{
			"lines": []map[string]any{{"ingredient_id": ingID, "qty": qty}},
		})
		if r.StatusCode != http.StatusOK {
			t.Fatalf("opening-balance %s: %d %s", qty, r.StatusCode, b)
		}
	}
	qtyNow := func() decimal.Decimal {
		var ing models.Ingredient
		gdb.Where("id = ?", ingID).First(&ing)
		return decimal.Normalize(ing.Qty)
	}

	apply("10")
	if !qtyNow().Equal(decimal.MustFromString("10")) {
		t.Fatalf("после первого ввода ждали 10, получили %s", qtyNow())
	}
	apply("10") // повтор тех же значений — не должно застэкать
	if !qtyNow().Equal(decimal.MustFromString("10")) {
		t.Fatalf("повторный ввод 10 застэкал: получили %s, ждали 10", qtyNow())
	}
	apply("15") // правка вверх
	if !qtyNow().Equal(decimal.MustFromString("15")) {
		t.Fatalf("после правки ждали 15, получили %s", qtyNow())
	}

	// Капитал opening_inventory: 500 (0→10) + 250 (10→15) = 750.
	var eqs []models.EquityEntry
	gdb.Where("restaurant_id = ? AND category = ?", f.rid, "opening_inventory").Find(&eqs)
	sum := decimal.Zero
	for _, e := range eqs {
		sum = decimal.Add(sum, e.Amount)
	}
	if !decimal.Normalize(sum).Equal(decimal.MustFromString("750")) {
		t.Fatalf("капитал opening_inventory ждали 750, получили %s", decimal.Normalize(sum))
	}
}

// #5 Редактирование ингредиента с qty: остаток ставится через корректирующее
// движение (раньше — ошибка VALIDATION), + проводка капитала на дельту.
func TestIngredientPatch_QtySetsViaAdjustment(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb := openTestDB(t)

	ingID, n, u := uuid.NewString(), "Мука-edit", "кг"
	if err := gdb.Create(&models.Ingredient{
		ID: ingID, Name: &n, Unit: &u, RestaurantID: &f.rid,
		Qty: decimal.MustFromString("10"), PricePerUnit: decimal.MustFromString("50"),
	}).Error; err != nil {
		t.Fatal(err)
	}

	r, b := f.patch(t, "/api/v1/stock/ingredients/"+ingID, tok, uuid.NewString(), map[string]any{"qty": "25"})
	if r.StatusCode != http.StatusOK {
		t.Fatalf("patch qty: %d %s", r.StatusCode, b)
	}
	var ing models.Ingredient
	gdb.Where("id = ?", ingID).First(&ing)
	if !decimal.Normalize(ing.Qty).Equal(decimal.MustFromString("25")) {
		t.Fatalf("после правки qty ждали 25, получили %s", decimal.Normalize(ing.Qty))
	}
	// Капитал stock_adjustment: дельта 15 × 50 = 750.
	var eqs []models.EquityEntry
	gdb.Where("restaurant_id = ? AND category = ?", f.rid, "stock_adjustment").Find(&eqs)
	if len(eqs) != 1 || !eqs[0].Amount.Equal(decimal.MustFromString("750")) {
		t.Fatalf("ждали 1 проводку 750, получили %+v", eqs)
	}
}
