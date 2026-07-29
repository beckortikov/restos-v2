//go:build integration

package service

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/db"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
	"github.com/restos/restos-v4/server/internal/synclog"
)

func syncOrdersTestDSN() string {
	if v := os.Getenv("RESTOS_TEST_DSN"); v != "" {
		return v
	}
	return "host=127.0.0.1 port=5432 user=restos dbname=restos_v4_test sslmode=disable"
}

// TestRecordOrderSync — whitebox-тест recordOrderSync (ADR-003 Фаза 5): пишет
// в sync_log снимок заказа вместе с его СВЕЖИМИ order_items (не по ссылке —
// отдельным SELECT в этой же tx), с правильными Entity/RowID/RestaurantID.
// Прямой доступ к неэкспортированной функции — поэтому package service, а не
// service_test (как остальные интеграционные тесты этого пакета).
func TestRecordOrderSync(t *testing.T) {
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
	for _, tbl := range []string{"sync_log", "order_items", "orders"} {
		if err := gdb.Exec("DELETE FROM " + tbl).Error; err != nil {
			t.Fatalf("clean %s: %v", tbl, err)
		}
	}
	synclog.SetEnabled(true)
	t.Cleanup(func() { synclog.SetEnabled(false) })

	restID := uuid.NewString()
	orderID := uuid.NewString()
	itemID := uuid.NewString()
	status := "closed"
	dishName := "Плов"
	order := models.Order{
		ID: orderID, OrderNumber: 1, Status: &status, RestaurantID: &restID,
		Total: decimal.MustFromString("350"), TotalWithService: decimal.MustFromString("350"),
	}

	if err := gdb.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(&order).Error; err != nil {
			return err
		}
		item := models.OrderItem{
			ID: itemID, OrderID: &orderID, Name: &dishName,
			Qty: decimal.MustFromString("1"), Price: decimal.MustFromString("350"),
		}
		if err := tx.Create(&item).Error; err != nil {
			return err
		}
		return recordOrderSync(tx, &order, "insert")
	}); err != nil {
		t.Fatalf("transaction: %v", err)
	}

	var rows []models.SyncLog
	if err := gdb.Where("table_name = ? AND row_id = ?", "orders", orderID).Find(&rows).Error; err != nil {
		t.Fatalf("find sync_log: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("sync_log rows = %d, want 1", len(rows))
	}
	if rows[0].Op != "insert" {
		t.Errorf("op = %s, want insert", rows[0].Op)
	}
	if rows[0].RestaurantID == nil || *rows[0].RestaurantID != restID {
		t.Errorf("restaurant_id = %v, want %s", rows[0].RestaurantID, restID)
	}
	if rows[0].SyncedAt != nil {
		t.Errorf("synced_at should be NULL (не отправлено пушером ещё)")
	}

	var payload orderSyncPayload
	if err := json.Unmarshal(rows[0].Payload, &payload); err != nil {
		t.Fatalf("unmarshal payload: %v", err)
	}
	if payload.ID != orderID {
		t.Errorf("payload.ID = %s, want %s", payload.ID, orderID)
	}
	if len(payload.Items) != 1 || payload.Items[0].Name == nil || *payload.Items[0].Name != dishName {
		t.Fatalf("payload.Items = %+v, want 1 item %q", payload.Items, dishName)
	}
}
