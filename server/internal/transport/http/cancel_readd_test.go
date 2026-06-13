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

// Репро жалобы: «официант пробил два блюда, отменил оба, потом снова пробил те
// же — не отражается в ПОС / не добавляется».
//
// Гипотеза: CancelItem при отмене ПОСЛЕДНЕЙ живой позиции авто-отменяет весь
// заказ (status → "cancelled", стол освобождается — orders_extras.go:771).
// А AddItems принимает только status open/new (orders_write.go:322) → повторное
// добавление в тот же заказ отбивается конфликтом. Отсюда «не добавляется».

type crItem struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	CancelledAt *string `json:"cancelled_at"`
}

func crDetail(t *testing.T, f *e2eFixture, tok, orderID string) (status string, total decimal.Decimal, items []crItem) {
	t.Helper()
	_, body := f.get(t, "/api/v1/orders/"+orderID, tok)
	var d struct {
		Order struct {
			Status string          `json:"status"`
			Total  decimal.Decimal `json:"total"`
		} `json:"order"`
		Items []crItem `json:"items"`
	}
	if err := json.Unmarshal(body, &d); err != nil {
		t.Fatalf("unmarshal detail: %v", err)
	}
	return d.Order.Status, d.Order.Total, d.Items
}

func crCancelItem(t *testing.T, f *e2eFixture, tok, orderID, itemID string) {
	t.Helper()
	r, b := f.post(t, fmt.Sprintf("/api/v1/orders/%s/items/%s/cancel", orderID, itemID), tok,
		uuid.NewString(), map[string]any{"reason": "guest_changed_mind"})
	if r.StatusCode != 200 {
		t.Fatalf("cancel item %s: %d %s", itemID, r.StatusCode, b)
	}
}

func crLiveCount(items []crItem) int {
	n := 0
	for _, it := range items {
		if it.CancelledAt == nil {
			n++
		}
	}
	return n
}

// TestCancelAll_ThenReAdd — отменяем ВСЕ позиции, затем добавляем те же заново.
// Ожидание официанта: заказ продолжает жить, блюда снова в нём. Тест проверяет
// именно это. Если заказ авто-отменился и AddItems отбивается — тест падает,
// показывая суть бага.
func TestCancelAll_ThenReAdd(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, miPlov, _, _ := seedForWrite(t, f) // Plov = 25
	miLagman := vtCreateMenuItem(t, gdb, f.rid, "Lagman", "40")

	// 1. Заказ с двумя блюдами.
	r, b := f.post(t, "/api/v1/orders", tok, uuid.NewString(), map[string]any{
		"items": []map[string]any{
			{"menu_item_id": miPlov, "qty": "1"},
			{"menu_item_id": miLagman, "qty": "1"},
		},
	})
	if r.StatusCode != 201 {
		t.Fatalf("create order: %d %s", r.StatusCode, b)
	}
	var ord models.Order
	_ = json.Unmarshal(b, &ord)

	_, _, items := crDetail(t, f, tok, ord.ID)
	if len(items) != 2 {
		t.Fatalf("ожидалось 2 позиции, получили %d", len(items))
	}

	// 2. Отменяем обе позиции (путь официанта: POST /items/{id}/cancel).
	for _, it := range items {
		crCancelItem(t, f, tok, ord.ID, it.ID)
	}

	statusAfterCancel, totalAfterCancel, _ := crDetail(t, f, tok, ord.ID)
	t.Logf("после отмены всех позиций: status=%q total=%s", statusAfterCancel, totalAfterCancel)

	// 3. Снова пробиваем те же два блюда в ТОТ ЖЕ заказ.
	ar, ab := f.post(t, fmt.Sprintf("/api/v1/orders/%s/items", ord.ID), tok, uuid.NewString(), map[string]any{
		"items": []map[string]any{
			{"menu_item_id": miPlov, "qty": "1"},
			{"menu_item_id": miLagman, "qty": "1"},
		},
	})
	t.Logf("повторное добавление: HTTP %d %s", ar.StatusCode, ab)

	if ar.StatusCode != 200 && ar.StatusCode != 201 {
		t.Errorf("повторное добавление в заказ отбито (HTTP %d) — заказ авто-отменился "+
			"при отмене всех позиций (status=%q), официант не может вернуть блюда",
			ar.StatusCode, statusAfterCancel)
		return
	}

	// 4. Если добавление прошло — заказ должен быть живым с 2 живыми позициями.
	status2, total2, items2 := crDetail(t, f, tok, ord.ID)
	if status2 == "cancelled" {
		t.Errorf("заказ остался cancelled после повторного добавления — блюда «становятся отменой»")
	}
	if live := crLiveCount(items2); live != 2 {
		t.Errorf("ожидалось 2 живых позиции после повторного добавления, получили %d (всего строк %d)", live, len(items2))
	}
	if total2.Cmp(decimal.FromInt(65)) != 0 {
		t.Errorf("ожидался total=65 после повторного добавления, получили %s", total2)
	}
}

// TestCancelOne_ThenReAdd — контраст: отменяем ТОЛЬКО одну из двух позиций
// (заказ остаётся живым), затем добавляем её заново. Этот путь должен работать
// и сейчас — показывает, что проблема именно в авто-отмене всего заказа.
func TestCancelOne_ThenReAdd(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, miPlov, _, _ := seedForWrite(t, f) // Plov = 25
	miLagman := vtCreateMenuItem(t, gdb, f.rid, "Lagman", "40")

	r, b := f.post(t, "/api/v1/orders", tok, uuid.NewString(), map[string]any{
		"items": []map[string]any{
			{"menu_item_id": miPlov, "qty": "1"},
			{"menu_item_id": miLagman, "qty": "1"},
		},
	})
	if r.StatusCode != 201 {
		t.Fatalf("create order: %d %s", r.StatusCode, b)
	}
	var ord models.Order
	_ = json.Unmarshal(b, &ord)

	_, _, items := crDetail(t, f, tok, ord.ID)
	var plovID string
	for _, it := range items {
		if it.Name == "Plov" {
			plovID = it.ID
		}
	}
	crCancelItem(t, f, tok, ord.ID, plovID) // отменяем только Plov, Lagman остаётся

	// Добавляем Plov заново.
	ar, ab := f.post(t, fmt.Sprintf("/api/v1/orders/%s/items", ord.ID), tok, uuid.NewString(), map[string]any{
		"items": []map[string]any{{"menu_item_id": miPlov, "qty": "1"}},
	})
	if ar.StatusCode != 200 && ar.StatusCode != 201 {
		t.Fatalf("повторное добавление Plov: %d %s", ar.StatusCode, ab)
	}

	status, total, items2 := crDetail(t, f, tok, ord.ID)
	if status == "cancelled" {
		t.Errorf("заказ cancelled, хотя живой Lagman оставался")
	}
	// Живые: Lagman + заново добавленный Plov = 2. Отменённый Plov остаётся
	// отдельной строкой.
	if live := crLiveCount(items2); live != 2 {
		t.Errorf("ожидалось 2 живых позиции (Lagman + новый Plov), получили %d", live)
	}
	if total.Cmp(decimal.FromInt(65)) != 0 {
		t.Errorf("ожидался total=65 (Lagman 40 + Plov 25), получили %s", total)
	}
}

// TestAddItems_ToReadyOrder — дозаказ в заказ со статусом ready. Раньше AddItems
// отбивал 409 (не open/new); теперь (как v1) добавляет и сбрасывает в cooking,
// т.к. новой позиции нужна кухня.
func TestAddItems_ToReadyOrder(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	_, miPlov, _, _ := seedForWrite(t, f)

	r, b := f.post(t, "/api/v1/orders", tok, uuid.NewString(), map[string]any{
		"items": []map[string]any{{"menu_item_id": miPlov, "qty": "1"}},
	})
	if r.StatusCode != 201 {
		t.Fatalf("create order: %d %s", r.StatusCode, b)
	}
	var ord models.Order
	_ = json.Unmarshal(b, &ord)

	// Переводим заказ в ready.
	rr, rb := f.post(t, fmt.Sprintf("/api/v1/orders/%s/mark-ready", ord.ID), tok, uuid.NewString(), map[string]any{})
	if rr.StatusCode != 200 {
		t.Fatalf("mark-ready: %d %s", rr.StatusCode, rb)
	}
	if st, _, _ := crDetail(t, f, tok, ord.ID); st != "ready" {
		t.Fatalf("ожидался status=ready, получили %q", st)
	}

	// Дозаказ в ready-заказ.
	ar, ab := f.post(t, fmt.Sprintf("/api/v1/orders/%s/items", ord.ID), tok, uuid.NewString(), map[string]any{
		"items": []map[string]any{{"menu_item_id": miPlov, "qty": "1"}},
	})
	if ar.StatusCode != 200 && ar.StatusCode != 201 {
		t.Fatalf("дозаказ в ready-заказ отбит: %d %s", ar.StatusCode, ab)
	}

	status, total, _ := crDetail(t, f, tok, ord.ID)
	if status != "cooking" {
		t.Errorf("после дозаказа в ready ожидался status=cooking, получили %q", status)
	}
	if total.Cmp(decimal.FromInt(50)) != 0 {
		t.Errorf("ожидался total=50 (Plov×2), получили %s", total)
	}
}
