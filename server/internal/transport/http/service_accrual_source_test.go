//go:build integration

package http_test

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// serviceRevenueFor — total_revenue по официанту из by-waiter отчёта.
func serviceRevenueFor(t *testing.T, body []byte, waiterID string) string {
	t.Helper()
	var env struct {
		Data []struct {
			WaiterID     string `json:"waiter_id"`
			TotalRevenue string `json:"total_revenue"`
		} `json:"data"`
	}
	_ = json.Unmarshal(body, &env)
	for _, row := range env.Data {
		if row.WaiterID == waiterID {
			return row.TotalRevenue
		}
	}
	return ""
}

// Обслуживание в отчётах (раздел «Обслуживание» и строки смены — оба бьют в
// AccrualByWaiter) должно браться из ЗАФИКСИРОВАННОГО при закрытии
// order.service_amount — это то, что реально начислено и отражено в смене, —
// а не пересчитываться из order_items по формуле price×qty/unitSize. Иначе
// весовые позиции (особенно со старой/несогласованной qty) дают другое число,
// и «в смене одно, а в разделе/закрытых — другое».
func TestAccrual_UsesFixedServiceAmount_NotItemRecompute(t *testing.T) {
	f := setupE2E(t)
	gdb, _, shiftID, _ := seedForWrite(t, f)
	tok := f.login(t)
	waiterID := mkUser(t, gdb, f.rid, "Сервис-Официант", "waiter", "")

	now := time.Now().UTC()
	st, hall, g := "closed", "hall", "g"
	orderID := uuid.NewString()
	// Зафиксировано при закрытии: подытог 200, обслуживание 10% = 20.
	if err := gdb.Create(&models.Order{
		ID: orderID, RestaurantID: &f.rid, WaiterID: &waiterID,
		Status: &st, Type: &hall, ShiftID: &shiftID,
		ServicePercent:   decimal.MustFromString("10"),
		ServiceAmount:    decimal.MustFromString("20"),
		Total:            decimal.MustFromString("200"),
		TotalWithService: decimal.MustFromString("220"),
		ClosedAt:         &now, CreatedAt: now, UpdatedAt: now,
	}).Error; err != nil {
		t.Fatal(err)
	}
	// Весовая позиция, у которой пересчёт даёт мизер: 40 × 1/100 = 0.4, ×10% = 0.04.
	// Это НЕ должно подменять зафиксированные 20.
	dish := "Казан 100г"
	if err := gdb.Create(&models.OrderItem{
		ID: uuid.NewString(), OrderID: &orderID, Name: &dish,
		Qty: decimal.MustFromString("1"), Price: decimal.MustFromString("40"),
		Unit: &g, UnitSize: decimal.MustFromString("100"), CreatedAt: now, UpdatedAt: now,
	}).Error; err != nil {
		t.Fatal(err)
	}

	got := accrualMap(t, f, tok)[waiterID]
	if got != "20" {
		t.Errorf("accrued = %q, ожидали 20 (зафиксированный service_amount), а не пересчёт из позиций (≈0.04)", got)
	}
}

// Выручка официанта (revenue) не должна раздуваться числом позиций: JOIN на
// order_items множит total_with_service на кол-во строк. Заказ с 3 позициями и
// total_with_service=300 обязан дать revenue=300, а не 900.
func TestAccrual_RevenueNotInflatedByItemCount(t *testing.T) {
	f := setupE2E(t)
	gdb, _, shiftID, _ := seedForWrite(t, f)
	tok := f.login(t)
	waiterID := mkUser(t, gdb, f.rid, "Многопозиц-Официант", "waiter", "")

	now := time.Now().UTC()
	st, hall, piece := "closed", "hall", "piece"
	orderID := uuid.NewString()
	if err := gdb.Create(&models.Order{
		ID: orderID, RestaurantID: &f.rid, WaiterID: &waiterID,
		Status: &st, Type: &hall, ShiftID: &shiftID,
		ServicePercent:   decimal.MustFromString("0"),
		ServiceAmount:    decimal.MustFromString("0"),
		Total:            decimal.MustFromString("300"),
		TotalWithService: decimal.MustFromString("300"),
		ClosedAt:         &now, CreatedAt: now, UpdatedAt: now,
	}).Error; err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		dish := "Блюдо"
		if err := gdb.Create(&models.OrderItem{
			ID: uuid.NewString(), OrderID: &orderID, Name: &dish,
			Qty: decimal.MustFromString("1"), Price: decimal.MustFromString("100"),
			Unit: &piece, UnitSize: decimal.MustFromString("1"),
			CreatedAt: now.Add(time.Duration(i) * time.Second), UpdatedAt: now,
		}).Error; err != nil {
			t.Fatal(err)
		}
	}

	r, b := f.get(t, "/api/v1/finance/service-accrual/by-waiter", tok)
	if r.StatusCode != 200 {
		t.Fatalf("accrual %d: %s", r.StatusCode, b)
	}
	rev := serviceRevenueFor(t, b, waiterID)
	if rev != "300" {
		t.Errorf("revenue = %q, ожидали 300 (не раздутое ×3 = 900)", rev)
	}
}
