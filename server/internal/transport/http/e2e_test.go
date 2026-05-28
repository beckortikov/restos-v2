//go:build integration

package http_test

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/db"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
	httpx "github.com/restos/restos-v4/server/internal/transport/http"
)

// Полный e2e: создаём ресторан+юзера+меню+заказ в БД,
// запускаем httptest-сервер, идём через /api/v1.

func testDSN() string {
	if v := os.Getenv("RESTOS_TEST_DSN"); v != "" {
		return v
	}
	return "host=127.0.0.1 port=5432 user=restos dbname=restos_v4_test sslmode=disable"
}

type e2eFixture struct {
	srv *httptest.Server
	rid string
	pin string
}

func setupE2E(t *testing.T) *e2eFixture {
	t.Helper()
	gdb, err := db.Open(testDSN())
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	if err := db.MigrateUp(t.Context(), gdb); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	// Очистка релевантных таблиц.
	for _, tbl := range []string{
		"audit_log", "print_jobs", "printers",
		"order_item_modifiers", "order_voids", "order_items", "orders",
		"stock_movements", "tech_card_lines", "ingredients",
		"cash_shift_operations", "cash_shifts",
		"sessions", "menu_items", "users", "restaurants",
	} {
		if err := gdb.Exec("DELETE FROM " + tbl).Error; err != nil {
			t.Fatalf("clean %s: %v", tbl, err)
		}
	}

	rid := uuid.NewString()
	techOff := false // Phase 19 — большинство e2e тестов не настраивают tech_card_lines,
	// поэтому отключаем валидацию по умолчанию. Phase 19 tests включают её вручную.
	if err := gdb.Create(&models.Restaurant{ID: rid, Name: "E2E", TechCardsEnabled: &techOff}).Error; err != nil {
		t.Fatal(err)
	}
	name := "Cashier"
	pin := "1234"
	role := "cashier"
	if err := gdb.Create(&models.User{
		ID: uuid.NewString(), Name: &name, PIN: &pin, Role: &role, RestaurantID: &rid,
	}).Error; err != nil {
		t.Fatal(err)
	}

	itemName := "Plov"
	if err := gdb.Create(&models.MenuItem{
		Name: &itemName, Price: decimal.MustFromString("25"), RestaurantID: &rid,
	}).Error; err != nil {
		t.Fatal(err)
	}

	router := httpx.NewRouter(httpx.Deps{
		DB:    gdb,
		Build: httpx.BuildInfo{Version: "test"},
	})
	srv := httptest.NewServer(router)

	t.Cleanup(func() {
		srv.Close()
		// Закрываем пул коннектов, чтобы не упереться в max_connections PG
		// после многих setupE2E подряд в полной сюите.
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})

	return &e2eFixture{srv: srv, rid: rid, pin: pin}
}

func (f *e2eFixture) login(t *testing.T) string {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"restaurant_id": f.rid, "pin": f.pin})
	resp, err := http.Post(f.srv.URL+"/api/v1/auth/login", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("login %d: %s", resp.StatusCode, b)
	}
	var out struct {
		Token string `json:"token"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&out)
	if out.Token == "" {
		t.Fatal("empty token")
	}
	return out.Token
}

func (f *e2eFixture) get(t *testing.T, path, token string) (*http.Response, []byte) {
	t.Helper()
	req, _ := http.NewRequest("GET", f.srv.URL+path, nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp, b
}

func TestE2E_AuthRequired(t *testing.T) {
	f := setupE2E(t)
	resp, _ := f.get(t, "/api/v1/menu/items", "")
	if resp.StatusCode != 401 {
		t.Fatalf("expected 401, got %d", resp.StatusCode)
	}
}

func TestE2E_LoginAndList(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)

	resp, body := f.get(t, "/api/v1/menu/items", tok)
	if resp.StatusCode != 200 {
		t.Fatalf("menu/items %d: %s", resp.StatusCode, body)
	}
	var env struct {
		Data       []map[string]any `json:"data"`
		NextCursor string           `json:"next_cursor"`
	}
	if err := json.Unmarshal(body, &env); err != nil {
		t.Fatal(err)
	}
	if len(env.Data) != 1 {
		t.Errorf("want 1 item, got %d", len(env.Data))
	}
}

func TestE2E_BadCursorReturnsItems(t *testing.T) {
	// Bad cursor сейчас проглатывается → первая страница. Это документированное
	// поведение cursor.Apply (см. комментарий). Тест защищает от регрессии.
	f := setupE2E(t)
	tok := f.login(t)
	resp, _ := f.get(t, "/api/v1/menu/items?cursor=!!!", tok)
	if resp.StatusCode != 200 {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
}

func TestE2E_TenantIsolation(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)

	// Создаём ВТОРОЙ ресторан с менюшкой через тот же DSN.
	gdb, _ := db.Open(testDSN())
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})
	ridB := uuid.NewString()
	if err := gdb.Create(&models.Restaurant{ID: ridB, Name: "Other"}).Error; err != nil {
		t.Fatal(err)
	}
	other := "Other Plov"
	if err := gdb.Create(&models.MenuItem{
		Name: &other, Price: decimal.MustFromString("100"), RestaurantID: &ridB,
	}).Error; err != nil {
		t.Fatal(err)
	}

	// Под токеном ресторана A не должно прийти меню ресторана B.
	resp, body := f.get(t, "/api/v1/menu/items", tok)
	if resp.StatusCode != 200 {
		t.Fatalf("status %d", resp.StatusCode)
	}
	var env struct{ Data []map[string]any }
	_ = json.Unmarshal(body, &env)
	for _, item := range env.Data {
		if name, _ := item["name"].(string); name == "Other Plov" {
			t.Fatalf("tenant leak! got item from restaurant B")
		}
	}
}
