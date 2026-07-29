//go:build integration

package http_test

import (
	"encoding/json"
	"net/http"
	"strconv"
	"testing"
	"time"

	"github.com/google/uuid"
)

// TestBalanceHistory_RollsBackFromCurrentBalance — остаток на конец дня.
//
// Истории остатков в схеме нет: financial_accounts.balance — скаляр «сейчас».
// Остаток на дату восстанавливается обратным ходом, и именно эту арифметику
// тест и проверяет: закрываем заказ (приход на счёт) и убеждаемся, что
// «вчера» на счёте было на сумму заказа меньше, чем сегодня.
func TestBalanceHistory_RollsBackFromCurrentBalance(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	_, menuItemID, shiftID, accountID := seedForWrite(t, f)

	today := time.Now().UTC().Format("2006-01-02")
	yesterday := time.Now().UTC().AddDate(0, 0, -1).Format("2006-01-02")

	before := balanceOn(t, f, tok, yesterday, today, accountID, today)

	// 4 × 25 = 100 приходит на счёт.
	orderID := auditCreateOrder(t, f, tok, menuItemID, "4")
	if r, b := f.post(t, "/api/v1/orders/"+orderID+"/close", tok, uuid.NewString(), map[string]any{
		"payment_method": "cash", "account_id": accountID, "shift_id": shiftID,
	}); r.StatusCode != http.StatusOK {
		t.Fatalf("close: %d %s", r.StatusCode, b)
	}

	afterToday := balanceOn(t, f, tok, yesterday, today, accountID, today)
	afterYesterday := balanceOn(t, f, tok, yesterday, today, accountID, yesterday)

	if got := afterToday - before; got != 100 {
		t.Fatalf("остаток на сегодня вырос на %v, ожидали 100", got)
	}
	// Вчерашний день заказ не трогал — остаток на конец вчера должен остаться
	// тем, что был до закрытия заказа.
	if afterYesterday != before {
		t.Fatalf("остаток на конец вчера = %v, ожидали %v (сегодняшняя операция не должна его двигать)",
			afterYesterday, before)
	}
}

// TestBalanceHistory_PeriodSummary — движение за период и остаток на начало.
func TestBalanceHistory_PeriodSummary(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	_, menuItemID, shiftID, accountID := seedForWrite(t, f)

	today := time.Now().UTC().Format("2006-01-02")
	orderID := auditCreateOrder(t, f, tok, menuItemID, "2") // 50
	if r, b := f.post(t, "/api/v1/orders/"+orderID+"/close", tok, uuid.NewString(), map[string]any{
		"payment_method": "cash", "account_id": accountID, "shift_id": shiftID,
	}); r.StatusCode != http.StatusOK {
		t.Fatalf("close: %d %s", r.StatusCode, b)
	}

	hist := fetchHistory(t, f, tok, today, today)
	for _, a := range hist.Accounts {
		if a.AccountID != accountID {
			continue
		}
		in := mustFloat(t, a.In)
		opening := mustFloat(t, a.Opening)
		closing := mustFloat(t, a.Closing)
		if in < 50 {
			t.Fatalf("приход за период = %v, ожидали минимум 50", in)
		}
		// Инвариант: остаток на начало + приход − расход = остаток на конец.
		out := mustFloat(t, a.Out)
		if got := opening + in - out; got != closing {
			t.Fatalf("opening(%v) + in(%v) − out(%v) = %v, а closing = %v", opening, in, out, got, closing)
		}
		return
	}
	t.Fatalf("счёт %s не найден в отчёте", accountID)
}

type histResp struct {
	Accounts []struct {
		AccountID string          `json:"account_id"`
		Opening   json.RawMessage `json:"opening_balance"`
		In        json.RawMessage `json:"in"`
		Out       json.RawMessage `json:"out"`
		Closing   json.RawMessage `json:"closing_balance"`
	} `json:"accounts"`
	Days []struct {
		Date       string                     `json:"date"`
		PerAccount map[string]json.RawMessage `json:"per_account"`
	} `json:"days"`
}

func fetchHistory(t *testing.T, f *e2eFixture, tok, from, to string) histResp {
	t.Helper()
	r, b := f.get(t, "/api/v1/finance/accounts/balance-history?from="+from+"&to="+to, tok)
	if r.StatusCode != http.StatusOK {
		t.Fatalf("balance-history: %d %s", r.StatusCode, b)
	}
	var out histResp
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatalf("unmarshal: %v — %s", err, b)
	}
	return out
}

// balanceOn — остаток конкретного счёта на конец дня `day`.
func balanceOn(t *testing.T, f *e2eFixture, tok, from, to, accountID, day string) float64 {
	t.Helper()
	h := fetchHistory(t, f, tok, from, to)
	for _, d := range h.Days {
		if d.Date != day {
			continue
		}
		raw, ok := d.PerAccount[accountID]
		if !ok {
			t.Fatalf("счёта %s нет в дне %s", accountID, day)
		}
		return mustFloat(t, raw)
	}
	t.Fatalf("день %s не найден в ответе", day)
	return 0
}

// mustFloat — Decimal сериализуется строкой или числом в зависимости от типа.
func mustFloat(t *testing.T, raw json.RawMessage) float64 {
	t.Helper()
	var f float64
	if err := json.Unmarshal(raw, &f); err == nil {
		return f
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		t.Fatalf("не число и не строка: %s", raw)
	}
	parsed, err := strconv.ParseFloat(s, 64)
	if err != nil {
		t.Fatalf("не парсится как число: %q", s)
	}
	return parsed
}
