//go:build integration

package service_test

import (
	"context"
	"testing"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/audit"
	"github.com/restos/restos-v4/server/internal/db"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
	"github.com/restos/restos-v4/server/internal/repo"
	"github.com/restos/restos-v4/server/internal/service"
)

// TestPayBranchExpense — Фаза Р, остаток: центр платит за филиал долг
// поставщику, регулярный платёж и произвольный расход.
//
// Главное, что проверяется, — ДОМЕННЫЕ ПОСЛЕДСТВИЯ у филиала. Одной проводки
// мало: если после оплаты долг накладной остался прежним, филиал продолжит
// считать, что должен поставщику, а «Аренда» будет вечно просроченной. И то и
// другое обязано примениться РОВНО ОДИН РАЗ — зеркало доставляется повторно,
// пока филиал не подтвердит его курсором, а долг и срок величины
// накопительные.
func TestPayBranchExpense(t *testing.T) {
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
		"financial_operations", "financial_accounts", "stock_receipts", "suppliers",
		"recurring_payments", "restaurants", "company_accounts", "sync_log",
	} {
		gdb.Exec("DELETE FROM " + tbl)
	}

	accountID := uuid.NewString()
	gdb.Create(&models.CompanyAccount{ID: accountID, Name: "Сеть"})
	centralID, branchID := uuid.NewString(), uuid.NewString()
	cw, ot := "central_warehouse", "outlet"
	gdb.Create(&models.Restaurant{ID: centralID, Name: "Центр", AccountID: &accountID, Kind: &cw})
	gdb.Create(&models.Restaurant{ID: branchID, Name: "Филиал", AccountID: &accountID, Kind: &ot})

	kassa := "Касса центра"
	accID := uuid.NewString()
	gdb.Create(&models.FinancialAccount{
		ID: accID, Name: &kassa, Balance: decimal.MustFromString("100000"),
		RestaurantID: &centralID, IsEnabled: true,
	})

	// Долг филиала поставщику: накладная на 5000, долг 5000.
	supName := "ООО Поставщик"
	supID := uuid.NewString()
	gdb.Create(&models.Supplier{
		ID: supID, Name: &supName, CurrentDebt: decimal.MustFromString("5000"), RestaurantID: &branchID,
	})
	recDate := "2026-08-01"
	receiptID := uuid.NewString()
	gdb.Create(&models.StockReceipt{
		ID: receiptID, SupplierID: &supID, SupplierName: &supName, Date: &recDate,
		TotalAmount: decimal.MustFromString("5000"), DebtAmount: decimal.MustFromString("5000"),
		RestaurantID: &branchID,
	})

	// Регулярный платёж филиала: аренда, срок 10 августа.
	rentName, rentCat, nextDue := "Аренда", "Аренда", "2026-08-10"
	rpID := uuid.NewString()
	gdb.Create(&models.RecurringPayment{
		ID: rpID, Name: &rentName, Category: &rentCat, Amount: decimal.MustFromString("3000"),
		DayOfMonth: 10, NextDue: &nextDue, Active: true, RestaurantID: &branchID,
	})

	netSvc := service.NewNetworkService(repo.New(gdb), "")
	syncSvc := service.NewSyncService(repo.New(gdb))
	owner := audit.Actor{UserID: uuid.NewString(), Role: "owner"}
	ctxCentral := audit.WithActor(tenant.WithRestaurant(context.Background(), centralID), owner)

	// ─── Список «что филиал должен» ───────────────────────────────────────
	payables, err := netSvc.BranchPayables(ctxCentral, branchID)
	if err != nil {
		t.Fatalf("BranchPayables: %v", err)
	}
	kinds := map[string]bool{}
	for _, p := range payables {
		kinds[p.Kind] = true
	}
	if !kinds["receipt"] || !kinds["recurring"] {
		t.Fatalf("в списке долгов нет обоих видов: %+v", payables)
	}

	// ─── Гварды ───────────────────────────────────────────────────────────
	if _, err := netSvc.PayBranchExpense(ctxCentral, service.PayBranchExpenseInput{
		BranchID: branchID, AccountID: accID, Amount: "9999",
		PayableKind: "receipt", PayableID: receiptID,
	}); err == nil {
		t.Error("сумма больше долга накладной должна быть отклонена")
	}
	if _, err := netSvc.PayBranchExpense(ctxCentral, service.PayBranchExpenseInput{
		BranchID: branchID, AccountID: accID, Amount: "100",
		PayableKind: "receipt", PayableID: uuid.NewString(),
	}); err == nil {
		t.Error("чужая/несуществующая накладная должна быть отклонена")
	}
	if _, err := netSvc.PayBranchExpense(ctxCentral, service.PayBranchExpenseInput{
		BranchID: branchID, AccountID: accID, Amount: "100",
	}); err == nil {
		t.Error("расход без категории и без привязки должен быть отклонён")
	}

	deliver := func() {
		t.Helper()
		pull, err := syncSvc.PullFor(context.Background(), branchID, nil)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := syncSvc.ApplyPulled(context.Background(), *pull, branchID); err != nil {
			t.Fatal(err)
		}
	}

	// ─── Р2: частичное гашение долга поставщику ───────────────────────────
	if _, err := netSvc.PayBranchExpense(ctxCentral, service.PayBranchExpenseInput{
		BranchID: branchID, AccountID: accID, Amount: "2000",
		PayableKind: "receipt", PayableID: receiptID,
	}); err != nil {
		t.Fatalf("оплата долга: %v", err)
	}
	deliver()

	var rec models.StockReceipt
	gdb.First(&rec, "id = ?", receiptID)
	if !rec.DebtAmount.Equal(decimal.MustFromString("3000")) {
		t.Errorf("долг накладной = %s, want 3000 — филиал продолжит считать, что должен", rec.DebtAmount.String())
	}
	if !rec.PaidAmount.Equal(decimal.MustFromString("2000")) {
		t.Errorf("оплачено по накладной = %s, want 2000", rec.PaidAmount.String())
	}
	if rec.PaymentType == nil || *rec.PaymentType != "partial" {
		t.Errorf("payment_type = %v, want partial", rec.PaymentType)
	}
	var sup models.Supplier
	gdb.First(&sup, "id = ?", supID)
	if !sup.CurrentDebt.Equal(decimal.MustFromString("3000")) {
		t.Errorf("долг поставщику = %s, want 3000", sup.CurrentDebt.String())
	}

	// ─── Ровно-однократность: повторные доставки НЕ гасят долг дважды ─────
	for i := 0; i < 3; i++ {
		deliver()
	}
	gdb.First(&rec, "id = ?", receiptID)
	if !rec.DebtAmount.Equal(decimal.MustFromString("3000")) {
		t.Errorf("ПОВТОРНОЕ ГАШЕНИЕ: долг = %s, want 3000 (зеркало доставляется многократно)", rec.DebtAmount.String())
	}
	gdb.First(&sup, "id = ?", supID)
	if !sup.CurrentDebt.Equal(decimal.MustFromString("3000")) {
		t.Errorf("ПОВТОРНОЕ ГАШЕНИЕ у поставщика: %s, want 3000", sup.CurrentDebt.String())
	}

	// ─── Полное гашение остатка → payment_type становится paid ────────────
	if _, err := netSvc.PayBranchExpense(ctxCentral, service.PayBranchExpenseInput{
		BranchID: branchID, AccountID: accID, Amount: "3000",
		PayableKind: "receipt", PayableID: receiptID,
	}); err != nil {
		t.Fatalf("доплата долга: %v", err)
	}
	deliver()
	gdb.First(&rec, "id = ?", receiptID)
	if rec.DebtAmount.IsPositive() {
		t.Errorf("долг после полной оплаты = %s, want 0", rec.DebtAmount.String())
	}
	if rec.PaymentType == nil || *rec.PaymentType != "paid" {
		t.Errorf("payment_type = %v, want paid", rec.PaymentType)
	}

	// ─── Р3: регулярный платёж — срок сдвинулся ───────────────────────────
	if _, err := netSvc.PayBranchExpense(ctxCentral, service.PayBranchExpenseInput{
		BranchID: branchID, AccountID: accID, Amount: "3000",
		PayableKind: "recurring", PayableID: rpID,
	}); err != nil {
		t.Fatalf("оплата регулярного: %v", err)
	}
	deliver()
	var rp models.RecurringPayment
	gdb.First(&rp, "id = ?", rpID)
	if rp.NextDue == nil || *rp.NextDue != "2026-09-10" {
		t.Errorf("срок = %v, want 2026-09-10 — иначе «Аренда» останется вечно просроченной", rp.NextDue)
	}
	if rp.LastPaidAt == nil {
		t.Error("last_paid_at не проставлен")
	}
	// Повтор не должен сдвинуть срок ещё на месяц.
	for i := 0; i < 3; i++ {
		deliver()
	}
	gdb.First(&rp, "id = ?", rpID)
	if rp.NextDue == nil || *rp.NextDue != "2026-09-10" {
		t.Errorf("ПОВТОРНЫЙ СДВИГ: срок = %v, want 2026-09-10", rp.NextDue)
	}

	// ─── Р4: произвольный расход, без привязки к документу ────────────────
	op, err := netSvc.PayBranchExpense(ctxCentral, service.PayBranchExpenseInput{
		BranchID: branchID, AccountID: accID, Amount: "700", Category: "Реклама",
	})
	if err != nil {
		t.Fatalf("произвольный расход: %v", err)
	}
	if op.TargetRestaurantID == nil || *op.TargetRestaurantID != branchID {
		t.Error("target_restaurant_id не проставлен — расход осядет в ОПиУ центра")
	}
	deliver()

	// ─── Раскладка по отчётам ─────────────────────────────────────────────
	fin := service.NewFinanceReportsService(repo.New(gdb))
	ctxBranch := audit.WithActor(tenant.WithRestaurant(context.Background(), branchID), owner)

	cfBranch, err := fin.Cashflow(ctxBranch, service.PeriodFilter{})
	if err != nil {
		t.Fatal(err)
	}
	if !cfBranch.ByActivity["operational"].Out.IsZero() {
		t.Errorf("ДДС филиала = %s, want 0: платил центр, его касса не пустела",
			cfBranch.ByActivity["operational"].Out.String())
	}
	pnlCentral, err := fin.PnL(ctxCentral, service.PeriodFilter{})
	if err != nil {
		t.Fatal(err)
	}
	if !pnlCentral.Opex.Total.IsZero() {
		t.Errorf("ОПиУ центра = %s, want 0: затраты принадлежат филиалу", pnlCentral.Opex.Total.String())
	}
	// Деньги ушли со счёта центра: 2000 + 3000 + 3000 + 700 = 8700.
	var acc models.FinancialAccount
	gdb.First(&acc, "id = ?", accID)
	if !acc.Balance.Equal(decimal.MustFromString("91300")) {
		t.Errorf("баланс центра = %s, want 91300", acc.Balance.String())
	}

	// Долги погашены — в списке остаётся только регулярный платёж.
	after, err := netSvc.BranchPayables(ctxCentral, branchID)
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range after {
		if p.Kind == "receipt" {
			t.Errorf("погашенная накладная всё ещё в списке долгов: %+v", p)
		}
	}
}
