//go:build integration

package service_test

import (
	"context"
	"testing"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/db"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/repo"
	"github.com/restos/restos-v4/server/internal/service"
)

// TestRestaurantStubPropagation — филиал узнаёт о central и соседях-филиалах
// через PullFor/ApplyPulled (тем же путём, что и network_menu_items/
// nomenclature), а не через JoinNetwork (тот пишет только account_id +
// sync_settings у СЕБЯ, ни одной строки-заглушки для central не заводит).
// Регресс-пруф: без этого «Перемещения» (CreateTransfer ищет to_restaurant_id
// в ЛОКАЛЬНОЙ restaurants) и дропдаун получателя не видели вообще никого —
// найдено вживую («в перемещении нет филиала пишет», 2026-08-20).
func TestRestaurantStubPropagation(t *testing.T) {
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
	for _, tbl := range []string{"restaurants", "company_accounts"} {
		gdb.Exec("DELETE FROM " + tbl)
	}

	accountID := uuid.NewString()
	gdb.Create(&models.CompanyAccount{ID: accountID, Name: "Сеть"})

	cw := "central_warehouse"
	centralID := uuid.NewString()
	gdb.Create(&models.Restaurant{ID: centralID, Name: "Central", AccountID: &accountID, Kind: &cw})

	ot := "outlet"
	branchAID := uuid.NewString()
	gdb.Create(&models.Restaurant{ID: branchAID, Name: "Филиал А", AccountID: &accountID, Kind: &ot})
	branchBID := uuid.NewString()
	gdb.Create(&models.Restaurant{ID: branchBID, Name: "Филиал Б", AccountID: &accountID, Kind: &ot})

	svc := service.NewSyncService(repo.New(gdb))
	ctx := context.Background()

	// ─── PullFor как филиал А отдаёт central + Филиал Б, но НЕ себя самого ──
	pull, err := svc.PullFor(ctx, branchAID)
	if err != nil {
		t.Fatalf("PullFor: %v", err)
	}
	seen := map[string]bool{}
	for _, e := range pull.Entries {
		if e.Entity == "restaurants" {
			seen[e.RowID] = true
		}
	}
	if !seen[centralID] {
		t.Error("PullFor не вернул central как restaurants — филиал не увидит central в перемещениях")
	}
	if !seen[branchBID] {
		t.Error("PullFor не вернул соседний филиал Б")
	}
	if seen[branchAID] {
		t.Error("PullFor вернул СЕБЯ САМОГО (branchA) — рискует затереть свою же строку при apply")
	}

	// ─── ApplyPulled заводит заглушки на филиале А ─────────────────────────
	if _, err := svc.ApplyPulled(ctx, *pull, branchAID); err != nil {
		t.Fatalf("ApplyPulled: %v", err)
	}
	var gotCentral models.Restaurant
	if err := gdb.First(&gotCentral, "id = ?", centralID).Error; err != nil {
		t.Fatalf("central stub not created: %v", err)
	}
	if gotCentral.Name != "Central" || gotCentral.Kind == nil || *gotCentral.Kind != "central_warehouse" {
		t.Errorf("central stub = %+v, want Name=Central Kind=central_warehouse", gotCentral)
	}

	// ─── Заглушка не трогает поля, которых нет в зеркале (license и т.п.) ──
	// Смоделировано отдельной строкой на "чужом" id — сама Restaurant с
	// реальными license-полями не была затронута апсертом заглушки выше,
	// потому что apply идёт по explicit column list (id/name/account_id/kind).
	lic := "SECRET-LICENSE-KEY"
	if err := gdb.Model(&models.Restaurant{}).Where("id = ?", centralID).Update("license_key", lic).Error; err != nil {
		t.Fatal(err)
	}
	pull2, err := svc.PullFor(ctx, branchAID)
	if err != nil {
		t.Fatalf("PullFor 2: %v", err)
	}
	if _, err := svc.ApplyPulled(ctx, *pull2, branchAID); err != nil {
		t.Fatalf("ApplyPulled 2: %v", err)
	}
	var gotCentral2 models.Restaurant
	gdb.First(&gotCentral2, "id = ?", centralID)
	if gotCentral2.LicenseKey == nil || *gotCentral2.LicenseKey != lic {
		t.Errorf("license_key затёрт повторным apply заглушки: %v, want %q (DoUpdates обязан быть explicit-list, не UpdateAll)", gotCentral2.LicenseKey, lic)
	}
}
