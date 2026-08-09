//go:build integration

package http_test

import (
	"net/http"
	"testing"

	"github.com/google/uuid"
)

// TestRefund_PrintsKitchenCancelRunner — возврат закрытого заказа печатает
// кухонный «ОТМЕНА» (как отмена): повар должен узнать, что блюда вернули.
// Запрос владельца. enqueueCancelRunners печатает только то, что кухня видела
// (printed_at), и НЕ трогает склад/выручку.
func TestRefund_PrintsKitchenCancelRunner(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	_, menuItemID, shiftID, accountID := seedForWrite(t, f)

	// Зал со столами (дефолт) → бегунок уходит на кухню сразу при создании,
	// значит у позиций проставлен printed_at.
	orderID := auditCreateOrder(t, f, tok, menuItemID, "2")
	if r, b := f.post(t, "/api/v1/orders/"+orderID+"/close", tok, uuid.NewString(), map[string]any{
		"payment_method": "cash", "account_id": accountID, "shift_id": shiftID,
	}); r.StatusCode != http.StatusOK {
		t.Fatalf("close: %d %s", r.StatusCode, b)
	}

	before := countCancelRunners(t, f, tok)

	// Полный возврат.
	if r, b := f.post(t, "/api/v1/orders/"+orderID+"/refund", tok, uuid.NewString(), map[string]any{
		"reason": "клиент вернул заказ",
	}); r.StatusCode != http.StatusOK {
		t.Fatalf("refund: %d %s", r.StatusCode, b)
	}

	if got := countCancelRunners(t, f, tok); got <= before {
		t.Fatalf("заданий «ОТМЕНА» после возврата = %d, было %d — кухня обязана узнать о возврате", got, before)
	}
}
