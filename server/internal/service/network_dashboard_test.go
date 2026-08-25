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

// TestNetworkDashboard — сводный дашборд сети (Ф-С1): выручка/заказы из
// закрытых заказов всех узлов, расходы по правилам сетевого ДДС (зеркала Ф-Р
// и внутрисетевые переводы НЕ считаются), кассы — только включённые счета,
// открытые смены находятся.
func TestNetworkDashboard(t *testing.T) {
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
	for _, tbl := range []string{
		"orders", "cash_shifts", "financial_operations", "financial_accounts",
		"restaurants", "company_accounts", "sync_log",
	} {
		gdb.Exec("DELETE FROM " + tbl)
	}

	accountID := uuid.NewString()
	gdb.Create(&models.CompanyAccount{ID: accountID, Name: "Сеть"})
	centralID, b1, b2 := uuid.NewString(), uuid.NewString(), uuid.NewString()
	cw, ot := "central_warehouse", "outlet"
	gdb.Create(&models.Restaurant{ID: centralID, Name: "Центр", AccountID: &accountID, Kind: &cw})
	gdb.Create(&models.Restaurant{ID: b1, Name: "Филиал-1", AccountID: &accountID, Kind: &ot})
	gdb.Create(&models.Restaurant{ID: b2, Name: "Филиал-2", AccountID: &accountID, Kind: &ot})

	now := time.Now().UTC()
	closed := "closed"
	mkOrder := func(rid string, total string) {
		gdb.Create(&models.Order{
			ID: uuid.NewString(), RestaurantID: &rid, Status: &closed,
			TotalWithService: decimal.MustFromString(total), ClosedAt: &now,
			CreatedAt: now, UpdatedAt: now,
		})
	}
	mkOrder(b1, "100")
	mkOrder(b1, "200")
	mkOrder(b2, "50")

	// Счета: включённые + один отключённый (не должен войти в кассу сети).
	mkAcc := func(rid, name, bal string, enabled bool) {
		n := name
		acc := models.FinancialAccount{
			ID: uuid.NewString(), Name: &n, Balance: decimal.MustFromString(bal),
			RestaurantID: &rid, IsEnabled: true,
		}
		gdb.Create(&acc)
		// Отключение — отдельным Update, как в боевом коде: Create с
		// IsEnabled=false молча превращается в true из-за gorm-тега
		// default:true (см. gorm-zero-value-default-tag-gotcha).
		if !enabled {
			gdb.Model(&models.FinancialAccount{}).Where("id = ?", acc.ID).Update("is_enabled", false)
		}
	}
	mkAcc(centralID, "Касса центра", "1000", true)
	mkAcc(b1, "Касса Ф1", "300", true)
	mkAcc(b2, "Касса Ф2", "700", true)
	mkAcc(b2, "Старый счёт", "9999", false)

	// Расходы: обычный расход (входит), зеркало Ф-Р (НЕ входит), перевод
	// activity=financial (НЕ входит).
	outT := "out"
	op := func(rid, amount string, activity string, paidBy *string) {
		a := activity
		gdb.Create(&models.FinancialOperation{
			ID: uuid.NewString(), Type: &outT, Amount: decimal.MustFromString(amount),
			Activity: &a, RestaurantID: &rid, PaidByRestaurantID: paidBy,
			CreatedAt: now, UpdatedAt: now,
		})
	}
	op(b1, "40", "operational", nil)
	op(b2, "60", "operational", nil)
	op(b1, "500", "operational", &centralID) // зеркало: платил центр
	op(centralID, "999", "financial", nil)   // перевод внутри сети

	// Смены: открытая у Ф1, закрытая у Ф2.
	open, closedSh := "open", "closed"
	gdb.Create(&models.CashShift{ID: uuid.NewString(), RestaurantID: &b1, Status: &open, OpenedAt: now})
	gdb.Create(&models.CashShift{ID: uuid.NewString(), RestaurantID: &b2, Status: &closedSh, OpenedAt: now})

	svc := service.NewNetworkService(repo.New(gdb), "")
	ctx := tenant.WithRestaurant(context.Background(), centralID)
	from := now.Add(-1 * time.Hour)
	out, err := svc.Dashboard(ctx, service.PeriodFilter{From: &from})
	if err != nil {
		t.Fatalf("Dashboard: %v", err)
	}

	if !out.Revenue.Equal(decimal.MustFromString("350")) {
		t.Errorf("выручка сети = %s, want 350", out.Revenue.String())
	}
	if out.OrdersCount != 3 {
		t.Errorf("заказов = %d, want 3", out.OrdersCount)
	}
	if !out.Expenses.Equal(decimal.MustFromString("100")) {
		t.Errorf("расходы = %s, want 100 (зеркало и перевод не считаются)", out.Expenses.String())
	}
	if !out.TotalCash.Equal(decimal.MustFromString("2000")) {
		t.Errorf("касса сети = %s, want 2000 (отключённый счёт не входит)", out.TotalCash.String())
	}
	if out.OpenShifts != 1 {
		t.Errorf("открытых смен = %d, want 1", out.OpenShifts)
	}
	byName := map[string]service.NetworkDashboardBranch{}
	for _, b := range out.Branches {
		byName[b.Name] = b
	}
	if !byName["Филиал-1"].OpenShift || byName["Филиал-2"].OpenShift {
		t.Errorf("статусы смен по филиалам: %+v", byName)
	}
	if !byName["Филиал-1"].Revenue.Equal(decimal.MustFromString("300")) {
		t.Errorf("выручка Ф1 = %s, want 300", byName["Филиал-1"].Revenue.String())
	}
	// Период: from в будущем → всё по нулям, но кассы остаются (это остатки,
	// не поток за период).
	future := now.Add(time.Hour)
	empty, err := svc.Dashboard(ctx, service.PeriodFilter{From: &future})
	if err != nil {
		t.Fatal(err)
	}
	if !empty.Revenue.IsZero() || empty.OrdersCount != 0 {
		t.Errorf("период в будущем: выручка %s, заказов %d — ожидались нули", empty.Revenue.String(), empty.OrdersCount)
	}
	if !empty.TotalCash.Equal(decimal.MustFromString("2000")) {
		t.Errorf("касса не должна зависеть от периода: %s", empty.TotalCash.String())
	}
}
