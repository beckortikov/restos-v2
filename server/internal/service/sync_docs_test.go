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

// cleanDocsTables — общая зачистка для тестов sync_docs.go.
func cleanDocsTables(t *testing.T, gdb *gorm.DB, tables ...string) {
	t.Helper()
	for _, tbl := range append([]string{"sync_log"}, tables...) {
		if err := gdb.Exec("DELETE FROM " + tbl).Error; err != nil {
			t.Fatalf("clean %s: %v", tbl, err)
		}
	}
}

// TestRecordReceiptSync — recordReceiptSync (Ф4) пишет ОДНУ строку в
// sync_log на накладную со снапшотом lines внутри payload, по списку id
// (allocateDebtPayment может задеть несколько накладных разом).
func TestRecordReceiptSync(t *testing.T) {
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
	cleanDocsTables(t, gdb, "stock_receipt_lines", "stock_receipts")
	synclog.SetEnabled(true)
	t.Cleanup(func() { synclog.SetEnabled(false) })

	restID := uuid.NewString()
	receiptID := uuid.NewString()
	lineID := uuid.NewString()
	flour := "Мука"
	receipt := models.StockReceipt{
		ID: receiptID, RestaurantID: &restID,
		TotalAmount: decimal.MustFromString("500"), DebtAmount: decimal.MustFromString("500"),
	}
	line := models.StockReceiptLine{
		ID: lineID, ReceiptID: &receiptID, Name: &flour,
		Qty: decimal.MustFromString("5"), PricePerUnit: decimal.MustFromString("100"),
	}

	if err := gdb.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(&receipt).Error; err != nil {
			return err
		}
		if err := tx.Create(&line).Error; err != nil {
			return err
		}
		return recordReceiptSync(tx, []string{receiptID})
	}); err != nil {
		t.Fatalf("transaction: %v", err)
	}

	var rows []models.SyncLog
	if err := gdb.Where("table_name = ? AND row_id = ?", "stock_receipts", receiptID).Find(&rows).Error; err != nil {
		t.Fatalf("find sync_log: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("sync_log rows = %d, want 1", len(rows))
	}
	var payload receiptSyncPayload
	if err := json.Unmarshal(rows[0].Payload, &payload); err != nil {
		t.Fatalf("unmarshal payload: %v", err)
	}
	if !payload.DebtAmount.Equal(decimal.MustFromString("500")) {
		t.Errorf("payload.DebtAmount = %s, want 500", payload.DebtAmount.String())
	}
	if len(payload.Lines) != 1 || payload.Lines[0].ID != lineID {
		t.Fatalf("payload.Lines = %+v, want 1 line %s", payload.Lines, lineID)
	}

	// Пустой список — no-op.
	if err := gdb.Transaction(func(tx *gorm.DB) error {
		return recordReceiptSync(tx, nil)
	}); err != nil {
		t.Fatalf("recordReceiptSync(nil): %v", err)
	}
}

// TestRecordWriteoffSync — recordWriteoffSync (Ф4) снимает снапшот ПОСЛЕ
// финального total_cost-патча шапки (симулируем реальный порядок вызова
// CreateWriteoff: create header с cost=0 → create lines → patch cost → sync).
func TestRecordWriteoffSync(t *testing.T) {
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
	cleanDocsTables(t, gdb, "stock_writeoff_lines", "stock_writeoffs")
	synclog.SetEnabled(true)
	t.Cleanup(func() { synclog.SetEnabled(false) })

	restID := uuid.NewString()
	writeoffID := uuid.NewString()
	w := models.StockWriteoff{ID: writeoffID, RestaurantID: &restID, TotalCost: decimal.Zero}

	if err := gdb.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(&w).Error; err != nil {
			return err
		}
		// Патч суммы ПОСЛЕ создания шапки — как в CreateWriteoff.
		if err := tx.Model(&w).Update("total_cost", decimal.MustFromString("300")).Error; err != nil {
			return err
		}
		return recordWriteoffSync(tx, []string{writeoffID})
	}); err != nil {
		t.Fatalf("transaction: %v", err)
	}

	var rows []models.SyncLog
	gdb.Where("table_name = ? AND row_id = ?", "stock_writeoffs", writeoffID).Find(&rows)
	if len(rows) != 1 {
		t.Fatalf("sync_log rows = %d, want 1", len(rows))
	}
	var payload writeoffSyncPayload
	if err := json.Unmarshal(rows[0].Payload, &payload); err != nil {
		t.Fatalf("unmarshal payload: %v", err)
	}
	if !payload.TotalCost.Equal(decimal.MustFromString("300")) {
		t.Errorf("payload.TotalCost = %s, want 300 (снапшот ПОСЛЕ патча, не 0)", payload.TotalCost.String())
	}
}

// TestRecordInventorySync — recordInventorySync (Ф4). RestaurantID на
// InventoryCheck — не указатель (в отличие от остальных трёх документов),
// проверяем что синк всё равно корректно берёт restaurant_id.
func TestRecordInventorySync(t *testing.T) {
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
	cleanDocsTables(t, gdb, "inventory_check_lines", "inventory_checks")
	synclog.SetEnabled(true)
	t.Cleanup(func() { synclog.SetEnabled(false) })

	restID := uuid.NewString()
	checkID := uuid.NewString()
	lineID := uuid.NewString()
	ingID := uuid.NewString()
	check := models.InventoryCheck{ID: checkID, RestaurantID: restID, ConductedBy: "Кладовщик", Status: "draft"}
	line := models.InventoryCheckLine{
		ID: lineID, CheckID: checkID, Kind: "ingredient", IngredientID: ingID,
		IngredientName: "Сахар", Unit: "кг", RestaurantID: restID,
	}

	if err := gdb.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(&check).Error; err != nil {
			return err
		}
		if err := tx.Create(&line).Error; err != nil {
			return err
		}
		return recordInventorySync(tx, []string{checkID})
	}); err != nil {
		t.Fatalf("transaction: %v", err)
	}

	var rows []models.SyncLog
	gdb.Where("table_name = ? AND row_id = ?", "inventory_checks", checkID).Find(&rows)
	if len(rows) != 1 {
		t.Fatalf("sync_log rows = %d, want 1", len(rows))
	}
	if rows[0].RestaurantID == nil || *rows[0].RestaurantID != restID {
		t.Errorf("sync_log.restaurant_id = %v, want %s", rows[0].RestaurantID, restID)
	}
	var payload inventorySyncPayload
	if err := json.Unmarshal(rows[0].Payload, &payload); err != nil {
		t.Fatalf("unmarshal payload: %v", err)
	}
	if len(payload.Lines) != 1 {
		t.Fatalf("payload.Lines = %+v, want 1 line", payload.Lines)
	}
}

// TestRecordReturnSync — recordReturnSync (Ф4): снапшот возврата + строк.
func TestRecordReturnSync(t *testing.T) {
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
	cleanDocsTables(t, gdb, "stock_return_lines", "stock_returns")
	synclog.SetEnabled(true)
	t.Cleanup(func() { synclog.SetEnabled(false) })

	restID := uuid.NewString()
	receiptID := uuid.NewString()
	returnID := uuid.NewString()
	lineID := uuid.NewString()
	receiptLineID := uuid.NewString()
	ret := models.StockReturn{
		ID: returnID, ReceiptID: receiptID, RestaurantID: &restID,
		Reason: "spoilage", RefundType: "debt", TotalAmount: decimal.MustFromString("50"),
	}
	line := models.StockReturnLine{
		ID: lineID, ReturnID: returnID, ReceiptLineID: receiptLineID,
		Qty: decimal.MustFromString("1"), PricePerUnit: decimal.MustFromString("50"),
	}

	if err := gdb.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(&ret).Error; err != nil {
			return err
		}
		if err := tx.Create(&line).Error; err != nil {
			return err
		}
		return recordReturnSync(tx, []string{returnID})
	}); err != nil {
		t.Fatalf("transaction: %v", err)
	}

	var rows []models.SyncLog
	gdb.Where("table_name = ? AND row_id = ?", "stock_returns", returnID).Find(&rows)
	if len(rows) != 1 {
		t.Fatalf("sync_log rows = %d, want 1", len(rows))
	}
	var payload returnSyncPayload
	if err := json.Unmarshal(rows[0].Payload, &payload); err != nil {
		t.Fatalf("unmarshal payload: %v", err)
	}
	if len(payload.Lines) != 1 || payload.Lines[0].ID != lineID {
		t.Fatalf("payload.Lines = %+v, want 1 line %s", payload.Lines, lineID)
	}
}

// TestRecordSupplierSync — recordSupplierSync/recordSupplierDeleteSync (Ф4):
// по образцу TestRecordIngredientSync (Ф3).
func TestRecordSupplierSync(t *testing.T) {
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
	cleanDocsTables(t, gdb, "suppliers")
	synclog.SetEnabled(true)
	t.Cleanup(func() { synclog.SetEnabled(false) })

	restID := uuid.NewString()
	supID := uuid.NewString()
	name := "ООО Молоко"
	sup := models.Supplier{ID: supID, Name: &name, RestaurantID: &restID, CurrentDebt: decimal.MustFromString("500")}

	if err := gdb.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(&sup).Error; err != nil {
			return err
		}
		return recordSupplierSync(tx, []string{supID})
	}); err != nil {
		t.Fatalf("transaction (insert): %v", err)
	}
	if err := gdb.Transaction(func(tx *gorm.DB) error {
		return recordSupplierDeleteSync(tx, supID, restID)
	}); err != nil {
		t.Fatalf("transaction (delete): %v", err)
	}

	var rows []models.SyncLog
	if err := gdb.Where("table_name = ? AND row_id = ?", "suppliers", supID).
		Order("created_at ASC").Find(&rows).Error; err != nil {
		t.Fatalf("find sync_log: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("sync_log rows = %d, want 2 (insert + delete)", len(rows))
	}
	if rows[0].Op != "update" || rows[1].Op != "delete" {
		t.Errorf("ops = %s/%s, want update/delete", rows[0].Op, rows[1].Op)
	}
	var payload models.Supplier
	if err := json.Unmarshal(rows[0].Payload, &payload); err != nil {
		t.Fatalf("unmarshal payload: %v", err)
	}
	if !payload.CurrentDebt.Equal(decimal.MustFromString("500")) {
		t.Errorf("payload.CurrentDebt = %s, want 500", payload.CurrentDebt.String())
	}
}
