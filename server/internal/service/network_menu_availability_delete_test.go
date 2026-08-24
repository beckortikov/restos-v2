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

// TestNetworkMenuAvailabilityDefault — стартовая доступность мастера доезжает
// до филиала (миграция 086). До фикса applyNetworkMenu хардкодил available=
// true на КАЖДОМ первом создании копии — блюдо, выключенное на центре ещё до
// того как филиал его впервые увидел, материализовалось продавабельным. Живой
// случай: 36 легаси-позиций Макбургера были выключены на центре, но появились
// включёнными на филиале.
func TestNetworkMenuAvailabilityDefault(t *testing.T) {
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
	for _, tbl := range []string{"menu_items", "network_menu_items", "restaurants", "company_accounts", "sync_log"} {
		gdb.Exec("DELETE FROM " + tbl)
	}

	accountID := uuid.NewString()
	gdb.Create(&models.CompanyAccount{ID: accountID, Name: "Сеть"})
	branchID := uuid.NewString()
	ot := "outlet"
	gdb.Create(&models.Restaurant{ID: branchID, Name: "Филиал", AccountID: &accountID, Kind: &ot})

	stoppedID, liveID := uuid.NewString(), uuid.NewString()
	stoppedName, liveName, cat, hot := "Легаси 12с", "Пепси", "Напитки", "bar"
	gdb.Create(&models.NetworkMenuItem{
		ID: stoppedID, AccountID: &accountID, Name: stoppedName, Category: &cat,
		BasePrice: decimal.MustFromString("12"), Station: &hot, Available: false,
	})
	gdb.Create(&models.NetworkMenuItem{
		ID: liveID, AccountID: &accountID, Name: liveName, Category: &cat,
		BasePrice: decimal.MustFromString("6"), Station: &hot, Available: true,
	})

	syncSvc := service.NewSyncService(repo.New(gdb))
	pull, err := syncSvc.PullFor(context.Background(), branchID, nil)
	if err != nil {
		t.Fatalf("PullFor: %v", err)
	}
	if _, err := syncSvc.ApplyPulled(context.Background(), *pull, branchID); err != nil {
		t.Fatalf("ApplyPulled: %v", err)
	}

	var stopped, live models.MenuItem
	if err := gdb.Where("restaurant_id = ? AND master_id = ?", branchID, stoppedID).First(&stopped).Error; err != nil {
		t.Fatalf("stopped продукт не материализован: %v", err)
	}
	if err := gdb.Where("restaurant_id = ? AND master_id = ?", branchID, liveID).First(&live).Error; err != nil {
		t.Fatalf("live продукт не материализован: %v", err)
	}
	if stopped.IsAvailable == nil || *stopped.IsAvailable {
		t.Errorf("«%s»: is_available = %v, want false — выключенное на центре стало продавабельным на филиале", stoppedName, derefBoolStr(stopped.IsAvailable))
	}
	if live.IsAvailable == nil || !*live.IsAvailable {
		t.Errorf("«%s»: is_available = %v, want true", liveName, derefBoolStr(live.IsAvailable))
	}
}

// TestNetworkMenuDeletePropagation — удаление блюда сети на центре доезжает
// до филиала и сносит его локальную копию (миграция 086, tombstone). До фикса
// SoftDeleteItem трогал только локальную копию центра — на филиалах блюдо
// оставалось жить навсегда, потому что нечему было прислать сигнал «его
// больше нет» (найдено владельцем сразу после первого импорта).
//
// Отдельно проверяется, что удаление на ФИЛИАЛЕ своей копии — это его
// ЛОКАЛЬНОЕ решение и мастера не трогает: сеть не должна терять блюдо у ВСЕХ
// только потому, что один филиал решил его у себя не продавать.
func derefBoolStr(b *bool) string {
	if b == nil {
		return "nil"
	}
	if *b {
		return "true"
	}
	return "false"
}

func TestNetworkMenuDeletePropagation(t *testing.T) {
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
	for _, tbl := range []string{
		"menu_item_variant_values", "menu_attribute_values", "menu_attributes",
		"menu_items", "network_menu_items", "restaurants", "company_accounts", "sync_log",
	} {
		gdb.Exec("DELETE FROM " + tbl)
	}

	accountID := uuid.NewString()
	gdb.Create(&models.CompanyAccount{ID: accountID, Name: "Сеть"})
	centralID, branchID := uuid.NewString(), uuid.NewString()
	cw, ot := "central_warehouse", "outlet"
	gdb.Create(&models.Restaurant{ID: centralID, Name: "Центр", AccountID: &accountID, Kind: &cw})
	gdb.Create(&models.Restaurant{ID: branchID, Name: "Филиал", AccountID: &accountID, Kind: &ot})

	masterID := uuid.NewString()
	name, cat, hot := "Пепперони", "Пиццы", "hot_kitchen"
	gdb.Create(&models.NetworkMenuItem{
		ID: masterID, AccountID: &accountID, Name: name, Category: &cat,
		BasePrice: decimal.MustFromString("46"), Station: &hot, Available: true,
	})
	centralProductID := uuid.NewString()
	avail := true
	gdb.Create(&models.MenuItem{
		ID: centralProductID, Name: &name, Category: &cat, MasterID: &masterID,
		RestaurantID: &centralID, Price: decimal.MustFromString("46"), IsAvailable: &avail,
		UnitSize: decimal.MustFromString("1"), COGS: decimal.Zero,
	})

	syncSvc := service.NewSyncService(repo.New(gdb))
	deliver := func(rid string) {
		t.Helper()
		pull, err := syncSvc.PullFor(context.Background(), rid, nil)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := syncSvc.ApplyPulled(context.Background(), *pull, rid); err != nil {
			t.Fatal(err)
		}
	}
	deliver(branchID)

	var branchProduct models.MenuItem
	if err := gdb.Where("restaurant_id = ? AND master_id = ?", branchID, masterID).First(&branchProduct).Error; err != nil {
		t.Fatalf("продукт филиала не материализован: %v", err)
	}

	// ─── Удаление на центре ────────────────────────────────────────────────
	menuSvc := service.NewMenuService(repo.New(gdb))
	ctxCentral := tenant.WithRestaurant(context.Background(), centralID)
	if err := menuSvc.SoftDeleteItem(ctxCentral, centralProductID); err != nil {
		t.Fatalf("SoftDeleteItem на центре: %v", err)
	}

	var master models.NetworkMenuItem
	gdb.First(&master, "id = ?", masterID)
	if master.DeletedAt == nil {
		t.Fatal("мастер не помечен удалённым после SoftDeleteItem на центре")
	}
	var centralAfter models.MenuItem
	gdb.First(&centralAfter, "id = ?", centralProductID)
	if !centralAfter.IsDeleted {
		t.Error("локальная копия центра не помечена удалённой")
	}

	// До доставки филиал ещё ничего не знает.
	var beforeSync models.MenuItem
	gdb.First(&beforeSync, "id = ?", branchProduct.ID)
	if beforeSync.IsDeleted {
		t.Error("филиал удалил блюдо ДО синка")
	}

	deliver(branchID)

	var branchAfter models.MenuItem
	gdb.First(&branchAfter, "id = ?", branchProduct.ID)
	if !branchAfter.IsDeleted {
		t.Error("удаление не доехало до филиала — блюдо продолжает жить там навсегда")
	}

	// ─── Повторные доставки идемпотентны ───────────────────────────────────
	gdb.Exec("DELETE FROM sync_log")
	for i := 0; i < 3; i++ {
		deliver(branchID)
	}
	var deltas int64
	gdb.Model(&models.SyncLog{}).Count(&deltas)
	if deltas != 0 {
		t.Errorf("повторные pull'ы после удаления пишут %d дельт — бесконечный пересинк", deltas)
	}

	// ─── Второй филиал, который ни разу не видел блюдо до удаления ────────
	branch2ID := uuid.NewString()
	gdb.Create(&models.Restaurant{ID: branch2ID, Name: "Филиал-2", AccountID: &accountID, Kind: &ot})
	deliver(branch2ID) // не должно упасть и не должно ничего создать
	var branch2Count int64
	gdb.Model(&models.MenuItem{}).Where("restaurant_id = ? AND master_id = ?", branch2ID, masterID).Count(&branch2Count)
	if branch2Count != 0 {
		t.Errorf("удалённый мастер материализовался на филиале, который его никогда не видел: %d строк", branch2Count)
	}

	// ─── Удаление СВОЕЙ копии на филиале — локальное решение, мастер цел ───
	masterID2 := uuid.NewString()
	teaName := "Чай"
	gdb.Create(&models.NetworkMenuItem{
		ID: masterID2, AccountID: &accountID, Name: teaName, BasePrice: decimal.MustFromString("5"), Station: &hot, Available: true,
	})
	deliver(branchID)
	var teaOnBranch models.MenuItem
	if err := gdb.Where("restaurant_id = ? AND master_id = ?", branchID, masterID2).First(&teaOnBranch).Error; err != nil {
		t.Fatalf("чай на филиале не материализован: %v", err)
	}
	ctxBranch := tenant.WithRestaurant(context.Background(), branchID)
	if err := menuSvc.SoftDeleteItem(ctxBranch, teaOnBranch.ID); err != nil {
		t.Fatalf("SoftDeleteItem на филиале: %v", err)
	}
	var master2 models.NetworkMenuItem
	gdb.First(&master2, "id = ?", masterID2)
	if master2.DeletedAt != nil {
		t.Error("удаление СВОЕЙ копии на филиале снесло мастера — должно было остаться локальным решением")
	}
}
