//go:build integration

package http_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/db/models"
)

// seedHotStation — блюдо уходит на горячий цех + station-принтер, чтобы
// runner-job'ам было куда роутиться.
func seedHotStation(t *testing.T, f *e2eFixture, gdb *gorm.DB, tok, menuItemID string) {
	t.Helper()
	hot := "hot_kitchen"
	if err := gdb.Model(&models.MenuItem{}).Where("id = ?", menuItemID).
		Update("station", hot).Error; err != nil {
		t.Fatal(err)
	}
	resp, body := f.post(t, "/api/v1/printers", tok, uuid.NewString(), map[string]any{
		"name": "Hot kitchen", "kind": "station", "station": hot,
		"driver": "virtual", "target": t.TempDir(),
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("printer create %d: %s", resp.StatusCode, body)
	}
}

func countJobs(t *testing.T, gdb *gorm.DB, orderID, typ string) int64 {
	t.Helper()
	var n int64
	if err := gdb.Model(&models.PrintJob{}).
		Where("order_id = ? AND type = ?", orderID, typ).Count(&n).Error; err != nil {
		t.Fatal(err)
	}
	return n
}

// TestKitchenOnPay_RunnerFiresOnCloseNotOnCreate — фастфуд-режим ресторана
// (restaurants.kitchen_on_pay = true): кухонный бегунок НЕ уходит при создании
// заказа, а печатается только после оплаты. Гость платит → чек с номером ему,
// бегунок с тем же order_number на кухню.
func TestKitchenOnPay_RunnerFiresOnCloseNotOnCreate(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, menuItemID, shiftID, accountID := seedForWrite(t, f)
	seedHotStation(t, f, gdb, tok, menuItemID)

	// Фастфуд-режим ресторана.
	if err := gdb.Model(&models.Restaurant{}).Where("id = ?", f.rid).
		Update("kitchen_on_pay", true).Error; err != nil {
		t.Fatal(err)
	}

	// 1. Создание заказа — бегунка быть НЕ должно.
	r, b := f.post(t, "/api/v1/orders", tok, uuid.NewString(),
		map[string]any{"items": []map[string]any{{"menu_item_id": menuItemID, "qty": "1"}}})
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("create order %d: %s", r.StatusCode, b)
	}
	var ord models.Order
	_ = json.Unmarshal(b, &ord)

	if n := countJobs(t, gdb, ord.ID, "runner"); n != 0 {
		t.Fatalf("kitchen_on_pay: при создании заказа runner-job'ов быть не должно, получили %d — кухня узнала о заказе ДО оплаты", n)
	}

	// 2. Оплата → бегунок уходит на кухню.
	r, b = f.post(t, fmt.Sprintf("/api/v1/orders/%s/close", ord.ID), tok, uuid.NewString(),
		map[string]any{"payment_method": "cash", "account_id": accountID, "shift_id": shiftID})
	if r.StatusCode != http.StatusOK {
		t.Fatalf("close order %d: %s", r.StatusCode, b)
	}

	if n := countJobs(t, gdb, ord.ID, "runner"); n != 1 {
		t.Fatalf("kitchen_on_pay: после оплаты ожидали 1 runner-job, получили %d", n)
	}
	// Чек гостя тоже поставлен — номер общий (order_number на обоих документах).
	if n := countJobs(t, gdb, ord.ID, "receipt"); n != 1 {
		t.Errorf("на оплате ожидали 1 receipt-job, получили %d", n)
	}
}

// TestKitchenOnPay_Off_RunnerOnCreate — дефолт (table-service, kitchen_on_pay=false):
// поведение НЕ изменилось — бегунок печатается сразу при создании заказа.
func TestKitchenOnPay_Off_RunnerOnCreate(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, menuItemID, _, _ := seedForWrite(t, f)
	seedHotStation(t, f, gdb, tok, menuItemID)

	// kitchen_on_pay не трогаем — дефолт false (классический флоу).
	r, b := f.post(t, "/api/v1/orders", tok, uuid.NewString(),
		map[string]any{"items": []map[string]any{{"menu_item_id": menuItemID, "qty": "1"}}})
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("create order %d: %s", r.StatusCode, b)
	}
	var ord models.Order
	_ = json.Unmarshal(b, &ord)

	if n := countJobs(t, gdb, ord.ID, "runner"); n != 1 {
		t.Fatalf("дефолт (table-service): ожидали 1 runner-job при создании, получили %d", n)
	}
}
