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

// TestRecordMenuItemsSync — whitebox-тест recordMenuItemsSync (Ф2): один
// вызов с несколькими id пишет по строке sync_log на каждый — покрывает
// массовые случаи (SoftDeleteItem — родитель+варианты, syncVariants —
// комбинации атрибутов, импорт xlsx) без инструментирования каждой Updates()
// внутри их циклов.
func TestRecordMenuItemsSync(t *testing.T) {
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
	for _, tbl := range []string{"sync_log", "menu_items"} {
		if err := gdb.Exec("DELETE FROM " + tbl).Error; err != nil {
			t.Fatalf("clean %s: %v", tbl, err)
		}
	}
	synclog.SetEnabled(true)
	t.Cleanup(func() { synclog.SetEnabled(false) })

	restID := uuid.NewString()
	parentID := uuid.NewString()
	variantID := uuid.NewString()
	parentName := "Пицца Маргарита"
	variantName := "Пицца Маргарита 30см"
	parent := models.MenuItem{ID: parentID, Name: &parentName, RestaurantID: &restID, Price: decimal.MustFromString("100")}
	variant := models.MenuItem{ID: variantID, Name: &variantName, ParentID: &parentID, RestaurantID: &restID, Price: decimal.MustFromString("120")}

	if err := gdb.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(&parent).Error; err != nil {
			return err
		}
		if err := tx.Create(&variant).Error; err != nil {
			return err
		}
		return recordMenuItemsSync(tx, []string{parentID, variantID})
	}); err != nil {
		t.Fatalf("transaction: %v", err)
	}

	var rows []models.SyncLog
	if err := gdb.Where("table_name = ? AND row_id IN ?", "menu_items", []string{parentID, variantID}).
		Find(&rows).Error; err != nil {
		t.Fatalf("find sync_log: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("sync_log rows = %d, want 2 (родитель + вариант)", len(rows))
	}

	var payloadIDs []string
	for _, r := range rows {
		var p models.MenuItem
		if err := json.Unmarshal(r.Payload, &p); err != nil {
			t.Fatalf("unmarshal payload: %v", err)
		}
		payloadIDs = append(payloadIDs, p.ID)
	}
	if !((payloadIDs[0] == parentID && payloadIDs[1] == variantID) || (payloadIDs[0] == variantID && payloadIDs[1] == parentID)) {
		t.Errorf("payload ids = %v, want [%s %s] in any order", payloadIDs, parentID, variantID)
	}

	// Пустой список — no-op, не должен упасть.
	if err := gdb.Transaction(func(tx *gorm.DB) error {
		return recordMenuItemsSync(tx, nil)
	}); err != nil {
		t.Fatalf("recordMenuItemsSync(nil): %v", err)
	}
}
