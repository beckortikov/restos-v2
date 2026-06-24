//go:build integration

package http_test

import (
	"encoding/json"
	"testing"

	"github.com/google/uuid"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// Задача 1: «Выплатить официанту». При выплате обслуживания со смены:
//   (a) с кассового счёта должна списаться сумма;
//   (b) выплата должна попасть в отчёт по смене (service-payout/by-shift).
// Баг был: payout не проставлял shift_id → отчёт по смене пустой.
func TestPayout_DecreasesCash_AndShowsInShiftReport(t *testing.T) {
	f := setupE2E(t)
	gdb, _, shiftID, accountID := seedForWrite(t, f)

	// Пополняем счёт, чтобы хватило на выплату.
	if err := gdb.Model(&models.FinancialAccount{}).Where("id = ?", accountID).
		Update("balance", decimal.MustFromString("1000")).Error; err != nil {
		t.Fatal(err)
	}
	wID := mkUser(t, gdb, f.rid, "Alice", "waiter", "")
	tok := f.login(t)

	r, b := f.post(t, "/api/v1/finance/service-charge/pay", tok, uuid.NewString(), map[string]any{
		"waiter_id":   wID,
		"amount":      "50",
		"account_id":  accountID,
		"period_from": "2026-01-01T00:00:00Z",
		"period_to":   "2026-12-31T00:00:00Z",
		"shift_id":    shiftID,
	})
	if r.StatusCode != 201 && r.StatusCode != 200 {
		t.Fatalf("pay %d: %s", r.StatusCode, b)
	}

	// (a) Касса уменьшилась на 50.
	var acc models.FinancialAccount
	if err := gdb.First(&acc, "id = ?", accountID).Error; err != nil {
		t.Fatal(err)
	}
	if got := decimal.Normalize(acc.Balance).String(); got != "950" {
		t.Errorf("баланс счёта = %s, ожидали 950 (касса должна минусоваться)", got)
	}

	// (b) Выплата видна в отчёте по смене.
	gr, gb := f.get(t, "/api/v1/finance/service-payout/by-shift/"+shiftID, tok)
	if gr.StatusCode != 200 {
		t.Fatalf("payout-by-shift %d: %s", gr.StatusCode, gb)
	}
	var env struct {
		Data []struct {
			WaiterID   string `json:"waiter_id"`
			PaidAmount string `json:"paid_amount"`
		} `json:"data"`
	}
	_ = json.Unmarshal(gb, &env)
	paid := ""
	for _, row := range env.Data {
		if row.WaiterID == wID {
			paid = row.PaidAmount
		}
	}
	if paid != "50" {
		t.Errorf("в отчёте по смене выплата официанту = %q, ожидали 50 (баг: shift_id не проставлялся)", paid)
	}
}

// Контроль: выплата без shift_id не должна попадать в отчёт КОНКРЕТНОЙ смены.
func TestPayout_NoShift_NotInShiftReport(t *testing.T) {
	f := setupE2E(t)
	gdb, _, shiftID, accountID := seedForWrite(t, f)
	if err := gdb.Model(&models.FinancialAccount{}).Where("id = ?", accountID).
		Update("balance", decimal.MustFromString("1000")).Error; err != nil {
		t.Fatal(err)
	}
	wID := mkUser(t, gdb, f.rid, "Bob", "waiter", "")
	tok := f.login(t)
	r, b := f.post(t, "/api/v1/finance/service-charge/pay", tok, uuid.NewString(), map[string]any{
		"waiter_id": wID, "amount": "30", "account_id": accountID,
		"period_from": "2026-01-01T00:00:00Z", "period_to": "2026-12-31T00:00:00Z",
		// без shift_id
	})
	if r.StatusCode != 201 && r.StatusCode != 200 {
		t.Fatalf("pay %d: %s", r.StatusCode, b)
	}
	_, gb := f.get(t, "/api/v1/finance/service-payout/by-shift/"+shiftID, tok)
	var env struct {
		Data []struct {
			WaiterID string `json:"waiter_id"`
		} `json:"data"`
	}
	_ = json.Unmarshal(gb, &env)
	for _, row := range env.Data {
		if row.WaiterID == wID {
			t.Errorf("выплата без shift_id не должна быть в отчёте смены %s", shiftID)
		}
	}
}
