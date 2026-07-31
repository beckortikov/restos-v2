//go:build integration

package service

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/audit"
	"github.com/restos/restos-v4/server/internal/db"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
	"github.com/restos/restos-v4/server/internal/repo"
	"github.com/restos/restos-v4/server/internal/synclog"
)

func ownerCtx() context.Context {
	return audit.WithActor(context.Background(), audit.Actor{UserName: "test-owner", Role: "owner"})
}

// TestBackfillRequiresOwner — не-owner получает FORBIDDEN, забфилл не трогает БД.
func TestBackfillRequiresOwner(t *testing.T) {
	gdb, err := db.Open(syncOrdersTestDSN())
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

	svc := NewSyncService(repo.New(gdb))
	ctx := audit.WithActor(context.Background(), audit.Actor{UserName: "cashier", Role: "cashier"})
	if _, err := svc.Backfill(ctx, uuid.NewString()); err == nil {
		t.Fatal("Backfill без owner — want error, got nil")
	}
}

// TestBackfillMenuItems — Pattern A (recordMenuItemsSync, список id).
func TestBackfillMenuItems(t *testing.T) {
	gdb, err := db.Open(syncOrdersTestDSN())
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
	cleanDocsTables(t, gdb, "menu_items")
	synclog.SetEnabled(true)
	t.Cleanup(func() { synclog.SetEnabled(false) })

	restID := uuid.NewString()
	name := "Плов"
	mi := models.MenuItem{ID: uuid.NewString(), Name: &name, RestaurantID: &restID, Price: decimal.MustFromString("100")}
	if err := gdb.Create(&mi).Error; err != nil {
		t.Fatalf("create menu item: %v", err)
	}
	// Другой ресторан — не должен попасть в бэкфилл этого rid.
	otherRid := uuid.NewString()
	otherName := "Чужое блюдо"
	other := models.MenuItem{ID: uuid.NewString(), Name: &otherName, RestaurantID: &otherRid, Price: decimal.MustFromString("50")}
	if err := gdb.Create(&other).Error; err != nil {
		t.Fatalf("create other menu item: %v", err)
	}

	res, err := NewSyncService(repo.New(gdb)).Backfill(ownerCtx(), restID)
	if err != nil {
		t.Fatalf("Backfill: %v", err)
	}
	if res.Entities["menu_items"] != 1 {
		t.Errorf("menu_items backfilled = %d, want 1 (не должен задеть чужой ресторан)", res.Entities["menu_items"])
	}
	var rows []models.SyncLog
	if err := gdb.Where("table_name = ? AND row_id = ?", "menu_items", mi.ID).Find(&rows).Error; err != nil {
		t.Fatalf("find sync_log: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("sync_log rows = %d, want 1", len(rows))
	}
}

// TestBackfillOrdersTerminalOnly — Pattern B (recordOrderSync) + фильтр
// терминальных статусов: активный (non-terminal) заказ НЕ должен попасть в
// бэкфилл, ровно как он не попадает в обычный live-sync (recordOrderSync
// вызывается только из терминальных точек).
func TestBackfillOrdersTerminalOnly(t *testing.T) {
	gdb, err := db.Open(syncOrdersTestDSN())
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
	cleanDocsTables(t, gdb, "order_items", "orders")
	synclog.SetEnabled(true)
	t.Cleanup(func() { synclog.SetEnabled(false) })

	restID := uuid.NewString()
	closedStatus := "closed"
	activeStatus := "new"
	closedOrder := models.Order{
		ID: uuid.NewString(), OrderNumber: 1, Status: &closedStatus, RestaurantID: &restID,
		Total: decimal.MustFromString("100"), TotalWithService: decimal.MustFromString("100"),
	}
	activeOrder := models.Order{
		ID: uuid.NewString(), OrderNumber: 2, Status: &activeStatus, RestaurantID: &restID,
		Total: decimal.MustFromString("200"), TotalWithService: decimal.MustFromString("200"),
	}
	if err := gdb.Create(&closedOrder).Error; err != nil {
		t.Fatalf("create closed order: %v", err)
	}
	if err := gdb.Create(&activeOrder).Error; err != nil {
		t.Fatalf("create active order: %v", err)
	}

	res, err := NewSyncService(repo.New(gdb)).Backfill(ownerCtx(), restID)
	if err != nil {
		t.Fatalf("Backfill: %v", err)
	}
	if res.Entities["orders"] != 1 {
		t.Errorf("orders backfilled = %d, want 1 (только терминальный)", res.Entities["orders"])
	}
	var closedCount, activeCount int64
	gdb.Model(&models.SyncLog{}).Where("table_name = ? AND row_id = ?", "orders", closedOrder.ID).Count(&closedCount)
	gdb.Model(&models.SyncLog{}).Where("table_name = ? AND row_id = ?", "orders", activeOrder.ID).Count(&activeCount)
	if closedCount != 1 {
		t.Errorf("closed order sync_log rows = %d, want 1", closedCount)
	}
	if activeCount != 0 {
		t.Errorf("active order sync_log rows = %d, want 0 (не терминальный — не должен синкаться)", activeCount)
	}
}

// TestBackfillCashShiftOperations — bespoke-сущность БЕЗ restaurant_id
// колонки (скоуп через JOIN на cash_shifts). Самая рискованная из бэкфилл-
// сущностей: пропущенный JOIN означал бы либо 0 строк, либо чужие рестораны.
func TestBackfillCashShiftOperations(t *testing.T) {
	gdb, err := db.Open(syncOrdersTestDSN())
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
	cleanDocsTables(t, gdb, "cash_shift_operations", "cash_shifts")
	synclog.SetEnabled(true)
	t.Cleanup(func() { synclog.SetEnabled(false) })

	restID := uuid.NewString()
	otherRid := uuid.NewString()
	shift := models.CashShift{ID: uuid.NewString(), RestaurantID: &restID}
	otherShift := models.CashShift{ID: uuid.NewString(), RestaurantID: &otherRid}
	if err := gdb.Create(&shift).Error; err != nil {
		t.Fatalf("create shift: %v", err)
	}
	if err := gdb.Create(&otherShift).Error; err != nil {
		t.Fatalf("create other shift: %v", err)
	}
	opType := "cash_in"
	op := models.CashShiftOperation{ID: uuid.NewString(), ShiftID: &shift.ID, Type: &opType, Amount: decimal.MustFromString("500")}
	otherOp := models.CashShiftOperation{ID: uuid.NewString(), ShiftID: &otherShift.ID, Type: &opType, Amount: decimal.MustFromString("999")}
	if err := gdb.Create(&op).Error; err != nil {
		t.Fatalf("create op: %v", err)
	}
	if err := gdb.Create(&otherOp).Error; err != nil {
		t.Fatalf("create other op: %v", err)
	}
	// trackedInsert-хук уже что-то записал при Create — чистим перед
	// собственно тестируемым вызовом Backfill, чтобы считать только его.
	if err := gdb.Exec("DELETE FROM sync_log").Error; err != nil {
		t.Fatalf("clean sync_log: %v", err)
	}

	res, err := NewSyncService(repo.New(gdb)).Backfill(ownerCtx(), restID)
	if err != nil {
		t.Fatalf("Backfill: %v", err)
	}
	if res.Entities["cash_shift_operations"] != 1 {
		t.Errorf("cash_shift_operations backfilled = %d, want 1 (JOIN на свою смену, не чужую)", res.Entities["cash_shift_operations"])
	}
	var count, otherCount int64
	gdb.Model(&models.SyncLog{}).Where("table_name = ? AND row_id = ?", "cash_shift_operations", op.ID).Count(&count)
	gdb.Model(&models.SyncLog{}).Where("table_name = ? AND row_id = ?", "cash_shift_operations", otherOp.ID).Count(&otherCount)
	if count != 1 {
		t.Errorf("своя операция: sync_log rows = %d, want 1", count)
	}
	if otherCount != 0 {
		t.Errorf("чужая операция: sync_log rows = %d, want 0 (утечка между ресторанами через JOIN)", otherCount)
	}
}

// TestBackfillFinancialAccounts — bespoke-сущность (Ф5, generic trackedSave
// в живом коде, но backfill не идёт через tx.Create — читает существующую
// строку и пишет sync_log напрямую, поэтому GORM zero-value-default баг
// (gorm-zero-value-default-tag-gotcha) здесь неприменим в принципе).
func TestBackfillFinancialAccounts(t *testing.T) {
	gdb, err := db.Open(syncOrdersTestDSN())
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
	cleanDocsTables(t, gdb, "financial_accounts")
	synclog.SetEnabled(true)
	t.Cleanup(func() { synclog.SetEnabled(false) })

	restID := uuid.NewString()
	name := "Касса"
	// IsEnabled создаём true (безопасное направление — см.
	// gorm-zero-value-default-tag-gotcha: Create() с IsEnabled:false
	// заранее подменил бы значение обратно на true ДО того, как Backfill
	// вообще прочитает строку — это была бы порча фикстуры теста, не баг
	// Backfill). Отключаем ОТДЕЛЬНЫМ map-based Update, как реальный
	// SetEnabled — та же схема, какой производственный код реально
	// достигает is_enabled=false.
	acc := models.FinancialAccount{ID: uuid.NewString(), Name: &name, RestaurantID: &restID, IsEnabled: true}
	if err := gdb.Create(&acc).Error; err != nil {
		t.Fatalf("create account: %v", err)
	}
	if err := gdb.Model(&models.FinancialAccount{ID: acc.ID}).Update("is_enabled", false).Error; err != nil {
		t.Fatalf("disable account: %v", err)
	}
	// financial_accounts — в trackedSave (Ф5): Create и Update фикстуры уже
	// синканули через generic-хук. Чистим, чтобы считать только вызов
	// Backfill ниже (тот же приём, что и в TestBackfillCashShiftOperations).
	if err := gdb.Exec("DELETE FROM sync_log").Error; err != nil {
		t.Fatalf("clean sync_log: %v", err)
	}

	res, err := NewSyncService(repo.New(gdb)).Backfill(ownerCtx(), restID)
	if err != nil {
		t.Fatalf("Backfill: %v", err)
	}
	if res.Entities["financial_accounts"] != 1 {
		t.Errorf("financial_accounts backfilled = %d, want 1", res.Entities["financial_accounts"])
	}
	var rows []models.SyncLog
	gdb.Where("table_name = ? AND row_id = ?", "financial_accounts", acc.ID).Find(&rows)
	if len(rows) != 1 {
		t.Fatalf("sync_log rows = %d, want 1", len(rows))
	}
	var payload models.FinancialAccount
	if err := json.Unmarshal(rows[0].Payload, &payload); err != nil {
		t.Fatalf("unmarshal payload: %v", err)
	}
	if payload.IsEnabled {
		t.Errorf("payload.IsEnabled = true, want false (backfill читает существующую строку напрямую, не через Create)")
	}
}

// TestBackfillPagination — постраничный драйвер реально проходит НЕСКОЛЬКО
// страниц (не только «одна страница = всё»). Временно уменьшаем
// backfillBatchSize, чтобы не создавать 500+ фикстур в тесте.
func TestBackfillPagination(t *testing.T) {
	gdb, err := db.Open(syncOrdersTestDSN())
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
	cleanDocsTables(t, gdb, "ingredients")
	synclog.SetEnabled(true)
	t.Cleanup(func() { synclog.SetEnabled(false) })

	oldBatch := backfillBatchSize
	backfillBatchSize = 3
	t.Cleanup(func() { backfillBatchSize = oldBatch })

	restID := uuid.NewString()
	const total = 7 // не кратно размеру страницы (3) — ловит off-by-one на последней неполной странице
	for i := 0; i < total; i++ {
		name := "Ингредиент"
		ing := models.Ingredient{ID: uuid.NewString(), Name: &name, RestaurantID: &restID}
		if err := gdb.Create(&ing).Error; err != nil {
			t.Fatalf("create ingredient %d: %v", i, err)
		}
	}

	res, err := NewSyncService(repo.New(gdb)).Backfill(ownerCtx(), restID)
	if err != nil {
		t.Fatalf("Backfill: %v", err)
	}
	if res.Entities["ingredients"] != total {
		t.Errorf("ingredients backfilled = %d, want %d (3 страницы: 3+3+1)", res.Entities["ingredients"], total)
	}
	var count int64
	gdb.Model(&models.SyncLog{}).Where("table_name = ?", "ingredients").Count(&count)
	if count != total {
		t.Errorf("sync_log rows = %d, want %d (не задвоилось между страницами)", count, total)
	}
}
