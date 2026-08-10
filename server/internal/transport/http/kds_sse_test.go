//go:build integration

package http_test

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

// Кухня жмёт статус позиции (POST /kds/items/{id}/status) → бэк публикует SSE
// kds.item.updated. Именно на него ТВ-табло выдачи (/board) инвалидит ['kds'] и
// обновляется мгновенно (кнопка «Готово»/«Выдан» → табло сразу), а не ждёт
// поллинга. Тест подтверждает, что событие реально уходит в поток.
func TestKDS_SetItemStatus_EmitsSSE(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	_, menuItemID, _, _ := seedForWrite(t, f)

	orderID := auditCreateOrder(t, f, tok, menuItemID, "1")

	// id позиции (order_item) — именно его двигает кухонное приложение.
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
	if len(detail.Items) == 0 {
		t.Fatal("в заказе нет позиций")
	}
	itemID := detail.Items[0].ID

	// Подписываемся на SSE ДО смены статуса, иначе пропустим событие.
	type sseRes struct {
		data string
		err  error
	}
	ch := make(chan sseRes, 1)
	go func() {
		data, err := readSSEUntil(f.srv.URL, tok, "kds.item.updated", 3*time.Second)
		ch <- sseRes{data, err}
	}()
	time.Sleep(200 * time.Millisecond) // даём стриму подключиться

	// Кухня переводит блюдо в «Готовится».
	r, b := f.post(t, "/api/v1/kds/items/"+itemID+"/status", tok, uuid.NewString(), map[string]any{"status": "cooking"})
	if r.StatusCode != http.StatusOK {
		t.Fatalf("set status: %d %s", r.StatusCode, b)
	}

	got := <-ch
	if got.err != nil {
		t.Fatalf("SSE не доставил kds.item.updated: %v", got.err)
	}
	// В payload — id позиции и order_number (по нему табло группирует).
	if !strings.Contains(got.data, itemID) {
		t.Errorf("kds.item.updated без id позиции в payload: %s", got.data)
	}
}
