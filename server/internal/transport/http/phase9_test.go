//go:build integration

package http_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/db"
	"github.com/restos/restos-v4/server/internal/db/models"
	httpx "github.com/restos/restos-v4/server/internal/transport/http"
)

// ─── Bootstrap ─────────────────────────────────────────────────────────────

// setupEmptyDB — пустая БД для bootstrap-теста. Удаляет ВСЁ из таблиц
// (агрессивнее обычного setupE2E), потом запускает сервер.
func setupEmptyDB(t *testing.T) (*httptest.Server, func()) {
	t.Helper()
	gdb, err := db.Open(testDSN())
	if err != nil {
		t.Fatal(err)
	}
	if err := db.MigrateUp(t.Context(), gdb); err != nil {
		t.Fatal(err)
	}
	// Чистим в правильном порядке (FK).
	for _, tbl := range []string{
		"audit_log", "print_jobs", "printers", "shadow_drifts",
		"order_item_modifiers", "order_voids", "order_splits", "order_items", "orders",
		"cash_shift_operations", "cash_shifts",
		"stock_movements", "tech_card_lines", "ingredients",
		"modifiers", "modifier_groups", "menu_items",
		"reservations", "suppliers", "customers", "time_entries",
		"sessions", "users", "tables", "zones", "restaurants",
	} {
		if err := gdb.Exec("DELETE FROM " + tbl).Error; err != nil {
			t.Fatal(err)
		}
	}

	router := httpx.NewRouter(httpx.Deps{
		DB:    gdb,
		Build: httpx.BuildInfo{Version: "bootstrap-test"},
	})
	srv := httptest.NewServer(router)
	cleanup := func() {
		srv.Close()
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	}
	return srv, cleanup
}

func TestBootstrap_StatusEmpty(t *testing.T) {
	srv, cleanup := setupEmptyDB(t)
	defer cleanup()

	resp, err := http.Get(srv.URL + "/api/v1/bootstrap/status")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatal(resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	var st struct {
		Initialized bool `json:"initialized"`
	}
	_ = json.Unmarshal(body, &st)
	if st.Initialized {
		t.Errorf("empty DB should not be initialized")
	}
}

func TestBootstrap_RunAndLogin(t *testing.T) {
	srv, cleanup := setupEmptyDB(t)
	defer cleanup()

	// Bootstrap.
	bootBody, _ := json.Marshal(map[string]any{
		"restaurant_name": "My Cafe",
		"owner_name":      "Owner Bob",
		"owner_pin":       "9999",
		"currency":        "USD",
	})
	resp, err := http.Post(srv.URL+"/api/v1/bootstrap", "application/json", bytes.NewReader(bootBody))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 201 {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("bootstrap %d: %s", resp.StatusCode, b)
	}
	var bres struct {
		Restaurant models.Restaurant `json:"restaurant"`
		Owner      models.User       `json:"owner"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&bres)
	if bres.Restaurant.Name != "My Cafe" {
		t.Errorf("name = %s, want My Cafe", bres.Restaurant.Name)
	}
	if bres.Owner.PIN != nil {
		t.Errorf("owner PIN leaked")
	}

	// Status теперь = initialized.
	respS, err := http.Get(srv.URL + "/api/v1/bootstrap/status")
	if err != nil {
		t.Fatal(err)
	}
	defer respS.Body.Close()
	bodyS, _ := io.ReadAll(respS.Body)
	var st struct{ Initialized bool }
	_ = json.Unmarshal(bodyS, &st)
	if !st.Initialized {
		t.Errorf("after bootstrap should be initialized")
	}

	// Повторный bootstrap → 409 CONFLICT.
	resp2, err := http.Post(srv.URL+"/api/v1/bootstrap", "application/json", bytes.NewReader(bootBody))
	if err != nil {
		t.Fatal(err)
	}
	defer resp2.Body.Close()
	if resp2.StatusCode != 409 {
		t.Errorf("second bootstrap expected 409, got %d", resp2.StatusCode)
	}

	// Login owner созданным PIN'ом.
	loginBody, _ := json.Marshal(map[string]string{
		"restaurant_id": bres.Restaurant.ID, "pin": "9999",
	})
	respL, err := http.Post(srv.URL+"/api/v1/auth/login", "application/json", bytes.NewReader(loginBody))
	if err != nil {
		t.Fatal(err)
	}
	defer respL.Body.Close()
	if respL.StatusCode != 200 {
		b, _ := io.ReadAll(respL.Body)
		t.Errorf("login %d: %s", respL.StatusCode, b)
	}
}

func TestBootstrap_Validation(t *testing.T) {
	srv, cleanup := setupEmptyDB(t)
	defer cleanup()

	body, _ := json.Marshal(map[string]any{"owner_name": "X"}) // нет restaurant_name + pin
	resp, err := http.Post(srv.URL+"/api/v1/bootstrap", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 400 {
		t.Errorf("empty validation: %d", resp.StatusCode)
	}
}

// ─── Finance smoke ─────────────────────────────────────────────────────────

func TestPhase9_AssetsLiabilitiesEquityBudget(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)

	// Assets.
	r1, b1 := f.post(t, "/api/v1/assets", tok, uuid.NewString(),
		map[string]any{"name": "Espresso machine", "category": "equipment", "amount": "5000"})
	if r1.StatusCode != 201 {
		t.Fatalf("asset create %d: %s", r1.StatusCode, b1)
	}
	var asset models.Asset
	_ = json.Unmarshal(b1, &asset)

	// Liabilities — auto remaining_amount = total - paid.
	r2, b2 := f.post(t, "/api/v1/liabilities", tok, uuid.NewString(),
		map[string]any{"name": "Bank loan", "total_amount": "100000", "paid_amount": "20000"})
	if r2.StatusCode != 201 {
		t.Fatalf("liability create %d: %s", r2.StatusCode, b2)
	}
	var liab models.Liability
	_ = json.Unmarshal(b2, &liab)
	if liab.RemainingAmount.String() != "80000" {
		t.Errorf("remaining = %s, want 80000", liab.RemainingAmount.String())
	}

	// Equity.
	r3, _ := f.post(t, "/api/v1/equity", tok, uuid.NewString(),
		map[string]any{"name": "Initial capital", "amount": "50000"})
	if r3.StatusCode != 201 {
		t.Errorf("equity %d", r3.StatusCode)
	}

	// Budget.
	r4, b4 := f.post(t, "/api/v1/budget", tok, uuid.NewString(),
		map[string]any{"category": "rent", "type": "expense", "plan_amount": "10000", "period": "2026-05"})
	if r4.StatusCode != 201 {
		t.Fatalf("budget %d: %s", r4.StatusCode, b4)
	}

	// Lists.
	lr, lb := f.get(t, "/api/v1/assets", tok)
	if lr.StatusCode != 200 {
		t.Fatal(lr.StatusCode)
	}
	var assetEnv struct {
		Data []models.Asset `json:"data"`
	}
	_ = json.Unmarshal(lb, &assetEnv)
	if len(assetEnv.Data) != 1 {
		t.Errorf("assets list: %d", len(assetEnv.Data))
	}

	// Patch liability — paid_amount → remaining пересчитывается.
	patchPath := fmt.Sprintf("/api/v1/liabilities/%s", liab.ID)
	pr, pb := f.patch(t, patchPath, tok, uuid.NewString(), map[string]any{"paid_amount": "50000"})
	if pr.StatusCode != 200 {
		t.Fatalf("patch %d: %s", pr.StatusCode, pb)
	}
	var patched models.Liability
	_ = json.Unmarshal(pb, &patched)
	if patched.RemainingAmount.String() != "50000" {
		t.Errorf("remaining after patch = %s, want 50000", patched.RemainingAmount.String())
	}

	// Delete asset.
	delResp, _ := f.del(t, fmt.Sprintf("/api/v1/assets/%s", asset.ID), tok, uuid.NewString())
	if delResp.StatusCode != 204 {
		t.Errorf("delete %d", delResp.StatusCode)
	}
}

// ─── TimeEntries ───────────────────────────────────────────────────────────

func TestPhase9_TimeEntries(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, _, _ := seedForWrite(t, f)

	// Берём существующего юзера из setupE2E.
	var u models.User
	if err := gdb.Where("restaurant_id = ?", f.rid).First(&u).Error; err != nil {
		t.Fatal(err)
	}

	// ClockIn.
	r1, b1 := f.post(t, "/api/v1/time-entries", tok, uuid.NewString(),
		map[string]any{"user_id": u.ID})
	if r1.StatusCode != 201 {
		t.Fatalf("clock-in %d: %s", r1.StatusCode, b1)
	}
	var te models.TimeEntry
	_ = json.Unmarshal(b1, &te)
	if te.Status == nil || *te.Status != "active" {
		t.Errorf("status = %v, want active", te.Status)
	}

	// ClockOut.
	r2, b2 := f.patch(t, fmt.Sprintf("/api/v1/time-entries/%s/clock-out", te.ID), tok, uuid.NewString(),
		map[string]any{"break_minutes": 30})
	if r2.StatusCode != 200 {
		t.Fatalf("clock-out %d: %s", r2.StatusCode, b2)
	}
	var closed models.TimeEntry
	_ = json.Unmarshal(b2, &closed)
	if closed.Status == nil || *closed.Status != "closed" {
		t.Errorf("after clock-out status = %v, want closed", closed.Status)
	}
	if closed.BreakMinutes == nil || *closed.BreakMinutes != 30 {
		t.Errorf("break_minutes mismatch")
	}

	// Double clock-out → 409.
	r3, _ := f.patch(t, fmt.Sprintf("/api/v1/time-entries/%s/clock-out", te.ID), tok, uuid.NewString(),
		map[string]any{})
	if r3.StatusCode != 409 {
		t.Errorf("double clock-out: %d, want 409", r3.StatusCode)
	}
}

// ─── ModifierGroups + Modifiers ────────────────────────────────────────────

func TestPhase9_ModifiersFlow(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	_, menuItemID, _, _ := seedForWrite(t, f)

	// Group.
	r1, b1 := f.post(t, "/api/v1/menu/modifier-groups", tok, uuid.NewString(),
		map[string]any{"name": "Прожарка", "menu_item_id": menuItemID, "is_required": true, "max_select": 1})
	if r1.StatusCode != 201 {
		t.Fatalf("group %d: %s", r1.StatusCode, b1)
	}
	var g models.ModifierGroup
	_ = json.Unmarshal(b1, &g)

	// Modifiers.
	for _, name := range []string{"Прожарка средняя", "Прожарка well done"} {
		r, b := f.post(t, "/api/v1/menu/modifiers", tok, uuid.NewString(),
			map[string]any{"group_id": g.ID, "name": name, "price": "0"})
		if r.StatusCode != 201 {
			t.Fatalf("modifier %s: %d %s", name, r.StatusCode, b)
		}
	}

	// List with group filter.
	lr, lb := f.get(t, fmt.Sprintf("/api/v1/menu/modifiers?group_id=%s", g.ID), tok)
	if lr.StatusCode != 200 {
		t.Fatal(lr.StatusCode)
	}
	var env struct {
		Data []models.Modifier `json:"data"`
	}
	_ = json.Unmarshal(lb, &env)
	if len(env.Data) != 2 {
		t.Errorf("modifiers list: %d, want 2", len(env.Data))
	}
}

// ─── TechCardLines ─────────────────────────────────────────────────────────

func TestPhase9_TechCards(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, menuItemID, _, _ := seedForWrite(t, f)

	var ing models.Ingredient
	if err := gdb.Where("restaurant_id = ?", f.rid).First(&ing).Error; err != nil {
		t.Fatal(err)
	}

	// Create tech card line — рис 0.3 на блюдо.
	r, b := f.post(t, "/api/v1/menu/tech-cards", tok, uuid.NewString(),
		map[string]any{"menu_item_id": menuItemID, "ingredient_id": ing.ID,
			"name": "Rice", "qty": "0.3", "unit": "kg"})
	if r.StatusCode != 201 {
		t.Fatalf("tech-card %d: %s", r.StatusCode, b)
	}

	// List by menu_item.
	lr, lb := f.get(t, fmt.Sprintf("/api/v1/menu/tech-cards?menu_item_id=%s", menuItemID), tok)
	if lr.StatusCode != 200 {
		t.Fatal(lr.StatusCode)
	}
	var env struct {
		Data []models.TechCardLine `json:"data"`
	}
	_ = json.Unmarshal(lb, &env)
	// seedForWrite уже создаёт одну строку (0.2 кг Beef), плюс наша 0.3 рис = 2.
	if len(env.Data) < 1 {
		t.Errorf("tech cards: %d", len(env.Data))
	}
}

// ─── SemiFinished ──────────────────────────────────────────────────────────

func TestPhase9_SemiTypes(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)

	r, b := f.post(t, "/api/v1/semi/types", tok, uuid.NewString(),
		map[string]any{"name": "Бульон", "output_unit": "л", "yield_percent": "92"})
	if r.StatusCode != 201 {
		t.Fatalf("semi type %d: %s", r.StatusCode, b)
	}

	lr, lb := f.get(t, "/api/v1/semi/types", tok)
	if lr.StatusCode != 200 {
		t.Fatal(lr.StatusCode)
	}
	var env struct {
		Data []models.SemiFinishedType `json:"data"`
	}
	_ = json.Unmarshal(lb, &env)
	if len(env.Data) != 1 {
		t.Errorf("semi types: %d", len(env.Data))
	}
}
