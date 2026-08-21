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

// TestNetworkPayBranchSalary — Фаза Р: зарплата сотруднику филиала из кассы
// центра.
//
// Главное, что здесь проверяется, — НЕВОЗМОЖНОСТЬ ДВОЙНОЙ ВЫПЛАТЫ. Она держится
// на том, что зеркальная проводка доезжает до филиала и попадает в его
// зарплатный кап: без этого филиал считал бы, что человеку ещё не платили, и
// спокойно выдал бы вторую зарплату. Плюс раскладка по отчётам: деньги ушли у
// центра (его ДДС), затрата принадлежит филиалу (его ОПиУ), и нигде не
// задваивается.
func TestNetworkPayBranchSalary(t *testing.T) {
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
		"financial_operations", "financial_accounts", "users",
		"restaurants", "company_accounts", "sync_log",
	} {
		gdb.Exec("DELETE FROM " + tbl)
	}

	accountID := uuid.NewString()
	gdb.Create(&models.CompanyAccount{ID: accountID, Name: "Сеть"})
	centralID, branchID := uuid.NewString(), uuid.NewString()
	cw, ot := "central_warehouse", "outlet"
	gdb.Create(&models.Restaurant{ID: centralID, Name: "Центр", AccountID: &accountID, Kind: &cw})
	gdb.Create(&models.Restaurant{ID: branchID, Name: "Филиал", AccountID: &accountID, Kind: &ot})

	// Счёт центра и сотрудник филиала с окладом 3000.
	kassa := "Касса центра"
	accID := uuid.NewString()
	gdb.Create(&models.FinancialAccount{
		ID: accID, Name: &kassa, Balance: decimal.MustFromString("10000"),
		RestaurantID: &centralID, IsEnabled: true,
	})
	empName, empRole, monthly := "Повар Филиала", "cook", "monthly"
	empID := uuid.NewString()
	gdb.Create(&models.User{
		ID: empID, Name: &empName, Role: &empRole, RestaurantID: &branchID,
		Salary: decimal.MustFromString("3000"), PayType: &monthly,
	})

	svc := service.NewNetworkService(repo.New(gdb), "")
	syncSvc := service.NewSyncService(repo.New(gdb))
	owner := audit.Actor{UserID: uuid.NewString(), Role: "owner"}
	ctxCentral := audit.WithActor(tenant.WithRestaurant(context.Background(), centralID), owner)
	period := "2026-07"

	// ─── Гварды ───────────────────────────────────────────────────────────
	if _, err := svc.PayBranchSalary(ctxCentral, service.PayBranchSalaryInput{
		BranchID: centralID, UserID: empID, Amount: "100", AccountID: accID, Period: period,
	}); err == nil {
		t.Error("для своих сотрудников должна использоваться обычная выплата")
	}
	if _, err := svc.PayBranchSalary(ctxCentral, service.PayBranchSalaryInput{
		BranchID: branchID, UserID: uuid.NewString(), Amount: "100", AccountID: accID, Period: period,
	}); err == nil {
		t.Error("чужой/несуществующий сотрудник должен быть отклонён")
	}
	// Кап: оклад 3000, больше отдать без override нельзя.
	if _, err := svc.PayBranchSalary(ctxCentral, service.PayBranchSalaryInput{
		BranchID: branchID, UserID: empID, Amount: "5000", AccountID: accID, Period: period,
	}); err == nil {
		t.Error("сумма выше начисленного должна требовать override")
	}

	// ─── Выплата ──────────────────────────────────────────────────────────
	op, err := svc.PayBranchSalary(ctxCentral, service.PayBranchSalaryInput{
		BranchID: branchID, UserID: empID, Amount: "3000", AccountID: accID, Period: period,
	})
	if err != nil {
		t.Fatalf("PayBranchSalary: %v", err)
	}
	if op.TargetRestaurantID == nil || *op.TargetRestaurantID != branchID {
		t.Errorf("target_restaurant_id = %v, want %s — иначе выплата осядет в ОПиУ центра", op.TargetRestaurantID, branchID)
	}
	// Деньги ушли со счёта центра.
	var acc models.FinancialAccount
	gdb.First(&acc, "id = ?", accID)
	if !acc.Balance.Equal(decimal.MustFromString("7000")) {
		t.Errorf("баланс центра = %s, want 7000", acc.Balance.String())
	}
	// Учётная дата — период начисления, а не «сегодня».
	if op.Date == nil || (*op.Date)[:7] != period {
		t.Errorf("дата операции = %v, want месяц %s (зарплата за июль обязана лечь в июль)", op.Date, period)
	}

	// ─── Раскладка по отчётам ─────────────────────────────────────────────
	fin := service.NewFinanceReportsService(repo.New(gdb))
	pnlCentral, err := fin.PnL(ctxCentral, service.PeriodFilter{})
	if err != nil {
		t.Fatal(err)
	}
	if !pnlCentral.Opex.Total.IsZero() {
		t.Errorf("ОПиУ центра = %s, want 0: затрата принадлежит филиалу, а не центру", pnlCentral.Opex.Total.String())
	}
	cfCentral, err := fin.Cashflow(ctxCentral, service.PeriodFilter{})
	if err != nil {
		t.Fatal(err)
	}
	if !cfCentral.ByActivity["operational"].Out.Equal(decimal.MustFromString("3000")) {
		t.Errorf("ДДС центра = %s, want 3000: деньги реально ушли отсюда",
			cfCentral.ByActivity["operational"].Out.String())
	}

	// ─── Зеркало доезжает до филиала ──────────────────────────────────────
	pull, err := syncSvc.PullFor(context.Background(), branchID, nil)
	if err != nil {
		t.Fatal(err)
	}
	var mirrorEntries int
	for _, e := range pull.Entries {
		if e.Entity == "financial_operations" {
			mirrorEntries++
		}
	}
	if mirrorEntries != 1 {
		t.Fatalf("филиалу уехало %d зеркал, want 1", mirrorEntries)
	}
	if _, err := syncSvc.ApplyPulled(context.Background(), *pull, branchID); err != nil {
		t.Fatalf("ApplyPulled: %v", err)
	}

	var mirror models.FinancialOperation
	if err := gdb.Where("restaurant_id = ? AND paid_by_restaurant_id IS NOT NULL", branchID).
		First(&mirror).Error; err != nil {
		t.Fatalf("зеркало не применилось на филиале: %v", err)
	}
	if mirror.AccountID != nil {
		t.Error("у зеркала есть счёт — оно бы двигало баланс филиала, которого не было")
	}

	// Повторная доставка (зеркало отдаётся, пока филиал не подтвердит курсором)
	// не должна плодить вторую зарплату в его ОПиУ — id выводится
	// детерминированно именно ради этого.
	if _, err := syncSvc.ApplyPulled(context.Background(), *pull, branchID); err != nil {
		t.Fatalf("повторный ApplyPulled: %v", err)
	}
	var mirrorCnt int64
	gdb.Model(&models.FinancialOperation{}).
		Where("restaurant_id = ? AND paid_by_restaurant_id IS NOT NULL", branchID).Count(&mirrorCnt)
	if mirrorCnt != 1 {
		t.Errorf("зеркал на филиале = %d, want 1 (повторная доставка задвоила зарплату)", mirrorCnt)
	}

	// Курсор филиала: после применения он сообщает центру свою метку, и центр
	// перестаёт слать уже доставленное.
	pullAgain, err := syncSvc.PullFor(context.Background(), branchID, &mirror.CreatedAt)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range pullAgain.Entries {
		if e.Entity == "financial_operations" && e.RowID != mirror.ID {
			t.Errorf("с курсором приехало лишнее зеркало %s", e.RowID)
		}
	}

	// Исходная проводка центра НЕ затёрта зеркалом (общий id, разные строки
	// в разных БД; тут одна БД, поэтому проверяем, что центр цел).
	var central models.FinancialOperation
	gdb.Where("id = ? AND restaurant_id = ?", op.ID, centralID).First(&central)
	if central.AccountID == nil || *central.AccountID != accID {
		t.Error("проводка центра потеряла счёт — платёж исчез бы из его кассы")
	}

	// ─── Отчёты филиала ───────────────────────────────────────────────────
	ctxBranch := audit.WithActor(tenant.WithRestaurant(context.Background(), branchID), owner)
	pnlBranch, err := fin.PnL(ctxBranch, service.PeriodFilter{})
	if err != nil {
		t.Fatal(err)
	}
	if !pnlBranch.Opex.Total.Equal(decimal.MustFromString("3000")) {
		t.Errorf("ОПиУ филиала = %s, want 3000: ФОТ — его затрата", pnlBranch.Opex.Total.String())
	}
	cfBranch, err := fin.Cashflow(ctxBranch, service.PeriodFilter{})
	if err != nil {
		t.Fatal(err)
	}
	if !cfBranch.ByActivity["operational"].Out.IsZero() {
		t.Errorf("ДДС филиала = %s, want 0: его касса не пустела, платил центр",
			cfBranch.ByActivity["operational"].Out.String())
	}

	// Сетевой ДДС: платёж посчитан РОВНО ОДИН раз.
	netCf, err := svc.Cashflow(ctxCentral, service.PeriodFilter{})
	if err != nil {
		t.Fatal(err)
	}
	if !netCf.Total.Out.Equal(decimal.MustFromString("3000")) {
		t.Errorf("сетевой ДДС отток = %s, want 3000 (не 6000 — иначе платёж задвоен)",
			netCf.Total.Out.String())
	}

	// ─── ГЛАВНОЕ: филиал больше не даст выплатить второй раз ─────────────
	salary := service.NewSalaryService(repo.New(gdb))
	if _, err := salary.PaySalary(ctxBranch, service.SalaryPayInput{
		UserID: &empID, Amount: strPtr("3000"), AccountID: &accID, Period: &period,
	}); err == nil {
		t.Error("ДВОЙНАЯ ВЫПЛАТА: филиал не увидел выплату, сделанную центром")
	}
}

func strPtr(s string) *string { return &s }
