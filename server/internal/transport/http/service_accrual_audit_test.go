//go:build integration

package http_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
	"gorm.io/gorm"
)

// ───────────────────────── helpers ─────────────────────────

// loginPIN — логин конкретного пользователя по PIN (актор = этот юзер).
func loginPIN(t *testing.T, f *e2eFixture, pin string) string {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"restaurant_id": f.rid, "pin": pin})
	resp, err := http.Post(f.srv.URL+"/api/v1/auth/login", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("loginPIN %s: %d %s", pin, resp.StatusCode, b)
	}
	var out struct {
		Token string `json:"token"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return out.Token
}

func mkUser(t *testing.T, gdb *gorm.DB, rid, name, role, pin string) string {
	t.Helper()
	id := uuid.NewString()
	u := &models.User{ID: id, Name: &name, Role: &role, RestaurantID: &rid}
	if pin != "" {
		u.PIN = &pin
	}
	if err := gdb.Create(u).Error; err != nil {
		t.Fatal(err)
	}
	return id
}

func mkTable(t *testing.T, gdb *gorm.DB, rid string, num int, waiterID *string) string {
	t.Helper()
	id := uuid.NewString()
	st := "occupied"
	now := time.Now().UTC()
	if err := gdb.Create(&models.Table{ID: id, Number: &num, Status: &st, WaiterID: waiterID, RestaurantID: &rid, CreatedAt: now, UpdatedAt: now}).Error; err != nil {
		t.Fatal(err)
	}
	return id
}

// mkOrder — создаёт заказ напрямую в БД с явным waiter_id + одна позиция qty×price.
func mkOrder(t *testing.T, gdb *gorm.DB, rid, shiftID string, tableID, waiterID *string, servicePct, qty, price string, unit string) string {
	t.Helper()
	now := time.Now().UTC()
	st := "new"
	hall := "hall"
	id := uuid.NewString()
	total := decimal.Normalize(decimal.Mul(decimal.MustFromString(qty), decimal.MustFromString(price)))
	o := &models.Order{
		ID: id, RestaurantID: &rid, TableID: tableID, WaiterID: waiterID,
		Status: &st, Type: &hall, ShiftID: &shiftID,
		ServicePercent: decimal.MustFromString(servicePct),
		Total:          total,
		CreatedAt:      now, UpdatedAt: now,
	}
	if err := gdb.Create(o).Error; err != nil {
		t.Fatal(err)
	}
	dish := "Dish"
	u := unit
	if u == "" {
		u = "piece"
	}
	if err := gdb.Create(&models.OrderItem{
		ID: uuid.NewString(), OrderID: &id, Name: &dish,
		Qty: decimal.MustFromString(qty), Price: decimal.MustFromString(price),
		Unit: &u, UnitSize: decimal.MustFromString("1"), CreatedAt: now, UpdatedAt: now,
	}).Error; err != nil {
		t.Fatal(err)
	}
	return id
}

func closeOrder(t *testing.T, f *e2eFixture, tok, orderID, shiftID, accountID string, extra map[string]any) (int, []byte) {
	t.Helper()
	body := map[string]any{"payment_method": "cash", "account_id": accountID, "shift_id": shiftID}
	for k, v := range extra {
		body[k] = v
	}
	r, b := f.post(t, fmt.Sprintf("/api/v1/orders/%s/close", orderID), tok, uuid.NewString(), body)
	return r.StatusCode, b
}

// accrualMap — map[waiterID] = accrued_amount (строка) из by-waiter отчёта.
func accrualMap(t *testing.T, f *e2eFixture, tok string) map[string]string {
	t.Helper()
	r, b := f.get(t, "/api/v1/finance/service-accrual/by-waiter", tok)
	if r.StatusCode != 200 {
		t.Fatalf("accrual %d: %s", r.StatusCode, b)
	}
	var env struct {
		Data []struct {
			WaiterID      string `json:"waiter_id"`
			AccruedAmount string `json:"accrued_amount"`
		} `json:"data"`
	}
	_ = json.Unmarshal(b, &env)
	out := map[string]string{}
	for _, row := range env.Data {
		out[row.WaiterID] = row.AccruedAmount
	}
	return out
}

func orderWaiter(t *testing.T, gdb *gorm.DB, orderID string) string {
	t.Helper()
	var o models.Order
	if err := gdb.First(&o, "id = ?", orderID).Error; err != nil {
		t.Fatal(err)
	}
	if o.WaiterID == nil {
		return ""
	}
	return *o.WaiterID
}

func ptrS(s string) *string { return &s }

// ───────────────────────── tests ─────────────────────────

// === Группа A: атрибуция при СОЗДАНИИ (кто создал — тому обслуживание) ===

func TestAccrual_CreateByWaiter_GoesToWaiter(t *testing.T) {
	f := setupE2E(t)
	gdb, menuItemID, shiftID, accountID := seedForWrite(t, f)
	wPIN := "5555"
	wID := mkUser(t, gdb, f.rid, "Waiter", "waiter", wPIN)
	tok := loginPIN(t, f, wPIN)
	r, b := f.post(t, "/api/v1/orders", tok, uuid.NewString(), map[string]any{
		"type": "hall", "items": []map[string]any{{"menu_item_id": menuItemID, "qty": "1"}},
	})
	if r.StatusCode != 201 {
		t.Fatalf("create %d: %s", r.StatusCode, b)
	}
	var o models.Order
	_ = json.Unmarshal(b, &o)
	if got := orderWaiter(t, gdb, o.ID); got != wID {
		t.Fatalf("order.waiter_id = %s, want waiter %s", got, wID)
	}
	if sc, cb := closeOrder(t, f, tok, o.ID, shiftID, accountID, map[string]any{"service_percent": "10"}); sc != 200 {
		t.Fatalf("close %d: %s", sc, cb)
	}
	acc := accrualMap(t, f, loginPIN(t, f, wPIN))
	if acc[wID] == "" || acc[wID] == "0" {
		t.Errorf("обслуживание не начислено официанту-создателю: %v", acc)
	}
}

func TestAccrual_CreateByCashier_GoesToCashier(t *testing.T) {
	f := setupE2E(t)
	gdb, menuItemID, shiftID, accountID := seedForWrite(t, f)
	tok := f.login(t) // cashier (PIN 1234)
	// cashier id
	var cashier models.User
	if err := gdb.First(&cashier, "restaurant_id = ? AND role = ?", f.rid, "cashier").Error; err != nil {
		t.Fatal(err)
	}
	r, b := f.post(t, "/api/v1/orders", tok, uuid.NewString(), map[string]any{
		"type": "hall", "items": []map[string]any{{"menu_item_id": menuItemID, "qty": "1"}},
	})
	if r.StatusCode != 201 {
		t.Fatalf("create %d: %s", r.StatusCode, b)
	}
	var o models.Order
	_ = json.Unmarshal(b, &o)
	closeOrder(t, f, tok, o.ID, shiftID, accountID, map[string]any{"service_percent": "10"})
	acc := accrualMap(t, f, tok)
	// ДИАГНОЗ: обслуживание заказа, оформленного кассиром, начисляется кассиру.
	if acc[cashier.ID] == "" {
		t.Errorf("ожидали начисление кассиру (диагноз leak): %v", acc)
	} else {
		t.Logf("DIAG: обслуживание заказа кассира начислено кассиру %s = %s", cashier.ID, acc[cashier.ID])
	}
}

func TestAccrual_TwoWaiters_EachOwn(t *testing.T) {
	f := setupE2E(t)
	gdb, _, shiftID, accountID := seedForWrite(t, f)
	aID := mkUser(t, gdb, f.rid, "Alice", "waiter", "")
	bID := mkUser(t, gdb, f.rid, "Bob", "waiter", "")
	tok := f.login(t)
	oa := mkOrder(t, gdb, f.rid, shiftID, ptrS(mkTable(t, gdb, f.rid, 1, &aID)), &aID, "10", "1", "100", "")
	ob := mkOrder(t, gdb, f.rid, shiftID, ptrS(mkTable(t, gdb, f.rid, 2, &bID)), &bID, "10", "1", "200", "")
	closeOrder(t, f, tok, oa, shiftID, accountID, map[string]any{"service_percent": "10"})
	closeOrder(t, f, tok, ob, shiftID, accountID, map[string]any{"service_percent": "10"})
	acc := accrualMap(t, f, tok)
	if acc[aID] != "10" {
		t.Errorf("Alice accrual = %q, want 10", acc[aID])
	}
	if acc[bID] != "20" {
		t.Errorf("Bob accrual = %q, want 20", acc[bID])
	}
}

// === Группа B: закрытие НЕ двигает waiter ===

func TestAccrual_CloseByCashier_StaysWithWaiter(t *testing.T) {
	f := setupE2E(t)
	gdb, _, shiftID, accountID := seedForWrite(t, f)
	aID := mkUser(t, gdb, f.rid, "Alice", "waiter", "")
	o := mkOrder(t, gdb, f.rid, shiftID, ptrS(mkTable(t, gdb, f.rid, 3, &aID)), &aID, "10", "1", "100", "")
	closeOrder(t, f, f.login(t), o, shiftID, accountID, map[string]any{"service_percent": "10"})
	if w := orderWaiter(t, gdb, o); w != aID {
		t.Errorf("после закрытия waiter = %s, want %s (не должен меняться)", w, aID)
	}
	if accrualMap(t, f, f.login(t))[aID] != "10" {
		t.Errorf("обслуживание должно остаться у Alice")
	}
}

func TestAccrual_MultiGroup_EachKeepsWaiter(t *testing.T) {
	f := setupE2E(t)
	gdb, _, shiftID, accountID := seedForWrite(t, f)
	aID := mkUser(t, gdb, f.rid, "Alice", "waiter", "")
	bID := mkUser(t, gdb, f.rid, "Bob", "waiter", "")
	tableID := mkTable(t, gdb, f.rid, 4, &aID)
	oa := mkOrder(t, gdb, f.rid, shiftID, &tableID, &aID, "10", "1", "100", "")
	ob := mkOrder(t, gdb, f.rid, shiftID, &tableID, &bID, "10", "1", "300", "")
	tok := f.login(t)
	closeOrder(t, f, tok, oa, shiftID, accountID, map[string]any{"service_percent": "10"})
	closeOrder(t, f, tok, ob, shiftID, accountID, map[string]any{"service_percent": "10"})
	acc := accrualMap(t, f, tok)
	if acc[aID] != "10" || acc[bID] != "30" {
		t.Errorf("мульти-группа: Alice=%q (want 10), Bob=%q (want 30)", acc[aID], acc[bID])
	}
}

func TestAccrual_MultiGroup_CloseOne_OtherUnaffected(t *testing.T) {
	f := setupE2E(t)
	gdb, _, shiftID, accountID := seedForWrite(t, f)
	aID := mkUser(t, gdb, f.rid, "Alice", "waiter", "")
	bID := mkUser(t, gdb, f.rid, "Bob", "waiter", "")
	tableID := mkTable(t, gdb, f.rid, 5, &aID)
	oa := mkOrder(t, gdb, f.rid, shiftID, &tableID, &aID, "10", "1", "100", "")
	ob := mkOrder(t, gdb, f.rid, shiftID, &tableID, &bID, "10", "1", "300", "")
	tok := f.login(t)
	closeOrder(t, f, tok, oa, shiftID, accountID, map[string]any{"service_percent": "10"})
	// ob ещё открыт — его waiter не должен измениться.
	if w := orderWaiter(t, gdb, ob); w != bID {
		t.Errorf("открытый заказ Bob изменил waiter на %s после закрытия чужой группы", w)
	}
}

// === Группа C: дозаказ (addItems) не меняет waiter ===

func TestAccrual_Dozakaz_ByCashier_WaiterUnchanged(t *testing.T) {
	f := setupE2E(t)
	gdb, menuItemID, shiftID, accountID := seedForWrite(t, f)
	aID := mkUser(t, gdb, f.rid, "Alice", "waiter", "")
	o := mkOrder(t, gdb, f.rid, shiftID, ptrS(mkTable(t, gdb, f.rid, 6, &aID)), &aID, "10", "1", "100", "")
	// Кассир делает дозаказ.
	r, b := f.post(t, fmt.Sprintf("/api/v1/orders/%s/items", o), f.login(t), uuid.NewString(), map[string]any{
		"items": []map[string]any{{"menu_item_id": menuItemID, "qty": "1"}},
	})
	if r.StatusCode != 200 && r.StatusCode != 201 {
		t.Fatalf("addItems %d: %s", r.StatusCode, b)
	}
	if w := orderWaiter(t, gdb, o); w != aID {
		t.Errorf("дозаказ кассиром изменил waiter на %s (должен остаться Alice %s)", w, aID)
	}
	closeOrder(t, f, f.login(t), o, shiftID, accountID, map[string]any{"service_percent": "10"})
	if accrualMap(t, f, f.login(t))[aID] == "" {
		t.Errorf("обслуживание должно остаться у Alice после дозаказа кассиром")
	}
}

// === Группа D: transfer ===

func TestAccrual_TransferTableOnly_WaiterUnchanged(t *testing.T) {
	f := setupE2E(t)
	gdb, _, shiftID, accountID := seedForWrite(t, f)
	aID := mkUser(t, gdb, f.rid, "Alice", "waiter", "")
	o := mkOrder(t, gdb, f.rid, shiftID, ptrS(mkTable(t, gdb, f.rid, 7, &aID)), &aID, "10", "1", "100", "")
	dstTable := mkTable(t, gdb, f.rid, 70, nil)
	r, b := f.post(t, fmt.Sprintf("/api/v1/orders/%s/transfer", o), f.login(t), uuid.NewString(), map[string]any{"table_id": dstTable})
	if r.StatusCode != 200 {
		t.Fatalf("transfer %d: %s", r.StatusCode, b)
	}
	if w := orderWaiter(t, gdb, o); w != aID {
		t.Errorf("перенос на стол изменил waiter на %s (должен остаться Alice)", w)
	}
	closeOrder(t, f, f.login(t), o, shiftID, accountID, map[string]any{"service_percent": "10"})
	if accrualMap(t, f, f.login(t))[aID] != "10" {
		t.Errorf("обслуживание должно остаться у Alice после переноса на стол")
	}
}

func TestAccrual_TransferToWaiter_Moves(t *testing.T) {
	f := setupE2E(t)
	gdb, _, shiftID, accountID := seedForWrite(t, f)
	aID := mkUser(t, gdb, f.rid, "Alice", "waiter", "")
	bID := mkUser(t, gdb, f.rid, "Bob", "waiter", "")
	o := mkOrder(t, gdb, f.rid, shiftID, ptrS(mkTable(t, gdb, f.rid, 8, &aID)), &aID, "10", "1", "100", "")
	r, b := f.post(t, fmt.Sprintf("/api/v1/orders/%s/transfer", o), f.login(t), uuid.NewString(), map[string]any{"waiter_id": bID})
	if r.StatusCode != 200 {
		t.Fatalf("transfer %d: %s", r.StatusCode, b)
	}
	closeOrder(t, f, f.login(t), o, shiftID, accountID, map[string]any{"service_percent": "10"})
	acc := accrualMap(t, f, f.login(t))
	if acc[bID] != "10" || (acc[aID] != "" && acc[aID] != "0") {
		t.Errorf("перенос на официанта: ожидали всё Bob'у. Alice=%q Bob=%q", acc[aID], acc[bID])
	}
}

// === Группа E: assign-waiter каскад ===

func TestAccrual_AssignWaiterCascade_MovesActiveOrders(t *testing.T) {
	f := setupE2E(t)
	gdb, _, shiftID, accountID := seedForWrite(t, f)
	aID := mkUser(t, gdb, f.rid, "Alice", "waiter", "")
	bID := mkUser(t, gdb, f.rid, "Bob", "waiter", "")
	tableID := mkTable(t, gdb, f.rid, 9, &aID)
	o := mkOrder(t, gdb, f.rid, shiftID, &tableID, &aID, "10", "1", "100", "")
	r, b := f.post(t, fmt.Sprintf("/api/v1/tables/%s/assign-waiter", tableID), f.login(t), uuid.NewString(), map[string]any{"waiter_id": bID})
	if r.StatusCode != 200 {
		t.Fatalf("assign %d: %s", r.StatusCode, b)
	}
	if w := orderWaiter(t, gdb, o); w != bID {
		t.Errorf("assign-waiter не каскаднул на заказ: waiter=%s", w)
	}
	closeOrder(t, f, f.login(t), o, shiftID, accountID, map[string]any{"service_percent": "10"})
	acc := accrualMap(t, f, f.login(t))
	if acc[bID] != "10" {
		t.Errorf("после assign+close обслуживание должно быть у Bob: %v", acc)
	}
}

func TestAccrual_AssignWaiter_DoesNotTouchClosed(t *testing.T) {
	f := setupE2E(t)
	gdb, _, shiftID, accountID := seedForWrite(t, f)
	aID := mkUser(t, gdb, f.rid, "Alice", "waiter", "")
	bID := mkUser(t, gdb, f.rid, "Bob", "waiter", "")
	tableID := mkTable(t, gdb, f.rid, 10, &aID)
	o := mkOrder(t, gdb, f.rid, shiftID, &tableID, &aID, "10", "1", "100", "")
	closeOrder(t, f, f.login(t), o, shiftID, accountID, map[string]any{"service_percent": "10"})
	// Переназначаем ПОСЛЕ закрытия — закрытый заказ не должен меняться.
	f.post(t, fmt.Sprintf("/api/v1/tables/%s/assign-waiter", tableID), f.login(t), uuid.NewString(), map[string]any{"waiter_id": bID})
	if w := orderWaiter(t, gdb, o); w != aID {
		t.Errorf("закрытый заказ изменил waiter после assign: %s (want Alice)", w)
	}
	if accrualMap(t, f, f.login(t))[aID] != "10" {
		t.Errorf("обслуживание закрытого заказа должно остаться у Alice")
	}
}

// === Группа F: service percent / тип ===

func TestAccrual_ServiceZero_NoAccrual(t *testing.T) {
	f := setupE2E(t)
	gdb, _, shiftID, accountID := seedForWrite(t, f)
	aID := mkUser(t, gdb, f.rid, "Alice", "waiter", "")
	o := mkOrder(t, gdb, f.rid, shiftID, ptrS(mkTable(t, gdb, f.rid, 11, &aID)), &aID, "0", "1", "100", "")
	closeOrder(t, f, f.login(t), o, shiftID, accountID, map[string]any{"service_percent": "0"})
	if v := accrualMap(t, f, f.login(t))[aID]; v != "" && v != "0" {
		t.Errorf("при service 0 не должно быть начисления, got %q", v)
	}
}

// Инвариант: начисленное официанту обслуживание == service_amount, который
// реально удержали с гостя по этому заказу. (Для весовых блюд «раздутость»
// зависит от unit_size в меню, но accrual и charged считаются одинаково —
// значит официанту начисляется ровно столько, сколько взяли с гостя.)
func TestAccrual_WeightItem_ConsistentWithServiceAmount(t *testing.T) {
	f := setupE2E(t)
	gdb, _, shiftID, accountID := seedForWrite(t, f)
	aID := mkUser(t, gdb, f.rid, "Alice", "waiter", "")
	o := mkOrder(t, gdb, f.rid, shiftID, ptrS(mkTable(t, gdb, f.rid, 12, &aID)), &aID, "10", "100", "350", "g")
	closeOrder(t, f, f.login(t), o, shiftID, accountID, map[string]any{"service_percent": "10"})
	var closed models.Order
	if err := gdb.First(&closed, "id = ?", o).Error; err != nil {
		t.Fatal(err)
	}
	acc := accrualMap(t, f, f.login(t))[aID]
	if acc != decimal.Normalize(closed.ServiceAmount).String() {
		t.Errorf("accrual (%s) != order.service_amount (%s) — несогласованность", acc, closed.ServiceAmount.String())
	}
}

// === Группа G: void / cancel ===

func TestAccrual_VoidItem_ExcludedFromAccrual(t *testing.T) {
	f := setupE2E(t)
	gdb, _, shiftID, accountID := seedForWrite(t, f)
	aID := mkUser(t, gdb, f.rid, "Alice", "waiter", "")
	tableID := mkTable(t, gdb, f.rid, 13, &aID)
	// Заказ на 2 позиции по 100 (total 200). Одну отменяем ШТАТНО через API —
	// CancelItem пересчитывает order.total до 100, и при закрытии обслуживание
	// (10%) фиксируется только с живой позиции = 10. Отчёт берёт зафиксированное
	// service_amount, поэтому отменённая позиция в обслуживание не попадает.
	o := mkOrder(t, gdb, f.rid, shiftID, &tableID, &aID, "10", "1", "100", "")
	now := time.Now().UTC()
	dish, piece, item2 := "Dish2", "piece", uuid.NewString()
	if err := gdb.Create(&models.OrderItem{
		ID: item2, OrderID: &o, Name: &dish,
		Qty: decimal.MustFromString("1"), Price: decimal.MustFromString("100"),
		Unit: &piece, UnitSize: decimal.MustFromString("1"), CreatedAt: now, UpdatedAt: now,
	}).Error; err != nil {
		t.Fatal(err)
	}
	if err := gdb.Model(&models.Order{}).Where("id = ?", o).Update("total", decimal.MustFromString("200")).Error; err != nil {
		t.Fatal(err)
	}
	tok := f.login(t)
	if r, b := f.post(t, fmt.Sprintf("/api/v1/orders/%s/items/%s/cancel", o, item2), tok, uuid.NewString(), map[string]any{"reason": "test"}); r.StatusCode != 200 {
		t.Fatalf("cancel item: %d %s", r.StatusCode, b)
	}
	closeOrder(t, f, tok, o, shiftID, accountID, map[string]any{"service_percent": "10"})
	if v := accrualMap(t, f, tok)[aID]; v != "10" {
		t.Errorf("после отмены одной из двух позиций обслуживание = 10 (только с живой), got %q", v)
	}
}

func TestAccrual_CancelledOrder_Excluded(t *testing.T) {
	f := setupE2E(t)
	gdb, _, shiftID, _ := seedForWrite(t, f)
	aID := mkUser(t, gdb, f.rid, "Alice", "waiter", "")
	o := mkOrder(t, gdb, f.rid, shiftID, ptrS(mkTable(t, gdb, f.rid, 14, &aID)), &aID, "10", "1", "100", "")
	// Отменяем заказ.
	r, b := f.post(t, fmt.Sprintf("/api/v1/orders/%s/cancel", o), f.login(t), uuid.NewString(), map[string]any{"reason": "test"})
	if r.StatusCode != 200 {
		t.Fatalf("cancel %d: %s", r.StatusCode, b)
	}
	if v := accrualMap(t, f, f.login(t))[aID]; v != "" && v != "0" {
		t.Errorf("отменённый заказ не должен начислять обслуживание, got %q", v)
	}
}

// === Группа H: агрегация / null waiter ===

func TestAccrual_NullWaiter_Excluded(t *testing.T) {
	f := setupE2E(t)
	gdb, _, shiftID, accountID := seedForWrite(t, f)
	o := mkOrder(t, gdb, f.rid, shiftID, ptrS(mkTable(t, gdb, f.rid, 15, nil)), nil, "10", "1", "100", "")
	closeOrder(t, f, f.login(t), o, shiftID, accountID, map[string]any{"service_percent": "10"})
	acc := accrualMap(t, f, f.login(t))
	if acc[""] != "" {
		t.Errorf("заказ без официанта не должен попадать в отчёт, got %v", acc)
	}
}

// === Группа I: реалистичный сценарий «обслуживание уходит другому» ===

// КЛЮЧЕВОЙ БАГ: стол переиспользуется. Alice обслужила и ЗАКРЫЛА заказ.
// Позже за этот стол сажают новых гостей и назначают Bob'а (assign-waiter).
// Каскад переписывает waiter_id ВСЕХ заказов стола, КРОМЕ ('done','cancelled') —
// а закрытые имеют статус 'closed' → СТАРЫЙ закрытый заказ Alice ретроактивно
// уходит Bob'у. Именно это «обслуживание уходит другому официанту».
func TestAccrual_ReassignTable_StealsOldClosedOrders(t *testing.T) {
	f := setupE2E(t)
	gdb, _, shiftID, accountID := seedForWrite(t, f)
	aID := mkUser(t, gdb, f.rid, "Alice", "waiter", "")
	bID := mkUser(t, gdb, f.rid, "Bob", "waiter", "")
	tableID := mkTable(t, gdb, f.rid, 20, &aID)
	// Alice обслужила и закрыла заказ.
	oOld := mkOrder(t, gdb, f.rid, shiftID, &tableID, &aID, "10", "1", "100", "")
	closeOrder(t, f, f.login(t), oOld, shiftID, accountID, map[string]any{"service_percent": "10"})
	if accrualMap(t, f, f.login(t))[aID] != "10" {
		t.Fatalf("предусловие: обслуживание Alice должно быть 10")
	}
	// Позже стол сажают на Bob (новые гости / смена).
	r, b := f.post(t, fmt.Sprintf("/api/v1/tables/%s/assign-waiter", tableID), f.login(t), uuid.NewString(), map[string]any{"waiter_id": bID})
	if r.StatusCode != 200 {
		t.Fatalf("assign %d: %s", r.StatusCode, b)
	}
	acc := accrualMap(t, f, f.login(t))
	t.Logf("DIAG после переназначения стола: Alice=%q Bob=%q", acc[aID], acc[bID])
	// Ожидаемое ПРАВИЛЬНОЕ поведение: старый закрытый заказ остаётся у Alice.
	if acc[aID] != "10" {
		t.Errorf("BUG: закрытый заказ Alice уехал (Alice=%q, want 10)", acc[aID])
	}
	if acc[bID] == "10" {
		t.Errorf("BUG: обслуживание Alice ретроактивно начислено Bob'у (%q)", acc[bID])
	}
}

func TestAccrual_MultiItemOrder_SumsItems(t *testing.T) {
	f := setupE2E(t)
	gdb, _, shiftID, accountID := seedForWrite(t, f)
	aID := mkUser(t, gdb, f.rid, "Alice", "waiter", "")
	tableID := mkTable(t, gdb, f.rid, 21, &aID)
	now := time.Now().UTC()
	st, hall := "new", "hall"
	oID := uuid.NewString()
	if err := gdb.Create(&models.Order{ID: oID, RestaurantID: &f.rid, TableID: &tableID, WaiterID: &aID, Status: &st, Type: &hall, ShiftID: &shiftID, ServicePercent: decimal.MustFromString("10"), Total: decimal.MustFromString("300"), CreatedAt: now, UpdatedAt: now}).Error; err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{"100", "200"} {
		dish, piece := "D", "piece"
		gdb.Create(&models.OrderItem{ID: uuid.NewString(), OrderID: &oID, Name: &dish, Qty: decimal.MustFromString("1"), Price: decimal.MustFromString(p), Unit: &piece, UnitSize: decimal.MustFromString("1"), CreatedAt: now, UpdatedAt: now})
	}
	closeOrder(t, f, f.login(t), oID, shiftID, accountID, map[string]any{"service_percent": "10"})
	if v := accrualMap(t, f, f.login(t))[aID]; v != "30" {
		t.Errorf("две позиции (100+200) при 10%%: ожидали 30, got %q", v)
	}
}

func TestAccrual_DiscountAppliedToServiceBase(t *testing.T) {
	f := setupE2E(t)
	gdb, _, shiftID, accountID := seedForWrite(t, f)
	aID := mkUser(t, gdb, f.rid, "Alice", "waiter", "")
	o := mkOrder(t, gdb, f.rid, shiftID, ptrS(mkTable(t, gdb, f.rid, 22, &aID)), &aID, "10", "1", "100", "")
	// Скидка 5 (<10%, без одобрения). accrual = qty*price*sp/100 её не учитывает.
	if sc, b := closeOrder(t, f, f.login(t), o, shiftID, accountID, map[string]any{"service_percent": "10", "discount_type": "fixed", "discount_value": "5"}); sc != 200 {
		t.Fatalf("close с скидкой %d: %s", sc, b)
	}
	v := accrualMap(t, f, f.login(t))[aID]
	// Источник правды — зафиксированное при закрытии service_amount, которое
	// считается от ПОСТ-скидочной базы (95 × 10% = 9.5) и печатается на чеке /
	// отражается в смене. Раздел «Обслуживание» обязан показывать то же число.
	if v != "9.5" {
		t.Errorf("ожидали 9.5 (зафиксированное service_amount от пост-скидочной базы), got %q", v)
	}
}

func TestAccrual_SameWaiterTwoOrders_Summed(t *testing.T) {
	f := setupE2E(t)
	gdb, _, shiftID, accountID := seedForWrite(t, f)
	aID := mkUser(t, gdb, f.rid, "Alice", "waiter", "")
	o1 := mkOrder(t, gdb, f.rid, shiftID, ptrS(mkTable(t, gdb, f.rid, 16, &aID)), &aID, "10", "1", "100", "")
	o2 := mkOrder(t, gdb, f.rid, shiftID, ptrS(mkTable(t, gdb, f.rid, 17, &aID)), &aID, "10", "1", "200", "")
	closeOrder(t, f, f.login(t), o1, shiftID, accountID, map[string]any{"service_percent": "10"})
	closeOrder(t, f, f.login(t), o2, shiftID, accountID, map[string]any{"service_percent": "10"})
	if v := accrualMap(t, f, f.login(t))[aID]; v != "30" {
		t.Errorf("два заказа Alice: ожидали 30, got %q", v)
	}
}
