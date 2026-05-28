//go:build integration

package http_test

import (
	"encoding/json"
	"fmt"
	"testing"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// ═════════════════════════════════════════════════════════════════════════
// Phase 20 — close_order: discount + multi-payment + cashier_id
// (Backend Gap H1)
// ═════════════════════════════════════════════════════════════════════════

// createOpenOrder — создаёт order с одной позицией price=25, qty=2 → total=50.
// Возвращает orderID и его total для удобства assert'ов.
func createOpenOrder(t *testing.T, f *e2eFixture, tok, menuItemID string, qty string) (string, decimal.Decimal) {
	t.Helper()
	resp, body := f.post(t, "/api/v1/orders", tok, uuid.NewString(), map[string]any{
		"items": []map[string]any{{"menu_item_id": menuItemID, "qty": qty}},
	})
	if resp.StatusCode != 201 {
		t.Fatalf("create order %d: %s", resp.StatusCode, body)
	}
	var created models.Order
	_ = json.Unmarshal(body, &created)
	return created.ID, created.Total
}

// TestPhase20_CloseOrder_FlatPayment — backward compat: один платёж как раньше.
func TestPhase20_CloseOrder_FlatPayment(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, menuItemID, shiftID, accountID := seedForWrite(t, f)

	oid, _ := createOpenOrder(t, f, tok, menuItemID, "2") // total=50
	resp, body := f.post(t, fmt.Sprintf("/api/v1/orders/%s/close", oid), tok, uuid.NewString(), map[string]any{
		"payment_method": "cash",
		"account_id":     accountID,
		"shift_id":       shiftID,
	})
	if resp.StatusCode != 200 {
		t.Fatalf("close %d: %s", resp.StatusCode, body)
	}
	var closed models.Order
	_ = json.Unmarshal(body, &closed)
	if !closed.TotalWithService.Equal(decimal.MustFromString("50")) {
		t.Errorf("total_with_service=%s want 50", closed.TotalWithService.String())
	}
	// Одна financial_operation на 50.
	var fos []models.FinancialOperation
	_ = gdb.Where("source_ref = ?", "order:"+oid).Find(&fos).Error
	if len(fos) != 1 {
		t.Fatalf("want 1 financial_operation, got %d", len(fos))
	}
	if !fos[0].Amount.Equal(decimal.MustFromString("50")) {
		t.Errorf("op amount=%s want 50", fos[0].Amount.String())
	}
}

// TestPhase20_CloseOrder_WithDiscount_Percent — 10% от 50 = 5 → discountedTotal=45.
func TestPhase20_CloseOrder_WithDiscount_Percent(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, menuItemID, shiftID, accountID := seedForWrite(t, f)

	oid, _ := createOpenOrder(t, f, tok, menuItemID, "2") // total=50

	reason := "VIP"
	resp, body := f.post(t, fmt.Sprintf("/api/v1/orders/%s/close", oid), tok, uuid.NewString(), map[string]any{
		"payment_method":  "cash",
		"account_id":      accountID,
		"shift_id":        shiftID,
		"discount_type":   "percent",
		"discount_value":  "10",
		"discount_reason": reason,
	})
	if resp.StatusCode != 200 {
		t.Fatalf("close %d: %s", resp.StatusCode, body)
	}
	var closed models.Order
	_ = json.Unmarshal(body, &closed)
	if !closed.DiscountAmount.Equal(decimal.MustFromString("5")) {
		t.Errorf("discount_amount=%s want 5", closed.DiscountAmount.String())
	}
	if !closed.TotalWithService.Equal(decimal.MustFromString("45")) {
		t.Errorf("total_with_service=%s want 45", closed.TotalWithService.String())
	}
	if closed.DiscountType == nil || *closed.DiscountType != "percent" {
		t.Errorf("discount_type not persisted")
	}
	if closed.DiscountReason == nil || *closed.DiscountReason != "VIP" {
		t.Errorf("discount_reason not persisted")
	}
	// FinOp = 45.
	var fos []models.FinancialOperation
	_ = gdb.Where("source_ref = ?", "order:"+oid).Find(&fos).Error
	if len(fos) != 1 || !fos[0].Amount.Equal(decimal.MustFromString("45")) {
		t.Fatalf("want 1 op amount=45, got len=%d", len(fos))
	}
	// Shift.cash_revenue = 45.
	var sh models.CashShift
	_ = gdb.First(&sh, "id = ?", shiftID).Error
	if !sh.CashRevenue.Equal(decimal.MustFromString("45")) {
		t.Errorf("shift.cash_revenue=%s want 45", sh.CashRevenue.String())
	}
}

// TestPhase20_CloseOrder_WithDiscount_Fixed — фиксированная скидка 7 от 50.
func TestPhase20_CloseOrder_WithDiscount_Fixed(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, menuItemID, shiftID, accountID := seedForWrite(t, f)

	oid, _ := createOpenOrder(t, f, tok, menuItemID, "2")
	resp, body := f.post(t, fmt.Sprintf("/api/v1/orders/%s/close", oid), tok, uuid.NewString(), map[string]any{
		"payment_method": "card",
		"account_id":     accountID,
		"shift_id":       shiftID,
		"discount_type":  "fixed",
		"discount_value": "7",
	})
	if resp.StatusCode != 200 {
		t.Fatalf("close %d: %s", resp.StatusCode, body)
	}
	var closed models.Order
	_ = json.Unmarshal(body, &closed)
	if !closed.TotalWithService.Equal(decimal.MustFromString("43")) {
		t.Errorf("total_with_service=%s want 43", closed.TotalWithService.String())
	}
	var sh models.CashShift
	_ = gdb.First(&sh, "id = ?", shiftID).Error
	if !sh.CardRevenue.Equal(decimal.MustFromString("43")) {
		t.Errorf("shift.card_revenue=%s want 43", sh.CardRevenue.String())
	}
}

// TestPhase20_CloseOrder_MultiPayment — cash 25 + card 25 от total 50.
func TestPhase20_CloseOrder_MultiPayment(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, menuItemID, shiftID, accountID := seedForWrite(t, f)

	oid, _ := createOpenOrder(t, f, tok, menuItemID, "2") // total=50
	resp, body := f.post(t, fmt.Sprintf("/api/v1/orders/%s/close", oid), tok, uuid.NewString(), map[string]any{
		"shift_id": shiftID,
		"payments": []map[string]any{
			{"method": "cash", "amount": "25", "account_id": accountID},
			{"method": "card", "amount": "25", "account_id": accountID},
		},
	})
	if resp.StatusCode != 200 {
		t.Fatalf("close %d: %s", resp.StatusCode, body)
	}
	var closed models.Order
	_ = json.Unmarshal(body, &closed)
	if closed.IsSplit == nil || !*closed.IsSplit {
		t.Errorf("is_split should be true")
	}
	if closed.PaymentMethod == nil || *closed.PaymentMethod != "split" {
		t.Errorf("payment_method want 'split', got %v", closed.PaymentMethod)
	}
	// Две financial_operation.
	var fos []models.FinancialOperation
	_ = gdb.Where("source_ref = ?", "order:"+oid).Order("amount DESC").Find(&fos).Error
	if len(fos) != 2 {
		t.Fatalf("want 2 financial_operations, got %d", len(fos))
	}
	sum := decimal.Add(fos[0].Amount, fos[1].Amount)
	if !sum.Equal(decimal.MustFromString("50")) {
		t.Errorf("sum fin_ops=%s want 50", sum.String())
	}
	// Shift counters.
	var sh models.CashShift
	_ = gdb.First(&sh, "id = ?", shiftID).Error
	if !sh.CashRevenue.Equal(decimal.MustFromString("25")) {
		t.Errorf("cash_revenue=%s want 25", sh.CashRevenue.String())
	}
	if !sh.CardRevenue.Equal(decimal.MustFromString("25")) {
		t.Errorf("card_revenue=%s want 25", sh.CardRevenue.String())
	}
	if sh.OrdersCount == nil || *sh.OrdersCount != 1 {
		t.Errorf("orders_count want 1, got %v", sh.OrdersCount)
	}
}

// TestPhase20_CloseOrder_DiscountPlusMultiPayment — 50, скидка 10 fixed → 40,
// сплит cash 20 + card 20.
func TestPhase20_CloseOrder_DiscountPlusMultiPayment(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, menuItemID, shiftID, accountID := seedForWrite(t, f)

	oid, _ := createOpenOrder(t, f, tok, menuItemID, "2") // 50
	resp, body := f.post(t, fmt.Sprintf("/api/v1/orders/%s/close", oid), tok, uuid.NewString(), map[string]any{
		"shift_id":       shiftID,
		"discount_type":  "fixed",
		"discount_value": "10",
		"payments": []map[string]any{
			{"method": "cash", "amount": "20", "account_id": accountID},
			{"method": "card", "amount": "20", "account_id": accountID},
		},
	})
	if resp.StatusCode != 200 {
		t.Fatalf("close %d: %s", resp.StatusCode, body)
	}
	var closed models.Order
	_ = json.Unmarshal(body, &closed)
	if !closed.TotalWithService.Equal(decimal.MustFromString("40")) {
		t.Errorf("total_with_service=%s want 40", closed.TotalWithService.String())
	}
	var fos []models.FinancialOperation
	_ = gdb.Where("source_ref = ?", "order:"+oid).Find(&fos).Error
	if len(fos) != 2 {
		t.Errorf("want 2 fin_ops, got %d", len(fos))
	}
}

// TestPhase20_CloseOrder_BadDiscountType — недопустимый discount_type → 400.
func TestPhase20_CloseOrder_BadDiscountType(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	_, menuItemID, shiftID, accountID := seedForWrite(t, f)

	oid, _ := createOpenOrder(t, f, tok, menuItemID, "2")
	resp, body := f.post(t, fmt.Sprintf("/api/v1/orders/%s/close", oid), tok, uuid.NewString(), map[string]any{
		"payment_method": "cash",
		"account_id":     accountID,
		"shift_id":       shiftID,
		"discount_type":  "absolute", // invalid
		"discount_value": "5",
	})
	if resp.StatusCode != 400 {
		t.Fatalf("want 400, got %d: %s", resp.StatusCode, body)
	}
}

// TestPhase20_CloseOrder_PaymentSumMismatch — sum split != total → 400.
func TestPhase20_CloseOrder_PaymentSumMismatch(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	_, menuItemID, shiftID, accountID := seedForWrite(t, f)

	oid, _ := createOpenOrder(t, f, tok, menuItemID, "2") // 50
	resp, body := f.post(t, fmt.Sprintf("/api/v1/orders/%s/close", oid), tok, uuid.NewString(), map[string]any{
		"shift_id": shiftID,
		"payments": []map[string]any{
			{"method": "cash", "amount": "10", "account_id": accountID},
			{"method": "card", "amount": "20", "account_id": accountID},
		},
	})
	if resp.StatusCode != 400 {
		t.Fatalf("want 400, got %d: %s", resp.StatusCode, body)
	}
}

// TestPhase20_CloseOrder_CashierID_Persisted — cashier_id попадает в order.cashier_id.
func TestPhase20_CloseOrder_CashierID_Persisted(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, menuItemID, shiftID, accountID := seedForWrite(t, f)

	cashierID := uuid.NewString()
	name := "Cashier Maria"
	role := "cashier"
	pin := "9999"
	if err := gdb.Create(&models.User{
		ID: cashierID, Name: &name, PIN: &pin, Role: &role, RestaurantID: &f.rid,
	}).Error; err != nil {
		t.Fatal(err)
	}

	oid, _ := createOpenOrder(t, f, tok, menuItemID, "2")
	resp, body := f.post(t, fmt.Sprintf("/api/v1/orders/%s/close", oid), tok, uuid.NewString(), map[string]any{
		"payment_method": "cash",
		"account_id":     accountID,
		"shift_id":       shiftID,
		"cashier_id":     cashierID,
	})
	if resp.StatusCode != 200 {
		t.Fatalf("close %d: %s", resp.StatusCode, body)
	}
	var ord models.Order
	_ = gdb.First(&ord, "id = ?", oid).Error
	if ord.CashierID == nil || *ord.CashierID != cashierID {
		t.Errorf("cashier_id want %s, got %v", cashierID, ord.CashierID)
	}
}
