package http_test

// Защитник №3: контракт-тест body-shapes из фронта против Go-Input DTO.
//
// Идея: захардкодить точные JSON-строки, которые отправляет фронт
// (lib/queries/*.ts), и попробовать декодировать их в Input-структуры
// сервиса с DisallowUnknownFields. Если фронт начнёт слать лишнее поле
// (как было с `cancelled_by` в v2.0.36) — тест упадёт ДО прода.
//
// Это НЕ e2e: тут нет http-сервера, БД и tenant'а. Только проверка
// shape'а JSON ↔ Go-struct. Дёшево, быстро, надёжно.
//
// Когда добавлять кейс: всякий раз, когда фронт начинает слать новый
// body на новый endpoint — закрепляем shape здесь.

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/restos/restos-v4/server/internal/service"
)

// decodeStrict — парсит JSON в out с запретом лишних полей.
// Возвращает err, если в body есть поле, которого нет в out.
func decodeStrict(t *testing.T, body string, out interface{}) error {
	t.Helper()
	dec := json.NewDecoder(strings.NewReader(body))
	dec.DisallowUnknownFields()
	return dec.Decode(out)
}

// TestContract_CancelOrder — POST /api/v1/orders/{id}/cancel.
//
// Историческая важность: до v2.0.38 фронт слал {"reason":"...","cancelled_by":"..."}.
// Бэкенд CancelOrderInput имеет ТОЛЬКО Reason. С DisallowUnknownFields
// (которое выставлено в idempotency middleware) бэк отвергал бы запрос на
// runtime. Этот тест ловит регрессию в обе стороны.
func TestContract_CancelOrder(t *testing.T) {
	body := `{"reason":"manual"}`
	var in service.CancelOrderInput
	if err := decodeStrict(t, body, &in); err != nil {
		t.Fatalf("decode failed: %v", err)
	}
	if in.Reason != "manual" {
		t.Errorf("expected reason=manual, got %q", in.Reason)
	}
}

// TestContract_VoidItem — POST /api/v1/orders/{id}/items/{itemId}/void.
func TestContract_VoidItem(t *testing.T) {
	body := `{"reason":"manual","approved_by":"00000000-0000-0000-0000-000000000001"}`
	var in service.VoidItemInput
	if err := decodeStrict(t, body, &in); err != nil {
		t.Fatalf("decode failed: %v", err)
	}
	if in.Reason != "manual" {
		t.Errorf("reason: %q", in.Reason)
	}
	if in.ApprovedBy == "" {
		t.Errorf("approved_by empty")
	}
}

// TestContract_CreateOrder — POST /api/v1/orders.
// Покрывает базовый shape без override'ов snapshot'а.
func TestContract_CreateOrder(t *testing.T) {
	body := `{
		"table_id": "11111111-1111-1111-1111-111111111111",
		"type": "hall",
		"guests_count": 2,
		"shift_id": "22222222-2222-2222-2222-222222222222",
		"comment": null,
		"items": [
			{
				"menu_item_id": "33333333-3333-3333-3333-333333333333",
				"qty": "1",
				"modifier_ids": []
			}
		]
	}`
	var in service.CreateOrderInput
	if err := decodeStrict(t, body, &in); err != nil {
		t.Fatalf("decode failed: %v", err)
	}
	if in.Type != "hall" {
		t.Errorf("type: %q", in.Type)
	}
	if len(in.Items) != 1 {
		t.Fatalf("items: %d", len(in.Items))
	}
}

// TestContract_CreateOrder_WithOverrides — фронт может слать override'ы
// snapshot'а цены/имени/cogs/modifiers. Проверяем что shape принимается.
func TestContract_CreateOrder_WithOverrides(t *testing.T) {
	body := `{
		"type": "takeaway",
		"table_id": null,
		"guests_count": null,
		"comment": "tab #5",
		"shift_id": null,
		"items": [
			{
				"menu_item_id": "33333333-3333-3333-3333-333333333333",
				"qty": "2.5",
				"modifier_ids": ["aaa"],
				"name": "Custom",
				"price": "10.00",
				"unit": "kg",
				"unit_size": "1",
				"cogs": "3.00",
				"modifiers": [
					{"modifier_id": "aaa", "name": "Extra cheese", "price": "1.50"}
				]
			}
		]
	}`
	var in service.CreateOrderInput
	if err := decodeStrict(t, body, &in); err != nil {
		t.Fatalf("decode failed: %v", err)
	}
}

// TestContract_AddItems — POST /api/v1/orders/{id}/items.
func TestContract_AddItems(t *testing.T) {
	body := `{
		"items": [
			{
				"menu_item_id": "33333333-3333-3333-3333-333333333333",
				"qty": "1",
				"modifier_ids": []
			}
		]
	}`
	var in service.AddItemsInput
	if err := decodeStrict(t, body, &in); err != nil {
		t.Fatalf("decode failed: %v", err)
	}
	if len(in.Items) != 1 {
		t.Fatalf("items: %d", len(in.Items))
	}
}

// TestContract_CloseOrder — POST /api/v1/orders/{id}/close.
// Минимальный body (cash, single account, без скидки и tip).
func TestContract_CloseOrder(t *testing.T) {
	body := `{
		"payment_method": "cash",
		"account_id": "44444444-4444-4444-4444-444444444444",
		"shift_id": "22222222-2222-2222-2222-222222222222"
	}`
	var in service.CloseOrderInput
	if err := decodeStrict(t, body, &in); err != nil {
		t.Fatalf("decode failed: %v", err)
	}
	if in.PaymentMethod != "cash" {
		t.Errorf("payment_method: %q", in.PaymentMethod)
	}
}

// TestContract_CloseOrder_Full — полный shape с скидкой, tip, service%,
// cashier_id и split payments. Это то, что фронт отправляет на «сложных»
// закрытиях (см. lib/queries/orders.ts closeOrderWithPayment).
func TestContract_CloseOrder_Full(t *testing.T) {
	body := `{
		"payment_method": "cash",
		"account_id": "44444444-4444-4444-4444-444444444444",
		"shift_id": "22222222-2222-2222-2222-222222222222",
		"tip_amount": "5.00",
		"cashier_id": "55555555-5555-5555-5555-555555555555",
		"discount_type": "percent",
		"discount_value": "10",
		"discount_reason": "loyalty",
		"service_percent": "0",
		"payments": [
			{"method": "cash", "amount": "50.00", "account_id": "44444444-4444-4444-4444-444444444444"},
			{"method": "card", "amount": "30.00", "account_id": "66666666-6666-6666-6666-666666666666"}
		]
	}`
	var in service.CloseOrderInput
	if err := decodeStrict(t, body, &in); err != nil {
		t.Fatalf("decode failed: %v", err)
	}
	if len(in.Payments) != 2 {
		t.Errorf("payments: %d", len(in.Payments))
	}
}

// TestContract_SetItemNote — PATCH /api/v1/orders/{id}/items/{itemId}/note.
func TestContract_SetItemNote(t *testing.T) {
	body := `{"note":"без лука"}`
	var in service.SetItemNoteInput
	if err := decodeStrict(t, body, &in); err != nil {
		t.Fatalf("decode failed: %v", err)
	}
	if in.Note == nil || *in.Note != "без лука" {
		t.Errorf("note: %v", in.Note)
	}
}

// TestContract_SetItemNote_Null — фронт может прислать null чтобы очистить.
func TestContract_SetItemNote_Null(t *testing.T) {
	body := `{"note":null}`
	var in service.SetItemNoteInput
	if err := decodeStrict(t, body, &in); err != nil {
		t.Fatalf("decode failed: %v", err)
	}
	if in.Note != nil {
		t.Errorf("expected nil, got %v", *in.Note)
	}
}

// TestContract_SplitEqual — POST /api/v1/orders/{id}/splits/equal.
// Фронт отправляет {"count": N}. Раньше было num_splits — теперь count.
func TestContract_SplitEqual(t *testing.T) {
	body := `{"count":2}`
	var in service.SplitEqualInput
	if err := decodeStrict(t, body, &in); err != nil {
		t.Fatalf("decode failed: %v", err)
	}
	if in.Count != 2 {
		t.Errorf("count: %d", in.Count)
	}
}

// ─── Регрессионные кейсы: ловим расхождения, которые уже были в проде ──

// TestContract_CancelOrder_RejectsCancelledBy — багфикс v2.0.38.
// Фронт раньше слал {"reason":"...","cancelled_by":"..."}, бэк отвергал.
// Тест гарантирует, что бэк продолжит отвергать лишнее поле, и фронт
// больше не пытается его слать. Если кто-то добавит CancelledBy в
// CancelOrderInput без обсуждения — тест упадёт с "expected error".
func TestContract_CancelOrder_RejectsCancelledBy(t *testing.T) {
	body := `{"reason":"manual","cancelled_by":"00000000-0000-0000-0000-000000000001"}`
	var in service.CancelOrderInput
	err := decodeStrict(t, body, &in)
	if err == nil {
		t.Fatalf("expected error for unknown field cancelled_by, got nil; " +
			"если поле теперь поддерживается — обнови этот тест И lib/queries/orders.ts cancelOrder()")
	}
	if !strings.Contains(err.Error(), "cancelled_by") {
		t.Errorf("expected error mentioning 'cancelled_by', got: %v", err)
	}
}
