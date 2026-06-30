//go:build integration

package http_test

import (
	"encoding/json"
	"fmt"
	"testing"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/db"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// TestNetwork_HTTP — «правильный» сквозной поток multi-branch через API:
// список филиалов → создать номенклатуру → привязать ингредиент → отправить
// перемещение. Без пред-сидинга nomenclature/ingredient.nomenclature_id.
func TestNetwork_HTTP(t *testing.T) {
	f := setupE2E(t)
	gdb, _ := db.Open(testDSN())
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})

	// Сеть: f.rid → центральный склад, + филиал.
	accountID := uuid.NewString()
	if err := gdb.Create(&models.CompanyAccount{ID: accountID, Name: "Сеть"}).Error; err != nil {
		t.Fatal(err)
	}
	cw := "central_warehouse"
	gdb.Model(&models.Restaurant{}).Where("id = ?", f.rid).Updates(map[string]any{"account_id": accountID, "kind": cw})
	outletID := uuid.NewString()
	ot := "outlet"
	if err := gdb.Create(&models.Restaurant{ID: outletID, Name: "Филиал", AccountID: &accountID, Kind: &ot}).Error; err != nil {
		t.Fatal(err)
	}

	// Ингредиент источника БЕЗ nomenclature_id (привяжем через API).
	meat, kg := "Мясо", "kg"
	srcIngID := uuid.NewString()
	if err := gdb.Create(&models.Ingredient{
		ID: srcIngID, Name: &meat, Unit: &kg, Qty: decimal.MustFromString("100"),
		PricePerUnit: decimal.MustFromString("20"), RestaurantID: &f.rid,
	}).Error; err != nil {
		t.Fatal(err)
	}

	tok := f.login(t)

	// ─── Филиалы сети ────────────────────────────────────────────────────
	br, bb := f.get(t, "/api/v1/network/branches", tok)
	if br.StatusCode != 200 {
		t.Fatalf("branches %d: %s", br.StatusCode, bb)
	}
	var branchEnv struct {
		Data []map[string]any `json:"data"`
	}
	_ = json.Unmarshal(bb, &branchEnv)
	if len(branchEnv.Data) != 2 {
		t.Errorf("branches = %d, want 2", len(branchEnv.Data))
	}

	// ─── Создать номенклатуру ────────────────────────────────────────────
	nr, nbody := f.post(t, "/api/v1/nomenclature", tok, uuid.NewString(), map[string]any{"name": "Мясо", "unit": "kg"})
	if nr.StatusCode != 201 {
		t.Fatalf("create nomenclature %d: %s", nr.StatusCode, nbody)
	}
	var nom models.Nomenclature
	_ = json.Unmarshal(nbody, &nom)
	if nom.ID == "" {
		t.Fatal("empty nomenclature id")
	}

	// ─── Привязать ингредиент ────────────────────────────────────────────
	lr, lb := f.post(t, fmt.Sprintf("/api/v1/stock/ingredients/%s/nomenclature", srcIngID), tok, uuid.NewString(),
		map[string]any{"nomenclature_id": nom.ID})
	if lr.StatusCode != 200 {
		t.Fatalf("link ingredient %d: %s", lr.StatusCode, lb)
	}

	// ─── Теперь перемещение проходит ─────────────────────────────────────
	tr, tb := f.post(t, "/api/v1/stock/transfers", tok, uuid.NewString(), map[string]any{
		"to_restaurant_id": outletID,
		"lines":            []map[string]any{{"ingredient_id": srcIngID, "qty": "10"}},
	})
	if tr.StatusCode != 201 {
		t.Fatalf("transfer after link %d: %s", tr.StatusCode, tb)
	}
}
