//go:build integration

package http_test

import (
	"encoding/json"
	"fmt"
	"testing"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// ─── Ingredients CRUD ──────────────────────────────────────────────────────

func TestPhase11_IngredientsCRUD(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)

	// Create — без qty.
	r, b := f.post(t, "/api/v1/stock/ingredients", tok, uuid.NewString(),
		map[string]any{"name": "Сахар", "unit": "kg", "category": "Бакалея"})
	if r.StatusCode != 201 {
		t.Fatalf("create %d: %s", r.StatusCode, b)
	}
	var ing models.Ingredient
	_ = json.Unmarshal(b, &ing)
	if ing.Name == nil || *ing.Name != "Сахар" {
		t.Errorf("name mismatch: %+v", ing)
	}
	if !ing.Qty.IsZero() {
		t.Errorf("expected qty=0 (no initial), got %s", ing.Qty.String())
	}

	// Create — с initial qty (StockMovement создаётся в той же tx).
	r2, b2 := f.post(t, "/api/v1/stock/ingredients", tok, uuid.NewString(),
		map[string]any{"name": "Соль", "unit": "kg", "qty": "5.5"})
	if r2.StatusCode != 201 {
		t.Fatalf("create with initial qty %d: %s", r2.StatusCode, b2)
	}
	var salt models.Ingredient
	_ = json.Unmarshal(b2, &salt)
	if !salt.Qty.Equal(decimal.MustFromString("5.5")) {
		t.Errorf("initial qty = %s, want 5.5", salt.Qty.String())
	}

	// Patch — qty запрещён.
	pr, _ := f.patch(t, fmt.Sprintf("/api/v1/stock/ingredients/%s", ing.ID), tok, uuid.NewString(),
		map[string]any{"qty": "10"})
	if pr.StatusCode != 400 {
		t.Errorf("patch qty: %d, want 400", pr.StatusCode)
	}

	// Patch — обычные поля OK.
	pr2, pb2 := f.patch(t, fmt.Sprintf("/api/v1/stock/ingredients/%s", ing.ID), tok, uuid.NewString(),
		map[string]any{"min_qty": "3", "category": "Crystal"})
	if pr2.StatusCode != 200 {
		t.Fatalf("patch %d: %s", pr2.StatusCode, pb2)
	}
	var patched models.Ingredient
	_ = json.Unmarshal(pb2, &patched)
	if !patched.MinQty.Equal(decimal.MustFromString("3")) {
		t.Errorf("min_qty = %s, want 3", patched.MinQty.String())
	}

	// Delete — без referencing tech_card_line → OK.
	dr, _ := f.del(t, fmt.Sprintf("/api/v1/stock/ingredients/%s", ing.ID), tok, uuid.NewString())
	if dr.StatusCode != 204 {
		t.Errorf("delete %d", dr.StatusCode)
	}

	// Delete with tech_card_line → 409.
	gdb, _, _, _ := seedForWrite(t, f)
	var seeded models.Ingredient
	if err := gdb.Where("restaurant_id = ? AND name = ?", f.rid, "Rice").First(&seeded).Error; err != nil {
		t.Fatal(err)
	}
	dr2, db2 := f.del(t, fmt.Sprintf("/api/v1/stock/ingredients/%s", seeded.ID), tok, uuid.NewString())
	if dr2.StatusCode != 409 {
		t.Errorf("delete in-use: %d, want 409 (body=%s)", dr2.StatusCode, db2)
	}
}

// ─── Stock receipts confirm ────────────────────────────────────────────────

func TestPhase11_StockReceiptsConfirm(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, _, _ := seedForWrite(t, f)

	var ing models.Ingredient
	if err := gdb.Where("restaurant_id = ?", f.rid).First(&ing).Error; err != nil {
		t.Fatal(err)
	}

	// Create receipt with payment_type=credit (на создании уже создаётся как credit).
	supplierName := "Acme Supplies"
	cr, cb := f.post(t, "/api/v1/stock/receipts", tok, uuid.NewString(),
		map[string]any{
			"payment_type":  "credit",
			"supplier_name": supplierName,
			"lines": []map[string]any{
				{"ingredient_id": ing.ID, "name": "Rice", "qty": "10", "price_per_unit": "2"},
			},
		})
	if cr.StatusCode != 201 {
		t.Fatalf("create receipt %d: %s", cr.StatusCode, cb)
	}
	var receipt models.StockReceipt
	_ = json.Unmarshal(cb, &receipt)
	if !receipt.DebtAmount.Equal(decimal.MustFromString("20")) {
		t.Errorf("debt_amount = %s, want 20", receipt.DebtAmount.String())
	}

	// Confirm с credit — создаст Liability.
	confirmPath := fmt.Sprintf("/api/v1/stock/receipts/%s/confirm", receipt.ID)
	conr, conb := f.post(t, confirmPath, tok, uuid.NewString(),
		map[string]any{"payment_type": "credit"})
	if conr.StatusCode != 200 {
		t.Fatalf("confirm %d: %s", conr.StatusCode, conb)
	}

	// Verify liability.
	var liabilities []models.Liability
	if err := gdb.Where("restaurant_id = ?", f.rid).Find(&liabilities).Error; err != nil {
		t.Fatal(err)
	}
	found := false
	for _, l := range liabilities {
		if l.Note != nil && *l.Note == "stock_receipt:"+receipt.ID {
			found = true
			if !l.TotalAmount.Equal(decimal.MustFromString("20")) {
				t.Errorf("liability total = %s, want 20", l.TotalAmount.String())
			}
		}
	}
	if !found {
		t.Errorf("liability for credit receipt not created (got %d)", len(liabilities))
	}
}

// ─── Stock movements list ──────────────────────────────────────────────────

func TestPhase11_StockMovementsList(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, _, _ := seedForWrite(t, f)

	var ing models.Ingredient
	if err := gdb.Where("restaurant_id = ?", f.rid).First(&ing).Error; err != nil {
		t.Fatal(err)
	}

	// Создаём приёмку → появится StockMovement type=receipt.
	rr, rb := f.post(t, "/api/v1/stock/receipts", tok, uuid.NewString(),
		map[string]any{
			"payment_type": "paid",
			"lines": []map[string]any{
				{"ingredient_id": ing.ID, "name": "Rice", "qty": "4", "price_per_unit": "2"},
			},
		})
	if rr.StatusCode != 201 {
		t.Fatalf("receipt %d: %s", rr.StatusCode, rb)
	}

	// List movements.
	lr, lb := f.get(t, "/api/v1/stock/movements?ingredient_id="+ing.ID, tok)
	if lr.StatusCode != 200 {
		t.Fatalf("movements list %d: %s", lr.StatusCode, lb)
	}
	var env struct {
		Data []models.StockMovement `json:"data"`
	}
	_ = json.Unmarshal(lb, &env)
	if len(env.Data) < 1 {
		t.Errorf("expected >=1 movement, got %d", len(env.Data))
	}
	hasReceipt := false
	for _, m := range env.Data {
		if m.Type != nil && *m.Type == "receipt" {
			hasReceipt = true
		}
	}
	if !hasReceipt {
		t.Errorf("no movement type=receipt found")
	}
}

// ─── SupplyExpenses ────────────────────────────────────────────────────────

func TestPhase11_SupplyExpenses(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, _, _ := seedForWrite(t, f)

	var ing models.Ingredient
	if err := gdb.Where("restaurant_id = ?", f.rid).First(&ing).Error; err != nil {
		t.Fatal(err)
	}
	before := ing.Qty

	cr, cb := f.post(t, "/api/v1/supply-expenses", tok, uuid.NewString(),
		map[string]any{
			"ingredient_id": ing.ID,
			"qty":           "1.5",
			"reason":        "hozyaystvennye",
		})
	if cr.StatusCode != 201 {
		t.Fatalf("create %d: %s", cr.StatusCode, cb)
	}

	// Ingredient.qty уменьшено через хук на StockMovement.
	var after models.Ingredient
	gdb.First(&after, "id = ?", ing.ID)
	want := decimal.Normalize(decimal.Sub(before, decimal.MustFromString("1.5")))
	if !after.Qty.Equal(want) {
		t.Errorf("after expense qty = %s, want %s", after.Qty.String(), want.String())
	}

	// List.
	lr, lb := f.get(t, "/api/v1/supply-expenses?ingredient_id="+ing.ID, tok)
	if lr.StatusCode != 200 {
		t.Fatalf("list %d: %s", lr.StatusCode, lb)
	}
	var env struct {
		Data []models.SupplyExpense `json:"data"`
	}
	_ = json.Unmarshal(lb, &env)
	if len(env.Data) != 1 {
		t.Errorf("expected 1 expense, got %d", len(env.Data))
	}
}

// ─── Ingredient categories ─────────────────────────────────────────────────

func TestPhase11_IngredientCategories(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)

	// Создаём ингредиенты с разными категориями.
	for _, payload := range []map[string]any{
		{"name": "Сахар", "unit": "kg", "category": "Бакалея"},
		{"name": "Мука", "unit": "kg", "category": "Бакалея"},
		{"name": "Молоко", "unit": "l", "category": "Молочка"},
	} {
		r, b := f.post(t, "/api/v1/stock/ingredients", tok, uuid.NewString(), payload)
		if r.StatusCode != 201 {
			t.Fatalf("create %d: %s", r.StatusCode, b)
		}
	}

	lr, lb := f.get(t, "/api/v1/stock/ingredient-categories", tok)
	if lr.StatusCode != 200 {
		t.Fatalf("categories %d: %s", lr.StatusCode, lb)
	}
	var env struct {
		Data []string `json:"data"`
	}
	_ = json.Unmarshal(lb, &env)
	if len(env.Data) != 2 {
		t.Errorf("expected 2 unique categories, got %d (%v)", len(env.Data), env.Data)
	}
	if len(env.Data) >= 2 && env.Data[0] != "Бакалея" {
		t.Errorf("expected sorted, got %v", env.Data)
	}
}

// ─── Inventory list + lines ────────────────────────────────────────────────

func TestPhase11_InventoryList(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, _, _ := seedForWrite(t, f)

	var ing models.Ingredient
	if err := gdb.Where("restaurant_id = ?", f.rid).First(&ing).Error; err != nil {
		t.Fatal(err)
	}

	// Create draft inventory.
	cr, cb := f.post(t, "/api/v1/stock/inventory", tok, uuid.NewString(),
		map[string]any{
			"note":  "weekly",
			"lines": []map[string]any{{"ingredient_id": ing.ID, "actual_qty": "9"}},
		})
	if cr.StatusCode != 201 {
		t.Fatalf("create %d: %s", cr.StatusCode, cb)
	}
	var check models.InventoryCheck
	_ = json.Unmarshal(cb, &check)

	// List.
	lr, lb := f.get(t, "/api/v1/stock/inventory", tok)
	if lr.StatusCode != 200 {
		t.Fatalf("list %d: %s", lr.StatusCode, lb)
	}
	var env struct {
		Data []models.InventoryCheck `json:"data"`
	}
	_ = json.Unmarshal(lb, &env)
	if len(env.Data) != 1 {
		t.Errorf("expected 1 check, got %d", len(env.Data))
	}

	// Get one.
	gr, gb := f.get(t, fmt.Sprintf("/api/v1/stock/inventory/%s", check.ID), tok)
	if gr.StatusCode != 200 {
		t.Fatalf("get %d: %s", gr.StatusCode, gb)
	}

	// Get lines.
	llr, llb := f.get(t, fmt.Sprintf("/api/v1/stock/inventory/%s/lines", check.ID), tok)
	if llr.StatusCode != 200 {
		t.Fatalf("lines %d: %s", llr.StatusCode, llb)
	}
	var lenv struct {
		Data []models.InventoryCheckLine `json:"data"`
	}
	_ = json.Unmarshal(llb, &lenv)
	if len(lenv.Data) != 1 {
		t.Errorf("expected 1 line, got %d", len(lenv.Data))
	}
}
