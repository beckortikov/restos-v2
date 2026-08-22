//go:build integration

package service_test

import (
	"context"
	"errors"
	"testing"
	"time"

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

// TestCancelBranchExpense — Фаза Р: отмена расхода, проведённого центром за
// филиал, обязана доехать до филиала и откатить ВСЁ, что платёж сделал.
//
// Без этого бухгалтер (он сидит в центре) отменяет ошибочную проводку, деньги
// возвращаются на счёт центра — а у филиала долг поставщику остаётся
// погашенным, «Аренда» оплаченной, и данные молча расходятся навсегда.
//
// Отдельно проверяется КУРСОР. Филиал тянет зеркала окном, и отмена не создаёт
// новой строки — она меняет старую. Поэтому здесь всегда доставляем ровно так,
// как это делает Puller (по самой свежей зеркальной проводке), и отменяем
// СТАРЫЙ расход, после которого приехали более новые: на окне по created_at
// такая отмена не уехала бы вниз никогда.
func TestCancelBranchExpense(t *testing.T) {
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

	// deliver — тик синка филиала ровно как в Puller: курсор = updated_at самой
	// свежей зеркальной проводки, которая у филиала уже есть.
	deliver := func() {
		t.Helper()
		var since *time.Time
		var last models.FinancialOperation
		err := gdb.Where("paid_by_restaurant_id IS NOT NULL").
			Order("updated_at DESC").First(&last).Error
		if err == nil {
			since = &last.UpdatedAt
		} else if !errors.Is(err, gorm.ErrRecordNotFound) {
			t.Fatal(err)
		}
		pull, err := syncSvc.PullFor(context.Background(), branchID, since)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := syncSvc.ApplyPulled(context.Background(), *pull, branchID); err != nil {
			t.Fatal(err)
		}
	}

	// ─── Платим долг поставщику, затем ещё один расход ПОЗЖЕ ──────────────
	// Второй нужен, чтобы курсор филиала ушёл дальше первого: отмену первого
	// окно по created_at уже не пропустило бы.
	debtOp, err := netSvc.PayBranchExpense(ctxCentral, service.PayBranchExpenseInput{
		BranchID: branchID, AccountID: accID, Amount: "2000",
		PayableKind: "receipt", PayableID: receiptID,
	})
	if err != nil {
		t.Fatalf("оплата долга: %v", err)
	}
	deliver()
	if _, err := netSvc.PayBranchExpense(ctxCentral, service.PayBranchExpenseInput{
		BranchID: branchID, AccountID: accID, Amount: "700", Category: "Реклама",
	}); err != nil {
		t.Fatalf("второй расход: %v", err)
	}
	deliver()

	var rec models.StockReceipt
	gdb.First(&rec, "id = ?", receiptID)
	if !rec.DebtAmount.Equal(decimal.MustFromString("3000")) {
		t.Fatalf("подготовка: долг = %s, want 3000", rec.DebtAmount.String())
	}

	// ─── Отмена первого расхода ───────────────────────────────────────────
	if _, err := netSvc.CancelBranchExpense(ctxCentral, debtOp.ID); err != nil {
		t.Fatalf("CancelBranchExpense: %v", err)
	}
	var central models.FinancialOperation
	gdb.First(&central, "id = ?", debtOp.ID)
	if central.CancelledAt == nil {
		t.Error("проводка центра не помечена отменённой")
	}
	var acc models.FinancialAccount
	gdb.First(&acc, "id = ?", accID)
	if !acc.Balance.Equal(decimal.MustFromString("99300")) {
		t.Errorf("баланс центра = %s, want 99300 (100000 − 700: 2000 вернулись)", acc.Balance.String())
	}

	// До доставки филиал ещё ничего не знает — долг прежний.
	gdb.First(&rec, "id = ?", receiptID)
	if !rec.DebtAmount.Equal(decimal.MustFromString("3000")) {
		t.Errorf("филиал откатил долг ДО синка: %s", rec.DebtAmount.String())
	}

	deliver()

	// ─── Откат у филиала ──────────────────────────────────────────────────
	var mirror models.FinancialOperation
	if err := gdb.Where("paid_by_restaurant_id IS NOT NULL AND source_ref = ?", receiptID).
		First(&mirror).Error; err != nil {
		t.Fatalf("зеркало не найдено: %v", err)
	}
	if mirror.CancelledAt == nil {
		t.Error("зеркало у филиала не помечено отменённым — отмена не доехала (курсор?)")
	}
	gdb.First(&rec, "id = ?", receiptID)
	if !rec.DebtAmount.Equal(decimal.MustFromString("5000")) {
		t.Errorf("долг накладной = %s, want 5000 — отмена не вернула долг", rec.DebtAmount.String())
	}
	if rec.PaidAmount.IsPositive() {
		t.Errorf("оплачено = %s, want 0", rec.PaidAmount.String())
	}
	if rec.PaymentType == nil || *rec.PaymentType != "credit" {
		t.Errorf("payment_type = %v, want credit", rec.PaymentType)
	}
	var sup models.Supplier
	gdb.First(&sup, "id = ?", supID)
	if !sup.CurrentDebt.Equal(decimal.MustFromString("5000")) {
		t.Errorf("долг поставщику = %s, want 5000", sup.CurrentDebt.String())
	}

	// ─── Ровно-однократность: повторные тики не наращивают долг ───────────
	for i := 0; i < 3; i++ {
		deliver()
	}
	gdb.First(&rec, "id = ?", receiptID)
	if !rec.DebtAmount.Equal(decimal.MustFromString("5000")) {
		t.Errorf("ПОВТОРНЫЙ ОТКАТ: долг = %s, want 5000", rec.DebtAmount.String())
	}
	gdb.First(&sup, "id = ?", supID)
	if !sup.CurrentDebt.Equal(decimal.MustFromString("5000")) {
		t.Errorf("ПОВТОРНЫЙ ОТКАТ у поставщика: %s, want 5000", sup.CurrentDebt.String())
	}

	// ─── Регулярный платёж: срок откатывается на месяц назад ──────────────
	rentOp, err := netSvc.PayBranchExpense(ctxCentral, service.PayBranchExpenseInput{
		BranchID: branchID, AccountID: accID, Amount: "3000",
		PayableKind: "recurring", PayableID: rpID,
	})
	if err != nil {
		t.Fatalf("оплата аренды: %v", err)
	}
	deliver()
	var rp models.RecurringPayment
	gdb.First(&rp, "id = ?", rpID)
	if rp.NextDue == nil || *rp.NextDue != "2026-09-10" {
		t.Fatalf("подготовка: срок = %v, want 2026-09-10", rp.NextDue)
	}
	if _, err := netSvc.CancelBranchExpense(ctxCentral, rentOp.ID); err != nil {
		t.Fatalf("отмена аренды: %v", err)
	}
	for i := 0; i < 3; i++ {
		deliver()
	}
	// Свежая переменная: GORM.First в уже заполненную структуру не обнуляет
	// поля, ставшие NULL, и последняя проверка молча читала бы старое значение.
	var rpBack models.RecurringPayment
	gdb.First(&rpBack, "id = ?", rpID)
	if rpBack.NextDue == nil || *rpBack.NextDue != "2026-08-10" {
		t.Errorf("срок = %v, want 2026-08-10 — отмена не вернула «Аренду» в неоплаченные", rpBack.NextDue)
	}
	if rpBack.LastPaidAt != nil {
		t.Error("last_paid_at остался проставленным — платёж отменён")
	}

	// ─── Гварды ───────────────────────────────────────────────────────────
	if _, err := netSvc.CancelBranchExpense(ctxCentral, debtOp.ID); err == nil {
		t.Error("повторная отмена должна быть отклонена")
	}
	ownOp := models.FinancialOperation{
		ID: uuid.NewString(), Amount: decimal.MustFromString("10"),
		RestaurantID: &centralID, CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC(),
	}
	gdb.Create(&ownOp)
	if _, err := netSvc.CancelBranchExpense(ctxCentral, ownOp.ID); err == nil {
		t.Error("собственный расход центра не должен отменяться этим методом")
	}

	// ─── Что видит владелец в списке ──────────────────────────────────────
	list, err := netSvc.BranchExpenses(ctxCentral, branchID, 0)
	if err != nil {
		t.Fatal(err)
	}
	var cancelled, live int
	for _, e := range list {
		if e.CancelledAt != nil {
			cancelled++
		} else {
			live++
		}
	}
	if cancelled != 2 || live != 1 {
		t.Errorf("в списке %d отменённых и %d живых, want 2 и 1: %+v", cancelled, live, list)
	}

	// ─── ДДС центра сходится: отменённые ушли и вернулись ─────────────────
	fin := service.NewFinanceReportsService(repo.New(gdb))
	cf, err := fin.Cashflow(ctxCentral, service.PeriodFilter{})
	if err != nil {
		t.Fatal(err)
	}
	net := decimal.Sub(cf.ByActivity["operational"].Out, cf.ByActivity["operational"].In)
	if !net.Equal(decimal.MustFromString("700")) {
		t.Errorf("чистый отток центра = %s, want 700 (2000 и 3000 отменены)", net.String())
	}
}
