//go:build integration

package service_test

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/db"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/repo"
	"github.com/restos/restos-v4/server/internal/service"
)

// TestNomenclaturePropagation — общий каталог номенклатуры сети (ADR-003,
// вариант 3B) распространяется на филиал через PullFor/ApplyPulled, тем же
// путём, что и мастер-меню (network_menu_sync_test.go). Регресс-пруф: раньше
// PullFor вообще не знал о nomenclature — товар, заведённый на central, никогда
// не попадал на филиал (найдено вживую: «рис» создан на central, не появился
// на филиале).
func TestNomenclaturePropagation(t *testing.T) {
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
	for _, tbl := range []string{"nomenclature", "restaurants", "company_accounts"} {
		gdb.Exec("DELETE FROM " + tbl)
	}

	accountID := uuid.NewString()
	gdb.Create(&models.CompanyAccount{ID: accountID, Name: "Сеть"})
	branchID := uuid.NewString()
	ot := "outlet"
	gdb.Create(&models.Restaurant{ID: branchID, Name: "Филиал", AccountID: &accountID, Kind: &ot})

	nomID := uuid.NewString()
	kg, cat := "kg", "Бакалея"
	if err := gdb.Create(&models.Nomenclature{ID: nomID, AccountID: &accountID, Name: "Рис", Unit: &kg, Category: &cat}).Error; err != nil {
		t.Fatal(err)
	}

	svc := service.NewSyncService(repo.New(gdb))
	ctx := context.Background()

	// ─── PullFor отдаёт номенклатуру central целиком ──────────────────────
	pull, err := svc.PullFor(ctx, branchID)
	if err != nil {
		t.Fatalf("PullFor: %v", err)
	}
	var found bool
	for _, e := range pull.Entries {
		if e.Entity == "nomenclature" && e.RowID == nomID {
			found = true
		}
	}
	if !found {
		t.Fatal("PullFor не вернул nomenclature — товар не дойдёт до филиала")
	}

	// ─── ApplyPulled применяет на филиале ──────────────────────────────────
	if _, err := svc.ApplyPulled(ctx, *pull, branchID); err != nil {
		t.Fatalf("ApplyPulled: %v", err)
	}
	var got models.Nomenclature
	if err := gdb.First(&got, "id = ?", nomID).Error; err != nil {
		t.Fatalf("nomenclature not applied: %v", err)
	}
	if got.Name != "Рис" || got.Unit == nil || *got.Unit != "kg" {
		t.Errorf("applied nomenclature = %+v, want Рис/kg", got)
	}

	// ─── Central переименовывает → повторный pull обновляет филиал ────────
	gdb.Model(&models.Nomenclature{}).Where("id = ?", nomID).Update("name", "Рис жасмин")
	pull2, err := svc.PullFor(ctx, branchID)
	if err != nil {
		t.Fatalf("PullFor 2: %v", err)
	}
	if _, err := svc.ApplyPulled(ctx, *pull2, branchID); err != nil {
		t.Fatalf("ApplyPulled 2: %v", err)
	}
	var got2 models.Nomenclature
	gdb.First(&got2, "id = ?", nomID)
	if got2.Name != "Рис жасмин" {
		t.Errorf("name after rename = %q, want «Рис жасмин»", got2.Name)
	}

	// ─── Up-push (branchID="") пока не поддержан — явный Skipped, не применяется вслепую ───
	payload, _ := json.Marshal(got2)
	res, err := svc.Ingest(ctx, service.IngestInput{Entries: []service.SyncEntry{
		{Entity: "nomenclature", RowID: nomID, Op: "upsert", Payload: payload},
	}})
	if err != nil {
		t.Fatalf("Ingest: %v", err)
	}
	if res.Applied != 0 || res.Skipped != 1 {
		t.Errorf("Ingest(nomenclature) applied=%d skipped=%d, want 0/1 (up-push ещё не реализован)", res.Applied, res.Skipped)
	}
}
