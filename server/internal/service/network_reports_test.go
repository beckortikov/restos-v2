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

// TestNetworkReports — Ф8: сводные P&L/ДДС/склад/счета сети — итог + разбивка
// по 2 филиалам. Источники — ровно то, что уже реплицируется Ф1-Ф5 (orders/
// order_items, stock_writeoffs, supply_expenses, financial_operations,
// ingredients, financial_accounts).
func TestNetworkReports(t *testing.T) {
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
		"financial_operations", "financial_accounts", "supply_expenses",
		"stock_writeoffs", "order_items", "orders", "ingredients",
		"restaurants", "company_accounts",
	} {
		gdb.Exec("DELETE FROM " + tbl)
	}

	accountID := uuid.NewString()
	if err := gdb.Create(&models.CompanyAccount{ID: accountID, Name: "Сеть"}).Error; err != nil {
		t.Fatal(err)
	}
	centralID, outletID := uuid.NewString(), uuid.NewString()
	cw, ot := "central_warehouse", "outlet"
	gdb.Create(&models.Restaurant{ID: centralID, Name: "Центр", AccountID: &accountID, Kind: &cw})
	gdb.Create(&models.Restaurant{ID: outletID, Name: "Филиал", AccountID: &accountID, Kind: &ot})

	now := time.Now().UTC()
	closedStatus := "closed"
	piece := "piece"

	seedOrder := func(rid, total, cogs string) {
		orderID := uuid.NewString()
		if err := gdb.Create(&models.Order{
			ID: orderID, OrderNumber: 1, Status: &closedStatus, RestaurantID: &rid,
			TotalWithService: decimal.MustFromString(total), ClosedAt: &now,
		}).Error; err != nil {
			t.Fatal(err)
		}
		if err := gdb.Create(&models.OrderItem{
			ID: uuid.NewString(), OrderID: &orderID, Qty: decimal.MustFromString("1"),
			COGS: decimal.MustFromString(cogs), Unit: &piece, UnitSize: decimal.MustFromString("1"),
		}).Error; err != nil {
			t.Fatal(err)
		}
	}
	seedOrder(centralID, "1000", "300")
	seedOrder(outletID, "2000", "500")

	seedWriteoff := func(rid, cost string) {
		if err := gdb.Create(&models.StockWriteoff{
			ID: uuid.NewString(), RestaurantID: &rid, TotalCost: decimal.MustFromString(cost),
		}).Error; err != nil {
			t.Fatal(err)
		}
	}
	seedWriteoff(centralID, "50")
	seedWriteoff(outletID, "80")

	seedSupplyExpense := func(rid, cost string) {
		if err := gdb.Create(&models.SupplyExpense{
			ID: uuid.NewString(), RestaurantID: &rid, Cost: decimal.MustFromString(cost),
		}).Error; err != nil {
			t.Fatal(err)
		}
	}
	seedSupplyExpense(centralID, "20")
	seedSupplyExpense(outletID, "30")

	in, out := "in", "out"
	seedFO := func(rid string, typ *string, amt string) {
		if err := gdb.Create(&models.FinancialOperation{
			ID: uuid.NewString(), Type: typ, RestaurantID: &rid, Amount: decimal.MustFromString(amt),
		}).Error; err != nil {
			t.Fatal(err)
		}
	}
	seedFO(centralID, &in, "1000")
	seedFO(centralID, &out, "100")
	seedFO(outletID, &in, "2000")
	seedFO(outletID, &out, "300")

	seedIngredient := func(rid, qty, price string) {
		if err := gdb.Create(&models.Ingredient{
			ID: uuid.NewString(), RestaurantID: &rid, Qty: decimal.MustFromString(qty),
			PricePerUnit: decimal.MustFromString(price),
		}).Error; err != nil {
			t.Fatal(err)
		}
	}
	seedIngredient(centralID, "10", "5")
	seedIngredient(outletID, "20", "3")

	// central: 2 счёта, один потом отключаем ОТДЕЛЬНЫМ Update — IsEnabled:false
	// в литерале Create() подменился бы GORM'ом на default:true, см.
	// [[gorm-zero-value-default-tag-gotcha]] (тот же баг, что в Ф5/Ф6).
	acc1, acc2, acc3 := uuid.NewString(), uuid.NewString(), uuid.NewString()
	name1, name2, name3 := "Касса", "Отключённый", "Касса филиала"
	gdb.Create(&models.FinancialAccount{ID: acc1, RestaurantID: &centralID, Name: &name1, Balance: decimal.MustFromString("500")})
	gdb.Create(&models.FinancialAccount{ID: acc2, RestaurantID: &centralID, Name: &name2, Balance: decimal.MustFromString("100")})
	gdb.Model(&models.FinancialAccount{ID: acc2}).Update("is_enabled", false)
	gdb.Create(&models.FinancialAccount{ID: acc3, RestaurantID: &outletID, Name: &name3, Balance: decimal.MustFromString("1000")})

	svc := service.NewNetworkService(repo.New(gdb), "")
	ctx := tenant.WithRestaurant(context.Background(), centralID)

	t.Run("PnL", func(t *testing.T) {
		pnl, err := svc.PnL(ctx, service.PeriodFilter{})
		if err != nil {
			t.Fatalf("PnL: %v", err)
		}
		if !pnl.Total.Revenue.Equal(decimal.MustFromString("3000")) {
			t.Errorf("total revenue = %s, want 3000", pnl.Total.Revenue.String())
		}
		if !pnl.Total.COGS.Equal(decimal.MustFromString("800")) {
			t.Errorf("total cogs = %s, want 800", pnl.Total.COGS.String())
		}
		if !pnl.Total.Writeoffs.Equal(decimal.MustFromString("130")) {
			t.Errorf("total writeoffs = %s, want 130", pnl.Total.Writeoffs.String())
		}
		if !pnl.Total.SupplyExpenses.Equal(decimal.MustFromString("50")) {
			t.Errorf("total supply_expenses = %s, want 50", pnl.Total.SupplyExpenses.String())
		}
		if !pnl.Total.GrossProfit.Equal(decimal.MustFromString("2020")) {
			t.Errorf("total gross_profit = %s, want 2020", pnl.Total.GrossProfit.String())
		}
		if pnl.Total.OrdersCount != 2 {
			t.Errorf("total orders_count = %d, want 2", pnl.Total.OrdersCount)
		}
		if len(pnl.Branches) != 2 {
			t.Fatalf("branches = %d, want 2", len(pnl.Branches))
		}
		byID := map[string]service.PnLAmounts{}
		for _, b := range pnl.Branches {
			byID[b.ID] = b.PnLAmounts
		}
		if !byID[centralID].Revenue.Equal(decimal.MustFromString("1000")) || !byID[centralID].GrossProfit.Equal(decimal.MustFromString("630")) {
			t.Errorf("central pnl = %+v, want revenue=1000 gross_profit=630", byID[centralID])
		}
		if !byID[outletID].Revenue.Equal(decimal.MustFromString("2000")) || !byID[outletID].GrossProfit.Equal(decimal.MustFromString("1390")) {
			t.Errorf("outlet pnl = %+v, want revenue=2000 gross_profit=1390", byID[outletID])
		}
	})

	t.Run("Cashflow", func(t *testing.T) {
		cf, err := svc.Cashflow(ctx, service.PeriodFilter{})
		if err != nil {
			t.Fatalf("Cashflow: %v", err)
		}
		if !cf.Total.In.Equal(decimal.MustFromString("3000")) || !cf.Total.Out.Equal(decimal.MustFromString("400")) || !cf.Total.Net.Equal(decimal.MustFromString("2600")) {
			t.Errorf("total cashflow = %+v, want in=3000 out=400 net=2600", cf.Total)
		}
		byID := map[string]service.CashflowAmounts{}
		for _, b := range cf.Branches {
			byID[b.ID] = b.CashflowAmounts
		}
		if !byID[centralID].Net.Equal(decimal.MustFromString("900")) {
			t.Errorf("central net = %s, want 900", byID[centralID].Net.String())
		}
		if !byID[outletID].Net.Equal(decimal.MustFromString("1700")) {
			t.Errorf("outlet net = %s, want 1700", byID[outletID].Net.String())
		}
	})

	t.Run("Warehouse", func(t *testing.T) {
		wh, err := svc.Warehouse(ctx)
		if err != nil {
			t.Fatalf("Warehouse: %v", err)
		}
		if !wh.TotalValue.Equal(decimal.MustFromString("110")) {
			t.Errorf("total value = %s, want 110", wh.TotalValue.String())
		}
		byID := map[string]decimal.Decimal{}
		for _, b := range wh.Branches {
			byID[b.ID] = b.Value
		}
		if !byID[centralID].Equal(decimal.MustFromString("50")) {
			t.Errorf("central value = %s, want 50", byID[centralID].String())
		}
		if !byID[outletID].Equal(decimal.MustFromString("60")) {
			t.Errorf("outlet value = %s, want 60", byID[outletID].String())
		}
	})

	t.Run("Accounts", func(t *testing.T) {
		accs, err := svc.Accounts(ctx)
		if err != nil {
			t.Fatalf("Accounts: %v", err)
		}
		if !accs.TotalBalance.Equal(decimal.MustFromString("1600")) {
			t.Errorf("total balance = %s, want 1600 (включая отключённый счёт)", accs.TotalBalance.String())
		}
		if len(accs.Accounts) != 3 {
			t.Fatalf("accounts = %d, want 3 (в т.ч. отключённый)", len(accs.Accounts))
		}
		var foundDisabled bool
		for _, a := range accs.Accounts {
			if a.ID == acc2 {
				foundDisabled = true
				if a.IsEnabled {
					t.Error("acc2 is_enabled = true, want false")
				}
				if a.BranchName != "Центр" {
					t.Errorf("acc2 branch_name = %q, want Центр", a.BranchName)
				}
			}
		}
		if !foundDisabled {
			t.Error("отключённый счёт не найден в ответе — Accounts не должен фильтровать is_enabled")
		}
	})
}
