//go:build integration

package repo_test

import (
	"context"
	"os"
	"testing"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/audit"
	"github.com/restos/restos-v4/server/internal/db"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
	"github.com/restos/restos-v4/server/internal/repo"
)

// Интеграционный тест против локального Postgres.
// Запуск:
//
//	go test -tags=integration ./internal/repo/...
//
// DSN: env RESTOS_TEST_DSN или дефолт на local restos_v4.
//
// Что проверяем (Acceptance Phase 1):
//   - Миграции прокатились (verified отдельно в migration_apply_test.go).
//   - CRUD orders / menu / stock работают через ForTenant.
//   - tenant isolation: tenant A не видит данные tenant B.
//   - Audit hook пишет в audit_log при Create/Update/Delete.

func testDSN() string {
	if v := os.Getenv("RESTOS_TEST_DSN"); v != "" {
		return v
	}
	return "host=127.0.0.1 port=5432 user=restos dbname=restos_v4_test sslmode=disable"
}

func setup(t *testing.T) (*repo.Repo, func()) {
	t.Helper()
	gdb, err := db.Open(testDSN())
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	// На всякий случай миграции (идемпотентно).
	if err := db.MigrateUp(context.Background(), gdb); err != nil {
		t.Fatalf("MigrateUp: %v", err)
	}

	// Чистим таблицы, которые трогает этот тест, в порядке безопасном для FK.
	tables := []string{
		"audit_log", "order_items", "orders",
		"menu_items", "menu_categories",
		"stock_movements", "ingredients",
		"users", "restaurants",
	}
	for _, tbl := range tables {
		if err := gdb.Exec("DELETE FROM " + tbl).Error; err != nil {
			t.Fatalf("clean %s: %v", tbl, err)
		}
	}

	r := repo.New(gdb)
	return r, func() {
		sqlDB, _ := gdb.DB()
		_ = sqlDB.Close()
	}
}

func newRestaurantID() string { return uuid.NewString() }

func TestCRUDMenu(t *testing.T) {
	r, cleanup := setup(t)
	defer cleanup()

	restA := newRestaurantID()
	restB := newRestaurantID()

	// Two restaurants — для tenant-теста.
	if err := r.Raw().Create(&models.Restaurant{ID: restA, Name: "A"}).Error; err != nil {
		t.Fatal(err)
	}
	if err := r.Raw().Create(&models.Restaurant{ID: restB, Name: "B"}).Error; err != nil {
		t.Fatal(err)
	}

	ctxA := tenant.WithRestaurant(context.Background(), restA)
	ctxB := tenant.WithRestaurant(context.Background(), restB)

	// Create menu_items в каждом ресторане.
	itemAName := "Plov A"
	itemBName := "Salad B"
	priceA := decimal.MustFromString("25.50")
	priceB := decimal.MustFromString("15.00")
	mA := &models.MenuItem{Name: &itemAName, Price: priceA, RestaurantID: &restA}
	mB := &models.MenuItem{Name: &itemBName, Price: priceB, RestaurantID: &restB}

	scoped, _ := r.ForTenant(ctxA)
	if err := scoped.Create(mA).Error; err != nil {
		t.Fatalf("create A: %v", err)
	}
	scoped, _ = r.ForTenant(ctxB)
	if err := scoped.Create(mB).Error; err != nil {
		t.Fatalf("create B: %v", err)
	}

	// Tenant isolation: A видит только свой item.
	scoped, _ = r.ForTenant(ctxA)
	var aItems []models.MenuItem
	if err := scoped.Find(&aItems).Error; err != nil {
		t.Fatal(err)
	}
	if len(aItems) != 1 || aItems[0].ID != mA.ID {
		t.Errorf("tenant A: want 1 own item, got %d (%+v)", len(aItems), aItems)
	}

	scoped, _ = r.ForTenant(ctxB)
	var bItems []models.MenuItem
	if err := scoped.Find(&bItems).Error; err != nil {
		t.Fatal(err)
	}
	if len(bItems) != 1 || bItems[0].ID != mB.ID {
		t.Errorf("tenant B: want 1 own item, got %d", len(bItems))
	}
}

func TestCRUDOrders(t *testing.T) {
	r, cleanup := setup(t)
	defer cleanup()

	rid := newRestaurantID()
	if err := r.Raw().Create(&models.Restaurant{ID: rid, Name: "R"}).Error; err != nil {
		t.Fatal(err)
	}
	ctx := tenant.WithRestaurant(context.Background(), rid)

	// Create order + items в транзакции.
	var orderID string
	err := r.Transaction(ctx, func(tr *repo.Repo) error {
		scoped, err := tr.ForTenant(ctx)
		if err != nil {
			return err
		}
		o := &models.Order{
			RestaurantID: &rid,
			Total:        decimal.MustFromString("100.00"),
		}
		if err := scoped.Create(o).Error; err != nil {
			return err
		}
		orderID = o.ID

		// order_items не имеет restaurant_id — пишем через Raw (FK к order даёт изоляцию).
		oi := &models.OrderItem{
			OrderID: &orderID,
			Qty:     decimal.MustFromString("2"),
			Price:   decimal.MustFromString("50.00"),
		}
		return tr.Raw().Create(oi).Error
	})
	if err != nil {
		t.Fatalf("tx: %v", err)
	}

	freshScoped, _ := r.ForTenant(ctx)
	var found models.Order
	if err := freshScoped.First(&found, "id = ?", orderID).Error; err != nil {
		t.Fatal(err)
	}
	if !found.Total.Equal(decimal.MustFromString("100")) {
		t.Errorf("total mismatch: %s", found.Total.String())
	}
}

func TestCRUDStockMovement(t *testing.T) {
	r, cleanup := setup(t)
	defer cleanup()

	rid := newRestaurantID()
	if err := r.Raw().Create(&models.Restaurant{ID: rid, Name: "R"}).Error; err != nil {
		t.Fatal(err)
	}
	ctx := tenant.WithRestaurant(context.Background(), rid)

	ingName := "Beef"
	ing := &models.Ingredient{Name: &ingName, RestaurantID: &rid, Unit: ptr("kg")}
	scoped, _ := r.ForTenant(ctx)
	if err := scoped.Create(ing).Error; err != nil {
		t.Fatal(err)
	}

	// stock_movement — append-only. Получаем свежий scoped.
	iid := ing.ID
	mv := &models.StockMovement{
		Type:           ptr("receipt"),
		IngredientID:   &iid,
		IngredientName: &ingName,
		Qty:            decimal.MustFromString("5.5"),
		Unit:           ptr("kg"),
		RestaurantID:   &rid,
	}
	scoped, _ = r.ForTenant(ctx)
	if err := scoped.Create(mv).Error; err != nil {
		t.Fatalf("create movement: %v", err)
	}

	scoped, _ = r.ForTenant(ctx)
	var movements []models.StockMovement
	if err := scoped.Find(&movements).Error; err != nil {
		t.Fatal(err)
	}
	if len(movements) != 1 {
		t.Errorf("want 1 movement, got %d", len(movements))
	}
}

func TestAuditHookOnCreate(t *testing.T) {
	r, cleanup := setup(t)
	defer cleanup()

	rid := newRestaurantID()
	if err := r.Raw().Create(&models.Restaurant{ID: rid, Name: "R"}).Error; err != nil {
		t.Fatal(err)
	}
	ctx := tenant.WithRestaurant(context.Background(), rid)
	ctx = audit.WithActor(ctx, audit.Actor{UserID: "user-1", UserName: "Petya"})

	scoped, _ := r.ForTenant(ctx)
	itemName := "Test dish"
	mi := &models.MenuItem{Name: &itemName, RestaurantID: &rid, Price: decimal.MustFromString("10")}
	if err := scoped.Create(mi).Error; err != nil {
		t.Fatal(err)
	}

	var logs []models.AuditLog
	if err := r.Raw().WithContext(ctx).Where("entity_id = ?", mi.ID).Find(&logs).Error; err != nil {
		t.Fatal(err)
	}
	if len(logs) == 0 {
		t.Fatal("audit log not written on Create")
	}
	if logs[0].Action == nil || *logs[0].Action != "create" {
		t.Errorf("want action=create, got %v", logs[0].Action)
	}
	if logs[0].UserID == nil || *logs[0].UserID != "user-1" {
		t.Errorf("want user_id=user-1, got %v", logs[0].UserID)
	}
}

func ptr[T any](v T) *T { return &v }
