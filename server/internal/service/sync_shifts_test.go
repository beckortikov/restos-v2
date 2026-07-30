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

// TestRecordShiftSync — whitebox-тест recordShiftSync (ADR-003 «Central видит
// всё», Ф1): пишет в sync_log снимок смены с правильными Entity/RowID/
// RestaurantID, повторный Save (обновлённые агрегаты) пишет ВТОРУЮ дельту
// (не апдейтит первую — sync_log это append-only журнал, central применяет
// строки по порядку через upsert).
func TestRecordShiftSync(t *testing.T) {
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
	for _, tbl := range []string{"sync_log", "cash_shifts"} {
		if err := gdb.Exec("DELETE FROM " + tbl).Error; err != nil {
			t.Fatalf("clean %s: %v", tbl, err)
		}
	}
	synclog.SetEnabled(true)
	t.Cleanup(func() { synclog.SetEnabled(false) })

	restID := uuid.NewString()
	shiftID := uuid.NewString()
	status := "open"
	shift := models.CashShift{
		ID: shiftID, RestaurantID: &restID, Status: &status,
		OpeningBalance: decimal.MustFromString("500"),
		CashRevenue:    decimal.MustFromString("350"),
	}

	if err := gdb.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(&shift).Error; err != nil {
			return err
		}
		return recordShiftSync(tx, &shift, "insert")
	}); err != nil {
		t.Fatalf("transaction (insert): %v", err)
	}

	// Смена ещё открыта, revenue подрос (order close) — ВТОРОЙ Save.
	if err := gdb.Transaction(func(tx *gorm.DB) error {
		shift.CashRevenue = decimal.MustFromString("700")
		if err := tx.Save(&shift).Error; err != nil {
			return err
		}
		return recordShiftSync(tx, &shift, "update")
	}); err != nil {
		t.Fatalf("transaction (update): %v", err)
	}

	var rows []models.SyncLog
	if err := gdb.Where("table_name = ? AND row_id = ?", "cash_shifts", shiftID).
		Order("created_at ASC").Find(&rows).Error; err != nil {
		t.Fatalf("find sync_log: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("sync_log rows = %d, want 2 (insert + update — журнал append-only)", len(rows))
	}
	if rows[0].Op != "insert" || rows[1].Op != "update" {
		t.Errorf("ops = %s/%s, want insert/update", rows[0].Op, rows[1].Op)
	}
	if rows[1].RestaurantID == nil || *rows[1].RestaurantID != restID {
		t.Errorf("restaurant_id = %v, want %s", rows[1].RestaurantID, restID)
	}

	var payload models.CashShift
	if err := json.Unmarshal(rows[1].Payload, &payload); err != nil {
		t.Fatalf("unmarshal payload: %v", err)
	}
	if !payload.CashRevenue.Equal(decimal.MustFromString("700")) {
		t.Errorf("payload.CashRevenue = %s, want 700 (снимок ЕЩЁ ОТКРЫТОЙ смены)", payload.CashRevenue.String())
	}
}

// TestRecordShiftOpDeleteSync — whitebox-тест удаления операции смены: пишет
// Op:"delete" БЕЗ payload (central удаляет по RowID, снимок строки ему не
// нужен — см. applyShiftOp).
func TestRecordShiftOpDeleteSync(t *testing.T) {
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
	for _, tbl := range []string{"sync_log"} {
		if err := gdb.Exec("DELETE FROM " + tbl).Error; err != nil {
			t.Fatalf("clean %s: %v", tbl, err)
		}
	}
	synclog.SetEnabled(true)
	t.Cleanup(func() { synclog.SetEnabled(false) })

	restID := uuid.NewString()
	opID := uuid.NewString()
	if err := gdb.Transaction(func(tx *gorm.DB) error {
		return recordShiftOpDeleteSync(tx, opID, restID)
	}); err != nil {
		t.Fatalf("transaction: %v", err)
	}

	var row models.SyncLog
	if err := gdb.Where("table_name = ? AND row_id = ?", "cash_shift_operations", opID).First(&row).Error; err != nil {
		t.Fatalf("find sync_log: %v", err)
	}
	if row.Op != "delete" {
		t.Errorf("op = %s, want delete", row.Op)
	}
	if len(row.Payload) != 0 {
		t.Errorf("payload = %s, want empty (delete не нуждается в снимке строки)", row.Payload)
	}
}

// TestRecordUserSync — whitebox-тест recordUserSync: PIN/Password (json:"-"
// на models.User) физически отсутствуют в сериализованном payload'е — central
// получает сотрудника с NULL pin/password, залогиниться под ним нельзя
// (LoginByPIN фильтрует "pin IS NOT NULL", см. auth.go).
func TestRecordUserSync(t *testing.T) {
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
	for _, tbl := range []string{"sync_log", "users"} {
		if err := gdb.Exec("DELETE FROM " + tbl).Error; err != nil {
			t.Fatalf("clean %s: %v", tbl, err)
		}
	}
	synclog.SetEnabled(true)
	t.Cleanup(func() { synclog.SetEnabled(false) })

	restID := uuid.NewString()
	userID := uuid.NewString()
	name := "Официант Азиз"
	role := "waiter"
	pin := "4321"
	pass := "secret"
	u := models.User{
		ID: userID, Name: &name, Role: &role, RestaurantID: &restID,
		PIN: &pin, Password: &pass,
	}

	if err := gdb.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(&u).Error; err != nil {
			return err
		}
		return recordUserSync(tx, &u, "insert")
	}); err != nil {
		t.Fatalf("transaction: %v", err)
	}

	var row models.SyncLog
	if err := gdb.Where("table_name = ? AND row_id = ?", "users", userID).First(&row).Error; err != nil {
		t.Fatalf("find sync_log: %v", err)
	}
	var raw map[string]any
	if err := json.Unmarshal(row.Payload, &raw); err != nil {
		t.Fatalf("unmarshal payload: %v", err)
	}
	if _, ok := raw["pin"]; ok {
		t.Errorf("payload содержит pin — секрет филиала утёк бы на central: %s", row.Payload)
	}
	if _, ok := raw["password"]; ok || raw["Password"] != nil {
		t.Errorf("payload содержит password — секрет филиала утёк бы на central: %s", row.Payload)
	}
	if name, ok := raw["name"].(string); !ok || name != "Официант Азиз" {
		t.Errorf("payload.name = %v, want Официант Азиз (обычные поля синкаются)", raw["name"])
	}
}
