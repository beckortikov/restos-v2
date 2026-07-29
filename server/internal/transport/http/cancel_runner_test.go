//go:build integration

package http_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"github.com/google/uuid"
)

// countCancelRunners — сколько заданий «ОТМЕНА» стоит в очереди печати.
func countCancelRunners(t *testing.T, f *e2eFixture, tok string) int {
	t.Helper()
	r, b := f.get(t, "/api/v1/print/jobs?type=cancel_runner&limit=200", tok)
	if r.StatusCode != http.StatusOK {
		t.Fatalf("print jobs: %d %s", r.StatusCode, b)
	}
	var env struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(b, &env); err != nil {
		t.Fatalf("unmarshal: %v — %s", err, b)
	}
	return len(env.Data)
}

// firstRestaurantID — id ресторана текущего токена.
func firstRestaurantID(t *testing.T, f *e2eFixture, tok string) string {
	t.Helper()
	r, b := f.get(t, "/api/v1/restaurants", tok)
	if r.StatusCode != http.StatusOK {
		t.Fatalf("restaurants: %d %s", r.StatusCode, b)
	}
	var env struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(b, &env); err != nil || len(env.Data) == 0 {
		t.Fatalf("нет ресторанов: %v — %s", err, b)
	}
	return env.Data[0].ID
}

// TestCancelRunner_NotPrintedItems_NoCancelJob — отмена НЕ печатается для
// позиций, которых кухня никогда не видела.
//
// В фастфуде бегунок ставится на ОПЛАТЕ. Если неоплаченный заказ отменили,
// кухня о блюде не знала — и «БЛЮДА УДАЛЕНЫ! НЕ ГОТОВИТЬ!» про него это
// в лучшем случае мусор, в худшем повар идёт выяснять, что он пропустил.
func TestCancelRunner_NotPrintedItems_NoCancelJob(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	_, menuItemID, _, _ := seedForWrite(t, f)

	// Фастфуд: кухня узнаёт о заказе только после оплаты.
	rid := firstRestaurantID(t, f, tok)
	if r, b := f.patch(t, fmt.Sprintf("/api/v1/restaurants/%s", rid), tok, uuid.NewString(),
		map[string]any{"tables_enabled": false}); r.StatusCode != http.StatusOK {
		t.Fatalf("patch restaurant: %d %s", r.StatusCode, b)
	}

	before := countCancelRunners(t, f, tok)

	orderID := auditCreateOrder(t, f, tok, menuItemID, "1")
	// Заказ НЕ оплачен → бегунок на кухню не ставился.
	//
	// Отменяем ОТДЕЛЬНУЮ ПОЗИЦИЮ, а не весь заказ: путь отмены заказа
	// (orders_void.go) фильтр по printed_at имел и раньше, а вот удаление
	// и списание позиции печатали «ОТМЕНА» безусловно — именно оттуда
	// приходил квиток на неоплаченный заказ.
	itemID := firstOrderItemID(t, f, tok, orderID)
	if r, b := f.post(t, fmt.Sprintf("/api/v1/orders/%s/items/%s/cancel", orderID, itemID),
		tok, uuid.NewString(), map[string]any{"reason": "клиент передумал"}); r.StatusCode != http.StatusOK {
		t.Fatalf("cancel item: %d %s", r.StatusCode, b)
	}

	if got := countCancelRunners(t, f, tok); got != before {
		t.Fatalf("создано %d заданий «ОТМЕНА» (было %d) — кухня это блюдо не видела, печатать нечего",
			got-before, before)
	}
}

// TestCancelRunner_PrintedItems_StillPrints — обратная сторона: если бегунок
// на кухню УХОДИЛ, отмена обязана напечататься. Иначе повар готовит то, что
// уже отменили.
func TestCancelRunner_PrintedItems_StillPrints(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	_, menuItemID, _, _ := seedForWrite(t, f)

	// Зал со столами (дефолт): бегунок уходит на кухню сразу при создании.
	before := countCancelRunners(t, f, tok)

	orderID := auditCreateOrder(t, f, tok, menuItemID, "1")
	itemID := firstOrderItemID(t, f, tok, orderID)
	if r, b := f.post(t, fmt.Sprintf("/api/v1/orders/%s/items/%s/cancel", orderID, itemID),
		tok, uuid.NewString(), map[string]any{"reason": "ошибка кассира"}); r.StatusCode != http.StatusOK {
		t.Fatalf("cancel item: %d %s", r.StatusCode, b)
	}

	if got := countCancelRunners(t, f, tok); got <= before {
		t.Fatalf("заданий «ОТМЕНА» %d, было %d — блюдо уходило на кухню, отмену печатать обязаны",
			got, before)
	}
}

// firstOrderItemID — id первой позиции заказа.
func firstOrderItemID(t *testing.T, f *e2eFixture, tok, orderID string) string {
	t.Helper()
	r, b := f.get(t, "/api/v1/orders/"+orderID, tok)
	if r.StatusCode != http.StatusOK {
		t.Fatalf("get order: %d %s", r.StatusCode, b)
	}
	var detail struct {
		Items []struct {
			ID string `json:"id"`
		} `json:"items"`
	}
	if err := json.Unmarshal(b, &detail); err != nil || len(detail.Items) == 0 {
		t.Fatalf("нет позиций: %v — %s", err, b)
	}
	return detail.Items[0].ID
}
