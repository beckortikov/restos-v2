//go:build integration

package http_test

import (
	"net/http"
	"testing"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/db"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

func openTestDB(t *testing.T) *gorm.DB {
	gdb, err := db.Open(testDSN())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if sqlDB, e := gdb.DB(); e == nil {
			_ = sqlDB.Close()
		}
	})
	return gdb
}

// Удаление ингредиента с остатком: остаток списывается (stock_writeoff на
// qty×price), сам ингредиент удаляется — Баланс сходится (склад −V, убыток −V).
func TestIngredientDelete_WithStock_WritesOff(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb := openTestDB(t)

	ingID, n, u := uuid.NewString(), "Удаляемый остаток", "кг"
	if err := gdb.Create(&models.Ingredient{
		ID: ingID, Name: &n, Unit: &u, RestaurantID: &f.rid,
		Qty: decimal.MustFromString("10"), PricePerUnit: decimal.MustFromString("50"),
	}).Error; err != nil {
		t.Fatal(err)
	}

	r, b := f.del(t, "/api/v1/stock/ingredients/"+ingID, tok, uuid.NewString())
	if r.StatusCode != http.StatusOK && r.StatusCode != http.StatusNoContent {
		t.Fatalf("delete: %d %s", r.StatusCode, b)
	}

	var cnt int64
	gdb.Model(&models.Ingredient{}).Where("id = ?", ingID).Count(&cnt)
	if cnt != 0 {
		t.Fatalf("ингредиент не удалён (count=%d)", cnt)
	}

	var wos []models.StockWriteoff
	gdb.Where("restaurant_id = ?", f.rid).Find(&wos)
	found := false
	for _, w := range wos {
		if w.TotalCost.Equal(decimal.MustFromString("500")) {
			found = true
		}
	}
	if !found {
		t.Fatalf("ожидали списание total_cost=500 (10×50), не нашли среди %d списаний", len(wos))
	}
}

// Удаление ингредиента БЕЗ остатка: списание НЕ создаётся.
func TestIngredientDelete_ZeroStock_NoWriteoff(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb := openTestDB(t)

	ingID, n, u := uuid.NewString(), "Пустой остаток", "шт"
	if err := gdb.Create(&models.Ingredient{
		ID: ingID, Name: &n, Unit: &u, RestaurantID: &f.rid,
		Qty: decimal.Zero, PricePerUnit: decimal.MustFromString("50"),
	}).Error; err != nil {
		t.Fatal(err)
	}

	var before int64
	gdb.Model(&models.StockWriteoff{}).Where("restaurant_id = ?", f.rid).Count(&before)

	r, b := f.del(t, "/api/v1/stock/ingredients/"+ingID, tok, uuid.NewString())
	if r.StatusCode != http.StatusOK && r.StatusCode != http.StatusNoContent {
		t.Fatalf("delete: %d %s", r.StatusCode, b)
	}
	var after int64
	gdb.Model(&models.StockWriteoff{}).Where("restaurant_id = ?", f.rid).Count(&after)
	if after != before {
		t.Fatalf("списание создалось при нулевом остатке (%d→%d)", before, after)
	}
}

// Удаление ингредиента, используемого в техкарте → 409 CONFLICT (блюда сломались бы).
func TestIngredientDelete_InUse_Conflict(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb := openTestDB(t)

	ingID, n, u := uuid.NewString(), "В техкарте", "кг"
	if err := gdb.Create(&models.Ingredient{
		ID: ingID, Name: &n, Unit: &u, RestaurantID: &f.rid,
		Qty: decimal.Zero, PricePerUnit: decimal.MustFromString("10"),
	}).Error; err != nil {
		t.Fatal(err)
	}
	tcID := uuid.NewString()
	if err := gdb.Create(&models.TechCardLine{
		ID: tcID, IngredientID: &ingID, Qty: decimal.MustFromString("1"), RestaurantID: &f.rid,
	}).Error; err != nil {
		t.Fatal(err)
	}

	r, b := f.del(t, "/api/v1/stock/ingredients/"+ingID, tok, uuid.NewString())
	if r.StatusCode != http.StatusConflict {
		t.Fatalf("ожидали 409 для используемого ингредиента, получили %d %s", r.StatusCode, b)
	}
}

// Каскадное удаление ПОКУПНОГО товара: is_purchased-блюдо + его 1:1 ингредиент.
// Ингредиент удаляется каскадом (блюдо прячется, техкарта и ингредиент удалены),
// а не упирается в CONFLICT — иначе покупные дубликаты не убрать с «Остатков».
func TestIngredientDelete_PurchasedCascades(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb := openTestDB(t)
	sp := func(s string) *string { return &s }

	miID := uuid.NewString()
	if err := gdb.Create(&models.MenuItem{
		ID: miID, Name: sp("Кола"), IsPurchased: true,
		Price: decimal.MustFromString("12"), RestaurantID: &f.rid,
	}).Error; err != nil {
		t.Fatal(err)
	}
	ingID := uuid.NewString()
	if err := gdb.Create(&models.Ingredient{
		ID: ingID, Name: sp("Кола"), Unit: sp("шт"),
		Qty: decimal.MustFromString("5"), PricePerUnit: decimal.MustFromString("7"), RestaurantID: &f.rid,
	}).Error; err != nil {
		t.Fatal(err)
	}
	if err := gdb.Create(&models.TechCardLine{
		ID: uuid.NewString(), MenuItemID: &miID, IngredientID: &ingID,
		Name: sp("Кола"), Qty: decimal.MustFromString("1"), Unit: sp("шт"), RestaurantID: &f.rid,
	}).Error; err != nil {
		t.Fatal(err)
	}

	r, b := f.del(t, "/api/v1/stock/ingredients/"+ingID, tok, uuid.NewString())
	if r.StatusCode != http.StatusOK && r.StatusCode != http.StatusNoContent {
		t.Fatalf("удаление покупного ингредиента: %d %s (ожидали каскад, не CONFLICT)", r.StatusCode, b)
	}
	var ingCnt, tclCnt int64
	gdb.Model(&models.Ingredient{}).Where("id = ?", ingID).Count(&ingCnt)
	if ingCnt != 0 {
		t.Errorf("ингредиент не удалён: count=%d", ingCnt)
	}
	gdb.Model(&models.TechCardLine{}).Where("ingredient_id = ?", ingID).Count(&tclCnt)
	if tclCnt != 0 {
		t.Errorf("техкарта осиротела: count=%d", tclCnt)
	}
	var mi models.MenuItem
	gdb.First(&mi, "id = ?", miID)
	if !mi.IsDeleted {
		t.Errorf("покупное блюдо не помечено is_deleted (история заказов должна остаться, но из меню/склада — уйти)")
	}

	// Обычный рецепт (блюдо НЕ покупное): сырьё удалить нельзя — CONFLICT.
	dishID := uuid.NewString()
	if err := gdb.Create(&models.MenuItem{ID: dishID, Name: sp("Борщ"), IsPurchased: false, RestaurantID: &f.rid}).Error; err != nil {
		t.Fatal(err)
	}
	rawID := uuid.NewString()
	if err := gdb.Create(&models.Ingredient{ID: rawID, Name: sp("Свёкла"), Unit: sp("kg"), RestaurantID: &f.rid}).Error; err != nil {
		t.Fatal(err)
	}
	if err := gdb.Create(&models.TechCardLine{ID: uuid.NewString(), MenuItemID: &dishID, IngredientID: &rawID, Name: sp("Свёкла"), Qty: decimal.MustFromString("0.2"), Unit: sp("kg"), RestaurantID: &f.rid}).Error; err != nil {
		t.Fatal(err)
	}
	rc, _ := f.del(t, "/api/v1/stock/ingredients/"+rawID, tok, uuid.NewString())
	if rc.StatusCode != http.StatusConflict {
		t.Errorf("удаление сырья из обычного рецепта: %d, want 409", rc.StatusCode)
	}
}
