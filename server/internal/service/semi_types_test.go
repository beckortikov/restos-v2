//go:build integration

package service_test

import (
	"context"
	"testing"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/db"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
	"github.com/restos/restos-v4/server/internal/repo"
	"github.com/restos/restos-v4/server/internal/service"
)

// Владелец 2026-08-30 («объём партии в техкарте», см. план): batch_qty —
// авторская подсказка формы («рецепт написан на партию N единиц выхода»),
// recipe_lines.qty_per_unit по-прежнему всегда «на 1 единицу» — Prepare/
// cascadeSemiDeduct её не видят. Эти тесты — только про batch_qty
// хранение/валидацию на CreateType/PatchType, не про сам расчёт рецепта
// (тот уже покрыт orders_semi_sale_test.go и не менялся).

func newSemiTypeFixture(t *testing.T) (*service.SemiFinishedService, string, context.Context) {
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
	for _, tbl := range []string{"semi_recipe_lines", "semi_finished_types", "restaurants"} {
		gdb.Exec("DELETE FROM " + tbl)
	}
	rid := uuid.NewString()
	if err := gdb.Create(&models.Restaurant{ID: rid, Name: "Тест"}).Error; err != nil {
		t.Fatalf("seed restaurant: %v", err)
	}
	svc := service.NewSemiFinishedService(repo.New(gdb))
	ctx := tenant.WithRestaurant(context.Background(), rid)
	return svc, rid, ctx
}

func TestSemiTypeBatchQty_DefaultsToOneWhenOmitted(t *testing.T) {
	svc, _, ctx := newSemiTypeFixture(t)
	name := "Тесто"
	out, err := svc.CreateType(ctx, service.SemiTypeInput{Name: &name})
	if err != nil {
		t.Fatalf("CreateType: %v", err)
	}
	if !out.BatchQty.Equal(decimal.MustFromString("1")) {
		t.Errorf("BatchQty = %s, want 1 (default, не переданный batch_qty)", out.BatchQty.String())
	}
}

func TestSemiTypeBatchQty_RoundTripsExplicitValue(t *testing.T) {
	svc, _, ctx := newSemiTypeFixture(t)
	name := "Тесто на 10кг"
	batch := "10"
	out, err := svc.CreateType(ctx, service.SemiTypeInput{Name: &name, BatchQty: &batch})
	if err != nil {
		t.Fatalf("CreateType: %v", err)
	}
	if !out.BatchQty.Equal(decimal.MustFromString("10")) {
		t.Errorf("BatchQty после Create = %s, want 10", out.BatchQty.String())
	}

	got, err := svc.GetType(ctx, out.ID, false)
	if err != nil {
		t.Fatalf("GetType: %v", err)
	}
	row, ok := got.(*models.SemiFinishedType)
	if !ok {
		t.Fatalf("GetType вернул неожиданный тип: %T", got)
	}
	if !row.BatchQty.Equal(decimal.MustFromString("10")) {
		t.Errorf("BatchQty после GetType = %s, want 10 (round-trip)", row.BatchQty.String())
	}

	// PatchType — независимая правка batch_qty на существующем типе.
	newBatch := "20"
	if _, err := svc.PatchType(ctx, out.ID, service.SemiTypeInput{BatchQty: &newBatch}); err != nil {
		t.Fatalf("PatchType: %v", err)
	}
	got2, err := svc.GetType(ctx, out.ID, false)
	if err != nil {
		t.Fatalf("GetType после Patch: %v", err)
	}
	row2 := got2.(*models.SemiFinishedType)
	if !row2.BatchQty.Equal(decimal.MustFromString("20")) {
		t.Errorf("BatchQty после Patch = %s, want 20", row2.BatchQty.String())
	}
}

func TestSemiTypeBatchQty_RejectsNonPositive(t *testing.T) {
	svc, _, ctx := newSemiTypeFixture(t)
	name := "Тесто"

	for _, bad := range []string{"0", "-5", "not-a-number", ""} {
		t.Run("create batch_qty="+bad, func(t *testing.T) {
			b := bad
			if _, err := svc.CreateType(ctx, service.SemiTypeInput{Name: &name, BatchQty: &b}); err == nil {
				t.Fatalf("want VALIDATION для batch_qty=%q, got nil error", bad)
			}
		})
	}

	// Существующий тип с валидным batch_qty=1 — Patch с "0" отклоняется,
	// а хранимое значение остаётся нетронутым (не тихо перезаписано нулём).
	out, err := svc.CreateType(ctx, service.SemiTypeInput{Name: &name})
	if err != nil {
		t.Fatalf("CreateType: %v", err)
	}
	zero := "0"
	if _, err := svc.PatchType(ctx, out.ID, service.SemiTypeInput{BatchQty: &zero}); err == nil {
		t.Fatal("want VALIDATION для Patch batch_qty=0")
	}
	got, err := svc.GetType(ctx, out.ID, false)
	if err != nil {
		t.Fatalf("GetType: %v", err)
	}
	row := got.(*models.SemiFinishedType)
	if !row.BatchQty.Equal(decimal.MustFromString("1")) {
		t.Errorf("BatchQty после отклонённого Patch = %s, want 1 (не должен был измениться)", row.BatchQty.String())
	}
}
