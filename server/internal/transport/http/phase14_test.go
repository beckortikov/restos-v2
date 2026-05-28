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

// ─── Shift active: open → GET active → close → 404 ──────────────────────

func TestPhase14_ShiftActive(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, _, _ := seedForWrite(t, f)

	// seedForWrite already opened a shift directly in DB — close it first.
	if err := gdb.Exec("DELETE FROM cash_shifts WHERE restaurant_id = ?", f.rid).Error; err != nil {
		t.Fatal(err)
	}

	// No active → 404.
	r0, _ := f.get(t, "/api/v1/shifts/active", tok)
	if r0.StatusCode != 404 {
		t.Fatalf("expected 404 when no active shift, got %d", r0.StatusCode)
	}

	// Open a shift via API.
	r1, b1 := f.post(t, "/api/v1/shifts", tok, uuid.NewString(), map[string]any{
		"opening_balance": "100",
	})
	if r1.StatusCode != 201 {
		t.Fatalf("open shift: %d %s", r1.StatusCode, b1)
	}
	var opened models.CashShift
	_ = json.Unmarshal(b1, &opened)

	// GET /shifts/active → matches.
	r2, b2 := f.get(t, "/api/v1/shifts/active", tok)
	if r2.StatusCode != 200 {
		t.Fatalf("active: %d %s", r2.StatusCode, b2)
	}
	var got models.CashShift
	_ = json.Unmarshal(b2, &got)
	if got.ID != opened.ID {
		t.Errorf("active.id = %s, want %s", got.ID, opened.ID)
	}

	// Close → 404 again.
	rc, bc := f.post(t, fmt.Sprintf("/api/v1/shifts/%s/close", opened.ID), tok, uuid.NewString(),
		map[string]any{"closing_balance": "100"})
	if rc.StatusCode != 200 {
		t.Fatalf("close: %d %s", rc.StatusCode, bc)
	}
	r3, _ := f.get(t, "/api/v1/shifts/active", tok)
	if r3.StatusCode != 404 {
		t.Errorf("after close: expected 404, got %d", r3.StatusCode)
	}
}

// ─── Shift Z-report: open → close order → /zreport returns aggregates ────

func TestPhase14_ShiftZReport(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	_, menuItemID, shiftID, accountID := seedForWrite(t, f)

	// Create + close an order in this shift.
	orderID, _ := phase13_createOrder(t, f, tok, menuItemID, 2) // total = 50
	closePath := fmt.Sprintf("/api/v1/orders/%s/close", orderID)
	r, b := f.post(t, closePath, tok, uuid.NewString(), map[string]any{
		"payment_method": "cash",
		"account_id":     accountID,
		"shift_id":       shiftID,
	})
	if r.StatusCode != 200 {
		t.Fatalf("close order: %d %s", r.StatusCode, b)
	}

	// Add a cash_out expense.
	re, be := f.post(t, fmt.Sprintf("/api/v1/shifts/%s/expenses", shiftID), tok, uuid.NewString(),
		map[string]any{"type": "expense", "amount": "10", "description": "tea"})
	if re.StatusCode != 201 {
		t.Fatalf("expense: %d %s", re.StatusCode, be)
	}

	// GET z-report.
	rz, bz := f.get(t, fmt.Sprintf("/api/v1/shifts/%s/zreport", shiftID), tok)
	if rz.StatusCode != 200 {
		t.Fatalf("zreport: %d %s", rz.StatusCode, bz)
	}
	var z struct {
		Shift struct {
			OrdersCount int             `json:"orders_count"`
			CashRevenue decimal.Decimal `json:"cash_revenue"`
		} `json:"shift"`
		RevenueByMethod []struct {
			PaymentMethod string          `json:"payment_method"`
			OrdersCount   int             `json:"orders_count"`
			Total         decimal.Decimal `json:"total"`
		} `json:"revenue_by_method"`
		Operations []models.CashShiftOperation `json:"operations"`
	}
	if err := json.Unmarshal(bz, &z); err != nil {
		t.Fatalf("decode zreport: %v", err)
	}
	if z.Shift.OrdersCount != 1 {
		t.Errorf("orders_count = %d, want 1", z.Shift.OrdersCount)
	}
	if !z.Shift.CashRevenue.Equal(decimal.MustFromString("50")) {
		t.Errorf("cash_revenue = %s, want 50", z.Shift.CashRevenue.String())
	}
	if len(z.RevenueByMethod) == 0 {
		t.Errorf("revenue_by_method empty")
	}
	if len(z.Operations) == 0 {
		t.Errorf("operations should include the expense")
	}

	// Revenue endpoint.
	rr, rb := f.get(t, fmt.Sprintf("/api/v1/shifts/%s/revenue", shiftID), tok)
	if rr.StatusCode != 200 {
		t.Fatalf("revenue: %d %s", rr.StatusCode, rb)
	}
	var rev struct {
		CashRevenue decimal.Decimal `json:"cash_revenue"`
		OrdersCount int             `json:"orders_count"`
	}
	_ = json.Unmarshal(rb, &rev)
	if rev.OrdersCount != 1 || !rev.CashRevenue.Equal(decimal.MustFromString("50")) {
		t.Errorf("revenue mismatch: %+v", rev)
	}

	// Operations endpoint.
	ro, rob := f.get(t, fmt.Sprintf("/api/v1/shifts/%s/operations", shiftID), tok)
	if ro.StatusCode != 200 {
		t.Fatalf("ops: %d %s", ro.StatusCode, rob)
	}
	var opsEnv struct {
		Data []models.CashShiftOperation `json:"data"`
	}
	_ = json.Unmarshal(rob, &opsEnv)
	if len(opsEnv.Data) == 0 {
		t.Errorf("expected at least 1 operation")
	}

	// Delete expense.
	opID := opsEnv.Data[0].ID
	rd, _ := f.del(t, fmt.Sprintf("/api/v1/shifts/%s/expenses/%s", shiftID, opID), tok, uuid.NewString())
	if rd.StatusCode != 204 {
		t.Errorf("delete expense: %d", rd.StatusCode)
	}
}

// ─── Stop list: low-stock ingredient + manual override ────────────────────

func TestPhase14_StopList(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, menuItemID, _, _ := seedForWrite(t, f)

	// Force ingredient.qty = 0 (below min_qty=0 is not enough — we need <= min_qty).
	// seedForWrite created ingredient with qty=10 min_qty=0. Bump min_qty to 100.
	if err := gdb.Exec(`UPDATE ingredients SET min_qty = 100 WHERE restaurant_id = ?`, f.rid).Error; err != nil {
		t.Fatal(err)
	}

	// GET stop-list → contains menuItem with manual=false.
	r, b := f.get(t, "/api/v1/stop-list", tok)
	if r.StatusCode != 200 {
		t.Fatalf("stop-list: %d %s", r.StatusCode, b)
	}
	var env struct {
		Data []struct {
			MenuItemID  string `json:"menu_item_id"`
			Manual      bool   `json:"manual"`
			Ingredients []struct {
				Name string `json:"name"`
			} `json:"ingredients"`
		} `json:"data"`
	}
	_ = json.Unmarshal(b, &env)
	foundAuto := false
	for _, it := range env.Data {
		if it.MenuItemID == menuItemID && !it.Manual && len(it.Ingredients) > 0 {
			foundAuto = true
		}
	}
	if !foundAuto {
		t.Errorf("expected auto-stop entry, got %+v", env.Data)
	}

	// Toggle override.
	ro, bo := f.post(t, fmt.Sprintf("/api/v1/stop-list/%s/override", menuItemID), tok, uuid.NewString(),
		map[string]any{"override": true})
	if ro.StatusCode != 200 {
		t.Fatalf("override: %d %s", ro.StatusCode, bo)
	}

	// Reset ingredient qty so it's no longer auto-stopped — then the only reason
	// it appears is manual=true.
	if err := gdb.Exec(`UPDATE ingredients SET min_qty = 0 WHERE restaurant_id = ?`, f.rid).Error; err != nil {
		t.Fatal(err)
	}

	r2, b2 := f.get(t, "/api/v1/stop-list", tok)
	if r2.StatusCode != 200 {
		t.Fatalf("stop-list 2: %d %s", r2.StatusCode, b2)
	}
	_ = json.Unmarshal(b2, &env)
	foundManual := false
	for _, it := range env.Data {
		if it.MenuItemID == menuItemID && it.Manual {
			foundManual = true
		}
	}
	if !foundManual {
		t.Errorf("expected manual stop entry, got %+v", env.Data)
	}

	// Recompute — no-op but should succeed.
	rr, _ := f.post(t, "/api/v1/stop-list/recompute", tok, uuid.NewString(), nil)
	if rr.StatusCode != 200 {
		t.Errorf("recompute: %d", rr.StatusCode)
	}
}

// ─── Semi prepare/consume ────────────────────────────────────────────────

func TestPhase14_SemiPrepareConsume(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, _, _ := seedForWrite(t, f)

	// Get the ingredient created in seed.
	var ing models.Ingredient
	if err := gdb.Where("restaurant_id = ?", f.rid).First(&ing).Error; err != nil {
		t.Fatal(err)
	}
	ingQtyBefore := ing.Qty

	// Create semi type.
	semiName := "Broth"
	semiUnit := "L"
	semiID := uuid.NewString()
	if err := gdb.Create(&models.SemiFinishedType{
		ID: semiID, Name: &semiName, OutputUnit: &semiUnit, RestaurantID: &f.rid,
		YieldPercent: decimal.MustFromString("100"),
	}).Error; err != nil {
		t.Fatal(err)
	}
	// Recipe: 1 unit of semi consumes 0.5 kg of Rice.
	if err := gdb.Create(&models.SemiRecipeLine{
		ID: uuid.NewString(), SemiTypeID: &semiID, IngredientID: &ing.ID,
		Name: ing.Name, QtyPerUnit: decimal.MustFromString("0.5"), Unit: ing.Unit,
	}).Error; err != nil {
		t.Fatal(err)
	}

	// Prepare 2 units → ingredient.qty -= 1.0.
	r, b := f.post(t, "/api/v1/semi/prepare", tok, uuid.NewString(), map[string]any{
		"semi_type_id": semiID,
		"qty":          "2",
	})
	if r.StatusCode != 200 {
		t.Fatalf("prepare: %d %s", r.StatusCode, b)
	}
	var stock models.SemiFinishedStock
	_ = json.Unmarshal(b, &stock)
	if !stock.Qty.Equal(decimal.MustFromString("2")) {
		t.Errorf("stock.qty = %s, want 2", stock.Qty.String())
	}

	// Verify ingredient was deducted.
	var ing2 models.Ingredient
	gdb.Where("id = ?", ing.ID).First(&ing2)
	want := decimal.Normalize(decimal.Sub(ingQtyBefore, decimal.MustFromString("1")))
	if !ing2.Qty.Equal(want) {
		t.Errorf("ingredient.qty = %s, want %s", ing2.Qty.String(), want.String())
	}

	// Consume 1 unit.
	rc, bc := f.post(t, "/api/v1/semi/consume", tok, uuid.NewString(), map[string]any{
		"semi_type_id": semiID,
		"qty":          "1",
	})
	if rc.StatusCode != 200 {
		t.Fatalf("consume: %d %s", rc.StatusCode, bc)
	}
	var stock2 models.SemiFinishedStock
	_ = json.Unmarshal(bc, &stock2)
	if !stock2.Qty.Equal(decimal.MustFromString("1")) {
		t.Errorf("after consume, stock.qty = %s, want 1", stock2.Qty.String())
	}
}

// ─── Batch cooking flow ───────────────────────────────────────────────────

func TestPhase14_BatchCooking(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, menuItemID, _, _ := seedForWrite(t, f)

	// max-portions: ingredient has qty=10, tech_card uses 0.2 per portion → 50.
	r, b := f.get(t, fmt.Sprintf("/api/v1/menu/items/%s/max-portions", menuItemID), tok)
	if r.StatusCode != 200 {
		t.Fatalf("max-portions: %d %s", r.StatusCode, b)
	}
	var mp struct {
		Max int `json:"max"`
	}
	_ = json.Unmarshal(b, &mp)
	if mp.Max != 50 {
		t.Errorf("max = %d, want 50", mp.Max)
	}

	// Produce 5 → ingredient.qty -= 1.0, prepared_qty = 5.
	rp, bp := f.post(t, fmt.Sprintf("/api/v1/menu/items/%s/batch/produce", menuItemID), tok, uuid.NewString(),
		map[string]any{"qty": 5})
	if rp.StatusCode != 200 {
		t.Fatalf("produce: %d %s", rp.StatusCode, bp)
	}
	var mi models.MenuItem
	_ = json.Unmarshal(bp, &mi)
	if mi.PreparedQty == nil || *mi.PreparedQty != 5 {
		t.Errorf("prepared_qty = %v, want 5", mi.PreparedQty)
	}

	// Decrement 2.
	rd, bd := f.post(t, fmt.Sprintf("/api/v1/menu/items/%s/batch/decrement", menuItemID), tok, uuid.NewString(),
		map[string]any{"qty": 2})
	if rd.StatusCode != 200 {
		t.Fatalf("decrement: %d %s", rd.StatusCode, bd)
	}
	var mi2 models.MenuItem
	_ = json.Unmarshal(bd, &mi2)
	if mi2.PreparedQty == nil || *mi2.PreparedQty != 3 {
		t.Errorf("after decrement: prepared_qty = %v, want 3", mi2.PreparedQty)
	}

	// Writeoff all.
	rw, bw := f.post(t, fmt.Sprintf("/api/v1/menu/items/%s/batch/writeoff", menuItemID), tok, uuid.NewString(),
		map[string]any{"reason": "spoiled"})
	if rw.StatusCode != 200 {
		t.Fatalf("writeoff: %d %s", rw.StatusCode, bw)
	}
	var mi3 models.MenuItem
	_ = json.Unmarshal(bw, &mi3)
	if mi3.PreparedQty == nil || *mi3.PreparedQty != 0 {
		t.Errorf("after writeoff: prepared_qty = %v, want 0", mi3.PreparedQty)
	}

	// Logs: should have 3 entries (produce/consume/writeoff).
	rl, bl := f.get(t, fmt.Sprintf("/api/v1/menu/items/%s/batch/logs", menuItemID), tok)
	if rl.StatusCode != 200 {
		t.Fatalf("logs: %d %s", rl.StatusCode, bl)
	}
	var lenv struct {
		Data []models.BatchCookingLog `json:"data"`
	}
	_ = json.Unmarshal(bl, &lenv)
	if len(lenv.Data) != 3 {
		t.Errorf("expected 3 logs, got %d", len(lenv.Data))
	}

	// Check stock movements: 5 produce-deducts should exist.
	var movCount int64
	if err := gdb.Model(&models.StockMovement{}).
		Where("restaurant_id = ? AND description = ?", f.rid, "batch_produce:"+menuItemID).
		Count(&movCount).Error; err != nil {
		t.Fatal(err)
	}
	if movCount < 1 {
		t.Errorf("expected stock movements for batch produce, got %d", movCount)
	}
}

// ─── Audit log: mutations write to log + filterable ──────────────────────

func TestPhase14_AuditLog(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	_, menuItemID, _, _ := seedForWrite(t, f)

	// Perform a mutation (creates order → audit entries).
	_, _ = phase13_createOrder(t, f, tok, menuItemID, 1)

	r, b := f.get(t, "/api/v1/audit-log", tok)
	if r.StatusCode != 200 {
		t.Fatalf("audit-log: %d %s", r.StatusCode, b)
	}
	var env struct {
		Data  []models.AuditLog `json:"data"`
		Total int64             `json:"total"`
	}
	_ = json.Unmarshal(b, &env)
	if env.Total == 0 || len(env.Data) == 0 {
		t.Errorf("expected at least 1 audit entry, got total=%d len=%d", env.Total, len(env.Data))
	}

	// Filter by entity_type=orders.
	r2, b2 := f.get(t, "/api/v1/audit-log?entity_type=orders&limit=10", tok)
	if r2.StatusCode != 200 {
		t.Fatalf("filtered: %d %s", r2.StatusCode, b2)
	}
	var env2 struct {
		Data  []models.AuditLog `json:"data"`
		Total int64             `json:"total"`
	}
	_ = json.Unmarshal(b2, &env2)
	for _, l := range env2.Data {
		if l.EntityType == nil || *l.EntityType != "orders" {
			t.Errorf("filter entity_type=orders returned entry with type=%v", l.EntityType)
		}
	}
}

// ─── Print reprint: clone existing job ───────────────────────────────────

func TestPhase14_ReprintJob(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, _, _ := seedForWrite(t, f)

	// Create a print job directly in DB.
	src := &models.PrintJob{
		ID:           uuid.NewString(),
		Type:         "receipt",
		Payload:      []byte{0x1B, 0x40, 'A', 'B'},
		Status:       "done",
		RestaurantID: &f.rid,
		CreatedAt:    time.Now().UTC(),
		UpdatedAt:    time.Now().UTC(),
	}
	if err := gdb.Create(src).Error; err != nil {
		t.Fatal(err)
	}

	r, b := f.post(t, fmt.Sprintf("/api/v1/print/jobs/%s/reprint", src.ID), tok, uuid.NewString(), nil)
	if r.StatusCode != 201 {
		t.Fatalf("reprint: %d %s", r.StatusCode, b)
	}
	var clone models.PrintJob
	_ = json.Unmarshal(b, &clone)
	if clone.ID == src.ID {
		t.Errorf("reprint should have new id")
	}
	if clone.Status != "pending" {
		t.Errorf("clone.status = %s, want pending", clone.Status)
	}

	// Verify 2 jobs total in DB.
	var n int64
	gdb.Model(&models.PrintJob{}).Where("restaurant_id = ?", f.rid).Count(&n)
	if n < 2 {
		t.Errorf("expected >=2 jobs, got %d", n)
	}
}

// ─── Reservations for table ──────────────────────────────────────────────

func TestPhase14_ReservationsForTable(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, _, _ := seedForWrite(t, f)

	// Need a table.
	tableID := uuid.NewString()
	num := 1
	if err := gdb.Create(&models.Table{
		ID: tableID, Number: &num, RestaurantID: &f.rid,
	}).Error; err != nil {
		t.Fatal(err)
	}

	// Reserve 1h from now.
	reservedAt := time.Now().UTC().Add(1 * time.Hour).Format(time.RFC3339)
	r, b := f.post(t, "/api/v1/reservations", tok, uuid.NewString(), map[string]any{
		"table_id":    tableID,
		"guest_name":  "Ali",
		"reserved_at": reservedAt,
	})
	if r.StatusCode != 201 {
		t.Fatalf("reserve: %d %s", r.StatusCode, b)
	}

	r2, b2 := f.get(t, fmt.Sprintf("/api/v1/reservations/for-table/%s", tableID), tok)
	if r2.StatusCode != 200 {
		t.Fatalf("for-table: %d %s", r2.StatusCode, b2)
	}
	var env struct {
		Data []models.Reservation `json:"data"`
	}
	_ = json.Unmarshal(b2, &env)
	if len(env.Data) != 1 {
		t.Errorf("expected 1 reservation, got %d", len(env.Data))
	}
}

// ─── Time entries active + patch + today-stats ──────────────────────────

func TestPhase14_TimeEntriesActive(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, _, _ := seedForWrite(t, f)

	var user models.User
	if err := gdb.Where("restaurant_id = ?", f.rid).First(&user).Error; err != nil {
		t.Fatal(err)
	}

	// No active → 404.
	r0, _ := f.get(t, fmt.Sprintf("/api/v1/time-entries/active?user_id=%s", user.ID), tok)
	if r0.StatusCode != 404 {
		t.Fatalf("expected 404, got %d", r0.StatusCode)
	}

	// Clock-in.
	r1, b1 := f.post(t, "/api/v1/time-entries", tok, uuid.NewString(), map[string]any{
		"user_id": user.ID,
	})
	if r1.StatusCode != 201 {
		t.Fatalf("clock-in: %d %s", r1.StatusCode, b1)
	}
	var te models.TimeEntry
	_ = json.Unmarshal(b1, &te)

	// GET active → matches.
	r2, b2 := f.get(t, fmt.Sprintf("/api/v1/time-entries/active?user_id=%s", user.ID), tok)
	if r2.StatusCode != 200 {
		t.Fatalf("active: %d %s", r2.StatusCode, b2)
	}
	var got models.TimeEntry
	_ = json.Unmarshal(b2, &got)
	if got.ID != te.ID {
		t.Errorf("active.id = %s, want %s", got.ID, te.ID)
	}

	// PATCH /time-entries/{id} — add a note.
	rp, bp := f.patch(t, fmt.Sprintf("/api/v1/time-entries/%s", te.ID), tok, uuid.NewString(),
		map[string]any{"note": "manual edit"})
	if rp.StatusCode != 200 {
		t.Fatalf("patch: %d %s", rp.StatusCode, bp)
	}

	// Clock-out.
	rc, bc := f.patch(t, fmt.Sprintf("/api/v1/time-entries/%s/clock-out", te.ID), tok, uuid.NewString(), map[string]any{})
	if rc.StatusCode != 200 {
		t.Fatalf("clock-out: %d %s", rc.StatusCode, bc)
	}

	// Active again → 404.
	r3, _ := f.get(t, fmt.Sprintf("/api/v1/time-entries/active?user_id=%s", user.ID), tok)
	if r3.StatusCode != 404 {
		t.Errorf("after clock-out: expected 404, got %d", r3.StatusCode)
	}

	// Today stats (no orders for this user as waiter but endpoint should succeed).
	rs, bs := f.get(t, fmt.Sprintf("/api/v1/waiters/%s/today-stats", user.ID), tok)
	if rs.StatusCode != 200 {
		t.Fatalf("today-stats: %d %s", rs.StatusCode, bs)
	}
	var stats struct {
		OrdersCount int             `json:"orders_count"`
		HoursWorked decimal.Decimal `json:"hours_worked"`
	}
	_ = json.Unmarshal(bs, &stats)
	// orders_count может быть 0 — главное, чтобы endpoint работал.
	_ = stats
}
