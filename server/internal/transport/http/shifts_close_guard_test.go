//go:build integration

package http_test

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/db"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// TestShiftClose_BlockedByOpenOrders — смену нельзя закрыть, пока есть
// незакрытые заказы (открытые столы / «с собой»). После их закрытия — можно.
func TestShiftClose_BlockedByOpenOrders(t *testing.T) {
	f := setupE2E(t)
	gdb, _ := db.Open(testDSN())
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})

	// Касса для оплаты/смены.
	cashAccID := uuid.NewString()
	cashName, cashType := "Касса", "cash"
	if err := gdb.Create(&models.FinancialAccount{
		ID: cashAccID, Name: &cashName, Type: &cashType, RestaurantID: &f.rid, Balance: decimal.Zero,
	}).Error; err != nil {
		t.Fatal(err)
	}
	// Меню-позиция.
	plovName := "Плов"
	plov := models.MenuItem{ID: uuid.NewString(), Name: &plovName, Price: decimal.MustFromString("50"), RestaurantID: &f.rid}
	if err := gdb.Create(&plov).Error; err != nil {
		t.Fatal(err)
	}

	tok := f.login(t)

	// Открыть смену.
	r, b := f.post(t, "/api/v1/shifts", tok, uuid.NewString(), map[string]any{"opening_balance": "0", "account_id": cashAccID})
	if r.StatusCode != 201 {
		t.Fatalf("open shift %d: %s", r.StatusCode, b)
	}
	var shift models.CashShift
	_ = json.Unmarshal(b, &shift)

	// Создать заказ (не закрывать) — status 'new', type hall.
	r, b = f.post(t, "/api/v1/orders", tok, uuid.NewString(), map[string]any{
		"items": []map[string]any{{"menu_item_id": plov.ID, "qty": "1"}},
	})
	if r.StatusCode != 201 {
		t.Fatalf("create order %d: %s", r.StatusCode, b)
	}
	var ord models.Order
	_ = json.Unmarshal(b, &ord)

	// ─── Закрытие смены заблокировано ────────────────────────────────────
	cr, cb := f.post(t, fmt.Sprintf("/api/v1/shifts/%s/close", shift.ID), tok, uuid.NewString(), map[string]any{"closing_balance": "0"})
	if cr.StatusCode != 409 {
		t.Fatalf("close shift with open order: got %d, want 409. body=%s", cr.StatusCode, cb)
	}
	if !strings.Contains(string(cb), "Сначала закройте") {
		t.Errorf("message should tell to close orders first, got: %s", cb)
	}

	// ─── Закрываем заказ ─────────────────────────────────────────────────
	or, ob := f.post(t, fmt.Sprintf("/api/v1/orders/%s/close", ord.ID), tok, uuid.NewString(), map[string]any{
		"payment_method": "cash", "account_id": cashAccID, "shift_id": shift.ID,
	})
	if or.StatusCode != 200 {
		t.Fatalf("close order %d: %s", or.StatusCode, ob)
	}

	// ─── Теперь смена закрывается ────────────────────────────────────────
	cr2, cb2 := f.post(t, fmt.Sprintf("/api/v1/shifts/%s/close", shift.ID), tok, uuid.NewString(), map[string]any{"closing_balance": "50"})
	if cr2.StatusCode != 200 {
		t.Fatalf("close shift after closing order: %d %s", cr2.StatusCode, cb2)
	}
}
