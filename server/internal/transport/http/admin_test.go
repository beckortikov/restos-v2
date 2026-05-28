//go:build integration

package http_test

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// ─── Users ─────────────────────────────────────────────────────────────────

func TestAdmin_UsersCRUD(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)

	// Create.
	resp, body := f.post(t, "/api/v1/users", tok, uuid.NewString(), map[string]any{
		"name": "Olga", "role": "cashier", "pin": "5555", "salary": "1500",
	})
	if resp.StatusCode != 201 {
		t.Fatalf("create %d: %s", resp.StatusCode, body)
	}
	var u models.User
	_ = json.Unmarshal(body, &u)
	if u.Name == nil || *u.Name != "Olga" {
		t.Errorf("bad created user: %+v", u)
	}
	// PIN не должен возвращаться.
	if u.PIN != nil {
		t.Errorf("PIN leaked in response")
	}

	// List — содержит созданного + cashier из setupE2E.
	listResp, listBody := f.get(t, "/api/v1/users", tok)
	if listResp.StatusCode != 200 {
		t.Fatal(listResp.StatusCode)
	}
	var env struct {
		Data []models.User `json:"data"`
	}
	_ = json.Unmarshal(listBody, &env)
	if len(env.Data) < 2 {
		t.Errorf("list want >= 2 users, got %d", len(env.Data))
	}

	// Patch.
	patchPath := fmt.Sprintf("/api/v1/users/%s", u.ID)
	respP, _ := f.patch(t, patchPath, tok, uuid.NewString(), map[string]any{"role": "manager"})
	if respP.StatusCode != 200 {
		t.Fatal(respP.StatusCode)
	}

	// Delete (soft → role=deleted).
	respD, _ := f.del(t, patchPath, tok, uuid.NewString())
	if respD.StatusCode != 204 {
		t.Errorf("delete %d", respD.StatusCode)
	}

	// Get → видим role=deleted.
	getResp, getBody := f.get(t, patchPath, tok)
	if getResp.StatusCode != 200 {
		t.Fatal(getResp.StatusCode)
	}
	var got models.User
	_ = json.Unmarshal(getBody, &got)
	if got.Role == nil || *got.Role != "deleted" {
		t.Errorf("soft delete: role = %v, want deleted", got.Role)
	}
}

// ─── Customers ─────────────────────────────────────────────────────────────

func TestAdmin_CustomersCRUD(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)

	resp, body := f.post(t, "/api/v1/customers", tok, uuid.NewString(), map[string]any{
		"name": "Marina", "phone": "+992 900 11 22 33", "notes": "VIP",
	})
	if resp.StatusCode != 201 {
		t.Fatalf("create %d: %s", resp.StatusCode, body)
	}
	var c models.Customer
	_ = json.Unmarshal(body, &c)

	// Search by query.
	lResp, lBody := f.get(t, "/api/v1/customers?q=Marina", tok)
	if lResp.StatusCode != 200 {
		t.Fatal(lResp.StatusCode)
	}
	var env struct {
		Data []models.Customer `json:"data"`
	}
	_ = json.Unmarshal(lBody, &env)
	if len(env.Data) != 1 {
		t.Errorf("search ?q=Marina: %d results", len(env.Data))
	}

	// Patch + delete.
	path := fmt.Sprintf("/api/v1/customers/%s", c.ID)
	respP, _ := f.patch(t, path, tok, uuid.NewString(), map[string]any{"notes": "regular"})
	if respP.StatusCode != 200 {
		t.Fatal(respP.StatusCode)
	}
	respD, _ := f.del(t, path, tok, uuid.NewString())
	if respD.StatusCode != 204 {
		t.Errorf("delete %d", respD.StatusCode)
	}
}

// ─── Suppliers ─────────────────────────────────────────────────────────────

func TestAdmin_SuppliersCRUD(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)

	resp, body := f.post(t, "/api/v1/suppliers", tok, uuid.NewString(), map[string]any{
		"name":               "Asia Foods",
		"phone":              "+992-...",
		"categories":         []string{"meat", "spices"},
		"payment_terms_days": 14,
		"credit_limit":       "50000",
	})
	if resp.StatusCode != 201 {
		t.Fatalf("create %d: %s", resp.StatusCode, body)
	}
	var s models.Supplier
	_ = json.Unmarshal(body, &s)

	lResp, _ := f.get(t, "/api/v1/suppliers", tok)
	if lResp.StatusCode != 200 {
		t.Fatal(lResp.StatusCode)
	}

	path := fmt.Sprintf("/api/v1/suppliers/%s", s.ID)
	respP, _ := f.patch(t, path, tok, uuid.NewString(), map[string]any{"payment_terms_days": 7})
	if respP.StatusCode != 200 {
		t.Fatal(respP.StatusCode)
	}
	respD, _ := f.del(t, path, tok, uuid.NewString())
	if respD.StatusCode != 204 {
		t.Errorf("delete %d", respD.StatusCode)
	}
}

// ─── Reservations ──────────────────────────────────────────────────────────

func TestAdmin_ReservationsCRUD(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)

	at := time.Now().Add(24 * time.Hour).UTC().Format(time.RFC3339)
	resp, body := f.post(t, "/api/v1/reservations", tok, uuid.NewString(), map[string]any{
		"guest_name":   "Ivan",
		"guest_phone":  "+992 901 12 34 56",
		"guests_count": 4,
		"reserved_at":  at,
		"duration_min": 90,
		"status":       "pending",
	})
	if resp.StatusCode != 201 {
		t.Fatalf("create %d: %s", resp.StatusCode, body)
	}
	var r models.Reservation
	_ = json.Unmarshal(body, &r)

	// List filter by status.
	lResp, lBody := f.get(t, "/api/v1/reservations?status=pending", tok)
	if lResp.StatusCode != 200 {
		t.Fatal(lResp.StatusCode)
	}
	var env struct {
		Data []models.Reservation `json:"data"`
	}
	_ = json.Unmarshal(lBody, &env)
	if len(env.Data) != 1 {
		t.Errorf("list pending: %d (want 1)", len(env.Data))
	}

	// Patch status → confirmed.
	path := fmt.Sprintf("/api/v1/reservations/%s", r.ID)
	respP, _ := f.patch(t, path, tok, uuid.NewString(), map[string]any{"status": "confirmed"})
	if respP.StatusCode != 200 {
		t.Fatal(respP.StatusCode)
	}
	respD, _ := f.del(t, path, tok, uuid.NewString())
	if respD.StatusCode != 204 {
		t.Errorf("delete %d", respD.StatusCode)
	}
}

// ─── Restaurant settings ───────────────────────────────────────────────────

func TestAdmin_RestaurantSettings(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)

	gResp, gBody := f.get(t, "/api/v1/restaurant", tok)
	if gResp.StatusCode != 200 {
		t.Fatalf("get %d", gResp.StatusCode)
	}
	var r models.Restaurant
	_ = json.Unmarshal(gBody, &r)
	if r.ID != f.rid {
		t.Errorf("rid mismatch: %s vs %s", r.ID, f.rid)
	}

	respP, body := f.patch(t, "/api/v1/restaurant", tok, uuid.NewString(), map[string]any{
		"name":             "New Name",
		"service_percent":  "15",
		"pin_lock_enabled": true,
	})
	if respP.StatusCode != 200 {
		t.Fatalf("patch %d: %s", respP.StatusCode, body)
	}
	var updated models.Restaurant
	_ = json.Unmarshal(body, &updated)
	if updated.Name != "New Name" {
		t.Errorf("name = %q, want New Name", updated.Name)
	}
	if !updated.ServicePercent.Equal(decimal.MustFromString("15")) {
		t.Errorf("service_percent = %s, want 15", updated.ServicePercent.String())
	}
	if updated.PinLockEnabled == nil || !*updated.PinLockEnabled {
		t.Errorf("pin_lock_enabled not set")
	}
}
