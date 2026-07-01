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

// TestNetworkMenu — CRUD мастер-меню сети (ADR-004).
func TestNetworkMenu(t *testing.T) {
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
	for _, tbl := range []string{"network_menu_items", "restaurants", "company_accounts"} {
		gdb.Exec("DELETE FROM " + tbl)
	}

	accountID := uuid.NewString()
	gdb.Create(&models.CompanyAccount{ID: accountID, Name: "Сеть"})
	rid := uuid.NewString()
	cw := "central_warehouse"
	gdb.Create(&models.Restaurant{ID: rid, Name: "Склад", AccountID: &accountID, Kind: &cw})

	svc := service.NewNetworkService(repo.New(gdb))
	ctx := tenant.WithRestaurant(context.Background(), rid)

	// Создать.
	m, err := svc.CreateNetworkMenuItem(ctx, service.NetworkMenuInput{Name: "Плов", Category: "Горячее", BasePrice: "50", Station: "hot_kitchen"})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if m.Name != "Плов" || !m.BasePrice.Equal(decimal.MustFromString("50")) {
		t.Errorf("created mismatch: %+v", m)
	}

	// Список.
	list, err := svc.ListNetworkMenu(ctx)
	if err != nil || len(list) != 1 {
		t.Fatalf("list = %d (err %v), want 1", len(list), err)
	}

	// Обновить цену.
	upd, err := svc.UpdateNetworkMenuItem(ctx, m.ID, service.NetworkMenuInput{Name: "Плов", BasePrice: "60"})
	if err != nil {
		t.Fatalf("Update: %v", err)
	}
	if !upd.BasePrice.Equal(decimal.MustFromString("60")) {
		t.Errorf("base_price after update = %s, want 60", upd.BasePrice.String())
	}

	// Чужой id — не найден.
	if _, err := svc.UpdateNetworkMenuItem(ctx, uuid.NewString(), service.NetworkMenuInput{Name: "X"}); err == nil {
		t.Errorf("unknown master item should not update")
	}
}
