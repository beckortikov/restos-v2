//go:build integration

package service_test

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/db"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
	"github.com/restos/restos-v4/server/internal/repo"
	"github.com/restos/restos-v4/server/internal/service"
)

// TestCancellationsReport — владелец 2026-08-29: «в аналитике дать
// возможность просматривать отменам детальный [отчёт]». Проверяет, что
// оба источника (order_voids построчно + orders.cancelled_at целиком)
// объединяются без задвоения и корректно бьются по причине/сотруднику/блюду.
func TestCancellationsReport(t *testing.T) {
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
	for _, tbl := range []string{"order_voids", "order_items", "orders", "users", "restaurants"} {
		gdb.Exec("DELETE FROM " + tbl)
	}

	rid := uuid.NewString()
	gdb.Create(&models.Restaurant{ID: rid, Name: "Тест"})
	managerName, managerRole := "Менеджер Аня", "manager"
	managerID := uuid.NewString()
	gdb.Create(&models.User{ID: managerID, Name: &managerName, Role: &managerRole, RestaurantID: &rid})

	now := time.Now().UTC()
	closed := "closed"
	plovName := "Плов"

	// Заказ A: одна позиция отменена ПОСЛЕ оплаты (VoidItem-путь → order_voids).
	orderAID := uuid.NewString()
	gdb.Create(&models.Order{
		ID: orderAID, Status: &closed, RestaurantID: &rid, Total: decimal.MustFromString("50"),
		TotalWithService: decimal.MustFromString("50"), ClosedAt: &now, CreatedAt: now, UpdatedAt: now,
	})
	guestChanged := "Гость передумал"
	gdb.Create(&models.OrderVoid{
		ID: uuid.NewString(), OrderID: &orderAID, ItemName: &plovName, ItemQty: intPtr(1),
		ItemPrice: decimal.MustFromString("30"), Reason: &guestChanged,
		ApprovedByName: &managerName, CreatedByName: &managerName, RestaurantID: &rid, CreatedAt: now,
	})

	// Заказ B: отменён ЦЕЛИКОМ (Cancel() — НЕ пишет в order_voids).
	orderBID := uuid.NewString()
	kitchenError := "Ошибка кухни"
	cancelledTotal := decimal.MustFromString("70")
	gdb.Create(&models.Order{
		ID: orderBID, Status: &closed, RestaurantID: &rid, Total: decimal.MustFromString("70"),
		TotalWithService: decimal.MustFromString("70"), ClosedAt: &now,
		CancelledAt: &now, CancelledBy: &managerID, CancelReason: &kitchenError, CancelledTotal: &cancelledTotal,
		CreatedAt: now, UpdatedAt: now,
	})

	svc := service.NewAnalyticsService(repo.New(gdb))
	ctx := tenant.WithRestaurant(context.Background(), rid)
	from := now.Add(-1 * time.Hour)
	out, err := svc.CancellationsReport(ctx, service.CancellationFilter{PeriodFilter: service.PeriodFilter{From: &from}})
	if err != nil {
		t.Fatalf("CancellationsReport: %v", err)
	}

	if out.Total != 2 {
		t.Fatalf("Total = %d, want 2: %+v", out.Total, out.Rows)
	}
	if len(out.Rows) != 2 {
		t.Fatalf("len(Rows) = %d, want 2", len(out.Rows))
	}
	var voidRow, cancelRow *service.CancellationRow
	for i := range out.Rows {
		switch out.Rows[i].Kind {
		case "item_void":
			voidRow = &out.Rows[i]
		case "order_cancel":
			cancelRow = &out.Rows[i]
		}
	}
	if voidRow == nil || cancelRow == nil {
		t.Fatalf("ожидались обе строки (item_void + order_cancel): %+v", out.Rows)
	}
	if voidRow.ItemName == nil || *voidRow.ItemName != plovName {
		t.Errorf("voidRow.ItemName = %v, want %q", voidRow.ItemName, plovName)
	}
	if !voidRow.Amount.Equal(decimal.MustFromString("30")) {
		t.Errorf("voidRow.Amount = %s, want 30", voidRow.Amount.String())
	}
	if !cancelRow.Amount.Equal(decimal.MustFromString("70")) {
		t.Errorf("cancelRow.Amount = %s, want 70 (cancelled_total)", cancelRow.Amount.String())
	}
	if cancelRow.CreatedByName == nil || *cancelRow.CreatedByName != managerName {
		t.Errorf("cancelRow.CreatedByName = %v, want %q (резолв через cancelled_by → users)", cancelRow.CreatedByName, managerName)
	}

	// Summary: суммы не задвоены, разделены по kind.
	if !out.Summary.TotalAmount.Equal(decimal.MustFromString("100")) {
		t.Errorf("Summary.TotalAmount = %s, want 100 (30+70, без задвоения)", out.Summary.TotalAmount.String())
	}
	if !out.Summary.ItemVoidsAmount.Equal(decimal.MustFromString("30")) {
		t.Errorf("Summary.ItemVoidsAmount = %s, want 30", out.Summary.ItemVoidsAmount.String())
	}
	if !out.Summary.OrderCancelsAmount.Equal(decimal.MustFromString("70")) {
		t.Errorf("Summary.OrderCancelsAmount = %s, want 70", out.Summary.OrderCancelsAmount.String())
	}
	if out.Summary.TotalCount != 2 {
		t.Errorf("Summary.TotalCount = %d, want 2", out.Summary.TotalCount)
	}

	// ByEmployee: обе отмены — один и тот же менеджер (созданы/подтверждены им же
	// в этой фикстуре) → одна строка на 100 суммарно.
	if len(out.Summary.ByEmployee) != 1 || !out.Summary.ByEmployee[0].Amount.Equal(decimal.MustFromString("100")) {
		t.Errorf("ByEmployee = %+v, want одна строка «%s» на 100", out.Summary.ByEmployee, managerName)
	}
	// ByDish — только item_void несёт название блюда; order_cancel не должен
	// протечь сюда как NULL-бакет.
	if len(out.Summary.ByDish) != 1 || out.Summary.ByDish[0].Name != plovName {
		t.Errorf("ByDish = %+v, want одна строка %q", out.Summary.ByDish, plovName)
	}
	foundReasons := map[string]bool{}
	for _, r := range out.Summary.ByReason {
		foundReasons[r.Name] = true
	}
	if !foundReasons[guestChanged] || !foundReasons[kitchenError] {
		t.Errorf("ByReason не содержит обе причины: %+v", out.Summary.ByReason)
	}
}

// TestCancellationsReport_Pagination — limit/offset режут построчный список,
// не трогая Summary (считается по ВСЕМ событиям периода, не по странице).
func TestCancellationsReport_Pagination(t *testing.T) {
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
	for _, tbl := range []string{"order_voids", "orders", "restaurants"} {
		gdb.Exec("DELETE FROM " + tbl)
	}

	rid := uuid.NewString()
	gdb.Create(&models.Restaurant{ID: rid, Name: "Тест"})
	now := time.Now().UTC()
	closed := "closed"
	itemName := "Позиция"
	for i := 0; i < 5; i++ {
		orderID := uuid.NewString()
		gdb.Create(&models.Order{
			ID: orderID, Status: &closed, RestaurantID: &rid, Total: decimal.MustFromString("10"),
			TotalWithService: decimal.MustFromString("10"), ClosedAt: &now, CreatedAt: now, UpdatedAt: now,
		})
		gdb.Create(&models.OrderVoid{
			ID: uuid.NewString(), OrderID: &orderID, ItemName: &itemName, ItemQty: intPtr(1),
			ItemPrice: decimal.MustFromString("10"), RestaurantID: &rid, CreatedAt: now.Add(time.Duration(i) * time.Second),
		})
	}

	svc := service.NewAnalyticsService(repo.New(gdb))
	ctx := tenant.WithRestaurant(context.Background(), rid)
	from := now.Add(-1 * time.Hour)
	out, err := svc.CancellationsReport(ctx, service.CancellationFilter{
		PeriodFilter: service.PeriodFilter{From: &from}, Limit: 2, Offset: 0,
	})
	if err != nil {
		t.Fatalf("CancellationsReport: %v", err)
	}
	if out.Total != 5 {
		t.Errorf("Total = %d, want 5 (полный счёт, не по странице)", out.Total)
	}
	if len(out.Rows) != 2 {
		t.Fatalf("len(Rows) = %d, want 2 (limit)", len(out.Rows))
	}
	if !out.Summary.TotalAmount.Equal(decimal.MustFromString("50")) {
		t.Errorf("Summary.TotalAmount = %s, want 50 (по ВСЕМ 5 событиям, не по странице)", out.Summary.TotalAmount.String())
	}
}
