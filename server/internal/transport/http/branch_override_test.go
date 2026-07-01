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
}
