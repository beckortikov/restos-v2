//go:build integration

package http_test

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// Z-отчёт: возврат покупателю показывается отдельной строкой (refunds_total /
// refunds_count) и НЕ задваивается в expenses_total — кассовое зеркало возврата
// исключено из «Расходов». При этом возврат остаётся операцией смены (cash_out),
// а сырая метка авто-зеркала «__auto_mirror__» в категории расходов не светится.
func TestZReport_Refunds_SeparateLine_NotInExpenses(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, menuItemID, shiftID, accountID := seedForWrite(t, f)

	// Привязываем смену к кассовому счёту — иначе зеркало возврата (cash_out) не
	// создаётся, и мы не проверим исключение из расходов.
	if err := gdb.Model(&models.CashShift{}).Where("id = ?", shiftID).
		Update("account_id", accountID).Error; err != nil {
		t.Fatal(err)
	}

	orderID := auditCreateOrder(t, f, tok, menuItemID, "4") // 4 × 25 = 100
	if r, b := f.post(t, "/api/v1/orders/"+orderID+"/close", tok, uuid.NewString(), map[string]any{
		"payment_method": "cash", "account_id": accountID, "shift_id": shiftID,
	}); r.StatusCode != http.StatusOK {
		t.Fatalf("close: %d %s", r.StatusCode, b)
	}

	// Частичный возврат 30 наличными.
	if r, b := f.post(t, "/api/v1/orders/"+orderID+"/refund", tok, uuid.NewString(), map[string]any{
		"reason": "брак", "amount": "30",
	}); r.StatusCode != http.StatusOK {
		t.Fatalf("refund: %d %s", r.StatusCode, b)
	}

	resp, b := f.get(t, "/api/v1/shifts/"+shiftID+"/zreport", tok)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("zreport: %d %s", resp.StatusCode, b)
	}
	var rep struct {
		ExpensesTotal      decimal.Decimal `json:"expenses_total"`
		ExpensesByCategory []struct {
			Category string          `json:"category"`
			Amount   decimal.Decimal `json:"amount"`
		} `json:"expenses_by_category"`
		RefundsTotal decimal.Decimal `json:"refunds_total"`
		RefundsCount int             `json:"refunds_count"`
		Operations   []struct {
			Type        *string `json:"type"`
			Description *string `json:"description"`
		} `json:"operations"`
	}
	if err := json.Unmarshal(b, &rep); err != nil {
		t.Fatal(err)
	}

	// Отдельная строка «Возвраты».
	if !rep.RefundsTotal.Equal(decimal.MustFromString("30")) {
		t.Errorf("refunds_total = %s, want 30", decimal.Normalize(rep.RefundsTotal).String())
	}
	if rep.RefundsCount != 1 {
		t.Errorf("refunds_count = %d, want 1", rep.RefundsCount)
	}

	// Возврат НЕ попал в расходы (иначе двойной учёт: и в «Расходах», и в «Возвратах»).
	if !decimal.Normalize(rep.ExpensesTotal).IsZero() {
		t.Errorf("expenses_total = %s, want 0 — зеркало возврата не должно попадать в расходы",
			decimal.Normalize(rep.ExpensesTotal).String())
	}

	// Сырую внутреннюю метку авто-зеркала в категориях не показываем.
	for _, c := range rep.ExpensesByCategory {
		if c.Category == "__auto_mirror__" {
			t.Errorf("expenses_by_category содержит сырую метку __auto_mirror__: %+v", c)
		}
	}

	// Возврат отражён как операция смены (cash_out «Возврат заказа #…»).
	foundOp := false
	for _, op := range rep.Operations {
		if op.Type != nil && *op.Type == "cash_out" && op.Description != nil &&
			strings.HasPrefix(*op.Description, "Возврат заказа #") {
			foundOp = true
		}
	}
	if !foundOp {
		t.Errorf("возврат не отражён как операция смены (cash_out «Возврат заказа #…»)")
	}
}
