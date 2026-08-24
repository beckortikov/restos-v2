//go:build integration

package http_test

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// TestRecurringPayment_PartialPayment — владелец гасит регулярный платёж
// (долг поставщику долями, «Погащение Арванд») не за один раз. Раньше
// Pay() безусловно двигал next_due на месяц вперёд при ЛЮБОЙ оплате —
// доплата 6000 из 9885 молча закрывала цикл, а строка тут же снова
// показывала полную сумму на следующий месяц, 3885 недоплаты терялись.
// Теперь: цикл закрывается (next_due двигается) только когда оплата
// покрывает остаток целиком.
func TestRecurringPayment_PartialPayment(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, _, accountID := seedForWrite(t, f)
	topUp(t, gdb, accountID) // баланс 10000
	if err := gdb.Exec(`UPDATE users SET permissions = '{"actions":{"finance.manage":true}}' WHERE restaurant_id = ?`, f.rid).Error; err != nil {
		t.Fatal(err)
	}

	r, b := f.post(t, "/api/v1/finance/recurring-payments", tok, uuid.NewString(), map[string]any{
		"name": "Погащения Арванд", "amount": "9885", "account_id": accountID,
		"category": "Прочее", "day_of_month": 21,
	})
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("create: %d %s", r.StatusCode, b)
	}
	var rp models.RecurringPayment
	if err := json.Unmarshal(b, &rp); err != nil {
		t.Fatal(err)
	}
	dueBefore := *rp.NextDue

	// ─── Частичная оплата: 6000 из 9885 ─────────────────────────────────────
	r, b = f.post(t, "/api/v1/finance/recurring-payments/"+rp.ID+"/pay", tok, uuid.NewString(), map[string]any{
		"amount": "6000",
	})
	if r.StatusCode != http.StatusOK {
		t.Fatalf("partial pay: %d %s", r.StatusCode, b)
	}
	var afterPartial models.RecurringPayment
	if err := json.Unmarshal(b, &afterPartial); err != nil {
		t.Fatal(err)
	}
	if afterPartial.NextDue == nil || *afterPartial.NextDue != dueBefore {
		t.Errorf("частичная оплата сдвинула next_due: было %s, стало %v — цикл не должен закрываться", dueBefore, afterPartial.NextDue)
	}
	if afterPartial.RemainingAmount == nil || !afterPartial.RemainingAmount.Equal(decimal.MustFromString("3885")) {
		t.Errorf("remaining_amount = %v, want 3885", afterPartial.RemainingAmount)
	}
	if afterPartial.LastPaidAmount == nil || !afterPartial.LastPaidAmount.Equal(decimal.MustFromString("6000")) {
		t.Errorf("last_paid_amount = %v, want 6000", afterPartial.LastPaidAmount)
	}
	if afterPartial.LastPaidAt == nil {
		t.Errorf("last_paid_at не проставлен")
	}
	var acc models.FinancialAccount
	gdb.First(&acc, "id = ?", accountID)
	if !acc.Balance.Equal(decimal.MustFromString("4000")) {
		t.Errorf("баланс после частичной оплаты = %s, want 4000", acc.Balance)
	}
	var fo1 models.FinancialOperation
	if err := gdb.Where("restaurant_id = ? AND amount = ?", f.rid, decimal.MustFromString("6000")).First(&fo1).Error; err != nil {
		t.Fatalf("финоп частичной оплаты не создан: %v", err)
	}
	if fo1.Description == nil || !contains(*fo1.Description, "частично") {
		t.Errorf("description = %v, ожидали пометку «частично»", fo1.Description)
	}

	// ─── Доплата остатка БЕЗ явной суммы — дефолт должен быть 3885, не 9885 ──
	r, b = f.post(t, "/api/v1/finance/recurring-payments/"+rp.ID+"/pay", tok, uuid.NewString(), map[string]any{})
	if r.StatusCode != http.StatusOK {
		t.Fatalf("close pay: %d %s", r.StatusCode, b)
	}
	var afterClose models.RecurringPayment
	if err := json.Unmarshal(b, &afterClose); err != nil {
		t.Fatal(err)
	}
	if afterClose.RemainingAmount != nil {
		t.Errorf("remaining_amount = %v, want nil (цикл закрыт)", afterClose.RemainingAmount)
	}
	if afterClose.NextDue == nil || *afterClose.NextDue <= dueBefore {
		t.Errorf("next_due не сдвинулся после закрытия остатка: было %s, стало %v", dueBefore, afterClose.NextDue)
	}
	gdb.First(&acc, "id = ?", accountID)
	if !acc.Balance.Equal(decimal.MustFromString("115")) { // 4000 − 3885
		t.Errorf("баланс после закрытия остатка = %s, want 115", acc.Balance)
	}
	var fo2 models.FinancialOperation
	if err := gdb.Where("restaurant_id = ? AND amount = ?", f.rid, decimal.MustFromString("3885")).First(&fo2).Error; err != nil {
		t.Fatalf("финоп доплаты остатка не создан: %v", err)
	}
	if fo2.Description != nil && contains(*fo2.Description, "частично") {
		t.Errorf("description = %v, доплата закрыла цикл целиком — «частично» быть не должно", *fo2.Description)
	}
}
