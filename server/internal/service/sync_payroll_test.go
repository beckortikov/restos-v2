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

// TestRecordTimeEntrySync — time_entries (Ф5б): explicit upsert (перечитывает
// по id, как cash_shifts в Ф1) + explicit hard delete.
func TestRecordTimeEntrySync(t *testing.T) {
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
	cleanDocsTables(t, gdb, "time_entries")
	synclog.SetEnabled(true)
	t.Cleanup(func() { synclog.SetEnabled(false) })

	restID := uuid.NewString()
	userID := uuid.NewString()
	teID := uuid.NewString()
	active := "active"
	te := models.TimeEntry{ID: teID, UserID: &userID, Status: &active, RestaurantID: &restID}
	if err := gdb.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(&te).Error; err != nil {
			return err
		}
		return recordTimeEntrySync(tx, teID)
	}); err != nil {
		t.Fatalf("transaction (insert): %v", err)
	}
	if err := gdb.Transaction(func(tx *gorm.DB) error {
		return recordTimeEntryDeleteSync(tx, teID, restID)
	}); err != nil {
		t.Fatalf("transaction (delete): %v", err)
	}

	var rows []models.SyncLog
	if err := gdb.Where("table_name = ? AND row_id = ?", "time_entries", teID).
		Order("created_at ASC").Find(&rows).Error; err != nil {
		t.Fatalf("find sync_log: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("sync_log rows = %d, want 2 (insert + delete)", len(rows))
	}
	if rows[0].Op != "update" || rows[1].Op != "delete" {
		t.Errorf("ops = %s/%s, want update/delete", rows[0].Op, rows[1].Op)
	}
	var payload models.TimeEntry
	if err := json.Unmarshal(rows[0].Payload, &payload); err != nil {
		t.Fatalf("unmarshal payload: %v", err)
	}
	if payload.Status == nil || *payload.Status != "active" {
		t.Errorf("payload.Status = %v, want active", payload.Status)
	}
}

// TestRecordSalaryWorkedDaySync — override-таблица: строка есть = отмечен
// вручную. Toggle = create/delete, не update.
func TestRecordSalaryWorkedDaySync(t *testing.T) {
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
	cleanDocsTables(t, gdb, "salary_worked_days")
	synclog.SetEnabled(true)
	t.Cleanup(func() { synclog.SetEnabled(false) })

	restID := uuid.NewString()
	userID := uuid.NewString()
	rowID := uuid.NewString()
	row := models.SalaryWorkedDay{ID: rowID, RestaurantID: &restID, UserID: &userID, WorkDate: "2026-08-01"}
	if err := gdb.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(&row).Error; err != nil {
			return err
		}
		return recordSalaryWorkedDaySync(tx, &row)
	}); err != nil {
		t.Fatalf("transaction (insert): %v", err)
	}
	if err := gdb.Transaction(func(tx *gorm.DB) error {
		return recordSalaryWorkedDayDeleteSync(tx, rowID, restID)
	}); err != nil {
		t.Fatalf("transaction (delete): %v", err)
	}

	var rows []models.SyncLog
	if err := gdb.Where("table_name = ? AND row_id = ?", "salary_worked_days", rowID).
		Order("created_at ASC").Find(&rows).Error; err != nil {
		t.Fatalf("find sync_log: %v", err)
	}
	if len(rows) != 2 || rows[0].Op != "update" || rows[1].Op != "delete" {
		t.Fatalf("sync_log = %+v, want update+delete", rows)
	}
}

// TestRecordSalaryDayMultiplierSync — тот же паттерн override-таблицы, что и
// salary_worked_days, отдельная таблица (066, merge из main).
func TestRecordSalaryDayMultiplierSync(t *testing.T) {
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
	cleanDocsTables(t, gdb, "salary_day_multipliers")
	synclog.SetEnabled(true)
	t.Cleanup(func() { synclog.SetEnabled(false) })

	restID := uuid.NewString()
	userID := uuid.NewString()
	rowID := uuid.NewString()
	row := models.SalaryDayMultiplier{ID: rowID, RestaurantID: &restID, UserID: &userID, WorkDate: "2026-08-01", Multiplier: 2}
	if err := gdb.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(&row).Error; err != nil {
			return err
		}
		return recordSalaryDayMultiplierSync(tx, &row)
	}); err != nil {
		t.Fatalf("transaction (insert): %v", err)
	}
	if err := gdb.Transaction(func(tx *gorm.DB) error {
		return recordSalaryDayMultiplierDeleteSync(tx, rowID, restID)
	}); err != nil {
		t.Fatalf("transaction (delete): %v", err)
	}

	var rows []models.SyncLog
	if err := gdb.Where("table_name = ? AND row_id = ?", "salary_day_multipliers", rowID).
		Order("created_at ASC").Find(&rows).Error; err != nil {
		t.Fatalf("find sync_log: %v", err)
	}
	if len(rows) != 2 || rows[0].Op != "update" || rows[1].Op != "delete" {
		t.Fatalf("sync_log = %+v, want update+delete", rows)
	}
	var payload models.SalaryDayMultiplier
	if err := json.Unmarshal(rows[0].Payload, &payload); err != nil {
		t.Fatalf("unmarshal payload: %v", err)
	}
	if payload.Multiplier != 2 {
		t.Errorf("payload.Multiplier = %d, want 2", payload.Multiplier)
	}
}

// TestRecordSalaryDeductionSync — create + soft-cancel, НИКОГДА hard delete
// (см. комментарий у applySalaryDeduction) — оба раза upsert.
func TestRecordSalaryDeductionSync(t *testing.T) {
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
	cleanDocsTables(t, gdb, "salary_deductions")
	synclog.SetEnabled(true)
	t.Cleanup(func() { synclog.SetEnabled(false) })

	restID := uuid.NewString()
	userID := uuid.NewString()
	rowID := uuid.NewString()
	row := models.SalaryDeduction{
		ID: rowID, RestaurantID: &restID, UserID: userID,
		Amount: decimal.MustFromString("100"), Reason: "опоздание",
	}
	if err := gdb.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(&row).Error; err != nil {
			return err
		}
		return recordSalaryDeductionSync(tx, &row)
	}); err != nil {
		t.Fatalf("transaction (insert): %v", err)
	}

	var rows []models.SyncLog
	if err := gdb.Where("table_name = ? AND row_id = ?", "salary_deductions", rowID).Find(&rows).Error; err != nil {
		t.Fatalf("find sync_log: %v", err)
	}
	if len(rows) != 1 || rows[0].Op != "update" {
		t.Fatalf("sync_log = %+v, want 1 update row", rows)
	}
	var payload models.SalaryDeduction
	if err := json.Unmarshal(rows[0].Payload, &payload); err != nil {
		t.Fatalf("unmarshal payload: %v", err)
	}
	if !payload.Amount.Equal(decimal.MustFromString("100")) {
		t.Errorf("payload.Amount = %s, want 100", payload.Amount.String())
	}
}

// TestRecordSalaryAdvanceSync — тот же паттерн, что salary_deductions:
// create + soft-cancel, никогда hard delete.
func TestRecordSalaryAdvanceSync(t *testing.T) {
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
	cleanDocsTables(t, gdb, "salary_advances")
	synclog.SetEnabled(true)
	t.Cleanup(func() { synclog.SetEnabled(false) })

	restID := uuid.NewString()
	userID := uuid.NewString()
	accID := uuid.NewString()
	rowID := uuid.NewString()
	row := models.SalaryAdvance{
		ID: rowID, RestaurantID: &restID, UserID: userID,
		Amount: decimal.MustFromString("500"), Period: "2026-08", AccountID: accID,
	}
	if err := gdb.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(&row).Error; err != nil {
			return err
		}
		return recordSalaryAdvanceSync(tx, &row)
	}); err != nil {
		t.Fatalf("transaction (insert): %v", err)
	}

	var rows []models.SyncLog
	if err := gdb.Where("table_name = ? AND row_id = ?", "salary_advances", rowID).Find(&rows).Error; err != nil {
		t.Fatalf("find sync_log: %v", err)
	}
	if len(rows) != 1 || rows[0].Op != "update" {
		t.Fatalf("sync_log = %+v, want 1 update row", rows)
	}
	var payload models.SalaryAdvance
	if err := json.Unmarshal(rows[0].Payload, &payload); err != nil {
		t.Fatalf("unmarshal payload: %v", err)
	}
	if !payload.Amount.Equal(decimal.MustFromString("500")) {
		t.Errorf("payload.Amount = %s, want 500", payload.Amount.String())
	}
}
