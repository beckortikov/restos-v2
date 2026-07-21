//go:build integration

package http_test

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/google/uuid"
)

// TestClose_SinglePayment_PersistsAccount — одиночная оплата должна оставлять
// на заказе состав оплаты вместе со счётом.
//
// Раньше при обычной (не смешанной) оплате сохранялся только payment_method:
// счёт нигде на заказе не оставался (колонки orders.account_id нет), он жил
// исключительно в financial_operations. Из-за этого список закрытых заказов
// не мог показать, КУДА ушли деньги, а чек печатал «Оплата: —».
func TestClose_SinglePayment_PersistsAccount(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	_, menuItemID, shiftID, accountID := seedForWrite(t, f)

	orderID := auditCreateOrder(t, f, tok, menuItemID, "4")
	if r, b := f.post(t, "/api/v1/orders/"+orderID+"/close", tok, uuid.NewString(), map[string]any{
		"payment_method": "cash", "account_id": accountID, "shift_id": shiftID,
	}); r.StatusCode != http.StatusOK {
		t.Fatalf("close: %d %s", r.StatusCode, b)
	}

	r, b := f.get(t, "/api/v1/orders/"+orderID, tok)
	if r.StatusCode != http.StatusOK {
		t.Fatalf("get order: %d %s", r.StatusCode, b)
	}
	var detail struct {
		Order struct {
			PaymentMethod string `json:"payment_method"`
			Payments      []struct {
				Method      string `json:"method"`
				AccountID   string `json:"account_id"`
				AccountName string `json:"account_name"`
			} `json:"payments"`
		} `json:"order"`
	}
	if err := json.Unmarshal(b, &detail); err != nil {
		t.Fatalf("unmarshal: %v — %s", err, b)
	}

	if detail.Order.PaymentMethod != "cash" {
		t.Fatalf("payment_method = %q, want cash", detail.Order.PaymentMethod)
	}
	if len(detail.Order.Payments) != 1 {
		t.Fatalf("payments = %d, want 1 (одиночная оплата тоже пишется в payments): %s",
			len(detail.Order.Payments), b)
	}
	p := detail.Order.Payments[0]
	if p.Method != "cash" {
		t.Fatalf("payments[0].method = %q, want cash", p.Method)
	}
	if p.AccountID != accountID {
		t.Fatalf("payments[0].account_id = %q, want %q", p.AccountID, accountID)
	}
	if p.AccountName == "" {
		t.Fatal("payments[0].account_name пустой — имя счёта должно денормализоваться на момент оплаты")
	}
}

// TestOrdersList_ExposesPayment — способ оплаты должен доезжать до СПИСКА
// заказов, а не только до детальки: история закрытых чеков грузится списком,
// и без этих полей колонка «Оплата» всегда показывала «—».
func TestOrdersList_ExposesPayment(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	_, menuItemID, shiftID, accountID := seedForWrite(t, f)

	orderID := auditCreateOrder(t, f, tok, menuItemID, "2")
	if r, b := f.post(t, "/api/v1/orders/"+orderID+"/close", tok, uuid.NewString(), map[string]any{
		"payment_method": "card", "account_id": accountID, "shift_id": shiftID,
	}); r.StatusCode != http.StatusOK {
		t.Fatalf("close: %d %s", r.StatusCode, b)
	}

	r, b := f.get(t, "/api/v1/orders?status=closed", tok)
	if r.StatusCode != http.StatusOK {
		t.Fatalf("list: %d %s", r.StatusCode, b)
	}
	var env struct {
		Data []struct {
			ID            string `json:"id"`
			PaymentMethod string `json:"payment_method"`
			Payments      []struct {
				Method      string `json:"method"`
				AccountName string `json:"account_name"`
			} `json:"payments"`
		} `json:"data"`
	}
	if err := json.Unmarshal(b, &env); err != nil {
		t.Fatalf("unmarshal: %v — %s", err, b)
	}

	var found bool
	for _, o := range env.Data {
		if o.ID != orderID {
			continue
		}
		found = true
		if o.PaymentMethod != "card" {
			t.Fatalf("slim payment_method = %q, want card", o.PaymentMethod)
		}
		if len(o.Payments) != 1 || o.Payments[0].AccountName == "" {
			t.Fatalf("slim payments не содержит счёт: %+v", o.Payments)
		}
	}
	if !found {
		t.Fatalf("закрытый заказ %s не найден в списке: %s", orderID, b)
	}
}
