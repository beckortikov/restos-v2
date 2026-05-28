//go:build integration

package http_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/db/models"
)

// ─── Zones CRUD ────────────────────────────────────────────────────────────

func TestPhase10_ZonesCRUD(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)

	// Create.
	r, b := f.post(t, "/api/v1/zones", tok, uuid.NewString(),
		map[string]any{"name": "Терраса", "sort_order": 1})
	if r.StatusCode != 201 {
		t.Fatalf("zone create %d: %s", r.StatusCode, b)
	}
	var z models.Zone
	_ = json.Unmarshal(b, &z)
	if z.Name != "Терраса" {
		t.Errorf("name = %s, want Терраса", z.Name)
	}

	// Patch.
	pr, pb := f.patch(t, fmt.Sprintf("/api/v1/zones/%s", z.ID), tok, uuid.NewString(),
		map[string]any{"name": "Зал 1"})
	if pr.StatusCode != 200 {
		t.Fatalf("zone patch %d: %s", pr.StatusCode, pb)
	}
	var z2 models.Zone
	_ = json.Unmarshal(pb, &z2)
	if z2.Name != "Зал 1" {
		t.Errorf("after patch name = %s", z2.Name)
	}

	// List.
	lr, lb := f.get(t, "/api/v1/zones", tok)
	if lr.StatusCode != 200 {
		t.Fatal(lr.StatusCode)
	}
	var env struct {
		Data []models.Zone `json:"data"`
	}
	_ = json.Unmarshal(lb, &env)
	if len(env.Data) != 1 {
		t.Errorf("zones list: %d", len(env.Data))
	}

	// Create a table referencing the zone — delete should fail.
	tr, tb := f.post(t, "/api/v1/tables", tok, uuid.NewString(),
		map[string]any{"number": 1, "zone_id": z.ID})
	if tr.StatusCode != 201 {
		t.Fatalf("table create %d: %s", tr.StatusCode, tb)
	}
	var tbl models.Table
	_ = json.Unmarshal(tb, &tbl)

	dr, _ := f.del(t, fmt.Sprintf("/api/v1/zones/%s", z.ID), tok, uuid.NewString())
	if dr.StatusCode != 409 {
		t.Errorf("zone delete with referencing table: %d, want 409", dr.StatusCode)
	}

	// Delete the table, then zone should delete OK.
	_, _ = f.del(t, fmt.Sprintf("/api/v1/tables/%s", tbl.ID), tok, uuid.NewString())
	dr2, _ := f.del(t, fmt.Sprintf("/api/v1/zones/%s", z.ID), tok, uuid.NewString())
	if dr2.StatusCode != 204 {
		t.Errorf("zone delete: %d", dr2.StatusCode)
	}
}

// ─── Tables CRUD ───────────────────────────────────────────────────────────

func TestPhase10_TablesCRUD(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)

	r, b := f.post(t, "/api/v1/tables", tok, uuid.NewString(),
		map[string]any{"number": 5, "capacity": 4, "name": "Стол 5"})
	if r.StatusCode != 201 {
		t.Fatalf("table create %d: %s", r.StatusCode, b)
	}
	var tbl models.Table
	_ = json.Unmarshal(b, &tbl)

	pr, pb := f.patch(t, fmt.Sprintf("/api/v1/tables/%s", tbl.ID), tok, uuid.NewString(),
		map[string]any{"capacity": 6})
	if pr.StatusCode != 200 {
		t.Fatalf("table patch %d: %s", pr.StatusCode, pb)
	}
	var tbl2 models.Table
	_ = json.Unmarshal(pb, &tbl2)
	if tbl2.Capacity == nil || *tbl2.Capacity != 6 {
		t.Errorf("capacity not patched")
	}

	dr, _ := f.del(t, fmt.Sprintf("/api/v1/tables/%s", tbl.ID), tok, uuid.NewString())
	if dr.StatusCode != 204 {
		t.Errorf("table delete: %d", dr.StatusCode)
	}
}

// ─── Tables status flow ────────────────────────────────────────────────────

func TestPhase10_TablesStatusFlow(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)

	r, b := f.post(t, "/api/v1/tables", tok, uuid.NewString(),
		map[string]any{"number": 10})
	if r.StatusCode != 201 {
		t.Fatalf("create %d: %s", r.StatusCode, b)
	}
	var tbl models.Table
	_ = json.Unmarshal(b, &tbl)

	// open-for-order.
	orderID := uuid.NewString()
	or, ob := f.post(t, fmt.Sprintf("/api/v1/tables/%s/open-for-order", tbl.ID), tok, uuid.NewString(),
		map[string]any{"order_id": orderID})
	if or.StatusCode != 200 {
		t.Fatalf("open-for-order %d: %s", or.StatusCode, ob)
	}
	var tbl2 models.Table
	_ = json.Unmarshal(ob, &tbl2)
	if tbl2.Status == nil || *tbl2.Status != "occupied" {
		t.Errorf("status = %v, want occupied", tbl2.Status)
	}
	if tbl2.CurrentOrderID == nil || *tbl2.CurrentOrderID != orderID {
		t.Errorf("current_order_id mismatch")
	}

	// Try to delete an occupied table — must fail.
	dr, _ := f.del(t, fmt.Sprintf("/api/v1/tables/%s", tbl.ID), tok, uuid.NewString())
	if dr.StatusCode != 409 {
		t.Errorf("delete occupied: %d, want 409", dr.StatusCode)
	}

	// assign-waiter (null).
	wid := uuid.NewString()
	ar, ab := f.post(t, fmt.Sprintf("/api/v1/tables/%s/assign-waiter", tbl.ID), tok, uuid.NewString(),
		map[string]any{"waiter_id": wid})
	if ar.StatusCode != 200 {
		t.Fatalf("assign-waiter %d: %s", ar.StatusCode, ab)
	}
	var tbl3 models.Table
	_ = json.Unmarshal(ab, &tbl3)
	if tbl3.WaiterID == nil || *tbl3.WaiterID != wid {
		t.Errorf("waiter not assigned")
	}

	// set status free + clear order via PATCH /status (current_order_id="" cleared).
	sr, sb := f.patch(t, fmt.Sprintf("/api/v1/tables/%s/status", tbl.ID), tok, uuid.NewString(),
		map[string]any{"status": "free"})
	if sr.StatusCode != 200 {
		t.Fatalf("status %d: %s", sr.StatusCode, sb)
	}

	// cleanup stuck — нет стуков сейчас (current_order_id ещё указывает на orderID,
	// но мы только что выставили free). Чтобы проверить — сделаем status='occupied'
	// без current_order_id вручную через PATCH /status, потом cleanup.
	sr2, _ := f.patch(t, fmt.Sprintf("/api/v1/tables/%s/status", tbl.ID), tok, uuid.NewString(),
		map[string]any{"status": "occupied", "current_order_id": ""})
	if sr2.StatusCode != 200 {
		t.Fatal(sr2.StatusCode)
	}

	cr, cb := f.post(t, "/api/v1/admin/cleanup/stuck-tables", tok, uuid.NewString(), map[string]any{})
	if cr.StatusCode != 200 {
		t.Fatalf("cleanup %d: %s", cr.StatusCode, cb)
	}
	var cres struct {
		Cleaned int64 `json:"cleaned"`
	}
	_ = json.Unmarshal(cb, &cres)
	if cres.Cleaned < 1 {
		t.Errorf("cleaned = %d, want >=1", cres.Cleaned)
	}
}

// ─── Tables merge ──────────────────────────────────────────────────────────

func TestPhase10_TablesMerge(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)

	r1, b1 := f.post(t, "/api/v1/tables", tok, uuid.NewString(),
		map[string]any{"number": 20, "capacity": 4})
	if r1.StatusCode != 201 {
		t.Fatalf("primary %d: %s", r1.StatusCode, b1)
	}
	var primary models.Table
	_ = json.Unmarshal(b1, &primary)

	r2, b2 := f.post(t, "/api/v1/tables", tok, uuid.NewString(),
		map[string]any{"number": 21, "capacity": 2})
	if r2.StatusCode != 201 {
		t.Fatalf("secondary %d: %s", r2.StatusCode, b2)
	}
	var secondary models.Table
	_ = json.Unmarshal(b2, &secondary)

	// Merge.
	mr, mb := f.post(t, "/api/v1/tables/merge", tok, uuid.NewString(),
		map[string]any{"primary_id": primary.ID, "secondary_id": secondary.ID})
	if mr.StatusCode != 200 {
		t.Fatalf("merge %d: %s", mr.StatusCode, mb)
	}
	var mres struct {
		Primary   models.Table `json:"primary"`
		Secondary models.Table `json:"secondary"`
	}
	_ = json.Unmarshal(mb, &mres)
	if mres.Primary.Capacity == nil || *mres.Primary.Capacity != 6 {
		t.Errorf("merged primary capacity = %v, want 6", mres.Primary.Capacity)
	}
	if mres.Secondary.MergedWith == nil || *mres.Secondary.MergedWith != primary.ID {
		t.Errorf("secondary.merged_with mismatch")
	}
	if mres.Secondary.Status == nil || *mres.Secondary.Status != "merged" {
		t.Errorf("secondary status = %v, want merged", mres.Secondary.Status)
	}

	// Unmerge.
	ur, ub := f.post(t, fmt.Sprintf("/api/v1/tables/%s/unmerge", primary.ID), tok, uuid.NewString(),
		map[string]any{})
	if ur.StatusCode != 200 {
		t.Fatalf("unmerge %d: %s", ur.StatusCode, ub)
	}
	var unmerged models.Table
	_ = json.Unmarshal(ub, &unmerged)
	if unmerged.Capacity == nil || *unmerged.Capacity != 4 {
		t.Errorf("after unmerge primary capacity = %v, want 4", unmerged.Capacity)
	}
}

// ─── Restaurants ───────────────────────────────────────────────────────────

func TestPhase10_Restaurants(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)

	// List должен показать как минимум setupE2E ресторан.
	lr, lb := f.get(t, "/api/v1/restaurants", tok)
	if lr.StatusCode != 200 {
		t.Fatalf("list %d: %s", lr.StatusCode, lb)
	}
	var env struct {
		Data []models.Restaurant `json:"data"`
	}
	_ = json.Unmarshal(lb, &env)
	if len(env.Data) < 1 {
		t.Errorf("restaurants list: %d", len(env.Data))
	}

	// Create a fresh restaurant.
	cr, cb := f.post(t, "/api/v1/restaurants", tok, uuid.NewString(),
		map[string]any{"name": "Second", "currency": "USD"})
	if cr.StatusCode != 201 {
		t.Fatalf("create %d: %s", cr.StatusCode, cb)
	}
	var rest models.Restaurant
	_ = json.Unmarshal(cb, &rest)
	if rest.Name != "Second" {
		t.Errorf("name mismatch")
	}

	// Get single.
	gr, gb := f.get(t, fmt.Sprintf("/api/v1/restaurants/%s", rest.ID), tok)
	if gr.StatusCode != 200 {
		t.Fatalf("get %d: %s", gr.StatusCode, gb)
	}

	// Patch.
	pr, _ := f.patch(t, fmt.Sprintf("/api/v1/restaurants/%s", rest.ID), tok, uuid.NewString(),
		map[string]any{"address": "Some street 1"})
	if pr.StatusCode != 200 {
		t.Errorf("patch %d", pr.StatusCode)
	}

	// Stats (no orders → 0).
	sr, sb := f.get(t, fmt.Sprintf("/api/v1/restaurants/%s/stats", rest.ID), tok)
	if sr.StatusCode != 200 {
		t.Fatalf("stats %d: %s", sr.StatusCode, sb)
	}
	var stats struct {
		OrdersCount int64 `json:"orders_count"`
	}
	_ = json.Unmarshal(sb, &stats)
	if stats.OrdersCount != 0 {
		t.Errorf("orders_count = %d, want 0", stats.OrdersCount)
	}

	// Delete (no orders/users) — должен пройти.
	dr, db := f.del(t, fmt.Sprintf("/api/v1/restaurants/%s", rest.ID), tok, uuid.NewString())
	if dr.StatusCode != 204 {
		t.Errorf("delete %d: %s", dr.StatusCode, db)
	}

	// Delete of setupE2E rid (has user + menu_item but no orders) — должен сказать 409 (есть users).
	dr2, _ := f.del(t, fmt.Sprintf("/api/v1/restaurants/%s", f.rid), tok, uuid.NewString())
	if dr2.StatusCode != 409 {
		t.Errorf("delete with users: %d, want 409", dr2.StatusCode)
	}

	// clear-menu на setupE2E ресторане — удалит menu_item (Plov).
	cmr, cmb := f.post(t, fmt.Sprintf("/api/v1/restaurants/%s/clear-menu", f.rid), tok, uuid.NewString(),
		map[string]any{})
	if cmr.StatusCode != 200 {
		t.Fatalf("clear-menu %d: %s", cmr.StatusCode, cmb)
	}
	var cmres struct {
		Counts struct {
			MenuItems int64 `json:"menu_items"`
		} `json:"counts"`
	}
	_ = json.Unmarshal(cmb, &cmres)
	if cmres.Counts.MenuItems < 1 {
		t.Errorf("clear-menu menu_items = %d, want >=1", cmres.Counts.MenuItems)
	}

	// clear-operations — нет заказов, но проходит без ошибки.
	cor, cob := f.post(t, fmt.Sprintf("/api/v1/restaurants/%s/clear-operations", f.rid), tok, uuid.NewString(),
		map[string]any{})
	if cor.StatusCode != 200 {
		t.Fatalf("clear-operations %d: %s", cor.StatusCode, cob)
	}
}

// тривиальный sanity — линкер.
var _ = http.StatusOK
