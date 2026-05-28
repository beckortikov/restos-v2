//go:build integration

package http_test

import (
	"crypto/ed25519"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/db"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
	"github.com/restos/restos-v4/server/internal/pkg/license"
	httpx "github.com/restos/restos-v4/server/internal/transport/http"
)

// licenseFixture — расширенная e2e с известным keypair, чтобы можно было
// выписывать тестовые токены.
type licenseFixture struct {
	srv  *httptest.Server
	rid  string
	pin  string
	priv ed25519.PrivateKey
	pub  ed25519.PublicKey
	gdb  *gorm.DB
}

func setupLicense(t *testing.T) *licenseFixture {
	t.Helper()
	gdb, err := db.Open(testDSN())
	if err != nil {
		t.Fatal(err)
	}
	if err := db.MigrateUp(t.Context(), gdb); err != nil {
		t.Fatal(err)
	}
	for _, tbl := range []string{
		"audit_log", "print_jobs", "printers",
		"order_item_modifiers", "order_voids", "order_items", "orders",
		"sessions", "menu_items", "users", "restaurants",
	} {
		if err := gdb.Exec("DELETE FROM " + tbl).Error; err != nil {
			t.Fatal(err)
		}
	}

	rid := uuid.NewString()
	if err := gdb.Create(&models.Restaurant{ID: rid, Name: "Lic"}).Error; err != nil {
		t.Fatal(err)
	}
	name := "Cashier"
	pin := "1234"
	if err := gdb.Create(&models.User{
		ID: uuid.NewString(), Name: &name, PIN: &pin, RestaurantID: &rid,
	}).Error; err != nil {
		t.Fatal(err)
	}
	itemName := "Plov"
	if err := gdb.Create(&models.MenuItem{
		Name: &itemName, Price: decimal.MustFromString("25"), RestaurantID: &rid,
	}).Error; err != nil {
		t.Fatal(err)
	}

	pub, priv, _ := license.GenerateKeypair()

	router := httpx.NewRouter(httpx.Deps{
		DB:               gdb,
		Build:            httpx.BuildInfo{Version: "test"},
		LicensePublicKey: pub,
	})
	srv := httptest.NewServer(router)
	t.Cleanup(func() {
		srv.Close()
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})

	return &licenseFixture{srv: srv, rid: rid, pin: pin, priv: priv, pub: pub, gdb: gdb}
}

func (f *licenseFixture) toE2E() *e2eFixture {
	return &e2eFixture{srv: f.srv, rid: f.rid, pin: f.pin}
}

func TestPhase7_StatusNone(t *testing.T) {
	lf := setupLicense(t)
	f := lf.toE2E()
	tok := f.login(t)

	resp, body := f.get(t, "/api/v1/license/status", tok)
	if resp.StatusCode != 200 {
		t.Fatalf("status %d: %s", resp.StatusCode, body)
	}
	var st struct {
		State string `json:"state"`
	}
	_ = json.Unmarshal(body, &st)
	if st.State != "none" {
		t.Errorf("state = %s, want none", st.State)
	}
}

func TestPhase7_ActivateAndStatus(t *testing.T) {
	lf := setupLicense(t)
	f := lf.toE2E()
	tok := f.login(t)

	// Выписываем токен на 30 дней.
	now := time.Now().UTC()
	licTok, err := license.Sign(lf.priv, license.Payload{
		Version:      license.CurrentVersion,
		RestaurantID: lf.rid,
		IssuedAt:     now,
		ExpiresAt:    now.AddDate(0, 0, 30),
		Edition:      license.EditionPro,
	})
	if err != nil {
		t.Fatal(err)
	}

	resp, body := f.post(t, "/api/v1/license/activate", tok, uuid.NewString(),
		map[string]any{"token": licTok})
	// Без idempotency_keys (group не имеет middleware) — но post всё равно ставит header. License не в idempotent group → header игнорируется.
	if resp.StatusCode != 200 {
		t.Fatalf("activate %d: %s", resp.StatusCode, body)
	}
	var st struct {
		State    string `json:"state"`
		DaysLeft int    `json:"days_left"`
	}
	_ = json.Unmarshal(body, &st)
	if st.State != "active" {
		t.Errorf("state = %s, want active", st.State)
	}
	if st.DaysLeft < 29 || st.DaysLeft > 30 {
		t.Errorf("days_left = %d, want 29..30", st.DaysLeft)
	}
}

func TestPhase7_ActivateWrongRestaurant(t *testing.T) {
	lf := setupLicense(t)
	f := lf.toE2E()
	tok := f.login(t)

	licTok, _ := license.Sign(lf.priv, license.Payload{
		Version:      license.CurrentVersion,
		RestaurantID: "other-restaurant",
		ExpiresAt:    time.Now().Add(24 * time.Hour),
	})
	resp, _ := f.post(t, "/api/v1/license/activate", tok, uuid.NewString(),
		map[string]any{"token": licTok})
	if resp.StatusCode != 400 {
		t.Errorf("wrong rid expected 400, got %d", resp.StatusCode)
	}
}

func TestPhase7_ActivateBadSignature(t *testing.T) {
	lf := setupLicense(t)
	f := lf.toE2E()
	tok := f.login(t)

	// Токен подписан ДРУГИМ keypair.
	_, otherPriv, _ := license.GenerateKeypair()
	licTok, _ := license.Sign(otherPriv, license.Payload{
		Version: license.CurrentVersion, RestaurantID: lf.rid,
		ExpiresAt: time.Now().Add(time.Hour),
	})
	resp, _ := f.post(t, "/api/v1/license/activate", tok, uuid.NewString(),
		map[string]any{"token": licTok})
	if resp.StatusCode != 400 {
		t.Errorf("bad signature expected 400, got %d", resp.StatusCode)
	}
}

func TestPhase7_WriteBlockedWhenLocked(t *testing.T) {
	lf := setupLicense(t)
	f := lf.toE2E()
	tok := f.login(t)

	// Вручную выставим expires в далёкое прошлое (>14 дней — locked).
	expired := time.Now().Add(-30 * 24 * time.Hour)
	if err := lf.gdb.Model(&models.Restaurant{}).
		Where("id = ?", lf.rid).
		Update("license_expires_at", expired).Error; err != nil {
		t.Fatal(err)
	}

	// Read доступен.
	rResp, _ := f.get(t, "/api/v1/menu/items", tok)
	if rResp.StatusCode != 200 {
		t.Errorf("read should still work, got %d", rResp.StatusCode)
	}

	// Write — 403 LICENSE_LOCKED.
	wResp, body := f.post(t, "/api/v1/menu/items", tok, uuid.NewString(),
		map[string]any{"name": "X", "price": "10"})
	if wResp.StatusCode != 403 {
		t.Fatalf("write expected 403, got %d: %s", wResp.StatusCode, body)
	}
	var env struct{ Code string }
	_ = json.Unmarshal(body, &env)
	if env.Code != "LICENSE_LOCKED" {
		t.Errorf("error code = %s, want LICENSE_LOCKED", env.Code)
	}

	// /license/status и /activate доступны (read group + license-activate в read group).
	stResp, _ := f.get(t, "/api/v1/license/status", tok)
	if stResp.StatusCode != 200 {
		t.Errorf("status should work in locked, got %d", stResp.StatusCode)
	}

	// Новый валидный токен → активация → разблокировка.
	now := time.Now().UTC()
	licTok, _ := license.Sign(lf.priv, license.Payload{
		Version: license.CurrentVersion, RestaurantID: lf.rid,
		IssuedAt: now, ExpiresAt: now.AddDate(0, 0, 30), Edition: license.EditionPro,
	})
	actResp, _ := f.post(t, "/api/v1/license/activate", tok, uuid.NewString(),
		map[string]any{"token": licTok})
	if actResp.StatusCode != 200 {
		t.Fatal(actResp.StatusCode)
	}

	// Теперь write проходит.
	wResp2, _ := f.post(t, "/api/v1/menu/items", tok, uuid.NewString(),
		map[string]any{"name": "Y", "price": "10"})
	if wResp2.StatusCode != 201 {
		t.Errorf("write after activate expected 201, got %d", wResp2.StatusCode)
	}
}

func TestPhase7_GraceState(t *testing.T) {
	lf := setupLicense(t)
	f := lf.toE2E()
	tok := f.login(t)

	// Истёк 3 дня назад → grace.
	expired := time.Now().Add(-3 * 24 * time.Hour)
	if err := lf.gdb.Model(&models.Restaurant{}).
		Where("id = ?", lf.rid).
		Update("license_expires_at", expired).Error; err != nil {
		t.Fatal(err)
	}
	resp, body := f.get(t, "/api/v1/license/status", tok)
	if resp.StatusCode != 200 {
		t.Fatal(resp.StatusCode)
	}
	var st struct {
		State string `json:"state"`
	}
	_ = json.Unmarshal(body, &st)
	if st.State != "grace" {
		t.Errorf("3 days expired → expected grace, got %s", st.State)
	}

	// Write должен работать в grace.
	wResp, _ := f.post(t, "/api/v1/menu/items", tok, uuid.NewString(),
		map[string]any{"name": "Grace-allowed", "price": "10"})
	if wResp.StatusCode != 201 {
		t.Errorf("write in grace expected 201, got %d", wResp.StatusCode)
	}
}

// Suppress unused for http.MethodPost.
var _ = http.MethodPost
