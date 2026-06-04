//go:build integration

package jobs_test

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/db"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/jobs"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// Запуск:
//   go test -tags=integration ./internal/jobs/...

func testDSN() string {
	if v := os.Getenv("RESTOS_TEST_DSN"); v != "" {
		return v
	}
	return "host=127.0.0.1 port=5432 user=restos dbname=restos_v4_test sslmode=disable"
}

// TestZombieCleanup — создаём order с 1 item, прямым SQL отмечаем item как
// cancelled (минуя service-layer, как было до v2.1.1), прогоняем cleanup →
// order должен стать cancelled и table — free.
func TestZombieCleanup(t *testing.T) {
	gdb, err := db.Open(testDSN())
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	if err := db.MigrateUp(context.Background(), gdb); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	// Чистка релевантных таблиц.
	for _, tbl := range []string{"audit_log", "order_items", "orders", "tables", "restaurants"} {
		if err := gdb.Exec("DELETE FROM " + tbl).Error; err != nil {
			t.Fatalf("clean %s: %v", tbl, err)
		}
	}

	rid := uuid.NewString()
	if err := gdb.Create(&models.Restaurant{ID: rid, Name: "Test"}).Error; err != nil {
		t.Fatalf("create restaurant: %v", err)
	}

	// Стол: занят, привязан к заказу.
	tableID := uuid.NewString()
	occupied := "occupied"
	orderID := uuid.NewString()
	now := time.Now()
	if err := gdb.Exec(`
		INSERT INTO tables (id, name, status, current_order_id, opened_at, restaurant_id, created_at, updated_at)
		VALUES (?, 'T1', ?, ?, ?, ?, ?, ?)
	`, tableID, occupied, orderID, now, rid, now, now).Error; err != nil {
		t.Fatalf("insert table: %v", err)
	}

	// Order в статусе open + 1 item.
	openStatus := "open"
	if err := gdb.Create(&models.Order{
		ID:           orderID,
		OrderNumber:  1,
		Status:       &openStatus,
		TableID:      &tableID,
		RestaurantID: &rid,
		Total:        decimal.FromInt(100),
	}).Error; err != nil {
		t.Fatalf("create order: %v", err)
	}
	itemID := uuid.NewString()
	if err := gdb.Exec(`
		INSERT INTO order_items (id, order_id, name, qty, price, cancelled_at)
		VALUES (?, ?, 'X', 1, 100, NOW())
	`, itemID, orderID).Error; err != nil {
		t.Fatalf("insert cancelled item: %v", err)
	}

	// Прогон cleanup.
	cancelled, freed, err := jobs.RunOrdersCleanupOnce(context.Background(), gdb)
	if err != nil {
		t.Fatalf("cleanup: %v", err)
	}
	if cancelled != 1 {
		t.Errorf("cancelled orders: got %d, want 1", cancelled)
	}
	if freed != 1 {
		t.Errorf("freed tables: got %d, want 1", freed)
	}

	// Assert order.status = cancelled.
	var got models.Order
	if err := gdb.First(&got, "id = ?", orderID).Error; err != nil {
		t.Fatalf("reload order: %v", err)
	}
	if got.Status == nil || *got.Status != "cancelled" {
		t.Errorf("order.status: got %v, want cancelled", got.Status)
	}
	if got.CancelledAt == nil {
		t.Errorf("order.cancelled_at must be set")
	}
	if got.CancelReason == nil || *got.CancelReason == "" {
		t.Errorf("order.cancel_reason must be set")
	}

	// Assert table.status = free.
	var tStatus string
	var currentOrder *string
	if err := gdb.Raw("SELECT status, current_order_id FROM tables WHERE id = ?", tableID).Row().Scan(&tStatus, &currentOrder); err != nil {
		t.Fatalf("reload table: %v", err)
	}
	if tStatus != "free" {
		t.Errorf("table.status: got %s, want free", tStatus)
	}
	if currentOrder != nil {
		t.Errorf("table.current_order_id: got %v, want nil", currentOrder)
	}

	// Idempotency: второй прогон не должен ничего поменять.
	cancelled2, freed2, err := jobs.RunOrdersCleanupOnce(context.Background(), gdb)
	if err != nil {
		t.Fatalf("cleanup #2: %v", err)
	}
	if cancelled2 != 0 || freed2 != 0 {
		t.Errorf("idempotency violated: cancelled=%d freed=%d", cancelled2, freed2)
	}
}

// TestCleanupNoZombies — control: order с живой позицией не должен трогаться.
func TestCleanupNoZombies(t *testing.T) {
	gdb, err := db.Open(testDSN())
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	if err := db.MigrateUp(context.Background(), gdb); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	for _, tbl := range []string{"audit_log", "order_items", "orders", "restaurants"} {
		if err := gdb.Exec("DELETE FROM " + tbl).Error; err != nil {
			t.Fatalf("clean %s: %v", tbl, err)
		}
	}

	rid := uuid.NewString()
	if err := gdb.Create(&models.Restaurant{ID: rid, Name: "T"}).Error; err != nil {
		t.Fatalf("restaurant: %v", err)
	}
	orderID := uuid.NewString()
	openStatus := "open"
	if err := gdb.Create(&models.Order{
		ID:           orderID,
		OrderNumber:  1,
		Status:       &openStatus,
		RestaurantID: &rid,
		Total:        decimal.FromInt(50),
	}).Error; err != nil {
		t.Fatalf("order: %v", err)
	}
	itemID := uuid.NewString()
	if err := gdb.Exec(`
		INSERT INTO order_items (id, order_id, name, qty, price)
		VALUES (?, ?, 'live', 1, 50)
	`, itemID, orderID).Error; err != nil {
		t.Fatalf("item: %v", err)
	}

	cancelled, freed, err := jobs.RunOrdersCleanupOnce(context.Background(), gdb)
	if err != nil {
		t.Fatalf("cleanup: %v", err)
	}
	if cancelled != 0 || freed != 0 {
		t.Errorf("non-zombie touched: cancelled=%d freed=%d", cancelled, freed)
	}
}
