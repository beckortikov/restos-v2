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
	plovItem, kebabItem := uuid.NewString(), uuid.NewString()
	if err := gdb.Create(&models.OrderItem{ID: plovItem, OrderID: &oid, MenuItemID: &plovID, Name: &plov, Qty: decimal.MustFromString("2"), Note: &note}).Error; err != nil {
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
