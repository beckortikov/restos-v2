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

// helper: создаёт open order через API, возвращает (orderID, total).
func phase13_createOrder(t *testing.T, f *e2eFixture, tok, menuItemID string, qty int) (string, decimal.Decimal) {
	t.Helper()
	items := make([]map[string]any, qty)
	for i := 0; i < qty; i++ {
		items[i] = map[string]any{"menu_item_id": menuItemID, "qty": "1"}
	}
	r, b := f.post(t, "/api/v1/orders", tok, uuid.NewString(),
		map[string]any{"items": items})
	if r.StatusCode != 201 {
		t.Fatalf("create order: %d %s", r.StatusCode, b)
	}
	var o models.Order
	_ = json.Unmarshal(b, &o)
	return o.ID, o.Total
}

// ─── Splits lifecycle: equal → pay each → auto-close ──────────────────────

func TestPhase13_SplitsLifecycle(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	_, menuItemID, _, accountID := seedForWrite(t, f)

	orderID, total := phase13_createOrder(t, f, tok, menuItemID, 4) // total = 100

	// Equal split into 2.
	r, b := f.post(t, fmt.Sprintf("/api/v1/orders/%s/splits/equal", orderID), tok, uuid.NewString(),
		map[string]any{"count": 2})
	if r.StatusCode != 200 {
		t.Fatalf("split equal: %d %s", r.StatusCode, b)
	}
	var sres struct {
		Order  models.Order        `json:"order"`
		Splits []models.OrderSplit `json:"splits"`
	}
	_ = json.Unmarshal(b, &sres)
	if len(sres.Splits) != 2 {
		t.Fatalf("expected 2 splits, got %d", len(sres.Splits))
	}
	if !sres.Order.Total.Equal(total) {
		t.Errorf("order total changed: %s vs %s", sres.Order.Total.String(), total.String())
	}
	if sres.Order.IsSplit == nil || !*sres.Order.IsSplit {
		t.Errorf("is_split should be true")
	}

	// List splits.
	lr, lb := f.get(t, fmt.Sprintf("/api/v1/orders/%s/splits", orderID), tok)
	if lr.StatusCode != 200 {
		t.Fatalf("list splits: %d %s", lr.StatusCode, lb)
	}
	var lenv struct {
		Data []models.OrderSplit `json:"data"`
	}
	_ = json.Unmarshal(lb, &lenv)
	if len(lenv.Data) != 2 {
		t.Errorf("list returned %d splits", len(lenv.Data))
	}

	// Pay first.
	pr1, pb1 := f.post(t, fmt.Sprintf("/api/v1/splits/%s/pay", sres.Splits[0].ID), tok, uuid.NewString(),
		map[string]any{"payment_method": "cash", "account_id": accountID})
	if pr1.StatusCode != 200 {
		t.Fatalf("pay #1: %d %s", pr1.StatusCode, pb1)
	}
	var pres1 struct {
		OrderClosed bool          `json:"order_closed"`
		Order       *models.Order `json:"order"`
	}
	_ = json.Unmarshal(pb1, &pres1)
	if pres1.OrderClosed {
		t.Errorf("order should NOT close yet (only 1 of 2 paid)")
	}

	// check-and-close: still unpaid.
	cr, cb := f.post(t, fmt.Sprintf("/api/v1/orders/%s/check-and-close", orderID), tok, uuid.NewString(), nil)
	if cr.StatusCode != 200 {
		t.Fatalf("check 1: %d %s", cr.StatusCode, cb)
	}
	var cres struct {
		Closed      bool `json:"closed"`
		PaidCount   int  `json:"paid_count"`
		UnpaidCount int  `json:"unpaid_count"`
	}
	_ = json.Unmarshal(cb, &cres)
	if cres.Closed {
		t.Errorf("should not close yet")
	}
	if cres.PaidCount != 1 || cres.UnpaidCount != 1 {
		t.Errorf("paid=%d unpaid=%d, want 1/1", cres.PaidCount, cres.UnpaidCount)
	}

	// Pay second → auto-close.
	pr2, pb2 := f.post(t, fmt.Sprintf("/api/v1/splits/%s/pay", sres.Splits[1].ID), tok, uuid.NewString(),
		map[string]any{"payment_method": "card", "account_id": accountID})
	if pr2.StatusCode != 200 {
		t.Fatalf("pay #2: %d %s", pr2.StatusCode, pb2)
	}
	var pres2 struct {
		OrderClosed bool          `json:"order_closed"`
		Order       *models.Order `json:"order"`
	}
	_ = json.Unmarshal(pb2, &pres2)
	if !pres2.OrderClosed {
		t.Errorf("order should auto-close after all splits paid")
	}
	if pres2.Order == nil || pres2.Order.Status == nil || *pres2.Order.Status != "closed" {
		t.Errorf("order.status not closed: %+v", pres2.Order)
	}

	// Try paying again → CONFLICT.
	dup, _ := f.post(t, fmt.Sprintf("/api/v1/splits/%s/pay", sres.Splits[1].ID), tok, uuid.NewString(),
		map[string]any{"payment_method": "card", "account_id": accountID})
	if dup.StatusCode != 409 {
		t.Errorf("double pay expected 409, got %d", dup.StatusCode)
	}
}

// ─── Splits by-items: pay one → check-and-close shows partial ─────────────

func TestPhase13_SplitsByItems(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	_, menuItemID, _, accountID := seedForWrite(t, f)

	orderID, _ := phase13_createOrder(t, f, tok, menuItemID, 2)

	// Need item IDs — GET order.
	gr, gb := f.get(t, fmt.Sprintf("/api/v1/orders/%s", orderID), tok)
	if gr.StatusCode != 200 {
		t.Fatalf("get order: %d %s", gr.StatusCode, gb)
	}
	var detail struct {
		Order models.Order `json:"order"`
		Items []struct {
			models.OrderItem
		} `json:"items"`
	}
	_ = json.Unmarshal(gb, &detail)
	if len(detail.Items) != 2 {
		t.Fatalf("expected 2 items, got %d", len(detail.Items))
	}

	// Split by items: each item own split.
	r, b := f.post(t, fmt.Sprintf("/api/v1/orders/%s/splits/by-items", orderID), tok, uuid.NewString(),
		map[string]any{
			"groups": []map[string]any{
				{"item_ids": []string{detail.Items[0].ID}},
				{"item_ids": []string{detail.Items[1].ID}},
			},
		})
	if r.StatusCode != 200 {
		t.Fatalf("split by items: %d %s", r.StatusCode, b)
	}
	var sres struct {
		Splits []models.OrderSplit `json:"splits"`
	}
	_ = json.Unmarshal(b, &sres)
	if len(sres.Splits) != 2 {
		t.Fatalf("expected 2 splits, got %d", len(sres.Splits))
	}

	// Pay first.
	pr, _ := f.post(t, fmt.Sprintf("/api/v1/splits/%s/pay", sres.Splits[0].ID), tok, uuid.NewString(),
		map[string]any{"payment_method": "cash", "account_id": accountID})
	if pr.StatusCode != 200 {
		t.Fatalf("pay 1: %d", pr.StatusCode)
	}

	// check-and-close → partial.
	cr, cb := f.post(t, fmt.Sprintf("/api/v1/orders/%s/check-and-close", orderID), tok, uuid.NewString(), nil)
	if cr.StatusCode != 200 {
		t.Fatalf("check: %d %s", cr.StatusCode, cb)
	}
	var cres struct {
		Closed      bool `json:"closed"`
		PaidCount   int  `json:"paid_count"`
		UnpaidCount int  `json:"unpaid_count"`
	}
	_ = json.Unmarshal(cb, &cres)
	if cres.Closed || cres.PaidCount != 1 || cres.UnpaidCount != 1 {
		t.Errorf("partial state mismatch: closed=%v paid=%d unpaid=%d", cres.Closed, cres.PaidCount, cres.UnpaidCount)
	}
}

// ─── Splits cancel: only if all unpaid ────────────────────────────────────

func TestPhase13_SplitsCancel(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	_, menuItemID, _, _ := seedForWrite(t, f)

	orderID, _ := phase13_createOrder(t, f, tok, menuItemID, 2)

	// Split.
	f.post(t, fmt.Sprintf("/api/v1/orders/%s/splits/equal", orderID), tok, uuid.NewString(),
		map[string]any{"count": 2})

	// Cancel splits.
	r, b := f.post(t, fmt.Sprintf("/api/v1/orders/%s/splits/cancel", orderID), tok, uuid.NewString(), nil)
	if r.StatusCode != 200 {
		t.Fatalf("cancel splits: %d %s", r.StatusCode, b)
	}
	var res struct {
		Order   models.Order `json:"order"`
		Removed int          `json:"removed"`
	}
	_ = json.Unmarshal(b, &res)
	if res.Removed != 2 {
		t.Errorf("removed = %d, want 2", res.Removed)
	}
	if res.Order.IsSplit != nil && *res.Order.IsSplit {
		t.Errorf("is_split should be false after cancel")
	}

	// List → empty.
	lr, lb := f.get(t, fmt.Sprintf("/api/v1/orders/%s/splits", orderID), tok)
	if lr.StatusCode != 200 {
		t.Fatalf("list: %d", lr.StatusCode)
	}
	var lenv struct {
		Data []models.OrderSplit `json:"data"`
	}
	_ = json.Unmarshal(lb, &lenv)
	if len(lenv.Data) != 0 {
		t.Errorf("expected 0 splits, got %d", len(lenv.Data))
	}
}

// ─── Voids list ───────────────────────────────────────────────────────────

func TestPhase13_VoidsList(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	_, menuItemID, _, _ := seedForWrite(t, f)
	orderID, _ := phase13_createOrder(t, f, tok, menuItemID, 2)

	// Get item ID.
	_, gb := f.get(t, fmt.Sprintf("/api/v1/orders/%s", orderID), tok)
	var detail struct {
		Items []struct {
			models.OrderItem
		} `json:"items"`
	}
	_ = json.Unmarshal(gb, &detail)
	itemID := detail.Items[0].ID

	// Void item via existing endpoint.
	r, b := f.post(t, fmt.Sprintf("/api/v1/orders/%s/items/%s/void", orderID, itemID), tok, uuid.NewString(),
		map[string]any{"reason": "spilled", "approved_by": uuid.NewString()})
	if r.StatusCode != 200 {
		t.Fatalf("void: %d %s", r.StatusCode, b)
	}

	// GET voids.
	vr, vb := f.get(t, fmt.Sprintf("/api/v1/orders/%s/voids", orderID), tok)
	if vr.StatusCode != 200 {
		t.Fatalf("list voids: %d %s", vr.StatusCode, vb)
	}
	var venv struct {
		Data []models.OrderVoid `json:"data"`
	}
	_ = json.Unmarshal(vb, &venv)
	if len(venv.Data) != 1 {
		t.Errorf("expected 1 void, got %d", len(venv.Data))
	}

	// Standalone create.
	cr, cb := f.post(t, "/api/v1/voids", tok, uuid.NewString(), map[string]any{
		"order_id":   orderID,
		"item_name":  "Adhoc",
		"item_qty":   1,
		"item_price": "10",
		"reason":     "ad-hoc correction",
	})
	if cr.StatusCode != 201 {
		t.Fatalf("create void: %d %s", cr.StatusCode, cb)
	}

	// /voids?order_ids=
	mr, mb := f.get(t, fmt.Sprintf("/api/v1/voids?order_ids=%s", orderID), tok)
	if mr.StatusCode != 200 {
		t.Fatalf("list voids by ids: %d %s", mr.StatusCode, mb)
	}
	var menv struct {
		Data []models.OrderVoid `json:"data"`
	}
	_ = json.Unmarshal(mb, &menv)
	if len(menv.Data) != 2 {
		t.Errorf("expected 2 voids, got %d", len(menv.Data))
	}
}

// ─── Item cancel ──────────────────────────────────────────────────────────

func TestPhase13_ItemCancel(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	_, menuItemID, _, _ := seedForWrite(t, f)
	orderID, _ := phase13_createOrder(t, f, tok, menuItemID, 2)

	_, gb := f.get(t, fmt.Sprintf("/api/v1/orders/%s", orderID), tok)
	var detail struct {
		Items []struct {
			models.OrderItem
		} `json:"items"`
	}
	_ = json.Unmarshal(gb, &detail)
	itemID := detail.Items[0].ID

	r, b := f.post(t, fmt.Sprintf("/api/v1/orders/%s/items/%s/cancel", orderID, itemID), tok, uuid.NewString(),
		map[string]any{"reason": "guest changed mind"})
	if r.StatusCode != 200 {
		t.Fatalf("cancel item: %d %s", r.StatusCode, b)
	}
	var it models.OrderItem
	_ = json.Unmarshal(b, &it)
	if it.CancelledAt == nil {
		t.Errorf("cancelled_at should be set")
	}

	// Order total should decrease by 25.
	_, gb2 := f.get(t, fmt.Sprintf("/api/v1/orders/%s", orderID), tok)
	var d2 struct {
		Order models.Order `json:"order"`
	}
	_ = json.Unmarshal(gb2, &d2)
	if !d2.Order.Total.Equal(decimal.MustFromString("25")) {
		t.Errorf("order total after cancel = %s, want 25", d2.Order.Total.String())
	}
}

// ─── Item served mark/unmark ──────────────────────────────────────────────

func TestPhase13_ItemServed(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	_, menuItemID, _, _ := seedForWrite(t, f)
	orderID, _ := phase13_createOrder(t, f, tok, menuItemID, 1)

	_, gb := f.get(t, fmt.Sprintf("/api/v1/orders/%s", orderID), tok)
	var detail struct {
		Items []struct {
			models.OrderItem
		} `json:"items"`
	}
	_ = json.Unmarshal(gb, &detail)
	itemID := detail.Items[0].ID

	// Mark served.
	r, b := f.post(t, fmt.Sprintf("/api/v1/orders/%s/items/%s/served", orderID, itemID), tok, uuid.NewString(), nil)
	if r.StatusCode != 200 {
		t.Fatalf("mark served: %d %s", r.StatusCode, b)
	}
	var it models.OrderItem
	_ = json.Unmarshal(b, &it)
	if it.ServedAt == nil {
		t.Errorf("served_at should be set")
	}

	// Unmark.
	r2, b2 := f.del(t, fmt.Sprintf("/api/v1/orders/%s/items/%s/served", orderID, itemID), tok, uuid.NewString())
	if r2.StatusCode != 200 {
		t.Fatalf("unmark: %d %s", r2.StatusCode, b2)
	}
	var it2 models.OrderItem
	_ = json.Unmarshal(b2, &it2)
	if it2.ServedAt != nil {
		t.Errorf("served_at should be nil")
	}
}

// ─── Claim print: atomic lock + release ───────────────────────────────────

func TestPhase13_ClaimPrint(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	_, menuItemID, _, _ := seedForWrite(t, f)
	orderID, _ := phase13_createOrder(t, f, tok, menuItemID, 1)

	_, gb := f.get(t, fmt.Sprintf("/api/v1/orders/%s", orderID), tok)
	var detail struct {
		Items []struct {
			models.OrderItem
		} `json:"items"`
	}
	_ = json.Unmarshal(gb, &detail)
	itemID := detail.Items[0].ID

	worker := uuid.NewString()

	// First claim → success.
	r1, b1 := f.post(t, fmt.Sprintf("/api/v1/orders/%s/items/%s/claim-print", orderID, itemID), tok, uuid.NewString(),
		map[string]any{"claimed_by": worker})
	if r1.StatusCode != 200 {
		t.Fatalf("claim 1: %d %s", r1.StatusCode, b1)
	}
	var res1 struct {
		Claimed bool             `json:"claimed"`
		Item    models.OrderItem `json:"item"`
	}
	_ = json.Unmarshal(b1, &res1)
	if !res1.Claimed {
		t.Errorf("first claim should succeed")
	}
	if res1.Item.PrintClaimedAt == nil {
		t.Errorf("print_claimed_at should be set")
	}

	// Second claim by another worker → not claimed (already locked).
	r2, b2 := f.post(t, fmt.Sprintf("/api/v1/orders/%s/items/%s/claim-print", orderID, itemID), tok, uuid.NewString(),
		map[string]any{"claimed_by": uuid.NewString()})
	if r2.StatusCode != 200 {
		t.Fatalf("claim 2: %d %s", r2.StatusCode, b2)
	}
	var res2 struct {
		Claimed bool `json:"claimed"`
	}
	_ = json.Unmarshal(b2, &res2)
	if res2.Claimed {
		t.Errorf("second claim should fail (already claimed)")
	}

	// Release.
	rr, _ := f.post(t, fmt.Sprintf("/api/v1/orders/%s/items/%s/release-print", orderID, itemID), tok, uuid.NewString(), nil)
	if rr.StatusCode != 200 {
		t.Fatalf("release: %d", rr.StatusCode)
	}

	// Second claim now succeeds.
	r3, b3 := f.post(t, fmt.Sprintf("/api/v1/orders/%s/items/%s/claim-print", orderID, itemID), tok, uuid.NewString(),
		map[string]any{"claimed_by": uuid.NewString()})
	if r3.StatusCode != 200 {
		t.Fatalf("claim 3: %d %s", r3.StatusCode, b3)
	}
	var res3 struct {
		Claimed bool `json:"claimed"`
	}
	_ = json.Unmarshal(b3, &res3)
	if !res3.Claimed {
		t.Errorf("claim after release should succeed")
	}
}

// ─── Auto ready check ─────────────────────────────────────────────────────

func TestPhase13_AutoReady(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, _, _ := seedForWrite(t, f)

	// Create an order directly in DB with status='cooking' and expected_ready_at in the past.
	past := time.Now().UTC().Add(-1 * time.Hour)
	cooking := "cooking"
	o := &models.Order{
		ID:              uuid.NewString(),
		Status:          &cooking,
		Total:           decimal.MustFromString("25"),
		ExpectedReadyAt: &past,
		RestaurantID:    &f.rid,
		CreatedAt:       past,
		UpdatedAt:       past,
	}
	if err := gdb.Create(o).Error; err != nil {
		t.Fatal(err)
	}

	r, b := f.post(t, "/api/v1/orders/auto-ready/check", tok, uuid.NewString(), nil)
	if r.StatusCode != 200 {
		t.Fatalf("auto-ready: %d %s", r.StatusCode, b)
	}
	var res struct {
		Updated  int      `json:"updated"`
		OrderIDs []string `json:"order_ids"`
	}
	_ = json.Unmarshal(b, &res)
	if res.Updated < 1 {
		t.Errorf("expected >=1 updated, got %d", res.Updated)
	}
	found := false
	for _, id := range res.OrderIDs {
		if id == o.ID {
			found = true
		}
	}
	if !found {
		t.Errorf("our order %s not in auto-ready list: %v", o.ID, res.OrderIDs)
	}

	// Verify in DB.
	var o2 models.Order
	if err := gdb.Where("id = ?", o.ID).First(&o2).Error; err != nil {
		t.Fatal(err)
	}
	if o2.Status == nil || *o2.Status != "ready" {
		t.Errorf("status = %v, want 'ready'", o2.Status)
	}
	if o2.ReadyAt == nil {
		t.Errorf("ready_at should be set")
	}
}

// ─── Cleanup orphan orders ────────────────────────────────────────────────

func TestPhase13_CleanupOrphans(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, _, _ := seedForWrite(t, f)

	// Old stale open order.
	old := time.Now().UTC().Add(-48 * time.Hour)
	open := "open"
	stale := &models.Order{
		ID:           uuid.NewString(),
		Status:       &open,
		Total:        decimal.MustFromString("10"),
		RestaurantID: &f.rid,
		CreatedAt:    old,
		UpdatedAt:    old,
	}
	if err := gdb.Create(stale).Error; err != nil {
		t.Fatal(err)
	}
	// Forcibly bump updated_at backwards (Create sets it to now via hook).
	if err := gdb.Model(&models.Order{}).Where("id = ?", stale.ID).
		Update("updated_at", old).Error; err != nil {
		t.Fatal(err)
	}

	// Fresh order — should NOT be cancelled.
	freshID := uuid.NewString()
	fresh := &models.Order{
		ID:           freshID,
		Status:       &open,
		Total:        decimal.MustFromString("20"),
		RestaurantID: &f.rid,
		CreatedAt:    time.Now().UTC(),
		UpdatedAt:    time.Now().UTC(),
	}
	if err := gdb.Create(fresh).Error; err != nil {
		t.Fatal(err)
	}

	r, b := f.post(t, "/api/v1/admin/cleanup/orphan-orders", tok, uuid.NewString(), nil)
	if r.StatusCode != 200 {
		t.Fatalf("cleanup: %d %s", r.StatusCode, b)
	}
	var res struct {
		Cancelled int      `json:"cancelled"`
		OrderIDs  []string `json:"order_ids"`
	}
	_ = json.Unmarshal(b, &res)
	if res.Cancelled < 1 {
		t.Errorf("expected >= 1 cancelled, got %d", res.Cancelled)
	}
	foundStale := false
	for _, id := range res.OrderIDs {
		if id == stale.ID {
			foundStale = true
		}
		if id == freshID {
			t.Errorf("fresh order %s should not be cancelled", freshID)
		}
	}
	if !foundStale {
		t.Errorf("stale order not cancelled: %v", res.OrderIDs)
	}

	// Verify in DB.
	var got models.Order
	if err := gdb.Where("id = ?", stale.ID).First(&got).Error; err != nil {
		t.Fatal(err)
	}
	if got.Status == nil || *got.Status != "cancelled" {
		t.Errorf("stale.status = %v, want cancelled", got.Status)
	}
	if got.CancelReason == nil || *got.CancelReason != "stale" {
		t.Errorf("cancel_reason = %v, want 'stale'", got.CancelReason)
	}
}
