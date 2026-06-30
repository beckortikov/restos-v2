//go:build integration

package http_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"testing"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/db"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// loginRid логинится в конкретный ресторан (помимо f.rid) и возвращает токен.
func loginRid(t *testing.T, srvURL, rid, pin string) string {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"restaurant_id": rid, "pin": pin})
	resp, err := http.Post(srvURL+"/api/v1/auth/login", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("login %s: %d %s", rid, resp.StatusCode, b)
	}
	var out struct {
		Token string `json:"token"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return out.Token
}

// TestTransfers_HTTP — сквозной HTTP-тест перемещений (ADR-003, Фаза 1):
// проверяет роутинг, реальный auth-путь (restaurant_id из токена в контекст)
// и деривацию сети из ресторана-источника.
func TestTransfers_HTTP(t *testing.T) {
	f := setupE2E(t)
	gdb, _ := db.Open(testDSN())
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})

	// Превращаем дефолтный ресторан в центральный склад сети.
	accountID := uuid.NewString()
	if err := gdb.Create(&models.CompanyAccount{ID: accountID, Name: "Сеть"}).Error; err != nil {
		t.Fatal(err)
	}
	cw := "central_warehouse"
	if err := gdb.Model(&models.Restaurant{}).Where("id = ?", f.rid).
		Updates(map[string]any{"account_id": accountID, "kind": cw}).Error; err != nil {
		t.Fatal(err)
	}

	// Филиал-получатель + кассир с тем же PIN.
	outletID := uuid.NewString()
	ot := "outlet"
	if err := gdb.Create(&models.Restaurant{ID: outletID, Name: "Филиал", AccountID: &accountID, Kind: &ot}).Error; err != nil {
		t.Fatal(err)
	}
	uname, pin, role := "Касса2", "1234", "cashier"
	if err := gdb.Create(&models.User{ID: uuid.NewString(), Name: &uname, PIN: &pin, Role: &role, RestaurantID: &outletID}).Error; err != nil {
		t.Fatal(err)
	}

	// Номенклатура + ингредиент источника (qty 100).
	nomID := uuid.NewString()
	meat, kg := "Мясо", "kg"
	if err := gdb.Create(&models.Nomenclature{ID: nomID, AccountID: &accountID, Name: meat, Unit: &kg}).Error; err != nil {
		t.Fatal(err)
	}
	srcIngID := uuid.NewString()
	if err := gdb.Create(&models.Ingredient{
		ID: srcIngID, Name: &meat, Unit: &kg, Qty: decimal.MustFromString("100"),
		PricePerUnit: decimal.MustFromString("20"), RestaurantID: &f.rid, NomenclatureID: &nomID,
	}).Error; err != nil {
		t.Fatal(err)
	}

	centralTok := f.login(t)
	outletTok := loginRid(t, f.srv.URL, outletID, "1234")

	// ─── Отправка (центральный склад) ────────────────────────────────────
	r, b := f.post(t, "/api/v1/stock/transfers", centralTok, uuid.NewString(), map[string]any{
		"to_restaurant_id": outletID,
		"lines":            []map[string]any{{"ingredient_id": srcIngID, "qty": "30"}},
	})
	if r.StatusCode != 201 {
		t.Fatalf("create transfer %d: %s", r.StatusCode, b)
	}
	var tr models.StockTransfer
	_ = json.Unmarshal(b, &tr)
	if tr.Status != "sent" {
		t.Errorf("status = %s, want sent", tr.Status)
	}
	if len(tr.Lines) != 1 {
		t.Errorf("lines = %d, want 1", len(tr.Lines))
	}

	// ─── Приём (филиал) ──────────────────────────────────────────────────
	rr, rb := f.post(t, fmt.Sprintf("/api/v1/stock/transfers/%s/receive", tr.ID), outletTok, uuid.NewString(), nil)
	if rr.StatusCode != 200 {
		t.Fatalf("receive %d: %s", rr.StatusCode, rb)
	}
	var got models.StockTransfer
	_ = json.Unmarshal(rb, &got)
	if got.Status != "received" {
		t.Errorf("status = %s, want received", got.Status)
	}

	// Остаток источника 70, у получателя появился ингредиент с qty 30.
	var src, dest models.Ingredient
	gdb.First(&src, "id = ?", srcIngID)
	if !src.Qty.Equal(decimal.MustFromString("70")) {
		t.Errorf("source qty = %s, want 70", src.Qty.String())
	}
	if err := gdb.Where("restaurant_id = ? AND nomenclature_id = ?", outletID, nomID).First(&dest).Error; err != nil {
		t.Fatalf("dest ingredient not created: %v", err)
	}
	if !dest.Qty.Equal(decimal.MustFromString("30")) {
		t.Errorf("dest qty = %s, want 30", dest.Qty.String())
	}

	// ─── Список у получателя ─────────────────────────────────────────────
	lr, lb := f.get(t, "/api/v1/stock/transfers", outletTok)
	if lr.StatusCode != 200 {
		t.Fatalf("list %d: %s", lr.StatusCode, lb)
	}
	var env struct {
		Data []models.StockTransfer `json:"data"`
	}
	_ = json.Unmarshal(lb, &env)
	if len(env.Data) != 1 {
		t.Errorf("list len = %d, want 1", len(env.Data))
	}
}
