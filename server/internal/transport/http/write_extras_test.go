//go:build integration

package http_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// Дополнительные write-flows: shifts open/close/operations, order cancel,
// item void, stock receipt/writeoff, concurrency smoke.

func TestWrite_ShiftsOpenCloseOperations(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)

	// Open shift.
	resp, body := f.post(t, "/api/v1/shifts", tok, uuid.NewString(),
		map[string]any{"opening_balance": "1000"})
	if resp.StatusCode != 201 {
		t.Fatalf("open %d: %s", resp.StatusCode, body)
	}
	var shift models.CashShift
	_ = json.Unmarshal(body, &shift)
	if !shift.OpeningBalance.Equal(decimal.MustFromString("1000")) {
		t.Errorf("opening_balance mismatch: %s", shift.OpeningBalance.String())
	}

	// Second open → CONFLICT.
	resp2, _ := f.post(t, "/api/v1/shifts", tok, uuid.NewString(),
		map[string]any{"opening_balance": "500"})
	if resp2.StatusCode != 409 {
		t.Errorf("double open expected 409, got %d", resp2.StatusCode)
	}

	// Add cash_in.
	opPath := fmt.Sprintf("/api/v1/shifts/%s/operations", shift.ID)
	resp3, b3 := f.post(t, opPath, tok, uuid.NewString(),
		map[string]any{"type": "cash_in", "amount": "200", "description": "размен"})
	if resp3.StatusCode != 201 {
		t.Fatalf("op %d: %s", resp3.StatusCode, b3)
	}

	// Close: expected = 1000 + 0 (revenue) + 200 = 1200. Кладём 1180 (расхождение -20).
	closePath := fmt.Sprintf("/api/v1/shifts/%s/close", shift.ID)
	resp4, b4 := f.post(t, closePath, tok, uuid.NewString(),
		map[string]any{"closing_balance": "1180"})
	if resp4.StatusCode != 200 {
		t.Fatalf("close %d: %s", resp4.StatusCode, b4)
	}
	var closed models.CashShift
	_ = json.Unmarshal(b4, &closed)
	if closed.ExpectedCash == nil || !closed.ExpectedCash.Equal(decimal.MustFromString("1200")) {
		t.Errorf("expected_cash = %v, want 1200", closed.ExpectedCash)
	}
	if !closed.ClosingBalance.Equal(decimal.MustFromString("1180")) {
		t.Errorf("closing_balance = %s, want 1180", closed.ClosingBalance.String())
	}

	// Cancel-after-close → 409.
	resp5, _ := f.post(t, closePath, tok, uuid.NewString(),
		map[string]any{"closing_balance": "1180"})
	if resp5.StatusCode != 409 {
		t.Errorf("close-closed expected 409, got %d", resp5.StatusCode)
	}
}

func TestWrite_CancelOrderAndVoidItem(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	_, menuItemID, _, _ := seedForWrite(t, f)

	// Create order with 2 items.
	resp, body := f.post(t, "/api/v1/orders", tok, uuid.NewString(), map[string]any{
		"items": []map[string]any{
			{"menu_item_id": menuItemID, "qty": "1"},
			{"menu_item_id": menuItemID, "qty": "1"},
		},
	})
	if resp.StatusCode != 201 {
		t.Fatalf("create %d: %s", resp.StatusCode, body)
	}
	var order models.Order
	_ = json.Unmarshal(body, &order)

	// Get detail to fetch item ids.
	getResp, getBody := f.get(t, "/api/v1/orders/"+order.ID, tok)
	if getResp.StatusCode != 200 {
		t.Fatalf("get %d", getResp.StatusCode)
	}
	var detail struct {
		Order models.Order `json:"order"`
		Items []struct {
			ID string `json:"id"`
		} `json:"items"`
	}
	_ = json.Unmarshal(getBody, &detail)
	if len(detail.Items) != 2 {
		t.Fatalf("want 2 items, got %d", len(detail.Items))
	}
	itemA := detail.Items[0].ID

	// Void item A.
	voidPath := fmt.Sprintf("/api/v1/orders/%s/items/%s/void", order.ID, itemA)
	resp2, body2 := f.post(t, voidPath, tok, uuid.NewString(),
		map[string]any{"reason": "ошибка пробивки", "approved_by": "manager-1"})
	if resp2.StatusCode != 200 {
		t.Fatalf("void %d: %s", resp2.StatusCode, body2)
	}

	// После void: order.total = 25 (только один item остался).
	gr, gb := f.get(t, "/api/v1/orders/"+order.ID, tok)
	if gr.StatusCode != 200 {
		t.Fatalf("get after void %d", gr.StatusCode)
	}
	var detail2 struct {
		Order models.Order `json:"order"`
	}
	_ = json.Unmarshal(gb, &detail2)
	if !detail2.Order.Total.Equal(decimal.MustFromString("25")) {
		t.Errorf("after void total = %s, want 25", detail2.Order.Total.String())
	}

	// Cancel whole order.
	cancelPath := fmt.Sprintf("/api/v1/orders/%s/cancel", order.ID)
	resp3, body3 := f.post(t, cancelPath, tok, uuid.NewString(),
		map[string]any{"reason": "клиент отказался"})
	if resp3.StatusCode != 200 {
		t.Fatalf("cancel %d: %s", resp3.StatusCode, body3)
	}

	// Double cancel → 409.
	resp4, _ := f.post(t, cancelPath, tok, uuid.NewString(),
		map[string]any{"reason": "ещё раз"})
	if resp4.StatusCode != 409 {
		t.Errorf("double cancel expected 409, got %d", resp4.StatusCode)
	}
}

func TestWrite_StockReceipt(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, _, _ := seedForWrite(t, f)

	// Найдём ingredient_id (создан seedForWrite).
	var ing models.Ingredient
	if err := gdb.Where("restaurant_id = ?", f.rid).First(&ing).Error; err != nil {
		t.Fatal(err)
	}

	resp, body := f.post(t, "/api/v1/stock/receipts", tok, uuid.NewString(),
		map[string]any{
			"supplier_name": "Test Supplier",
			"payment_type":  "paid",
			"lines": []map[string]any{
				{
					"ingredient_id":  ing.ID,
					"name":           "Rice",
					"qty":            "10",
					"price_per_unit": "5",
				},
			},
		})
	if resp.StatusCode != 201 {
		t.Fatalf("receipt %d: %s", resp.StatusCode, body)
	}
	var receipt models.StockReceipt
	_ = json.Unmarshal(body, &receipt)
	if !receipt.TotalAmount.Equal(decimal.MustFromString("50")) {
		t.Errorf("total_amount = %s, want 50", receipt.TotalAmount.String())
	}
	if !receipt.PaidAmount.Equal(decimal.MustFromString("50")) {
		t.Errorf("paid_amount = %s, want 50 (paid type → auto-fill)", receipt.PaidAmount.String())
	}

	// Проверяем stock_movement создан с positive qty.
	var mv models.StockMovement
	if err := gdb.Where("description = ?", "receipt:"+receipt.ID).First(&mv).Error; err != nil {
		t.Fatal(err)
	}
	if !mv.Qty.Equal(decimal.MustFromString("10")) {
		t.Errorf("movement qty = %s, want +10", mv.Qty.String())
	}
}

// TestWrite_ConcurrencyOrders — критичный тест для PRD acceptance.
//
// 50 параллельных POST /orders. Все должны успешно создаться, без дублей,
// без race-conditions на уровне БД (например, дубликаты по order_number SERIAL).
func TestWrite_ConcurrencyOrders(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	_, menuItemID, _, _ := seedForWrite(t, f)

	const N = 50
	var wg sync.WaitGroup
	var ok atomic.Int32
	var fail atomic.Int32
	ids := make([]string, N)

	var firstFailMu sync.Mutex
	var firstFail string
	for i := 0; i < N; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			resp, body := f.post(t, "/api/v1/orders", tok, uuid.NewString(),
				map[string]any{
					"items": []map[string]any{{"menu_item_id": menuItemID, "qty": "1"}},
				})
			if resp.StatusCode != 201 {
				fail.Add(1)
				firstFailMu.Lock()
				if firstFail == "" {
					firstFail = fmt.Sprintf("status=%d body=%s", resp.StatusCode, body)
				}
				firstFailMu.Unlock()
				return
			}
			var o models.Order
			if err := json.Unmarshal(body, &o); err != nil {
				fail.Add(1)
				return
			}
			ids[i] = o.ID
			ok.Add(1)
		}(i)
	}
	wg.Wait()

	if ok.Load() != N {
		t.Fatalf("parallel: %d ok, %d failed (want %d ok). First fail: %s", ok.Load(), fail.Load(), N, firstFail)
	}
	uniq := make(map[string]bool, N)
	for _, id := range ids {
		if id == "" || uniq[id] {
			t.Fatalf("duplicate or empty id detected")
		}
		uniq[id] = true
	}
}

// Подавляем линт unused для http.MethodPost (вдруг не используется).
var _ = http.MethodPost
