//go:build integration

package http_test

import (
	"encoding/json"
	"fmt"
	"testing"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/db/models"
)

// TestPhase16_SplitByItems_WithQty проверяет новую форму input'а
// {groups: [{items: [{order_item_id, qty?}]}]} — частичные qty и распределение.
//
// Схема: создаём заказ из 3 позиций (по qty=1, price=25). Делим:
//   - group[0]: первая позиция с qty=0.5  (line=12.5)
//   - group[1]: первая позиция остаток (qty=0.5) + вторая + третья (line=12.5+25+25=62.5)
//
// Проверяем количество splits, итоговые суммы и что суммарный qty по item1
// не превысил оригинальный.
func TestPhase16_SplitByItems_PartialQty(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	_, menuItemID, _, _ := seedForWrite(t, f)

	// Заказ с 3 позициями (qty=1 каждая, price=25 в seedForWrite).
	orderID, _ := phase13_createOrder(t, f, tok, menuItemID, 3)

	// Получаем item IDs.
	gr, gb := f.get(t, fmt.Sprintf("/api/v1/orders/%s", orderID), tok)
	if gr.StatusCode != 200 {
		t.Fatalf("get order: %d %s", gr.StatusCode, gb)
	}
	var detail struct {
		Items []models.OrderItem `json:"items"`
	}
	_ = json.Unmarshal(gb, &detail)
	if len(detail.Items) != 3 {
		t.Fatalf("expected 3 items, got %d", len(detail.Items))
	}
	item1ID := detail.Items[0].ID
	item2ID := detail.Items[1].ID
	item3ID := detail.Items[2].ID

	// Split по новой схеме: item1 разбит 0.5/0.5, item2/3 целиком во второй группе.
	r, b := f.post(t, fmt.Sprintf("/api/v1/orders/%s/splits/by-items", orderID), tok, uuid.NewString(),
		map[string]any{
			"groups": []map[string]any{
				{"items": []map[string]any{
					{"order_item_id": item1ID, "qty": "0.5"},
				}},
				{"items": []map[string]any{
					{"order_item_id": item1ID, "qty": "0.5"},
					{"order_item_id": item2ID},
					{"order_item_id": item3ID},
				}},
			},
		})
	if r.StatusCode != 200 {
		t.Fatalf("split by-items: %d %s", r.StatusCode, b)
	}
	var sres struct {
		Splits []models.OrderSplit `json:"splits"`
	}
	_ = json.Unmarshal(b, &sres)
	if len(sres.Splits) != 2 {
		t.Fatalf("expected 2 splits, got %d", len(sres.Splits))
	}
	// Split 0: 0.5 * 25 = 12.5
	if got := sres.Splits[0].Total.String(); got != "12.5" {
		t.Errorf("split[0].total = %s, want 12.5", got)
	}
	// Split 1: 0.5*25 + 25 + 25 = 62.5
	if got := sres.Splits[1].Total.String(); got != "62.5" {
		t.Errorf("split[1].total = %s, want 62.5", got)
	}
}

// TestPhase16_SplitByItems_ExceedsQty — попытка разрезать на больше qty, чем
// есть в order_item → VALIDATION.
func TestPhase16_SplitByItems_ExceedsQty(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	_, menuItemID, _, _ := seedForWrite(t, f)

	orderID, _ := phase13_createOrder(t, f, tok, menuItemID, 2)
	_, gb := f.get(t, fmt.Sprintf("/api/v1/orders/%s", orderID), tok)
	var detail struct {
		Items []models.OrderItem `json:"items"`
	}
	_ = json.Unmarshal(gb, &detail)
	item1ID := detail.Items[0].ID
	item2ID := detail.Items[1].ID

	r, _ := f.post(t, fmt.Sprintf("/api/v1/orders/%s/splits/by-items", orderID), tok, uuid.NewString(),
		map[string]any{
			"groups": []map[string]any{
				{"items": []map[string]any{
					{"order_item_id": item1ID, "qty": "2"}, // > item.qty=1
				}},
				{"items": []map[string]any{
					{"order_item_id": item2ID},
				}},
			},
		})
	if r.StatusCode != 400 {
		t.Errorf("expected 400 VALIDATION on qty overflow, got %d", r.StatusCode)
	}
}

// TestPhase16_DeleteCashShiftOperationByID — DELETE /cash-shift-operations/{id}.
func TestPhase16_DeleteCashShiftOperationByID(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)

	// Открываем смену.
	r, b := f.post(t, "/api/v1/shifts", tok, uuid.NewString(), map[string]any{
		"opening_balance": "100",
	})
	if r.StatusCode != 201 {
		t.Fatalf("open shift: %d %s", r.StatusCode, b)
	}
	var shift models.CashShift
	_ = json.Unmarshal(b, &shift)

	// Добавляем cash_in.
	r2, b2 := f.post(t, fmt.Sprintf("/api/v1/shifts/%s/operations", shift.ID), tok, uuid.NewString(),
		map[string]any{"type": "cash_in", "amount": "50", "description": "тест"})
	if r2.StatusCode != 201 {
		t.Fatalf("add op: %d %s", r2.StatusCode, b2)
	}
	var op models.CashShiftOperation
	_ = json.Unmarshal(b2, &op)

	// DELETE по новому пути.
	rd, bd := f.del(t, "/api/v1/cash-shift-operations/"+op.ID, tok, uuid.NewString())
	if rd.StatusCode != 204 {
		t.Fatalf("delete op: %d %s", rd.StatusCode, bd)
	}

	// Повторный DELETE → 404.
	rd2, _ := f.del(t, "/api/v1/cash-shift-operations/"+op.ID, tok, uuid.NewString())
	if rd2.StatusCode != 404 {
		t.Errorf("expected 404 on second delete, got %d", rd2.StatusCode)
	}
}

// TestPhase16_ShiftsEmbedAccountName — GET /shifts возвращает account_name.
func TestPhase16_ShiftsEmbedAccountName(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, shiftID, accountID := seedForWrite(t, f)

	// Привязываем accountID к смене напрямую в БД (seedForWrite этого не делает).
	if err := gdb.Exec(`UPDATE cash_shifts SET account_id = ? WHERE id = ?`,
		accountID, shiftID).Error; err != nil {
		t.Fatal(err)
	}

	// GET /shifts/active → account_name заполнен.
	ra, ba := f.get(t, "/api/v1/shifts/active", tok)
	if ra.StatusCode != 200 {
		t.Fatalf("active: %d %s", ra.StatusCode, ba)
	}
	var active map[string]any
	_ = json.Unmarshal(ba, &active)
	if name, _ := active["account_name"].(string); name != "Main cash" {
		t.Errorf("active.account_name = %v, want 'Main cash'", active["account_name"])
	}

	// GET /shifts (list) → каждая запись имеет account_name.
	rl, bl := f.get(t, "/api/v1/shifts?limit=10", tok)
	if rl.StatusCode != 200 {
		t.Fatalf("list: %d %s", rl.StatusCode, bl)
	}
	var listEnv struct {
		Data []map[string]any `json:"data"`
	}
	_ = json.Unmarshal(bl, &listEnv)
	if len(listEnv.Data) == 0 {
		t.Fatalf("expected at least one shift in list")
	}
	found := false
	for _, row := range listEnv.Data {
		if name, _ := row["account_name"].(string); name == "Main cash" {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("list shifts: no row has account_name='Main cash'")
	}
}

// TestPhase16_GeneratePIN — POST /users/generate-pin returns a unique 4-digit pin.
func TestPhase16_GeneratePIN(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)

	r, b := f.post(t, "/api/v1/users/generate-pin", tok, uuid.NewString(), map[string]any{})
	if r.StatusCode != 200 {
		t.Fatalf("generate-pin: %d %s", r.StatusCode, b)
	}
	var resp struct {
		PIN string `json:"pin"`
	}
	_ = json.Unmarshal(b, &resp)
	if len(resp.PIN) != 4 {
		t.Errorf("pin = %q, want 4 digits", resp.PIN)
	}
}

// TestPhase16_UsersFilterByRestaurant — GET /users?restaurant_id=.
func TestPhase16_UsersFilterByRestaurant(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)

	r, b := f.get(t, "/api/v1/users?restaurant_id="+f.rid, tok)
	if r.StatusCode != 200 {
		t.Fatalf("list: %d %s", r.StatusCode, b)
	}
	var env struct {
		Data []models.User `json:"data"`
	}
	_ = json.Unmarshal(b, &env)
	if len(env.Data) == 0 {
		t.Errorf("expected at least 1 user for this restaurant")
	}
	for _, u := range env.Data {
		if u.RestaurantID == nil || *u.RestaurantID != f.rid {
			t.Errorf("user %s has restaurant_id = %v, want %s", u.ID, u.RestaurantID, f.rid)
		}
	}

	// Random restaurant_id → empty.
	r2, b2 := f.get(t, "/api/v1/users?restaurant_id="+uuid.NewString(), tok)
	if r2.StatusCode != 200 {
		t.Fatalf("list (empty): %d %s", r2.StatusCode, b2)
	}
	var env2 struct {
		Data []models.User `json:"data"`
	}
	_ = json.Unmarshal(b2, &env2)
	if len(env2.Data) != 0 {
		t.Errorf("expected 0 users for random restaurant_id, got %d", len(env2.Data))
	}
}
