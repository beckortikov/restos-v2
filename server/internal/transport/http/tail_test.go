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

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// patch — PATCH-helper аналогичный post.
func (f *e2eFixture) patch(t *testing.T, path, token, idemKey string, body any) (*http.Response, []byte) {
	t.Helper()
	b, _ := json.Marshal(body)
	req, _ := http.NewRequest("PATCH", f.srv.URL+path, bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if idemKey != "" {
		req.Header.Set("Idempotency-Key", idemKey)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	rb, _ := io.ReadAll(resp.Body)
	return resp, rb
}

func (f *e2eFixture) del(t *testing.T, path, token, idemKey string) (*http.Response, []byte) {
	t.Helper()
	req, _ := http.NewRequest("DELETE", f.srv.URL+path, nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if idemKey != "" {
		req.Header.Set("Idempotency-Key", idemKey)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	rb, _ := io.ReadAll(resp.Body)
	return resp, rb
}

// TestTail_StockDenormOnReceipt — приёмка должна увеличивать ingredients.qty.
func TestTail_StockDenormOnReceipt(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, _, _ := seedForWrite(t, f)

	var ing models.Ingredient
	if err := gdb.Where("restaurant_id = ?", f.rid).First(&ing).Error; err != nil {
		t.Fatal(err)
	}
	before := ing.Qty

	resp, body := f.post(t, "/api/v1/stock/receipts", tok, uuid.NewString(),
		map[string]any{
			"payment_type": "paid",
			"lines": []map[string]any{
				{"ingredient_id": ing.ID, "name": "Rice", "qty": "3.5", "price_per_unit": "5"},
			},
		})
	if resp.StatusCode != 201 {
		t.Fatalf("receipt %d: %s", resp.StatusCode, body)
	}

	var after models.Ingredient
	if err := gdb.First(&after, "id = ?", ing.ID).Error; err != nil {
		t.Fatal(err)
	}
	want := decimal.Normalize(decimal.Add(before, decimal.MustFromString("3.5")))
	if !after.Qty.Equal(want) {
		t.Errorf("after receipt qty = %s, want %s (was %s)", after.Qty.String(), want.String(), before.String())
	}
}

// TestTail_StockDenormOnWriteoff — списание уменьшает qty.
func TestTail_StockDenormOnWriteoff(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, _, _ := seedForWrite(t, f)

	var ing models.Ingredient
	if err := gdb.Where("restaurant_id = ?", f.rid).First(&ing).Error; err != nil {
		t.Fatal(err)
	}
	before := ing.Qty

	resp, body := f.post(t, "/api/v1/stock/writeoffs", tok, uuid.NewString(),
		map[string]any{
			"reason": "porchu",
			"lines": []map[string]any{
				{"ingredient_id": ing.ID, "name": "Rice", "qty": "2", "cost": "10"},
			},
		})
	if resp.StatusCode != 201 {
		t.Fatalf("writeoff %d: %s", resp.StatusCode, body)
	}

	var after models.Ingredient
	gdb.First(&after, "id = ?", ing.ID)
	want := decimal.Normalize(decimal.Sub(before, decimal.MustFromString("2")))
	if !after.Qty.Equal(want) {
		t.Errorf("after writeoff qty = %s, want %s", after.Qty.String(), want.String())
	}
}

// TestTail_MenuItemCRUD — POST → PATCH → DELETE (soft).
func TestTail_MenuItemCRUD(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)

	// CREATE
	resp, body := f.post(t, "/api/v1/menu/items", tok, uuid.NewString(),
		map[string]any{
			"name":  "Borsch",
			"price": "30",
		})
	if resp.StatusCode != 201 {
		t.Fatalf("create %d: %s", resp.StatusCode, body)
	}
	var mi models.MenuItem
	_ = json.Unmarshal(body, &mi)
	if mi.Name == nil || *mi.Name != "Borsch" || !mi.Price.Equal(decimal.MustFromString("30")) {
		t.Errorf("bad created item: %+v", mi)
	}

	// PATCH (только цена)
	patchPath := fmt.Sprintf("/api/v1/menu/items/%s", mi.ID)
	resp2, body2 := f.patch(t, patchPath, tok, uuid.NewString(),
		map[string]any{"price": "35"})
	if resp2.StatusCode != 200 {
		t.Fatalf("patch %d: %s", resp2.StatusCode, body2)
	}
	var patched models.MenuItem
	_ = json.Unmarshal(body2, &patched)
	if !patched.Price.Equal(decimal.MustFromString("35")) {
		t.Errorf("patched price = %s, want 35", patched.Price.String())
	}
	if patched.Name == nil || *patched.Name != "Borsch" {
		t.Errorf("name should be preserved on PATCH")
	}

	// DELETE (soft)
	resp3, _ := f.del(t, patchPath, tok, uuid.NewString())
	if resp3.StatusCode != 204 {
		t.Errorf("delete %d", resp3.StatusCode)
	}

	// GET list — softdeleted не должен появляться.
	listResp, listBody := f.get(t, "/api/v1/menu/items", tok)
	if listResp.StatusCode != 200 {
		t.Fatal(listResp.StatusCode)
	}
	var env struct {
		Data []models.MenuItem `json:"data"`
	}
	_ = json.Unmarshal(listBody, &env)
	for _, x := range env.Data {
		if x.ID == mi.ID {
			t.Errorf("soft-deleted item appears in list")
		}
	}
}

// TestTail_InventoryDraftAndApply — draft → apply → ingredients.qty обновлён.
func TestTail_InventoryDraftAndApply(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, _, _ := seedForWrite(t, f)

	var ing models.Ingredient
	if err := gdb.Where("restaurant_id = ?", f.rid).First(&ing).Error; err != nil {
		t.Fatal(err)
	}
	// seeded qty = 10; устанавливаем actual = 8.5 (diff = -1.5).
	actual := "8.5"

	resp, body := f.post(t, "/api/v1/stock/inventory", tok, uuid.NewString(),
		map[string]any{
			"note":  "weekly",
			"lines": []map[string]any{{"ingredient_id": ing.ID, "actual_qty": actual}},
		})
	if resp.StatusCode != 201 {
		t.Fatalf("create inventory %d: %s", resp.StatusCode, body)
	}
	var check models.InventoryCheck
	_ = json.Unmarshal(body, &check)
	if check.Status != "draft" {
		t.Errorf("status = %s, want draft", check.Status)
	}

	// Apply.
	applyPath := fmt.Sprintf("/api/v1/stock/inventory/%s/apply", check.ID)
	resp2, body2 := f.post(t, applyPath, tok, uuid.NewString(), map[string]any{})
	if resp2.StatusCode != 200 {
		t.Fatalf("apply %d: %s", resp2.StatusCode, body2)
	}

	// Проверяем: ingredients.qty стало 8.5.
	var after models.Ingredient
	gdb.First(&after, "id = ?", ing.ID)
	if !after.Qty.Equal(decimal.MustFromString("8.5")) {
		t.Errorf("after apply qty = %s, want 8.5", after.Qty.String())
	}

	// Double apply → 409.
	resp3, _ := f.post(t, applyPath, tok, uuid.NewString(), map[string]any{})
	if resp3.StatusCode != 409 {
		t.Errorf("double apply expected 409, got %d", resp3.StatusCode)
	}
}
