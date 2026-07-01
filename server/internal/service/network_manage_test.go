//go:build integration

package service_test

import (
	"context"
	"testing"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/db"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
	"github.com/restos/restos-v4/server/internal/repo"
	"github.com/restos/restos-v4/server/internal/service"
)

// TestNetworkManage — заведение сети из UI и смена типа филиала (ADR-003 Фаза 4).
func TestNetworkManage(t *testing.T) {
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

	centralID := uuid.NewString()
	if err := gdb.Create(&models.Restaurant{ID: centralID, Name: "Моя точка"}).Error; err != nil {
		t.Fatal(err)
	}
	svc := service.NewNetworkService(repo.New(gdb))
	ctx := tenant.WithRestaurant(context.Background(), centralID)

	// ─── Создать сеть ────────────────────────────────────────────────────
	acc, err := svc.CreateNetwork(ctx, "Сеть №1")
	if err != nil {
		t.Fatalf("CreateNetwork: %v", err)
	}
	var rest models.Restaurant
	gdb.First(&rest, "id = ?", centralID)
	if rest.AccountID == nil || *rest.AccountID != acc.ID {
		t.Errorf("restaurant account_id not set to %s", acc.ID)
	}
	if rest.Kind == nil || *rest.Kind != "central_warehouse" {
		t.Errorf("kind = %v, want central_warehouse", rest.Kind)
	}

	// Повторно — конфликт.
	if _, err := svc.CreateNetwork(ctx, "Сеть №2"); err == nil {
		t.Errorf("second CreateNetwork should conflict")
	}

	// ─── Второй филиал в той же сети + смена типа ────────────────────────
	outletID := uuid.NewString()
	cw := "central_warehouse"
	if err := gdb.Create(&models.Restaurant{ID: outletID, Name: "Филиал-2", AccountID: &acc.ID, Kind: &cw}).Error; err != nil {
		t.Fatal(err)
	}
	if err := svc.SetBranchKind(ctx, outletID, "outlet"); err != nil {
		t.Fatalf("SetBranchKind: %v", err)
	}
	var outlet models.Restaurant
	gdb.First(&outlet, "id = ?", outletID)
	if outlet.Kind == nil || *outlet.Kind != "outlet" {
		t.Errorf("outlet kind = %v, want outlet", outlet.Kind)
	}

	// Плохой kind — ошибка.
	if err := svc.SetBranchKind(ctx, outletID, "bar"); err == nil {
		t.Errorf("bad kind should error")
	}
	// Чужой ресторан (не в сети) — не найден.
	if err := svc.SetBranchKind(ctx, uuid.NewString(), "outlet"); err == nil {
		t.Errorf("unknown branch should not be updatable")
	}
}
