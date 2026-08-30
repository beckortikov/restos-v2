//go:build integration

package service_test

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/db"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
	"github.com/restos/restos-v4/server/internal/repo"
	"github.com/restos/restos-v4/server/internal/service"
)

// Владелец 2026-08-30 («зачем в коде что-то делит, если ресторан пишет
// рецепт целиком на партию»): semi_recipe_lines.qty_per_batch (099) хранит
// рецепт РОВНО в терминах партии — Prepare сам делит на BatchQty в момент
// производства. Эти тесты фиксируют именно эту точку, которую раньше
// проверяли только вручную в браузере (v3.16.360).
func newSemiPrepareFixture(t *testing.T) (*service.SemiFinishedService, string, context.Context, *gorm.DB) {
	t.Helper()
	gdb, err := db.Open(transferTestDSN())
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	if err := db.MigrateUp(t.Context(), gdb); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})
	for _, tbl := range []string{"stock_movements", "semi_recipe_lines", "semi_finished_types", "ingredients", "restaurants"} {
		gdb.Exec("DELETE FROM " + tbl)
	}
	rid := uuid.NewString()
	if err := gdb.Create(&models.Restaurant{ID: rid, Name: "Тест"}).Error; err != nil {
		t.Fatalf("seed restaurant: %v", err)
	}
	svc := service.NewSemiFinishedService(repo.New(gdb))
	ctx := tenant.WithRestaurant(context.Background(), rid)
	return svc, rid, ctx, gdb
}

// seedFlourSemiType — «Тесто», batch_qty=10, рецепт «5 кг муки на партию
// 10 кг теста» (qty_per_batch=5, НЕ qty_per_unit=0.5 — так реально ввёл бы
// пользователь после этой фичи). wastePercent — % отходов на самой муке
// (0 — без отходов).
func seedFlourSemiType(t *testing.T, gdb *gorm.DB, rid string, wastePercent string) (semiTypeID, flourID string) {
	t.Helper()
	kg := "kg"
	flourID = uuid.NewString()
	flourName := "Мука"
	if err := gdb.Create(&models.Ingredient{
		ID: flourID, Name: &flourName, Unit: &kg, RestaurantID: &rid,
		Qty: decimal.MustFromString("1000"), PricePerUnit: decimal.MustFromString("10"),
		WastePercent: decimal.MustFromString(wastePercent),
	}).Error; err != nil {
		t.Fatalf("seed flour: %v", err)
	}
	doughName := "Тесто"
	semiTypeID = uuid.NewString()
	if err := gdb.Create(&models.SemiFinishedType{
		ID: semiTypeID, Name: &doughName, OutputUnit: &kg, RestaurantID: &rid,
		YieldPercent: decimal.MustFromString("100"),
		BatchQty:     decimal.MustFromString("10"),
	}).Error; err != nil {
		t.Fatalf("seed semi type: %v", err)
	}
	if err := gdb.Create(&models.SemiRecipeLine{
		ID: uuid.NewString(), SemiTypeID: &semiTypeID, IngredientID: &flourID,
		Name: &flourName, QtyPerBatch: decimal.MustFromString("5"), Unit: &kg,
	}).Error; err != nil {
		t.Fatalf("seed recipe line: %v", err)
	}
	return
}

func flourDeducted(t *testing.T, gdb *gorm.DB, rid, flourID string) decimal.Decimal {
	t.Helper()
	var mv models.StockMovement
	if err := gdb.Where("restaurant_id = ? AND ingredient_id = ?", rid, flourID).First(&mv).Error; err != nil {
		t.Fatalf("stock_movement not found: %v", err)
	}
	return mv.Qty.Neg()
}

func TestSemiPrepare_QtyPerBatch_DividesCorrectly(t *testing.T) {
	svc, rid, ctx, gdb := newSemiPrepareFixture(t)
	semiTypeID, flourID := seedFlourSemiType(t, gdb, rid, "0")

	if _, err := svc.Prepare(ctx, service.SemiPrepareInput{SemiTypeID: semiTypeID, Qty: "3"}); err != nil {
		t.Fatalf("Prepare: %v", err)
	}
	// 5 кг муки / 10 кг партии × 3 кг теста = 1.5 кг муки — НЕ 5×3=15.
	got := flourDeducted(t, gdb, rid, flourID)
	if !got.Equal(decimal.MustFromString("1.5")) {
		t.Errorf("списано муки = %s, want 1.5 (5/10×3)", got.String())
	}
}

func TestSemiPrepare_AppliesWastePercent(t *testing.T) {
	svc, rid, ctx, gdb := newSemiPrepareFixture(t)
	semiTypeID, flourID := seedFlourSemiType(t, gdb, rid, "20")

	if _, err := svc.Prepare(ctx, service.SemiPrepareInput{SemiTypeID: semiTypeID, Qty: "3"}); err != nil {
		t.Fatalf("Prepare: %v", err)
	}
	// Раньше Prepare писал StockMovement напрямую мимо writeIngredientDeduct —
	// waste_percent игнорировался, списалось бы 1.5. С фиксом: 1.5/(1-0.2)=1.875.
	got := flourDeducted(t, gdb, rid, flourID)
	want := decimal.MustFromString("1.875")
	if !got.Equal(want) {
		t.Errorf("списано муки с учётом waste_percent=20%% = %s, want %s", got.String(), want.String())
	}
}
