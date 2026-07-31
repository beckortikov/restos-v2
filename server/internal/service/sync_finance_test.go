//go:build integration

package service

import (
	"encoding/json"
	"testing"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/db"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
	"github.com/restos/restos-v4/server/internal/synclog"
)

// TestFinancialAccountTrackedSaveHook — generic trackedSave-хук (Ф5):
// Create И Update синкаются автоматически, БЕЗ явного recordXSync на каждой
// из ~20 точек мутации баланса. Update проверяется в ДВУХ формах:
//   - gorm.Expr(...) — стиль, которым 6 из 20 найденных точек реально пишут
//     баланс (balance +/- ?), значение вычисляется в БД, а не в Go;
//   - обычное Go-значение (SetEnabled-стиль, is_enabled).
//
// Оба случая должны попасть в sync_log с ПРАВИЛЬНЫМ финальным значением —
// хук перечитывает строку из БД по ID (не пытается прочитать Updates(map)
// напрямую, что было бы ненадёжно и для gorm.Expr в принципе невозможно).
func TestFinancialAccountTrackedSaveHook(t *testing.T) {
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
	accID := uuid.NewString()
	name := "Касса"
	acc := models.FinancialAccount{
		ID: accID, Name: &name, RestaurantID: &restID,
		Balance: decimal.MustFromString("100"), IsEnabled: true,
	}
	if err := gdb.Create(&acc).Error; err != nil {
		t.Fatalf("create: %v", err)
	}
	var createRows []models.SyncLog
	if err := gdb.Where("table_name = ? AND row_id = ?", "financial_accounts", accID).Find(&createRows).Error; err != nil {
		t.Fatalf("find create sync_log: %v", err)
	}
	if len(createRows) != 1 || createRows[0].Op != "insert" {
		t.Fatalf("after create: sync_log = %+v, want 1 insert row", createRows)
	}

	// Update через gorm.Expr — баланс-стиль (6/20 точек).
	if err := gdb.Model(&models.FinancialAccount{ID: accID}).
		Updates(map[string]any{"balance": gorm.Expr("balance + ?", decimal.MustFromString("50"))}).Error; err != nil {
		t.Fatalf("update via gorm.Expr: %v", err)
	}
	var updateRows []models.SyncLog
	if err := gdb.Where("table_name = ? AND row_id = ? AND op = ?", "financial_accounts", accID, "update").
		Find(&updateRows).Error; err != nil {
		t.Fatalf("find update sync_log: %v", err)
	}
	if len(updateRows) != 1 {
		t.Fatalf("after gorm.Expr update: sync_log update rows = %d, want 1", len(updateRows))
	}
	var payload models.FinancialAccount
	if err := json.Unmarshal(updateRows[0].Payload, &payload); err != nil {
		t.Fatalf("unmarshal payload: %v", err)
	}
	if !payload.Balance.Equal(decimal.MustFromString("150")) {
		t.Errorf("synced balance after gorm.Expr = %s, want 150 (перечитано из БД, не взято из Updates(map))", payload.Balance.String())
	}

	// Update обычным Go-значением — SetEnabled-стиль.
	if err := gdb.Model(&models.FinancialAccount{ID: accID}).
		Updates(map[string]any{"is_enabled": false}).Error; err != nil {
		t.Fatalf("update plain value: %v", err)
	}
	var updateRows2 []models.SyncLog
	if err := gdb.Where("table_name = ? AND row_id = ? AND op = ?", "financial_accounts", accID, "update").
		Find(&updateRows2).Error; err != nil {
		t.Fatalf("find second update sync_log: %v", err)
	}
	if len(updateRows2) != 2 {
		t.Fatalf("after second update: sync_log update rows = %d, want 2", len(updateRows2))
	}
	var payload2 models.FinancialAccount
	if err := json.Unmarshal(updateRows2[1].Payload, &payload2); err != nil {
		t.Fatalf("unmarshal second payload: %v", err)
	}
	if payload2.IsEnabled {
		t.Errorf("synced is_enabled = true, want false")
	}

	// Голый литерал БЕЗ ID — регресс-проверка известного ограничения (см.
	// комментарий у trackedSave, recorder_hook.go): хук должен молча
	// пропустить, а не запаниковать и не засинкать пустой RowID.
	otherID := uuid.NewString()
	otherName := "Банк"
	if err := gdb.Create(&models.FinancialAccount{ID: otherID, Name: &otherName, RestaurantID: &restID}).Error; err != nil {
		t.Fatalf("create other: %v", err)
	}
	if err := gdb.Model(&models.FinancialAccount{}).Where("id = ?", otherID).
		Updates(map[string]any{"is_enabled": false}).Error; err != nil {
		t.Fatalf("update bare literal: %v", err)
	}
	var bareRows []models.SyncLog
	if err := gdb.Where("table_name = ? AND row_id = ? AND op = ?", "financial_accounts", otherID, "update").
		Find(&bareRows).Error; err != nil {
		t.Fatalf("find bare-literal sync_log: %v", err)
	}
	if len(bareRows) != 0 {
		t.Errorf("bare-literal update synced rows = %d, want 0 (ID недоступен через reflection — известное ограничение)", len(bareRows))
	}
}

// TestRecordFinancialAccountDeleteSync — Delete не ловится generic-хуком
// (только Create/Update) — explicit-вызов, как у suppliers/ingredients.
func TestRecordFinancialAccountDeleteSync(t *testing.T) {
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
	accID := uuid.NewString()
	if err := gdb.Transaction(func(tx *gorm.DB) error {
		return recordFinancialAccountDeleteSync(tx, accID, restID)
	}); err != nil {
		t.Fatalf("recordFinancialAccountDeleteSync: %v", err)
	}
	var rows []models.SyncLog
	if err := gdb.Where("table_name = ? AND row_id = ?", "financial_accounts", accID).Find(&rows).Error; err != nil {
		t.Fatalf("find sync_log: %v", err)
	}
	if len(rows) != 1 || rows[0].Op != "delete" {
		t.Fatalf("sync_log = %+v, want 1 delete row", rows)
	}
}

// TestRecordRecurringPaymentSync — recurring_payments (Ф5): explicit, по
// списку id (та же форма, что recordIngredientSync/recordSupplierSync).
func TestRecordRecurringPaymentSync(t *testing.T) {
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
	cleanDocsTables(t, gdb, "recurring_payments")
	synclog.SetEnabled(true)
	t.Cleanup(func() { synclog.SetEnabled(false) })

	restID := uuid.NewString()
	rpID := uuid.NewString()
	name := "Аренда"
	rp := models.RecurringPayment{
		ID: rpID, Name: &name, RestaurantID: &restID,
		Amount: decimal.MustFromString("5000"), DayOfMonth: 5, Active: true,
	}
	if err := gdb.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(&rp).Error; err != nil {
			return err
		}
		return recordRecurringPaymentSync(tx, []string{rpID})
	}); err != nil {
		t.Fatalf("transaction (insert): %v", err)
	}
	if err := gdb.Transaction(func(tx *gorm.DB) error {
		return recordRecurringPaymentDeleteSync(tx, rpID, restID)
	}); err != nil {
		t.Fatalf("transaction (delete): %v", err)
	}

	var rows []models.SyncLog
	if err := gdb.Where("table_name = ? AND row_id = ?", "recurring_payments", rpID).
		Order("created_at ASC").Find(&rows).Error; err != nil {
		t.Fatalf("find sync_log: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("sync_log rows = %d, want 2 (insert + delete)", len(rows))
	}
	if rows[0].Op != "update" || rows[1].Op != "delete" {
		t.Errorf("ops = %s/%s, want update/delete", rows[0].Op, rows[1].Op)
	}
	var payload models.RecurringPayment
	if err := json.Unmarshal(rows[0].Payload, &payload); err != nil {
		t.Fatalf("unmarshal payload: %v", err)
	}
	if !payload.Amount.Equal(decimal.MustFromString("5000")) {
		t.Errorf("payload.Amount = %s, want 5000", payload.Amount.String())
	}
}

// TestRecordFinancialOpDeleteSync — закрывает известный пробел (Ф5):
// DeleteExpense/DeleteOperation реально удаляют связанную FinancialOperation,
// generic trackedInsert-хук (append-only-предположение) этого не ловит.
func TestRecordFinancialOpDeleteSync(t *testing.T) {
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
	cleanDocsTables(t, gdb, "financial_operations")
	synclog.SetEnabled(true)
	t.Cleanup(func() { synclog.SetEnabled(false) })

	restID := uuid.NewString()
	opID := uuid.NewString()
	if err := gdb.Transaction(func(tx *gorm.DB) error {
		return recordFinancialOpDeleteSync(tx, opID, restID)
	}); err != nil {
		t.Fatalf("recordFinancialOpDeleteSync: %v", err)
	}
	var rows []models.SyncLog
	if err := gdb.Where("table_name = ? AND row_id = ?", "financial_operations", opID).Find(&rows).Error; err != nil {
		t.Fatalf("find sync_log: %v", err)
	}
	if len(rows) != 1 || rows[0].Op != "delete" {
		t.Fatalf("sync_log = %+v, want 1 delete row", rows)
	}
}
