//go:build integration

package http_test

import (
	"encoding/json"
	"io"
	"net/http"
	"testing"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/db"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// menuNames — GET /menu/items с опциональным X-Branch-Id, вернуть имена блюд.
func menuNames(t *testing.T, srvURL, tok, branchID string) []string {
	t.Helper()
	req, _ := http.NewRequest("GET", srvURL+"/api/v1/menu/items?limit=200", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	if branchID != "" {
		req.Header.Set("X-Branch-Id", branchID)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	var env struct {
		Data []struct {
			Name string `json:"name"`
		} `json:"data"`
	}
	_ = json.Unmarshal(b, &env)
	out := make([]string, 0, len(env.Data))
	for _, d := range env.Data {
		out = append(out, d.Name)
	}
	return out
}

func has(names []string, name string) bool {
	for _, n := range names {
		if n == name {
			return true
		}
	}
	return false
}

// TestBranchOverride — владелец сети через X-Branch-Id смотрит меню другого
// филиала СВОЕЙ сети; не-owner и чужая сеть — override игнорируется (ADR-003 Ф4).
func TestBranchOverride(t *testing.T) {
	f := setupE2E(t) // создаёт ресторан f.rid + кассир pin 1234 + "Plov"
	gdb, _ := db.Open(testDSN())
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})

	// f.rid → центральный склад сети + owner-пользователь.
	accountID := uuid.NewString()
	gdb.Create(&models.CompanyAccount{ID: accountID, Name: "Сеть"})
	cw := "central_warehouse"
	gdb.Model(&models.Restaurant{}).Where("id = ?", f.rid).Updates(map[string]any{"account_id": accountID, "kind": cw})
	ownerName, ownerPin, ownerRole := "Владелец", "9999", "owner"
	gdb.Create(&models.User{ID: uuid.NewString(), Name: &ownerName, PIN: &ownerPin, Role: &ownerRole, RestaurantID: &f.rid})

	// Филиал той же сети + его блюдо.
	outletID := uuid.NewString()
	ot := "outlet"
	gdb.Create(&models.Restaurant{ID: outletID, Name: "Филиал", AccountID: &accountID, Kind: &ot})
	outletDish := "OutletDish"
	gdb.Create(&models.MenuItem{ID: uuid.NewString(), Name: &outletDish, Price: decimal.MustFromString("10"), RestaurantID: &outletID})

	// Ресторан ДРУГОЙ сети + его блюдо (для проверки изоляции).
	otherID := uuid.NewString()
	otherAcc := uuid.NewString()
	gdb.Create(&models.CompanyAccount{ID: otherAcc, Name: "Чужая"})
	gdb.Create(&models.Restaurant{ID: otherID, Name: "Чужой", AccountID: &otherAcc})
	otherDish := "OtherDish"
	gdb.Create(&models.MenuItem{ID: uuid.NewString(), Name: &otherDish, Price: decimal.MustFromString("10"), RestaurantID: &otherID})

	ownerTok := loginRid(t, f.srv.URL, f.rid, "9999")
	cashierTok := f.login(t) // кассир pin 1234

	// ─── Без заголовка: свой ресторан (Plov, не OutletDish) ──────────────
	own := menuNames(t, f.srv.URL, ownerTok, "")
	if !has(own, "Plov") || has(own, outletDish) {
		t.Errorf("own menu = %v, want Plov без OutletDish", own)
	}

	// ─── Owner + X-Branch-Id=филиал: меню филиала ────────────────────────
	branch := menuNames(t, f.srv.URL, ownerTok, outletID)
	if !has(branch, outletDish) || has(branch, "Plov") {
		t.Errorf("branch menu = %v, want OutletDish без Plov", branch)
	}

	// ─── Гвард: кассир (не owner) — override игнорируется ────────────────
	asCashier := menuNames(t, f.srv.URL, cashierTok, outletID)
	if !has(asCashier, "Plov") || has(asCashier, outletDish) {
		t.Errorf("cashier override should be ignored: %v", asCashier)
	}

	// ─── Гвард: чужая сеть — override игнорируется ───────────────────────
	asOther := menuNames(t, f.srv.URL, ownerTok, otherID)
	if !has(asOther, "Plov") || has(asOther, otherDish) {
		t.Errorf("cross-network override should be ignored: %v", asOther)
	}

	// ─── Гвард: owner ФИЛИАЛА не может переключиться на central ──────────
	// У филиала своя отдельная БД (ADR-003) — в общей тестовой БД у него
	// нет реальных данных central, только доступ к тем же строкам, что и в
	// проде выглядели бы заглушками. Override обязан работать ТОЛЬКО с
	// central_warehouse (нашли вживую: филиал случайно выбрал central и
	// получил ложный экран активации лицензии через /license/status).
	branchOwnerName, branchOwnerPin, branchOwnerRole := "Управляющий филиала", "7777", "owner"
	gdb.Create(&models.User{ID: uuid.NewString(), Name: &branchOwnerName, PIN: &branchOwnerPin, Role: &branchOwnerRole, RestaurantID: &outletID})
	branchOwnerTok := loginRid(t, f.srv.URL, outletID, "7777")

	asBranchOwner := menuNames(t, f.srv.URL, branchOwnerTok, f.rid)
	if !has(asBranchOwner, outletDish) || has(asBranchOwner, "Plov") {
		t.Errorf("branch->central override should be ignored (not central_warehouse): %v", asBranchOwner)
	}

	// ─── Лицензия НИКОГДА не подменяется через X-Branch-Id ────────────────
	// central лицензирован (валиден 365 дней), у outlet license_expires_at
	// нарочно оставлен NULL (как заглушка в реальной cross-node строке).
	// Even valid central-owner override на outlet не должен утянуть его
	// пустой лицензионный статус на central-сессию — /license/* исключён
	// безусловно (см. BranchOverride).
	future := "now() + interval '365 days'"
	gdb.Exec("UPDATE restaurants SET license_expires_at = "+future+" WHERE id = ?", f.rid)
	withoutOverride := licenseState(t, f.srv.URL, ownerTok, "")
	withOverride := licenseState(t, f.srv.URL, ownerTok, outletID)
	if withoutOverride != "active" {
		t.Fatalf("central license state = %q, want active (test setup)", withoutOverride)
	}
	if withOverride != withoutOverride {
		t.Errorf("license/status changed under X-Branch-Id override: without=%q, with=%q (must always reflect the LOGGED-IN restaurant)", withoutOverride, withOverride)
	}
}

// licenseState — GET /license/status с опциональным X-Branch-Id, вернуть state.
func licenseState(t *testing.T, srvURL, tok, branchID string) string {
	t.Helper()
	req, _ := http.NewRequest("GET", srvURL+"/api/v1/license/status", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	if branchID != "" {
		req.Header.Set("X-Branch-Id", branchID)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	var out struct {
		State string `json:"state"`
	}
	_ = json.Unmarshal(b, &out)
	return out.State
}

// branchScopeHeader — GET по произвольному пути с опциональным X-Branch-Id,
// вернуть значение X-Branch-Data-Scope (пусто, если баннер не выставлен).
func branchScopeHeader(t *testing.T, srvURL, tok, branchID, path string) string {
	t.Helper()
	req, _ := http.NewRequest("GET", srvURL+path, nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	if branchID != "" {
		req.Header.Set("X-Branch-Id", branchID)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, resp.Body)
	return resp.Header.Get("X-Branch-Data-Scope")
}

// TestBranchOverride_BlocklistBanner — Ф7: инверсия allowlist→blocklist.
// /orders читает нетерминальные заказы (не реплицируются) — баннер обязателен.
// /finance/operations — только своя таблица, без JOIN — доступен по умолчанию,
// баннера НЕ должно быть, хотя раньше (allowlist-эпоха) он был бы, т.к. путь
// никогда явно не добавляли (см. Ф7-разведку в branch_override.go).
func TestBranchOverride_BlocklistBanner(t *testing.T) {
	f := setupE2E(t)
	gdb, _ := db.Open(testDSN())
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})

	accountID := uuid.NewString()
	gdb.Create(&models.CompanyAccount{ID: accountID, Name: "Сеть"})
	cw := "central_warehouse"
	gdb.Model(&models.Restaurant{}).Where("id = ?", f.rid).Updates(map[string]any{"account_id": accountID, "kind": cw})
	ownerName, ownerPin, ownerRole := "Владелец", "9999", "owner"
	gdb.Create(&models.User{ID: uuid.NewString(), Name: &ownerName, PIN: &ownerPin, Role: &ownerRole, RestaurantID: &f.rid})

	outletID := uuid.NewString()
	ot := "outlet"
	gdb.Create(&models.Restaurant{ID: outletID, Name: "Филиал", AccountID: &accountID, Kind: &ot})

	ownerTok := loginRid(t, f.srv.URL, f.rid, "9999")

	if got := branchScopeHeader(t, f.srv.URL, ownerTok, outletID, "/api/v1/orders?status=new"); got != "unavailable" {
		t.Errorf("/orders under override: X-Branch-Data-Scope = %q, want unavailable (нетерминальные заказы не реплицируются)", got)
	}
	if got := branchScopeHeader(t, f.srv.URL, ownerTok, outletID, "/api/v1/finance/operations"); got != "" {
		t.Errorf("/finance/operations under override: X-Branch-Data-Scope = %q, want пусто (default-allow, только своя таблица без JOIN)", got)
	}
	// Без override (свой ресторан) баннера быть не должно нигде.
	if got := branchScopeHeader(t, f.srv.URL, ownerTok, "", "/api/v1/orders"); got != "" {
		t.Errorf("/orders без override: X-Branch-Data-Scope = %q, want пусто", got)
	}
}

// TestBranchOverride_WarehousesNoPhantomRow — Ф7: /warehouses исключён из
// подмены tenant вовсе (noTenantSubstitution), а не просто помечен баннером —
// WarehouseService.List безусловно вызывает ensureWarehouses(rid), и под
// обычной подменой central создал бы себе фантомные строки склада с
// restaurant_id=outletID и случайными UUID, не связанными с реальными
// складами филиала (своя Postgres). Проверяем: баннер показан, НО ни одной
// строки warehouses с restaurant_id=outletID в БД central не появилось.
func TestBranchOverride_WarehousesNoPhantomRow(t *testing.T) {
	f := setupE2E(t)
	gdb, _ := db.Open(testDSN())
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})

	accountID := uuid.NewString()
	gdb.Create(&models.CompanyAccount{ID: accountID, Name: "Сеть"})
	cw := "central_warehouse"
	gdb.Model(&models.Restaurant{}).Where("id = ?", f.rid).Updates(map[string]any{"account_id": accountID, "kind": cw})
	ownerName, ownerPin, ownerRole := "Владелец", "9999", "owner"
	gdb.Create(&models.User{ID: uuid.NewString(), Name: &ownerName, PIN: &ownerPin, Role: &ownerRole, RestaurantID: &f.rid})

	outletID := uuid.NewString()
	ot := "outlet"
	gdb.Create(&models.Restaurant{ID: outletID, Name: "Филиал", AccountID: &accountID, Kind: &ot})

	ownerTok := loginRid(t, f.srv.URL, f.rid, "9999")

	if got := branchScopeHeader(t, f.srv.URL, ownerTok, outletID, "/api/v1/warehouses"); got != "unavailable" {
		t.Errorf("/warehouses under override: X-Branch-Data-Scope = %q, want unavailable", got)
	}

	var phantomCount int64
	if err := gdb.Model(&models.Warehouse{}).Where("restaurant_id = ?", outletID).Count(&phantomCount).Error; err != nil {
		t.Fatalf("count warehouses: %v", err)
	}
	if phantomCount != 0 {
		t.Errorf("warehouses с restaurant_id=%s (филиал) = %d, want 0 — override не должен был подменить tenant для /warehouses", outletID, phantomCount)
	}
}
