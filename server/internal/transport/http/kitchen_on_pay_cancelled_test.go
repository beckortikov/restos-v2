//go:build integration

package http_test

import (
	"bytes"
	"net/http"
	"testing"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// TestKitchenOnPay_CancelledItem_NotPrinted — в режиме «печать на кухню при
// оплате» (fastfood/kitchen_on_pay) ОТМЕНЁННЫЕ позиции не должны уезжать на
// кухню при закрытии.
//
// Симптом с прода (заказ #41): кухня получала блюда, которых нет в гостевом
// счёте. Причина — выручка/чек фильтруют cancelled_at IS NULL, а кухонный
// бегунок при оплате грузил ВСЕ позиции заказа (включая отменённые), а
// enqueueRunners печатает полную qty каждой строки без своей проверки cancelled.
func TestKitchenOnPay_CancelledItem_NotPrinted(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, menuItemID, shiftID, accountID := seedForWrite(t, f)

	// Фастфуд: кухня печатается на оплате (kitchenOnPay = NOT tables_enabled).
	rid := firstRestaurantID(t, f, tok)
	if r, b := f.patch(t, "/api/v1/restaurants/"+rid, tok, uuid.NewString(),
		map[string]any{"tables_enabled": false}); r.StatusCode != http.StatusOK {
		t.Fatalf("patch restaurant: %d %s", r.StatusCode, b)
	}

	// Второе блюдо с уникальным ASCII-именем (ищем его в payload бегунка) — его
	// добавим в заказ и отменим. Станция — как у seed-блюда, чтобы точно
	// маршрутизировалось на тот же принтер.
	var seed models.MenuItem
	if err := gdb.First(&seed, "id = ?", menuItemID).Error; err != nil {
		t.Fatal(err)
	}
	dropName, dropCat := "ZDROPZ", "Test"
	dropID := uuid.NewString()
	if err := gdb.Create(&models.MenuItem{
		ID: dropID, Name: &dropName, Category: &dropCat, Price: decimal.MustFromString("10"),
		Station: seed.Station, RestaurantID: &f.rid,
	}).Error; err != nil {
		t.Fatal(err)
	}

	// Заказ: живое блюдо + отменяемое.
	orderID := auditCreateOrder(t, f, tok, menuItemID, "1")
	if r, b := f.post(t, "/api/v1/orders/"+orderID+"/items", tok, uuid.NewString(), map[string]any{
		"items": []map[string]any{{"menu_item_id": dropID, "qty": "1"}},
	}); r.StatusCode != http.StatusOK && r.StatusCode != http.StatusCreated {
		t.Fatalf("add drop item: %d %s", r.StatusCode, b)
	}
	var dropOI models.OrderItem
	if err := gdb.Where("order_id = ? AND menu_item_id = ?", orderID, dropID).First(&dropOI).Error; err != nil {
		t.Fatalf("drop item не найден: %v", err)
	}
	if r, b := f.post(t, "/api/v1/orders/"+orderID+"/items/"+dropOI.ID+"/cancel", tok, uuid.NewString(),
		map[string]any{"reason": "гость передумал"}); r.StatusCode != http.StatusOK {
		t.Fatalf("cancel drop: %d %s", r.StatusCode, b)
	}

	// Закрываем — тут (fastfood) ставится кухонный бегунок.
	if r, b := f.post(t, "/api/v1/orders/"+orderID+"/close", tok, uuid.NewString(), map[string]any{
		"payment_method": "cash", "account_id": accountID, "shift_id": shiftID,
	}); r.StatusCode != http.StatusOK {
		t.Fatalf("close: %d %s", r.StatusCode, b)
	}

	// Бегунок должен быть (по живому блюду) и НЕ содержать отменённого ZDROPZ.
	var jobs []models.PrintJob
	if err := gdb.Where("order_id = ? AND type = ?", orderID, "runner").Find(&jobs).Error; err != nil {
		t.Fatal(err)
	}
	if len(jobs) == 0 {
		t.Fatalf("при закрытии (fastfood) кухонный бегунок не создан")
	}
	for _, j := range jobs {
		if bytes.Contains(j.Payload, []byte("ZDROPZ")) {
			t.Errorf("отменённое блюдо ушло на кухню — kitchen-on-pay печатает cancelled (баг заказа #41)")
		}
	}
}
