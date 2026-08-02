//go:build integration

package http_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/db"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// TestKDS_HTTP — сквозной тест кухонного дисплея (per-dish доска, миграция 033):
// список блюд, фильтр по станции, смена статуса позиции, исключение отменённых.
func TestKDS_HTTP(t *testing.T) {
	f := setupE2E(t)
	gdb, _ := db.Open(testDSN())
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})

	// Меню двух станций.
	hot, grill := "hot_kitchen", "grill"
	plov, kebab := "Плов", "Люля-кебаб"
	plovID, kebabID := uuid.NewString(), uuid.NewString()
	for _, mi := range []models.MenuItem{
		{ID: plovID, Name: &plov, Station: &hot, Price: decimal.MustFromString("25"), RestaurantID: &f.rid},
		{ID: kebabID, Name: &kebab, Station: &grill, Price: decimal.MustFromString("30"), RestaurantID: &f.rid},
	} {
		if err := gdb.Create(&mi).Error; err != nil {
			t.Fatal(err)
		}
	}

	// Открытый заказ с двумя блюдами (плов — с комментарием).
	oid := uuid.NewString()
	st, typ := "new", "hall"
	if err := gdb.Create(&models.Order{ID: oid, RestaurantID: &f.rid, Status: &st, Type: &typ, OrderNumber: 42}).Error; err != nil {
		t.Fatal(err)
	}
	note := "без лука"
	gramUnit := "g"
	plovItem, kebabItem := uuid.NewString(), uuid.NewString()
	// Плов — весовое блюдо (unit=g): qty=200 = 200 граммов, а не «×200».
	if err := gdb.Create(&models.OrderItem{ID: plovItem, OrderID: &oid, MenuItemID: &plovID, Name: &plov, Qty: decimal.MustFromString("2"), Unit: &gramUnit, Note: &note}).Error; err != nil {
		t.Fatal(err)
	}
	if err := gdb.Create(&models.OrderItem{ID: kebabItem, OrderID: &oid, MenuItemID: &kebabID, Name: &kebab, Qty: decimal.MustFromString("1")}).Error; err != nil {
		t.Fatal(err)
	}

	tok := f.login(t)

	list := func(t *testing.T, query string) []map[string]any {
		t.Helper()
		r, b := f.get(t, "/api/v1/kds/items"+query, tok)
		if r.StatusCode != 200 {
			t.Fatalf("list %s: %d %s", query, r.StatusCode, b)
		}
		var env struct {
			Data []map[string]any `json:"data"`
		}
		_ = json.Unmarshal(b, &env)
		return env.Data
	}

	// ─── Все блюда в работе (2 позиции, pending) ─────────────────────────────
	all := list(t, "")
	if len(all) != 2 {
		t.Fatalf("list all = %d, want 2", len(all))
	}
	// Комментарий, кол-во, станция, статус пришли.
	var plovCard map[string]any
	for _, it := range all {
		if it["id"] == plovItem {
			plovCard = it
		}
	}
	if plovCard == nil {
		t.Fatal("plov item missing from board")
	}
	if plovCard["comment"] != "без лука" {
		t.Errorf("comment = %v, want «без лука»", plovCard["comment"])
	}
	if plovCard["station"] != "hot_kitchen" {
		t.Errorf("station = %v, want hot_kitchen", plovCard["station"])
	}
	if plovCard["station_status"] != "pending" {
		t.Errorf("station_status = %v, want pending", plovCard["station_status"])
	}
	if plovCard["qty"] != "2" {
		t.Errorf("qty = %v, want 2", plovCard["qty"])
	}
	// age_seconds присутствует и неотрицателен (блюдо только что создано → ~0).
	if age, ok := plovCard["age_seconds"].(float64); !ok || age < 0 {
		t.Errorf("age_seconds = %v (ok=%v), want number >= 0", plovCard["age_seconds"], ok)
	}
	// unit весового блюда доходит до кухни (для «200 г» вместо «×200»).
	if plovCard["unit"] != "g" {
		t.Errorf("unit = %v, want g", plovCard["unit"])
	}

	// ─── Фильтр по станции grill → только люля ───────────────────────────────
	grillOnly := list(t, "?stations=grill")
	if len(grillOnly) != 1 || grillOnly[0]["id"] != kebabItem {
		t.Fatalf("grill filter = %+v, want [kebab]", grillOnly)
	}

	// ─── Смена статуса: плов → cooking ───────────────────────────────────────
	code, body := postJSON(t, f.srv.URL+fmt.Sprintf("/api/v1/kds/items/%s/status", plovItem), tok, map[string]string{"status": "cooking"})
	if code != 200 {
		t.Fatalf("set status: %d %s", code, body)
	}
	var updated map[string]any
	_ = json.Unmarshal(body, &updated)
	if updated["station_status"] != "cooking" {
		t.Errorf("after set: station_status = %v, want cooking", updated["station_status"])
	}

	// Фильтр по статусу cooking → только плов.
	cooking := list(t, "?status=cooking")
	if len(cooking) != 1 || cooking[0]["id"] != plovItem {
		t.Fatalf("cooking filter = %+v, want [plov]", cooking)
	}

	// ─── Отменённое блюдо уходит с доски ─────────────────────────────────────
	now := time.Now().UTC()
	if err := gdb.Model(&models.OrderItem{}).Where("id = ?", kebabItem).Update("cancelled_at", now).Error; err != nil {
		t.Fatal(err)
	}
	afterCancel := list(t, "")
	if len(afterCancel) != 1 || afterCancel[0]["id"] != plovItem {
		t.Fatalf("after cancel = %+v, want [plov]", afterCancel)
	}
}

// TestKDS_CallWaiter — колокольчик «позвать официанта»: 200 + имя, когда у
// заказа есть официант; 422, когда официанта нет.
func TestKDS_CallWaiter(t *testing.T) {
	f := setupE2E(t)
	gdb, _ := db.Open(testDSN())
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})

	waiterID := uuid.NewString()
	wname, wrole := "Диляра", "waiter"
	if err := gdb.Create(&models.User{ID: waiterID, Name: &wname, Role: &wrole, RestaurantID: &f.rid}).Error; err != nil {
		t.Fatal(err)
	}

	st, typ := "new", "hall"
	dish := "Салат Домашний большой"

	// Заказ С официантом.
	oid := uuid.NewString()
	if err := gdb.Create(&models.Order{ID: oid, RestaurantID: &f.rid, Status: &st, Type: &typ, OrderNumber: 58, WaiterID: &waiterID}).Error; err != nil {
		t.Fatal(err)
	}
	itemID := uuid.NewString()
	if err := gdb.Create(&models.OrderItem{ID: itemID, OrderID: &oid, Name: &dish, Qty: decimal.MustFromString("1")}).Error; err != nil {
		t.Fatal(err)
	}

	tok := f.login(t)

	code, body := postJSON(t, f.srv.URL+fmt.Sprintf("/api/v1/kds/items/%s/call-waiter", itemID), tok, map[string]any{})
	if code != 200 {
		t.Fatalf("call-waiter: %d %s", code, body)
	}
	var out struct {
		WaiterName string `json:"waiter_name"`
	}
	_ = json.Unmarshal(body, &out)
	if out.WaiterName != wname {
		t.Errorf("waiter_name = %q, want %q", out.WaiterName, wname)
	}

	// Заказ БЕЗ официанта → 422.
	oid2 := uuid.NewString()
	if err := gdb.Create(&models.Order{ID: oid2, RestaurantID: &f.rid, Status: &st, Type: &typ, OrderNumber: 59}).Error; err != nil {
		t.Fatal(err)
	}
	item2 := uuid.NewString()
	if err := gdb.Create(&models.OrderItem{ID: item2, OrderID: &oid2, Name: &dish, Qty: decimal.MustFromString("1")}).Error; err != nil {
		t.Fatal(err)
	}
	code2, body2 := postJSON(t, f.srv.URL+fmt.Sprintf("/api/v1/kds/items/%s/call-waiter", item2), tok, map[string]any{})
	if code2 != 400 {
		t.Errorf("no-waiter call = %d %s, want 400", code2, body2)
	}
}

// TestKDS_StopList_BlocksOrder — сквозная гарантия фичи «повар жмёт СТОП»:
// кухня ставит stop_list_override → касса/официант НЕ могут пробить блюдо
// (409 ITEM_STOPPED); повар снял стоп → заказ снова проходит.
func TestKDS_StopList_BlocksOrder(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _ := db.Open(testDSN())
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})

	name := "Салат Домашний"
	miID := uuid.NewString()
	if err := gdb.Create(&models.MenuItem{
		ID: miID, Name: &name, Price: decimal.MustFromString("20"), RestaurantID: &f.rid,
	}).Error; err != nil {
		t.Fatal(err)
	}
	order := map[string]any{"items": []map[string]any{{"menu_item_id": miID, "qty": "1"}}}

	// До стопа заказ проходит.
	if r, b := f.post(t, "/api/v1/orders", tok, uuid.NewString(), order); r.StatusCode != http.StatusCreated {
		t.Fatalf("до стопа заказ должен проходить: %d %s", r.StatusCode, b)
	}

	// Повар на кухне: «закончилось».
	if r, b := f.post(t, "/api/v1/stop-list/"+miID+"/override", tok, uuid.NewString(),
		map[string]any{"override": true}); r.StatusCode != http.StatusOK {
		t.Fatalf("поставить стоп: %d %s", r.StatusCode, b)
	}

	// Кассир/официант больше не пробьёт.
	r, b := f.post(t, "/api/v1/orders", tok, uuid.NewString(), order)
	if r.StatusCode != http.StatusConflict {
		t.Fatalf("после стопа заказ должен отклоняться 409, получили %d: %s", r.StatusCode, b)
	}
	if !strings.Contains(string(b), "ITEM_STOPPED") {
		t.Errorf("ожидали код ITEM_STOPPED, получили: %s", b)
	}

	// Повар снял стоп — снова можно пробивать.
	if rr, bb := f.post(t, "/api/v1/stop-list/"+miID+"/override", tok, uuid.NewString(),
		map[string]any{"override": false}); rr.StatusCode != http.StatusOK {
		t.Fatalf("снять стоп: %d %s", rr.StatusCode, bb)
	}
	if rr, bb := f.post(t, "/api/v1/orders", tok, uuid.NewString(), order); rr.StatusCode != http.StatusCreated {
		t.Fatalf("после снятия стопа заказ должен проходить: %d %s", rr.StatusCode, bb)
	}
}

// TestKDS_StopList_EmitsSSE — стоп с кухни долетает до кассы/официанта сразу:
// override → SSE stop_list.updated с menu_item_id и stopped (иначе меню на кассе
// обновилось бы только при следующем перезапросе).
func TestKDS_StopList_EmitsSSE(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _ := db.Open(testDSN())
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})

	name := "Плов"
	miID := uuid.NewString()
	if err := gdb.Create(&models.MenuItem{
		ID: miID, Name: &name, Price: decimal.MustFromString("20"), RestaurantID: &f.rid,
	}).Error; err != nil {
		t.Fatal(err)
	}

	gotCh := make(chan string, 1)
	errCh := make(chan error, 1)
	go func() {
		data, err := readSSEUntilEvent(t, f.srv.URL, tok, "stop_list.updated", 4*time.Second)
		if err != nil {
			errCh <- err
			return
		}
		gotCh <- data
	}()
	// Даём SSE подписаться до публикации события.
	time.Sleep(200 * time.Millisecond)

	if r, b := f.post(t, "/api/v1/stop-list/"+miID+"/override", tok, uuid.NewString(),
		map[string]any{"override": true}); r.StatusCode != http.StatusOK {
		t.Fatalf("поставить стоп: %d %s", r.StatusCode, b)
	}

	select {
	case data := <-gotCh:
		if !strings.Contains(data, miID) {
			t.Errorf("в payload нет menu_item_id %s: %s", miID, data)
		}
		if !strings.Contains(data, `"stopped":true`) {
			t.Errorf("в payload нет stopped:true: %s", data)
		}
	case err := <-errCh:
		t.Fatalf("SSE: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("не дождались события stop_list.updated")
	}
}

// TestKDS_AddAfterAdvanced_NewPendingRow — дозаказ того же блюда, которое повар
// уже двинул на кухне (ready/served), НЕ сливается в готовую строку, а создаёт
// новую позицию со station_status=pending (на доске — «Новые», а не «готовое»).
func TestKDS_AddAfterAdvanced_NewPendingRow(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _ := db.Open(testDSN())
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})

	name := "Лагман"
	miID := uuid.NewString()
	if err := gdb.Create(&models.MenuItem{
		ID: miID, Name: &name, Price: decimal.MustFromString("30"), RestaurantID: &f.rid,
	}).Error; err != nil {
		t.Fatal(err)
	}

	// Заказ с одним лагманом.
	code, body := postJSON(t, f.srv.URL+"/api/v1/orders", tok,
		map[string]any{"items": []map[string]any{{"menu_item_id": miID, "qty": "1"}}})
	if code != http.StatusCreated {
		t.Fatalf("create order: %d %s", code, body)
	}
	var created struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(body, &created)
	if created.ID == "" {
		t.Fatalf("no order id in payload: %s", body)
	}

	// Первая позиция — из БД (не зависим от формата create-ответа).
	var first models.OrderItem
	if err := gdb.Where("order_id = ?", created.ID).First(&first).Error; err != nil {
		t.Fatal(err)
	}

	// Повар на кухне двинул блюдо в «готово».
	if c, b := postJSON(t, f.srv.URL+fmt.Sprintf("/api/v1/kds/items/%s/status", first.ID), tok,
		map[string]string{"status": "ready"}); c != 200 {
		t.Fatalf("set ready: %d %s", c, b)
	}

	// Дозаказ того же лагмана.
	if c, b := postJSON(t, f.srv.URL+fmt.Sprintf("/api/v1/orders/%s/items", created.ID), tok,
		map[string]any{"items": []map[string]any{{"menu_item_id": miID, "qty": "1"}}}); c != 200 && c != http.StatusCreated {
		t.Fatalf("add items: %d %s", c, b)
	}

	// В БД: две отдельные строки. Первая ready, вторая — новая pending.
	var rows []models.OrderItem
	if err := gdb.Where("order_id = ? AND cancelled_at IS NULL", created.ID).
		Order("created_at").Find(&rows).Error; err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 {
		t.Fatalf("ожидали 2 отдельные позиции (дозаказ не слить в готовую), получили %d", len(rows))
	}
	pending := 0
	for _, r := range rows {
		if r.StationStatus != nil && *r.StationStatus == "pending" {
			pending++
		}
	}
	if pending != 1 {
		t.Fatalf("ожидали ровно 1 pending-позицию (новый дозаказ), получили %d из %d", pending, len(rows))
	}
}

// postJSON — POST с Bearer + Idempotency-Key (write-эндпоинты его требуют).
func postJSON(t *testing.T, url, token string, body any) (int, []byte) {
	t.Helper()
	raw, _ := json.Marshal(body)
	req, _ := http.NewRequest("POST", url, bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Idempotency-Key", uuid.NewString())
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, b
}
