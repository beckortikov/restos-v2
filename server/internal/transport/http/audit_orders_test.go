//go:build integration

package http_test

import (
	"encoding/json"
	"net/http"
	"sync"
	"testing"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// Тесты аудита денежных путей заказа. Каждый ассертит ПРАВИЛЬНОЕ поведение —
// если баг реален, тест падает. Падение = подтверждение.

// createOrder — заказ из одной позиции меню, qty штук. Возвращает id заказа.
func auditCreateOrder(t *testing.T, f *e2eFixture, tok, menuItemID, qty string) string {
	t.Helper()
	r, b := f.post(t, "/api/v1/orders", tok, uuid.NewString(), map[string]any{
		"type": "hall", "guests_count": 1,
		"items": []map[string]any{{"menu_item_id": menuItemID, "qty": qty}},
	})
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("create order: %d %s", r.StatusCode, b)
	}
	var o models.Order
	if err := json.Unmarshal(b, &o); err != nil {
		t.Fatal(err)
	}
	return o.ID
}

// БАГ #2: закрытие «весь счёт» поверх созданных сплитов задваивает выручку.
func TestAudit_CloseAfterSplits_NoDoubleRevenue(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, menuItemID, shiftID, accountID := seedForWrite(t, f)

	orderID := auditCreateOrder(t, f, tok, menuItemID, "4") // 4 × 25 = 100

	// Создаём разделение счёта по позициям.
	gr, gb := f.get(t, "/api/v1/orders/"+orderID, tok)
	if gr.StatusCode != http.StatusOK {
		t.Fatalf("get order: %d %s", gr.StatusCode, gb)
	}
	var detail struct {
		Items []struct {
			ID string `json:"id"`
		} `json:"items"`
	}
	if err := json.Unmarshal(gb, &detail); err != nil {
		t.Fatal(err)
	}
	sr, sb := f.post(t, "/api/v1/orders/"+orderID+"/splits/by-items", tok, uuid.NewString(), map[string]any{
		"groups": []map[string]any{
			{"items": []map[string]any{{"order_item_id": detail.Items[0].ID, "qty": "2"}}},
			{"items": []map[string]any{{"order_item_id": detail.Items[0].ID, "qty": "2"}}},
		},
	})
	if sr.StatusCode != http.StatusOK && sr.StatusCode != http.StatusCreated {
		t.Skipf("split by-items не прошёл (%d %s) — сценарий не воспроизвести", sr.StatusCode, sb)
	}
	var splitRes struct {
		Splits []struct {
			ID string `json:"id"`
		} `json:"splits"`
	}
	_ = json.Unmarshal(sb, &splitRes)

	var accBefore models.FinancialAccount
	gdb.First(&accBefore, "id = ?", accountID)

	// Кассир нажимает «оплатить весь счёт» — /close.
	r, b := f.post(t, "/api/v1/orders/"+orderID+"/close", tok, uuid.NewString(), map[string]any{
		"payment_method": "cash", "account_id": accountID, "shift_id": shiftID,
	})
	if r.StatusCode != http.StatusOK {
		t.Logf("close поверх сплитов отбит: %d %s (это была бы защита)", r.StatusCode, b)
	}

	// Потом проводят сами сплиты.
	for _, sp := range splitRes.Splits {
		f.post(t, "/api/v1/splits/"+sp.ID+"/pay", tok, uuid.NewString(), map[string]any{
			"payment_method": "cash", "account_id": accountID,
		})
	}

	// На счёт зачислено ровно 100 — split-finop имеют source_ref="split:<id>"
	// (без orderID), поэтому меряем именно баланс счёта, а не сумму по orderID.
	var accAfter models.FinancialAccount
	gdb.First(&accAfter, "id = ?", accountID)
	credited := decimal.Sub(accAfter.Balance, accBefore.Balance)
	if credited.GreaterThan(decimal.MustFromString("100")) {
		t.Errorf("на счёт зачислено %s, want ≤100 — close+сплиты задвоили выручку", credited)
	}
}

// БАГ #3: частичный возврат не идемпотентен — двойная отправка удваивает возврат.
func TestAudit_PartialRefund_NotIdempotent(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, menuItemID, shiftID, accountID := seedForWrite(t, f)

	orderID := auditCreateOrder(t, f, tok, menuItemID, "4") // 100
	if r, b := f.post(t, "/api/v1/orders/"+orderID+"/close", tok, uuid.NewString(), map[string]any{
		"payment_method": "cash", "account_id": accountID, "shift_id": shiftID,
	}); r.StatusCode != http.StatusOK {
		t.Fatalf("close: %d %s", r.StatusCode, b)
	}

	var accBefore models.FinancialAccount
	gdb.First(&accBefore, "id = ?", accountID)

	// #3: диалог возврата шлёт ОДИН стабильный Idempotency-Key на попытку
	// (refundKeyRef). Двойная отправка (двойной клик / сетевой ретрай) уходит с
	// тем же ключом → middleware дедупит: второй получает кэш первого, возврат
	// НЕ удваивается. Раньше клиент генерил новый ключ на каждый fetch.
	body := map[string]any{"reason": "брак", "amount": "50"}
	stableKey := uuid.NewString()
	r1, _ := f.post(t, "/api/v1/orders/"+orderID+"/refund", tok, stableKey, body)
	r2, _ := f.post(t, "/api/v1/orders/"+orderID+"/refund", tok, stableKey, body)

	var ord models.Order
	gdb.First(&ord, "id = ?", orderID)
	// Возвращено ровно один раз: 50, а не 100.
	if !ord.RefundedTotal.Equal(decimal.MustFromString("50")) {
		t.Errorf("refunded_total = %s, want 50 — повтор с тем же ключом удвоил возврат (r1=%d r2=%d)",
			ord.RefundedTotal, r1.StatusCode, r2.StatusCode)
	}
	var accAfter models.FinancialAccount
	gdb.First(&accAfter, "id = ?", accountID)
	moved := decimal.Sub(accBefore.Balance, accAfter.Balance)
	if !moved.Equal(decimal.MustFromString("50")) {
		t.Errorf("со счёта ушло %s, want 50 — деньги списаны дважды", moved)
	}
}

// #26: pending-резерв не даёт повтору выполнить операцию второй раз (краш между
// коммитом и записью ответа оставляет pending-строку).
func TestAudit_IdempotencyInProgress_Blocks(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, menuItemID, shiftID, accountID := seedForWrite(t, f)
	orderID := auditCreateOrder(t, f, tok, menuItemID, "4")

	// Эмулируем «упавшую после коммита» операцию: pending-строка (status=0) под
	// ключом. Такую строку оставляет краш между коммитом и Complete.
	key := uuid.NewString()
	if err := gdb.Exec(
		"INSERT INTO idempotency_keys (key, method, path, request_hash, response_status, created_at, expires_at) "+
			"VALUES (?, 'POST', '/api/v1/orders/"+orderID+"/close', 'x', 0, now(), now() + interval '24 hours')", key,
	).Error; err != nil {
		t.Fatal(err)
	}
	// Повтор close под тем же ключом — обязан быть отбит как in-progress, а не
	// выполнить закрытие второй раз.
	r, b := f.post(t, "/api/v1/orders/"+orderID+"/close", tok, key, map[string]any{
		"payment_method": "cash", "account_id": accountID, "shift_id": shiftID,
	})
	if r.StatusCode != http.StatusConflict {
		t.Errorf("повтор под pending-ключом: %d %s, want 409 (in-progress)", r.StatusCode, b)
	}
	var ord models.Order
	gdb.First(&ord, "id = ?", orderID)
	if ord.Status != nil && *ord.Status == "closed" {
		t.Error("заказ закрылся под pending-ключом — повтор выполнил операцию")
	}
}

// БАГ #4: оплата разделением счёта не начисляет сервисный сбор.
func TestAudit_SplitPay_ChargesService(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, menuItemID, shiftID, accountID := seedForWrite(t, f)
	_ = shiftID

	// Включаем сервис 10% на ресторане.
	if err := gdb.Model(&models.Restaurant{}).Where("id = ?", f.rid).
		Update("service_percent", decimal.MustFromString("10")).Error; err != nil {
		t.Fatal(err)
	}

	orderID := auditCreateOrder(t, f, tok, menuItemID, "4") // 100 + 10% сервис = 110
	gr, gb := f.get(t, "/api/v1/orders/"+orderID, tok)
	if gr.StatusCode != http.StatusOK {
		t.Fatalf("get: %d %s", gr.StatusCode, gb)
	}
	var detail struct {
		Items []struct {
			ID string `json:"id"`
		} `json:"items"`
	}
	_ = json.Unmarshal(gb, &detail)

	sr, sb := f.post(t, "/api/v1/orders/"+orderID+"/splits/by-items", tok, uuid.NewString(), map[string]any{
		"groups": []map[string]any{
			{"items": []map[string]any{{"order_item_id": detail.Items[0].ID, "qty": "2"}}},
			{"items": []map[string]any{{"order_item_id": detail.Items[0].ID, "qty": "2"}}},
		},
	})
	if sr.StatusCode != http.StatusOK && sr.StatusCode != http.StatusCreated {
		t.Skipf("split by-items не прошёл: %d %s", sr.StatusCode, sb)
	}
	var splitRes struct {
		Splits []struct {
			ID string `json:"id"`
		} `json:"splits"`
	}
	_ = json.Unmarshal(sb, &splitRes)
	for _, sp := range splitRes.Splits {
		if r, b := f.post(t, "/api/v1/splits/"+sp.ID+"/pay", tok, uuid.NewString(), map[string]any{
			"payment_method": "cash", "account_id": accountID,
		}); r.StatusCode != http.StatusOK {
			t.Fatalf("pay split: %d %s", r.StatusCode, b)
		}
	}

	var ord models.Order
	gdb.First(&ord, "id = ?", orderID)
	// Выручка со сервисом обязана быть 110, как при обычном закрытии.
	if !ord.TotalWithService.Equal(decimal.MustFromString("110")) {
		t.Errorf("total_with_service = %s, want 110 — сплит-оплата потеряла сервисный сбор", ord.TotalWithService)
	}
}

// БАГ #5: reopen → добавить позицию → reclose не списывает склад нового блюда.
func TestAudit_ReopenAddReclose_DeductsNewItem(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, menuItemID, shiftID, accountID := seedForWrite(t, f)

	// Стартовый остаток Rice = 10 кг; тех-карта 0.2 кг/порция.
	var ing models.Ingredient
	gdb.Where("restaurant_id = ? AND name = ?", f.rid, "Rice").First(&ing)
	startQty := ing.Qty

	orderID := auditCreateOrder(t, f, tok, menuItemID, "1") // 1 порция → −0.2
	if r, b := f.post(t, "/api/v1/orders/"+orderID+"/close", tok, uuid.NewString(), map[string]any{
		"payment_method": "cash", "account_id": accountID, "shift_id": shiftID,
	}); r.StatusCode != http.StatusOK {
		t.Fatalf("close1: %d %s", r.StatusCode, b)
	}
	gdb.First(&ing, "id = ?", ing.ID)
	afterClose1 := ing.Qty // ожидаем startQty − 0.2

	// Reopen.
	if r, b := f.post(t, "/api/v1/orders/"+orderID+"/reopen", tok, uuid.NewString(), map[string]any{}); r.StatusCode != http.StatusOK {
		t.Skipf("reopen не прошёл: %d %s", r.StatusCode, b)
	}
	// Добавляем ещё одну порцию.
	if r, b := f.post(t, "/api/v1/orders/"+orderID+"/items", tok, uuid.NewString(), map[string]any{
		"items": []map[string]any{{"menu_item_id": menuItemID, "qty": "1"}},
	}); r.StatusCode != http.StatusOK && r.StatusCode != http.StatusCreated {
		t.Fatalf("add item: %d %s", r.StatusCode, b)
	}
	// Reclose.
	if r, b := f.post(t, "/api/v1/orders/"+orderID+"/close", tok, uuid.NewString(), map[string]any{
		"payment_method": "cash", "account_id": accountID, "shift_id": shiftID,
	}); r.StatusCode != http.StatusOK {
		t.Fatalf("close2: %d %s", r.StatusCode, b)
	}

	gdb.First(&ing, "id = ?", ing.ID)
	// Списано 2 порции всего → startQty − 0.4.
	want := decimal.Sub(startQty, decimal.MustFromString("0.4"))
	if !ing.Qty.Equal(want) {
		t.Errorf("остаток Rice = %s, want %s (после close=%s). Новая позиция не списана при reclose",
			ing.Qty, want, afterClose1)
	}
}

// БАГ #6: batch-блюдо reopen → reclose списывает prepared_qty дважды.
func TestAudit_BatchReopenReclose_NoDoubleDeduct(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, shiftID, accountID := seedForWrite(t, f)

	// Batch-блюдо с prepared_qty=10, без тех-карты (чистая заготовка).
	batch := true
	prep := 10
	name := "Заготовка-плов"
	price := decimal.MustFromString("30")
	station := "hot_kitchen"
	mi := &models.MenuItem{
		ID: uuid.NewString(), Name: &name, Price: price, Station: &station,
		IsBatchCooking: &batch, PreparedQty: &prep, RestaurantID: &f.rid,
	}
	if err := gdb.Create(mi).Error; err != nil {
		t.Fatal(err)
	}

	orderID := auditCreateOrder(t, f, tok, mi.ID, "3") // продаём 3 порции
	if r, b := f.post(t, "/api/v1/orders/"+orderID+"/close", tok, uuid.NewString(), map[string]any{
		"payment_method": "cash", "account_id": accountID, "shift_id": shiftID,
	}); r.StatusCode != http.StatusOK {
		t.Fatalf("close1: %d %s", r.StatusCode, b)
	}
	var after models.MenuItem
	gdb.First(&after, "id = ?", mi.ID)
	if after.PreparedQty == nil || *after.PreparedQty != 7 {
		t.Fatalf("после close prepared_qty = %v, want 7", after.PreparedQty)
	}

	if r, b := f.post(t, "/api/v1/orders/"+orderID+"/reopen", tok, uuid.NewString(), map[string]any{}); r.StatusCode != http.StatusOK {
		t.Skipf("reopen не прошёл: %d %s", r.StatusCode, b)
	}
	if r, b := f.post(t, "/api/v1/orders/"+orderID+"/close", tok, uuid.NewString(), map[string]any{
		"payment_method": "cash", "account_id": accountID, "shift_id": shiftID,
	}); r.StatusCode != http.StatusOK {
		t.Fatalf("close2: %d %s", r.StatusCode, b)
	}

	gdb.First(&after, "id = ?", mi.ID)
	// Продали 3 порции — prepared_qty обязан быть 7, а не 4.
	got := -1
	if after.PreparedQty != nil {
		got = *after.PreparedQty
	}
	if got != 7 {
		t.Errorf("prepared_qty после reopen+reclose = %d, want 7 — заготовка списана дважды за одну продажу", got)
	}
}

// БАГ #30: повторный CreateVoid по той же позиции многократно режет total.
func TestAudit_CreateVoidRepeat_NoDoubleReduction(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, menuItemID, _, _ := seedForWrite(t, f)

	orderID := auditCreateOrder(t, f, tok, menuItemID, "2") // 2 × 25 = 50

	// Пытаемся списать 3 единицы при 2 в позиции — сверх имеющегося.
	r, b := f.post(t, "/api/v1/voids", tok, uuid.NewString(), map[string]any{
		"order_id": orderID, "item_name": "Plov", "item_qty": 3, "item_price": "25", "reason": "тест",
	})
	if r.StatusCode != http.StatusConflict {
		t.Errorf("void 3 из 2: %d %s, want 409 — списание сверх количества позиции", r.StatusCode, b)
	}
	var ord models.Order
	gdb.First(&ord, "id = ?", orderID)
	if !ord.Total.Equal(decimal.MustFromString("50")) {
		t.Errorf("total = %s, want 50 — отбитый over-void не должен трогать сумму", ord.Total)
	}

	// Легитимно списываем обе единицы двумя вызовами.
	for i := 0; i < 2; i++ {
		f.post(t, "/api/v1/voids", tok, uuid.NewString(), map[string]any{
			"order_id": orderID, "item_name": "Plov", "item_qty": 1, "item_price": "25", "reason": "тест",
		})
	}
	gdb.First(&ord, "id = ?", orderID)
	if ord.Total.LessThan(decimal.Zero) {
		t.Errorf("total = %s ушёл в минус", ord.Total)
	}
	// Третья попытка при пустой позиции не должна дальше резать сумму.
	f.post(t, "/api/v1/voids", tok, uuid.NewString(), map[string]any{
		"order_id": orderID, "item_name": "Plov", "item_qty": 1, "item_price": "25", "reason": "тест",
	})
	gdb.First(&ord, "id = ?", orderID)
	if !ord.Total.Equal(decimal.Zero) {
		t.Errorf("total = %s после исчерпания позиции, want 0", ord.Total)
	}
}

// БАГ #1: Close без FOR UPDATE на смене теряет инкремент выручки при гонке.
// Два заказа одной смены закрываются одновременно.
func TestAudit_ConcurrentClose_ShiftRevenueNotLost(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, menuItemID, shiftID, accountID := seedForWrite(t, f)

	const n = 8 // n заказов по 25 → смена обязана накопить 25n
	orderIDs := make([]string, n)
	for i := range orderIDs {
		orderIDs[i] = auditCreateOrder(t, f, tok, menuItemID, "1")
	}

	var wg sync.WaitGroup
	for _, oid := range orderIDs {
		wg.Add(1)
		go func(id string) {
			defer wg.Done()
			f.post(t, "/api/v1/orders/"+id+"/close", tok, uuid.NewString(), map[string]any{
				"payment_method": "cash", "account_id": accountID, "shift_id": shiftID,
			})
		}(oid)
	}
	wg.Wait()

	var shift models.CashShift
	gdb.First(&shift, "id = ?", shiftID)
	want := decimal.Mul(decimal.FromInt(int64(n)), decimal.MustFromString("25"))
	if !shift.CashRevenue.Equal(want) {
		t.Errorf("shift.CashRevenue = %s, want %s — потерян инкремент при параллельном close (%d заказов)",
			shift.CashRevenue, want, n)
	}
}

// orderItemIDs — вспомогательный: id всех живых позиций заказа через GET.
func orderItemIDs(t *testing.T, f *e2eFixture, tok, orderID string) []string {
	t.Helper()
	gr, gb := f.get(t, "/api/v1/orders/"+orderID, tok)
	if gr.StatusCode != http.StatusOK {
		t.Fatalf("get order: %d %s", gr.StatusCode, gb)
	}
	var detail struct {
		Items []struct {
			ID string `json:"id"`
		} `json:"items"`
	}
	if err := json.Unmarshal(gb, &detail); err != nil {
		t.Fatal(err)
	}
	ids := make([]string, len(detail.Items))
	for i, it := range detail.Items {
		ids[i] = it.ID
	}
	return ids
}

// Владелец 2026-08-29: «дать доступ редактирование закрытых заказов, если
// один товар захотят заменить по просьбе клиента» — void позиции ПОСЛЕ
// reopen обязан вернуть списанный при close ингредиент на склад (иначе замена
// блюда тихо ворует остаток дважды: один раз на исходном close, второй — на
// reclose новой позиции).
func TestAudit_ReopenVoidItem_ReturnsIngredientToStock(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, menuItemID, shiftID, accountID := seedForWrite(t, f)

	var ing models.Ingredient
	gdb.Where("restaurant_id = ? AND name = ?", f.rid, "Rice").First(&ing)
	startQty := ing.Qty // 10, тех-карта 0.2 кг/порция

	orderID := auditCreateOrder(t, f, tok, menuItemID, "1")
	if r, b := f.post(t, "/api/v1/orders/"+orderID+"/close", tok, uuid.NewString(), map[string]any{
		"payment_method": "cash", "account_id": accountID, "shift_id": shiftID,
	}); r.StatusCode != http.StatusOK {
		t.Fatalf("close1: %d %s", r.StatusCode, b)
	}
	gdb.First(&ing, "id = ?", ing.ID)
	afterClose := ing.Qty
	if want := decimal.Sub(startQty, decimal.MustFromString("0.2")); !afterClose.Equal(want) {
		t.Fatalf("после close Rice = %s, want %s", afterClose, want)
	}

	if r, b := f.post(t, "/api/v1/orders/"+orderID+"/reopen", tok, uuid.NewString(), map[string]any{}); r.StatusCode != http.StatusOK {
		t.Skipf("reopen не прошёл: %d %s", r.StatusCode, b)
	}

	ids := orderItemIDs(t, f, tok, orderID)
	if len(ids) != 1 {
		t.Fatalf("ожидалась 1 позиция, получено %d", len(ids))
	}
	if r, b := f.post(t, "/api/v1/orders/"+orderID+"/items/"+ids[0]+"/void", tok, uuid.NewString(), map[string]any{
		"reason": "клиент передумал",
	}); r.StatusCode != http.StatusOK {
		t.Fatalf("void: %d %s", r.StatusCode, b)
	}

	gdb.First(&ing, "id = ?", ing.ID)
	if !ing.Qty.Equal(startQty) {
		t.Errorf("после void Rice = %s, want %s (0.2 кг обязан вернуться на склад)", ing.Qty, startQty)
	}
}

// Частичный void (2 из 3 порций остаются) — возврат пропорционален снятому
// количеству, а не всей позиции; повторный reclose оставшихся 2 порций не
// должен ни списать их повторно, ни вернуть склад повторно (идемпотентность
// по item.ID в deductStockForOrder/returnStockForVoidedItem не сбивается
// partial-split'ом).
func TestAudit_ReopenPartialVoidItem_ReturnsProportionalStock(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, menuItemID, shiftID, accountID := seedForWrite(t, f)

	var ing models.Ingredient
	gdb.Where("restaurant_id = ? AND name = ?", f.rid, "Rice").First(&ing)
	startQty := ing.Qty

	orderID := auditCreateOrder(t, f, tok, menuItemID, "3") // 3 × 0.2 = 0.6
	if r, b := f.post(t, "/api/v1/orders/"+orderID+"/close", tok, uuid.NewString(), map[string]any{
		"payment_method": "cash", "account_id": accountID, "shift_id": shiftID,
	}); r.StatusCode != http.StatusOK {
		t.Fatalf("close1: %d %s", r.StatusCode, b)
	}
	gdb.First(&ing, "id = ?", ing.ID)
	afterClose := ing.Qty
	wantAfterClose := decimal.Sub(startQty, decimal.MustFromString("0.6"))
	if !afterClose.Equal(wantAfterClose) {
		t.Fatalf("после close Rice = %s, want %s", afterClose, wantAfterClose)
	}

	if r, b := f.post(t, "/api/v1/orders/"+orderID+"/reopen", tok, uuid.NewString(), map[string]any{}); r.StatusCode != http.StatusOK {
		t.Skipf("reopen не прошёл: %d %s", r.StatusCode, b)
	}
	ids := orderItemIDs(t, f, tok, orderID)
	if len(ids) != 1 {
		t.Fatalf("ожидалась 1 позиция, получено %d", len(ids))
	}
	// Снимаем 1 из 3 порций.
	if r, b := f.post(t, "/api/v1/orders/"+orderID+"/items/"+ids[0]+"/void", tok, uuid.NewString(), map[string]any{
		"reason": "клиент передумал", "qty": "1",
	}); r.StatusCode != http.StatusOK {
		t.Fatalf("void partial: %d %s", r.StatusCode, b)
	}

	gdb.First(&ing, "id = ?", ing.ID)
	wantAfterVoid := decimal.Add(afterClose, decimal.MustFromString("0.2"))
	if !ing.Qty.Equal(wantAfterVoid) {
		t.Errorf("после partial-void Rice = %s, want %s (0.2 кг за 1 снятую порцию, не 0.6 за всю позицию)", ing.Qty, wantAfterVoid)
	}

	// Reclose оставшихся 2 порций: они уже были списаны на close1 (тот же
	// item.ID пережил partial-split) — повторного списания/возврата быть не должно.
	if r, b := f.post(t, "/api/v1/orders/"+orderID+"/close", tok, uuid.NewString(), map[string]any{
		"payment_method": "cash", "account_id": accountID, "shift_id": shiftID,
	}); r.StatusCode != http.StatusOK {
		t.Fatalf("close2: %d %s", r.StatusCode, b)
	}
	gdb.First(&ing, "id = ?", ing.ID)
	if !ing.Qty.Equal(wantAfterVoid) {
		t.Errorf("после reclose Rice = %s, want %s (не изменился) — реклоуз оставшихся порций не должен ни списать, ни вернуть склад повторно", ing.Qty, wantAfterVoid)
	}
}

// Регресс-гвард: живой void (заказ ещё НИ РАЗУ не закрывался, order.ReopenedAt
// == nil) не должен создавать voidreturn-движений — стоку взяться неоткуда,
// forward-списание происходит только на close.
func TestAudit_LiveVoidItem_NoStockReturn(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, menuItemID, _, _ := seedForWrite(t, f)

	var ing models.Ingredient
	gdb.Where("restaurant_id = ? AND name = ?", f.rid, "Rice").First(&ing)
	startQty := ing.Qty

	orderID := auditCreateOrder(t, f, tok, menuItemID, "1") // НЕ закрываем
	ids := orderItemIDs(t, f, tok, orderID)
	if len(ids) != 1 {
		t.Fatalf("ожидалась 1 позиция, получено %d", len(ids))
	}
	if r, b := f.post(t, "/api/v1/orders/"+orderID+"/items/"+ids[0]+"/void", tok, uuid.NewString(), map[string]any{
		"reason": "тест",
	}); r.StatusCode != http.StatusOK {
		t.Fatalf("void: %d %s", r.StatusCode, b)
	}

	gdb.First(&ing, "id = ?", ing.ID)
	if !ing.Qty.Equal(startQty) {
		t.Errorf("Rice = %s, want %s — живой void (до первой оплаты) не должен трогать склад", ing.Qty, startQty)
	}
	var voidReturnCount int64
	gdb.Model(&models.StockMovement{}).
		Where("restaurant_id = ? AND description LIKE ?", f.rid, "%:voidreturn").
		Count(&voidReturnCount)
	if voidReturnCount != 0 {
		t.Errorf("найдено %d voidreturn-движений для живого void, want 0", voidReturnCount)
	}
}

// Полуфабрикат: void ПОСЛЕ reopen обязан вернуть заготовку в
// semi_finished_stock (не в сырьё — тот же путь, что и списание при наличии
// готового остатка, см. TestSemiSale_WithStock_ConsumesSemi_NotRaw).
func TestAudit_ReopenSemiItem_ReturnsSemiStock(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, shiftID, accountID := seedForWrite(t, f)
	soupID, semiID, meat := seedSemiSoup(t, f, gdb)

	if r, b := f.post(t, "/api/v1/semi/prepare", tok, uuid.NewString(), map[string]any{"semi_type_id": semiID, "qty": "5"}); r.StatusCode != http.StatusOK {
		t.Fatalf("prepare: %d %s", r.StatusCode, b)
	}
	meatAfterPrep := ingQty(t, gdb, meat.ID)

	r, b := f.post(t, "/api/v1/orders", tok, uuid.NewString(), map[string]any{
		"items": []map[string]any{{"menu_item_id": soupID, "qty": "1"}},
	})
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("create order: %d %s", r.StatusCode, b)
	}
	var ord models.Order
	if err := json.Unmarshal(b, &ord); err != nil {
		t.Fatal(err)
	}
	orderID := ord.ID
	if r, b := f.post(t, "/api/v1/orders/"+orderID+"/close", tok, uuid.NewString(), map[string]any{
		"payment_method": "cash", "account_id": accountID, "shift_id": shiftID,
	}); r.StatusCode != http.StatusOK {
		t.Fatalf("close1: %d %s", r.StatusCode, b)
	}
	afterClose := semiStockQty(t, gdb, f.rid, semiID)
	if want := decimal.MustFromString("4.5"); !afterClose.Equal(want) {
		t.Fatalf("Broth после close = %s, want %s", afterClose, want)
	}

	if r, b := f.post(t, "/api/v1/orders/"+orderID+"/reopen", tok, uuid.NewString(), map[string]any{}); r.StatusCode != http.StatusOK {
		t.Skipf("reopen не прошёл: %d %s", r.StatusCode, b)
	}
	ids := orderItemIDs(t, f, tok, orderID)
	if len(ids) != 1 {
		t.Fatalf("ожидалась 1 позиция, получено %d", len(ids))
	}
	if r, b := f.post(t, "/api/v1/orders/"+orderID+"/items/"+ids[0]+"/void", tok, uuid.NewString(), map[string]any{
		"reason": "замена блюда",
	}); r.StatusCode != http.StatusOK {
		t.Fatalf("void: %d %s", r.StatusCode, b)
	}

	afterVoid := semiStockQty(t, gdb, f.rid, semiID)
	if want := decimal.MustFromString("5"); !afterVoid.Equal(want) {
		t.Errorf("Broth после void = %s, want %s (0.5 L обязан вернуться)", afterVoid, want)
	}
	if got := ingQty(t, gdb, meat.ID); !got.Equal(meatAfterPrep) {
		t.Errorf("Meat после void = %s, want unchanged %s — возврат заготовки не должен трогать сырьё", got, meatAfterPrep)
	}
}
