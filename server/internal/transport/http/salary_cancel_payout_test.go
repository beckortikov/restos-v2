//go:build integration

package http_test

import (
	"encoding/json"
	"net/http"
	"net/url"
	"testing"
	"time"

	"github.com/google/uuid"
	"gorm.io/datatypes"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// TestSalary_CancelPayout_RefundsAccountAndReversesMirror — отмена выплаты
// зарплаты (071): деньги возвращаются на счёт, снимается зеркало кассовой
// смены, исходная проводка помечается отменённой и исключается из сумм отчёта,
// повторная отмена запрещена.
func TestSalary_CancelPayout_RefundsAccountAndReversesMirror(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb := openTestDB(t)

	gdb.Model(&models.User{}).Where("restaurant_id = ?", f.rid).
		Update("permissions", datatypes.JSON([]byte(`{"actions":{"payroll.manage":true,"finance.manage":true}}`)))

	accID, accName := uuid.NewString(), "Касса"
	if err := gdb.Create(&models.FinancialAccount{
		ID: accID, Name: &accName, Balance: decimal.MustFromString("10000"), RestaurantID: &f.rid,
	}).Error; err != nil {
		t.Fatal(err)
	}
	// Открытая смена на счёте — чтобы выплата зеркалилась в неё.
	shiftID, openStatus := uuid.NewString(), "open"
	if err := gdb.Create(&models.CashShift{
		ID: shiftID, RestaurantID: &f.rid, AccountID: &accID, Status: &openStatus,
		OpeningBalance: decimal.Zero, OpenedAt: time.Now().UTC(),
	}).Error; err != nil {
		t.Fatal(err)
	}
	empName, role, payType := "Оклад-сотрудник", "waiter", "monthly"
	empID := uuid.NewString()
	if err := gdb.Create(&models.User{
		ID: empID, Name: &empName, Role: &role, PayType: &payType,
		Salary: decimal.MustFromString("5000"), RestaurantID: &f.rid,
	}).Error; err != nil {
		t.Fatal(err)
	}

	period := time.Now().UTC().Format("2006-01")
	r, b := f.post(t, "/api/v1/finance/salary/pay", tok, uuid.NewString(), map[string]any{
		"user_id": empID, "amount": "3000", "account_id": accID, "employee_name": empName,
		"period": period, "kind": "salary",
	})
	if r.StatusCode != http.StatusOK && r.StatusCode != http.StatusCreated {
		t.Fatalf("pay salary: %d %s", r.StatusCode, b)
	}

	var op models.FinancialOperation
	if err := gdb.Where("restaurant_id = ? AND source_ref = ? AND category = ? AND type = ?", f.rid, empID, "Зарплата", "out").
		Order("created_at DESC").First(&op).Error; err != nil {
		t.Fatalf("выплата не найдена: %v", err)
	}
	var mirrors int64
	gdb.Model(&models.CashShiftOperation{}).
		Where("shift_id = ? AND category = ? AND source_ref = ?", shiftID, "__auto_mirror__", op.ID).Count(&mirrors)
	if mirrors != 1 {
		t.Fatalf("зеркал до отмены = %d, want 1", mirrors)
	}
	var acc models.FinancialAccount
	gdb.First(&acc, "id = ?", accID)
	if !acc.Balance.Equal(decimal.MustFromString("7000")) {
		t.Fatalf("баланс до отмены = %s, want 7000", decimal.Normalize(acc.Balance).String())
	}

	// ─── Отмена выплаты ──────────────────────────────────────────────────────
	rc, bc := f.del(t, "/api/v1/finance/salary/payouts/"+op.ID, tok, uuid.NewString())
	if rc.StatusCode != http.StatusOK {
		t.Fatalf("cancel payout: %d %s", rc.StatusCode, bc)
	}

	gdb.First(&acc, "id = ?", accID)
	if !acc.Balance.Equal(decimal.MustFromString("10000")) {
		t.Errorf("баланс после отмены = %s, want 10000 (деньги вернулись)", decimal.Normalize(acc.Balance).String())
	}
	var after models.FinancialOperation
	gdb.First(&after, "id = ?", op.ID)
	if after.CancelledAt == nil {
		t.Errorf("cancelled_at не проставлен — повторная отмена не защищена")
	}
	var reverses int64
	gdb.Model(&models.FinancialOperation{}).
		Where("restaurant_id = ? AND source_ref = ? AND category = ? AND type = ?", f.rid, empID, "Зарплата", "in").Count(&reverses)
	if reverses != 1 {
		t.Errorf("компенсирующих проводок (in) = %d, want 1", reverses)
	}
	gdb.Model(&models.CashShiftOperation{}).
		Where("shift_id = ? AND category = ? AND source_ref = ?", shiftID, "__auto_mirror__", op.ID).Count(&mirrors)
	if mirrors != 0 {
		t.Errorf("зеркал после отмены = %d, want 0 (снято — деньги в ящике)", mirrors)
	}

	// ─── Отчёт: выплата помечена cancelled, из сумм исключена ────────────────
	q := url.Values{}
	q.Set("from", period+"-01")
	q.Set("to", time.Now().UTC().Format("2006-01-02"))
	rr, br := f.get(t, "/api/v1/finance/salary/report?"+q.Encode(), tok)
	if rr.StatusCode != http.StatusOK {
		t.Fatalf("report: %d %s", rr.StatusCode, br)
	}
	var rep struct {
		Payouts []struct {
			ID        string `json:"id"`
			Cancelled bool   `json:"cancelled"`
		} `json:"payouts"`
		Totals struct {
			SalaryPaid decimal.Decimal `json:"salary_paid"`
		} `json:"totals"`
	}
	_ = json.Unmarshal(br, &rep)
	var found bool
	for _, p := range rep.Payouts {
		if p.ID == op.ID {
			found = true
			if !p.Cancelled {
				t.Errorf("в отчёте выплата не помечена cancelled")
			}
		}
	}
	if !found {
		t.Errorf("отменённая выплата пропала из ленты отчёта (должна остаться зачёркнутой)")
	}
	if !rep.Totals.SalaryPaid.Equal(decimal.Zero) {
		t.Errorf("totals.salary_paid = %s, want 0 (единственная выплата отменена)", rep.Totals.SalaryPaid.String())
	}

	// ─── Повторная отмена → 400 ─────────────────────────────────────────────
	rc2, _ := f.del(t, "/api/v1/finance/salary/payouts/"+op.ID, tok, uuid.NewString())
	if rc2.StatusCode != http.StatusBadRequest {
		t.Errorf("повторная отмена: %d, want 400 (уже отменена)", rc2.StatusCode)
	}
}
