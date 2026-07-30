//go:build integration

package service

import (
	"testing"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/db"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/synclog"
)

// TestRecordTableSync — whitebox-тест recordTableSync/recordTableDeleteSync
// (Ф2): insert/update/delete пишут по строке в sync_log с правильными
// Entity/RowID/Op.
func TestRecordTableSync(t *testing.T) {
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
	for _, tbl := range []string{"sync_log", "tables"} {
		if err := gdb.Exec("DELETE FROM " + tbl).Error; err != nil {
			t.Fatalf("clean %s: %v", tbl, err)
		}
	}
	synclog.SetEnabled(true)
	t.Cleanup(func() { synclog.SetEnabled(false) })

	restID := uuid.NewString()
	tableID := uuid.NewString()
	num := 3
	tbl := models.Table{ID: tableID, Number: &num, RestaurantID: &restID}

	if err := gdb.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(&tbl).Error; err != nil {
			return err
		}
		return recordTableSync(tx, &tbl, "insert")
	}); err != nil {
		t.Fatalf("transaction (insert): %v", err)
	}
	if err := gdb.Transaction(func(tx *gorm.DB) error {
		return recordTableDeleteSync(tx, tableID, restID)
	}); err != nil {
		t.Fatalf("transaction (delete): %v", err)
	}

	var rows []models.SyncLog
	if err := gdb.Where("table_name = ? AND row_id = ?", "tables", tableID).
		Order("created_at ASC").Find(&rows).Error; err != nil {
		t.Fatalf("find sync_log: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("sync_log rows = %d, want 2 (insert + delete)", len(rows))
	}
	if rows[0].Op != "insert" || rows[1].Op != "delete" {
		t.Errorf("ops = %s/%s, want insert/delete", rows[0].Op, rows[1].Op)
	}
	if len(rows[1].Payload) != 0 {
		t.Errorf("delete payload = %s, want empty", rows[1].Payload)
	}
}

// TestRecordZoneSync — whitebox-тест recordZoneSync/recordZoneDeleteSync.
func TestRecordZoneSync(t *testing.T) {
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
	for _, tbl := range []string{"sync_log", "zones"} {
		if err := gdb.Exec("DELETE FROM " + tbl).Error; err != nil {
			t.Fatalf("clean %s: %v", tbl, err)
		}
	}
	synclog.SetEnabled(true)
	t.Cleanup(func() { synclog.SetEnabled(false) })

	restID := uuid.NewString()
	zoneID := uuid.NewString()
	z := models.Zone{ID: zoneID, Name: "Терраса", RestaurantID: &restID}

	if err := gdb.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(&z).Error; err != nil {
			return err
		}
		return recordZoneSync(tx, &z, "insert")
	}); err != nil {
		t.Fatalf("transaction (insert): %v", err)
	}
	if err := gdb.Transaction(func(tx *gorm.DB) error {
		return recordZoneDeleteSync(tx, zoneID, restID)
	}); err != nil {
		t.Fatalf("transaction (delete): %v", err)
	}

	var rows []models.SyncLog
	if err := gdb.Where("table_name = ? AND row_id = ?", "zones", zoneID).
		Order("created_at ASC").Find(&rows).Error; err != nil {
		t.Fatalf("find sync_log: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("sync_log rows = %d, want 2 (insert + delete)", len(rows))
	}
	if rows[0].Op != "insert" || rows[1].Op != "delete" {
		t.Errorf("ops = %s/%s, want insert/delete", rows[0].Op, rows[1].Op)
	}
}
