//go:build integration

package http_test

import (
	"net/http"
	"testing"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// Н11: смена цены ингредиента при ненулевом остатке переоценивает актив «Склад»
// и обязана иметь встречную проводку капитала (переоценка). Иначе расчётный
// капитал в Балансе дрейфует на стоимость переоценки.
func TestIngredientPatch_PriceChange_RecordsRevaluation(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb := openTestDB(t)

	ingID, n, u := uuid.NewString(), "Масло-reval", "кг"
	if err := gdb.Create(&models.Ingredient{
		ID: ingID, Name: &n, Unit: &u, RestaurantID: &f.rid,
		Qty: decimal.MustFromString("50"), PricePerUnit: decimal.MustFromString("10"),
	}).Error; err != nil {
		t.Fatal(err)
	}

	// Меняем ТОЛЬКО цену 10→100 при остатке 50 → переоценка 50×90 = 4500.
	r, b := f.patch(t, "/api/v1/stock/ingredients/"+ingID, tok, uuid.NewString(),
		map[string]any{"price_per_unit": "100"})
	if r.StatusCode != http.StatusOK {
		t.Fatalf("patch price: %d %s", r.StatusCode, b)
	}

	var eqs []models.EquityEntry
	gdb.Where("restaurant_id = ? AND category = ?", f.rid, "stock_revaluation").Find(&eqs)
	if len(eqs) != 1 || !eqs[0].Amount.Equal(decimal.MustFromString("4500")) {
		t.Fatalf("ждали 1 проводку переоценки 4500, получили %+v", eqs)
	}
}
