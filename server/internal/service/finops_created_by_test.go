//go:build integration

package service_test

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/audit"
	"github.com/restos/restos-v4/server/internal/db"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
	"github.com/restos/restos-v4/server/internal/repo"
	"github.com/restos/restos-v4/server/internal/service"
)

// Владелец 2026-08-31 («расходы по статьям… рассмотреть каждый расход когда
// сделан КЕМ»): до миграции 100 в financial_operations не хранилось, кто
// провёл операцию — единственным «кто» был cancelled_by, то есть кто ОТМЕНИЛ.
// Эти тесты фиксируют, что автор проставляется из audit.Actor и что его
// отсутствие (фон/репликация) даёт честный NULL, а не выдуманного человека.

func newFinOpsFixture(t *testing.T) (*service.FinancialOperationsService, string, string, *gorm.DB) {
	t.Helper()
	gdb, err := db.Open(transferTestDSN())
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
	for _, tbl := range []string{"financial_operations", "financial_accounts", "users", "restaurants"} {
		gdb.Exec("DELETE FROM " + tbl)
	}

	rid := uuid.NewString()
	if err := gdb.Create(&models.Restaurant{ID: rid, Name: "Тест"}).Error; err != nil {
		t.Fatalf("seed restaurant: %v", err)
	}
	accName := "Касса"
	accID := uuid.NewString()
	if err := gdb.Create(&models.FinancialAccount{
		ID: accID, Name: &accName, RestaurantID: &rid,
		Balance: decimal.MustFromString("10000"), IsEnabled: true,
	}).Error; err != nil {
		t.Fatalf("seed account: %v", err)
	}
	return service.NewFinancialOperationsService(repo.New(gdb)), rid, accID, gdb
}

func TestFinOpCreatedBy_TakenFromActor(t *testing.T) {
	svc, rid, accID, gdb := newFinOpsFixture(t)

	userID := uuid.NewString()
	ctx := audit.WithActor(
		tenant.WithRestaurant(context.Background(), rid),
		audit.Actor{UserID: userID, UserName: "Бухгалтер", Role: "owner"},
	)

	outType, amount, category := "out", "500", "rent"
	op, err := svc.Create(ctx, service.FinancialOperationInput{
		Type: &outType, Amount: &amount, Category: &category, AccountID: &accID,
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if op.CreatedBy == nil || *op.CreatedBy != userID {
		t.Errorf("op.CreatedBy = %v, want %s", op.CreatedBy, userID)
	}

	// Через БД — что реально записалось, а не что вернул конструктор.
	var stored models.FinancialOperation
	if err := gdb.First(&stored, "id = ?", op.ID).Error; err != nil {
		t.Fatalf("read back: %v", err)
	}
	if stored.CreatedBy == nil || *stored.CreatedBy != userID {
		t.Errorf("в БД created_by = %v, want %s", stored.CreatedBy, userID)
	}
}

func TestFinOpCreatedBy_NilWithoutActor(t *testing.T) {
	svc, rid, accID, gdb := newFinOpsFixture(t)

	// Контекст без актора — так выглядят фоновые джобы и путь репликации.
	ctx := tenant.WithRestaurant(context.Background(), rid)

	outType, amount, category := "out", "300", "rent"
	op, err := svc.Create(ctx, service.FinancialOperationInput{
		Type: &outType, Amount: &amount, Category: &category, AccountID: &accID,
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	var stored models.FinancialOperation
	if err := gdb.First(&stored, "id = ?", op.ID).Error; err != nil {
		t.Fatalf("read back: %v", err)
	}
	if stored.CreatedBy != nil {
		t.Errorf("created_by = %v, want NULL (человека в контексте не было — выдумывать автора нельзя)", *stored.CreatedBy)
	}
}
