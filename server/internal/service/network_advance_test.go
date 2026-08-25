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

// TestNetworkBranchAdvance — аванс сотруднику филиала из кассы центра (Ф-С5).
//
// Ключевое отличие от зарплаты: кап периода вычитает авансы из строк
// salary_advances (advDedForPeriod), а не из финопер — поэтому зеркало аванса
// обязано СОЗДАВАТЬ строку аванса у филиала и двигать users.advance. Без
// этого аванс центра не уменьшал бы «к выплате» и открывал двойную выдачу.
// Проверяются: строка+счётчик, ровно-однократность при повторной доставке,
// кап следующей выплаты, запрет ЛОКАЛЬНОЙ отмены (счёта-то нет — деньги
// списаны на центре) и откат при отмене С ЦЕНТРА.
func TestNetworkBranchAdvance(t *testing.T) {
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
		"salary_advances", "financial_operations", "financial_accounts", "users",
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
	advKind := "advance"

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

	// ─── Аванс 1000 с центра ──────────────────────────────────────────────
	advOp, err := svc.PayBranchSalary(ctxCentral, service.PayBranchSalaryInput{
		BranchID: branchID, UserID: empID, Amount: "1000", AccountID: accID,
		Period: period, Kind: &advKind,
	})
	if err != nil {
		t.Fatalf("аванс с центра: %v", err)
	}
	if advOp.Category == nil || *advOp.Category != "Аванс" {
		t.Errorf("категория = %v, want Аванс", advOp.Category)
	}
	deliver()

	var row models.SalaryAdvance
	if err := gdb.Where("restaurant_id = ? AND user_id = ?", branchID, empID).First(&row).Error; err != nil {
		t.Fatalf("строка аванса у филиала не создана: %v", err)
	}
	if row.Period != period {
		t.Errorf("период аванса = %q, want %q", row.Period, period)
	}
	if row.AccountID != nil {
		t.Error("у зеркального аванса не должно быть счёта — деньги списаны на центре")
	}
	var emp models.User
	gdb.First(&emp, "id = ?", empID)
	if !emp.Advance.Equal(decimal.MustFromString("1000")) {
		t.Errorf("users.advance = %s, want 1000", emp.Advance.String())
	}

	// ─── Повторная доставка не дублирует ──────────────────────────────────
	for i := 0; i < 3; i++ {
		deliver()
	}
	var advCount int64
	gdb.Model(&models.SalaryAdvance{}).Where("restaurant_id = ?", branchID).Count(&advCount)
	if advCount != 1 {
		t.Errorf("строк аванса = %d, want 1 (повторная доставка задублировала)", advCount)
	}
	gdb.First(&emp, "id = ?", empID)
	if !emp.Advance.Equal(decimal.MustFromString("1000")) {
		t.Errorf("users.advance после повторов = %s, want 1000", emp.Advance.String())
	}

	// ─── Кап: зарплата за период теперь не больше 3000−1000 ───────────────
	if _, err := svc.PayBranchSalary(ctxCentral, service.PayBranchSalaryInput{
		BranchID: branchID, UserID: empID, Amount: "2500", AccountID: accID, Period: period,
	}); err == nil {
		t.Error("выплата сверх остатка (3000−аванс 1000=2000) должна быть отклонена")
	}
	if _, err := svc.PayBranchSalary(ctxCentral, service.PayBranchSalaryInput{
		BranchID: branchID, UserID: empID, Amount: "2000", AccountID: accID, Period: period,
	}); err != nil {
		t.Errorf("остаток 2000 должен выплачиваться: %v", err)
	}

	// ─── Локальная отмена запрещена (счёта нет) ───────────────────────────
	salarySvc := service.NewSalaryService(repo.New(gdb))
	ctxBranch := audit.WithActor(tenant.WithRestaurant(context.Background(), branchID), owner)
	if _, err := salarySvc.CancelAdvance(ctxBranch, row.ID); err == nil {
		t.Error("локальная отмена аванса центра должна быть запрещена")
	}

	// ─── Отмена с центра: строка снимается, счётчик возвращается ──────────
	if _, err := svc.CancelBranchExpense(ctxCentral, advOp.ID); err != nil {
		t.Fatalf("отмена аванса на центре: %v", err)
	}
	for i := 0; i < 3; i++ {
		deliver()
	}
	gdb.First(&row, "id = ?", row.ID)
	if row.CancelledAt == nil {
		t.Error("строка аванса филиала не помечена отменённой")
	}
	gdb.First(&emp, "id = ?", empID)
	if !emp.Advance.IsZero() {
		t.Errorf("users.advance после отмены = %s, want 0", emp.Advance.String())
	}
}
