//go:build integration

package service_test

import (
	"context"
	"testing"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/db"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
	"github.com/restos/restos-v4/server/internal/repo"
	"github.com/restos/restos-v4/server/internal/service"
)

// TestNetworkMenuPropagation — мастер-меню распространяется в филиал (ADR-004):
// создаётся menu_item; при обновлении мастера наследуемые поля обновляются, а
// локальные (цена/доступность) филиала сохраняются.
func TestNetworkMenuPropagation(t *testing.T) {
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
	for _, tbl := range []string{"menu_items", "network_menu_items", "restaurants", "company_accounts"} {
		gdb.Exec("DELETE FROM " + tbl)
	}

	accountID := uuid.NewString()
	gdb.Create(&models.CompanyAccount{ID: accountID, Name: "Сеть"})
	branchID := uuid.NewString()
	ot := "outlet"
	gdb.Create(&models.Restaurant{ID: branchID, Name: "Филиал", AccountID: &accountID, Kind: &ot})

	masterID := uuid.NewString()
	plov, cat, hot := "Плов", "Горячее", "hot_kitchen"
	gdb.Create(&models.NetworkMenuItem{ID: masterID, AccountID: &accountID, Name: plov, Category: &cat, BasePrice: decimal.MustFromString("50"), Station: &hot})

	svc := service.NewSyncService(repo.New(gdb))
	ctx := context.Background()

	// ─── Первое распространение: создаётся блюдо филиала ─────────────────
	pull, err := svc.PullFor(ctx, branchID, nil)
	if err != nil {
		t.Fatalf("PullFor: %v", err)
	}
	if _, err := svc.ApplyPulled(ctx, *pull, branchID); err != nil {
		t.Fatalf("ApplyPulled: %v", err)
	}
	var mi models.MenuItem
	if err := gdb.Where("restaurant_id = ? AND master_id = ?", branchID, masterID).First(&mi).Error; err != nil {
		t.Fatalf("branch menu_item not created: %v", err)
	}
	if mi.Name == nil || *mi.Name != "Плов" || !mi.Price.Equal(decimal.MustFromString("50")) {
		t.Errorf("created menu_item: name=%v price=%s, want Плов/50", mi.Name, mi.Price.String())
	}

	// ─── Филиал переопределяет локально: цена 70, стоп ───────────────────
	no := false
	gdb.Model(&models.MenuItem{}).Where("id = ?", mi.ID).Updates(map[string]any{"price": decimal.MustFromString("70"), "is_available": &no})

	// ─── Мастер меняет имя → повторное распространение ───────────────────
	gdb.Model(&models.NetworkMenuItem{}).Where("id = ?", masterID).Update("name", "Плов Premium")
	pull2, _ := svc.PullFor(ctx, branchID, nil)
	if _, err := svc.ApplyPulled(ctx, *pull2, branchID); err != nil {
		t.Fatalf("ApplyPulled 2: %v", err)
	}

	var mi2 models.MenuItem
	gdb.Where("id = ?", mi.ID).First(&mi2)
	// Наследуемое (имя) — обновилось.
	if mi2.Name == nil || *mi2.Name != "Плов Premium" {
		t.Errorf("name after master update = %v, want 'Плов Premium'", mi2.Name)
	}
	// Локальное (цена/доступность) — сохранилось.
	if !mi2.Price.Equal(decimal.MustFromString("70")) {
		t.Errorf("local price overwritten = %s, want 70 (сохраняется)", mi2.Price.String())
	}
	if mi2.IsAvailable == nil || *mi2.IsAvailable {
		t.Errorf("local is_available overwritten = %v, want false (сохраняется)", mi2.IsAvailable)
	}

	// Не задвоилось.
	var cnt int64
	gdb.Model(&models.MenuItem{}).Where("restaurant_id = ? AND master_id = ?", branchID, masterID).Count(&cnt)
	if cnt != 1 {
		t.Errorf("branch menu_items for master = %d, want 1", cnt)
	}
}
