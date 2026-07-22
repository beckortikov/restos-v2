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

// TestRecurringPayment_CreateAndPay — модуль «Платежи»: шаблон повторяющегося
// платежа создаётся с вычисленным next_due; оплата списывает деньги со счёта,
// создаёт financial_operation out и двигает next_due вперёд; сумму можно
// переопределить (коммуналка); нехватка денег → 409.
func TestRecurringPayment_CreateAndPay(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, _, accountID := seedForWrite(t, f)
	topUp(t, gdb, accountID) // баланс 10000
	// Фикстура-кассир не имеет finance.manage — выдаём (управление платежами —
	// право бухгалтера). Гейт на пользователе БЕЗ права проверяет отдельный тест.
	if err := gdb.Exec(`UPDATE users SET permissions = '{"actions":{"finance.manage":true}}' WHERE restaurant_id = ?`, f.rid).Error; err != nil {
		t.Fatal(err)
	}

	// ─── Создание шаблона ───────────────────────────────────────────────────
	r, b := f.post(t, "/api/v1/finance/recurring-payments", tok, uuid.NewString(), map[string]any{
		"name": "Аренда", "amount": "3000", "account_id": accountID,
		"category": "rent", "day_of_month": 5,
	})
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("create: %d %s", r.StatusCode, b)
	}
	var rp models.RecurringPayment
	if err := json.Unmarshal(b, &rp); err != nil {
		t.Fatal(err)
	}
	if rp.NextDue == nil || *rp.NextDue == "" {
		t.Fatalf("next_due не вычислен при создании")
	}
	dueBefore := *rp.NextDue

	// ─── Оплата по умолчанию (сумма из шаблона) ─────────────────────────────
	r, b = f.post(t, "/api/v1/finance/recurring-payments/"+rp.ID+"/pay", tok, uuid.NewString(), map[string]any{})
	if r.StatusCode != http.StatusOK {
		t.Fatalf("pay default: %d %s", r.StatusCode, b)
	}
	var afterPay models.RecurringPayment
	if err := json.Unmarshal(b, &afterPay); err != nil {
		t.Fatal(err)
	}
	// next_due сдвинулся вперёд, last_paid_at проставлен.
	if afterPay.NextDue == nil || *afterPay.NextDue <= dueBefore {
		t.Errorf("next_due не сдвинулся вперёд: было %s, стало %v", dueBefore, afterPay.NextDue)
	}
	if afterPay.LastPaidAt == nil {
		t.Errorf("last_paid_at не проставлен")
	}

	// Деньги списаны: 10000 − 3000 = 7000.
	var acc models.FinancialAccount
	gdb.First(&acc, "id = ?", accountID)
	if !acc.Balance.Equal(decimal.MustFromString("7000")) {
		t.Errorf("баланс = %s, want 7000", acc.Balance)
	}
	// Финоп: out / rent / 3000 / operational.
	var fo models.FinancialOperation
	if err := gdb.Where("restaurant_id = ? AND category = ? AND amount = ?",
		f.rid, "rent", decimal.MustFromString("3000")).First(&fo).Error; err != nil {
		t.Fatalf("финоп не создан: %v", err)
	}
	if fo.Type == nil || *fo.Type != "out" {
		t.Errorf("финоп type = %v, want out", fo.Type)
	}

	// ─── Оплата с override суммы (коммуналка меняется помесячно) ─────────────
	r, b = f.post(t, "/api/v1/finance/recurring-payments", tok, uuid.NewString(), map[string]any{
		"name": "Коммуналка", "amount": "500", "account_id": accountID, "category": "utilities", "day_of_month": 10,
	})
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("create utilities: %d %s", r.StatusCode, b)
	}
	var util models.RecurringPayment
	_ = json.Unmarshal(b, &util)
	r, b = f.post(t, "/api/v1/finance/recurring-payments/"+util.ID+"/pay", tok, uuid.NewString(), map[string]any{
		"amount": "800", // в этом месяце больше
	})
	if r.StatusCode != http.StatusOK {
		t.Fatalf("pay override: %d %s", r.StatusCode, b)
	}
	// 7000 − 800 = 6200 (списали override, а не 500 из шаблона).
	gdb.First(&acc, "id = ?", accountID)
	if !acc.Balance.Equal(decimal.MustFromString("6200")) {
		t.Errorf("баланс после override = %s, want 6200", acc.Balance)
	}

	// ─── Нехватка денег → 409 ───────────────────────────────────────────────
	r, b = f.post(t, "/api/v1/finance/recurring-payments", tok, uuid.NewString(), map[string]any{
		"name": "Дорого", "amount": "999999", "account_id": accountID, "day_of_month": 1,
	})
	var big models.RecurringPayment
	_ = json.Unmarshal(b, &big)
	r, b = f.post(t, "/api/v1/finance/recurring-payments/"+big.ID+"/pay", tok, uuid.NewString(), map[string]any{})
	if r.StatusCode != http.StatusConflict {
		t.Fatalf("оплата без денег: %d %s, want 409", r.StatusCode, b)
	}
	// Баланс не тронут неудачной оплатой.
	gdb.First(&acc, "id = ?", accountID)
	if !acc.Balance.Equal(decimal.MustFromString("6200")) {
		t.Errorf("баланс после неудачной оплаты = %s, want 6200 (не тронут)", acc.Balance)
	}
}
