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

// ═════════════════════════════════════════════════════════════════════════
// F11: RestaurantStats.total_revenue
// ═════════════════════════════════════════════════════════════════════════

func TestPhase18_RestaurantStatsRevenue(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, _, _ := seedForWrite(t, f)

	closedStatus := "closed"
	now := time.Now().UTC()
	for _, total := range []string{"100", "200"} {
		ord := &models.Order{
			ID: uuid.NewString(), Status: &closedStatus,
			TotalWithService: decimal.MustFromString(total),
			RestaurantID:     &f.rid,
			ClosedAt:         &now, CreatedAt: now, UpdatedAt: now,
		}
		if err := gdb.Create(ord).Error; err != nil {
			t.Fatal(err)
		}
	}

	resp, b := f.get(t, fmt.Sprintf("/api/v1/restaurants/%s/stats", f.rid), tok)
	if resp.StatusCode != 200 {
		t.Fatalf("stats: %d %s", resp.StatusCode, b)
	}
	var stats struct {
		OrdersCount  int    `json:"orders_count"`
		TotalRevenue string `json:"total_revenue"`
	}
	_ = json.Unmarshal(b, &stats)
	if stats.OrdersCount != 2 {
		t.Errorf("orders_count = %d, want 2", stats.OrdersCount)
	}
	got, _ := decimal.FromString(stats.TotalRevenue)
	if !got.Equal(decimal.MustFromString("300")) {
		t.Errorf("total_revenue = %s, want 300", stats.TotalRevenue)
	}
}

// ═════════════════════════════════════════════════════════════════════════
// F12: WaiterTodayStats.service_earned
// ═════════════════════════════════════════════════════════════════════════

func TestPhase18_WaiterServiceEarned(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, _, _ := seedForWrite(t, f)

	waiterID := uuid.NewString()
	name := "W"
	role := "waiter"
	if err := gdb.Create(&models.User{
		ID: waiterID, Name: &name, Role: &role, RestaurantID: &f.rid,
	}).Error; err != nil {
		t.Fatal(err)
	}

	closedStatus := "closed"
	now := time.Now().UTC()
	for _, svc := range []string{"10", "15"} {
		ord := &models.Order{
			ID: uuid.NewString(), Status: &closedStatus,
			WaiterID:      &waiterID,
			ServiceAmount: decimal.MustFromString(svc),
			RestaurantID:  &f.rid,
			ClosedAt:      &now, CreatedAt: now, UpdatedAt: now,
		}
		if err := gdb.Create(ord).Error; err != nil {
			t.Fatal(err)
		}
	}

	resp, b := f.get(t, fmt.Sprintf("/api/v1/waiters/%s/today-stats", waiterID), tok)
	if resp.StatusCode != 200 {
		t.Fatalf("today-stats: %d %s", resp.StatusCode, b)
	}
	var stats struct {
		ServiceEarned string `json:"service_earned"`
	}
	_ = json.Unmarshal(b, &stats)
	got, _ := decimal.FromString(stats.ServiceEarned)
	if !got.Equal(decimal.MustFromString("25")) {
		t.Errorf("service_earned = %s, want 25", stats.ServiceEarned)
	}
}

// ═════════════════════════════════════════════════════════════════════════
// F15: monthlyRevenue with expenses
// ═════════════════════════════════════════════════════════════════════════

func TestPhase18_MonthlyRevenueExpenses(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, _, accountID := seedForWrite(t, f)

	now := time.Now().UTC()
	date := now.Format("2006-01-02")
	outType := "out"
	activity := "operational"
	cat := "rent"
	if err := gdb.Create(&models.FinancialOperation{
		ID:    uuid.NewString(),
		Type:  &outType,
		Amount: decimal.MustFromString("50"),
		Category: &cat,
		AccountID: &accountID,
		Activity: &activity,
		Date: &date,
		RestaurantID: &f.rid,
		CreatedAt: now, UpdatedAt: now,
	}).Error; err != nil {
		t.Fatal(err)
	}
	// Add a closed order in current month for revenue.
	closedStatus := "closed"
	ord := &models.Order{
		ID: uuid.NewString(), Status: &closedStatus,
		TotalWithService: decimal.MustFromString("200"),
		RestaurantID:     &f.rid,
		ClosedAt:         &now, CreatedAt: now, UpdatedAt: now,
	}
	if err := gdb.Create(ord).Error; err != nil {
		t.Fatal(err)
	}

	resp, b := f.get(t, "/api/v1/finance/monthly-revenue?months=12", tok)
	if resp.StatusCode != 200 {
		t.Fatalf("monthly-revenue: %d %s", resp.StatusCode, b)
	}
	var env struct {
		Data []struct {
			Month    string `json:"month"`
			Revenue  string `json:"revenue"`
			Expenses string `json:"expenses"`
			Profit   string `json:"profit"`
		} `json:"data"`
	}
	_ = json.Unmarshal(b, &env)
	curKey := now.Format("2006-01")
	found := false
	for _, r := range env.Data {
		if r.Month == curKey {
			found = true
			exp, _ := decimal.FromString(r.Expenses)
			if !exp.Equal(decimal.MustFromString("50")) {
				t.Errorf("expenses = %s, want 50", r.Expenses)
			}
			rev, _ := decimal.FromString(r.Revenue)
			profit, _ := decimal.FromString(r.Profit)
			expectedProfit := decimal.Sub(rev, exp)
			if !profit.Equal(expectedProfit) {
				t.Errorf("profit = %s, want %s", r.Profit, expectedProfit.String())
			}
		}
	}
	if !found {
		t.Errorf("did not find current month %s in response", curKey)
	}
}

// ═════════════════════════════════════════════════════════════════════════
// F16: PATCH /api/v1/orders/{id}
// ═════════════════════════════════════════════════════════════════════════

func TestPhase18_PatchOrder(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	_, menuItemID, _, _ := seedForWrite(t, f)

	// Create order
	r, b := f.post(t, "/api/v1/orders", tok, uuid.NewString(), map[string]any{
		"items": []map[string]any{{"menu_item_id": menuItemID, "qty": "1"}},
	})
	if r.StatusCode != 201 {
		t.Fatalf("create: %d %s", r.StatusCode, b)
	}
	var created models.Order
	_ = json.Unmarshal(b, &created)

	// PATCH guests_count + comment
	rp, bp := f.patch(t, fmt.Sprintf("/api/v1/orders/%s", created.ID), tok, uuid.NewString(), map[string]any{
		"guests_count": 5,
		"comment":      "VIP",
	})
	if rp.StatusCode != 200 {
		t.Fatalf("patch: %d %s", rp.StatusCode, bp)
	}
	var patched models.Order
	_ = json.Unmarshal(bp, &patched)
	if patched.GuestsCount == nil || *patched.GuestsCount != 5 {
		t.Errorf("guests_count = %v, want 5", patched.GuestsCount)
	}
	if patched.Comment == nil || *patched.Comment != "VIP" {
		t.Errorf("comment = %v, want VIP", patched.Comment)
	}
}

// ═════════════════════════════════════════════════════════════════════════
// F17: User permissions + advance/deductions
// ═════════════════════════════════════════════════════════════════════════

func TestPhase18_UserPermissions(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)

	// Create user with permissions.
	rp, bp := f.post(t, "/api/v1/users", tok, uuid.NewString(), map[string]any{
		"name":        "Bob",
		"role":        "manager",
		"permissions": map[string]any{"finance": true, "menu": false},
	})
	if rp.StatusCode != 201 && rp.StatusCode != 200 {
		t.Fatalf("create user: %d %s", rp.StatusCode, bp)
	}
	var u models.User
	_ = json.Unmarshal(bp, &u)
	if u.Permissions == nil || len(u.Permissions) == 0 {
		t.Errorf("permissions not stored; got %s", string(u.Permissions))
	}

	// PATCH permissions.
	rp2, bp2 := f.patch(t, fmt.Sprintf("/api/v1/users/%s", u.ID), tok, uuid.NewString(), map[string]any{
		"permissions": map[string]any{"finance": false, "menu": true},
	})
	if rp2.StatusCode != 200 {
		t.Fatalf("patch user: %d %s", rp2.StatusCode, bp2)
	}
}

func TestPhase18_UserAdvanceDeductions(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)

	rp, bp := f.post(t, "/api/v1/users", tok, uuid.NewString(), map[string]any{
		"name":         "Eve",
		"role":         "waiter",
		"advance":      "100.5",
		"deductions":   "10",
		"shift_number": 2,
	})
	if rp.StatusCode != 201 && rp.StatusCode != 200 {
		t.Fatalf("create user: %d %s", rp.StatusCode, bp)
	}
	var u models.User
	_ = json.Unmarshal(bp, &u)
	if !u.Advance.Equal(decimal.MustFromString("100.5")) {
		t.Errorf("advance = %s, want 100.5", u.Advance.String())
	}
	if !u.Deductions.Equal(decimal.MustFromString("10")) {
		t.Errorf("deductions = %s, want 10", u.Deductions.String())
	}
	if u.ShiftNumber == nil || *u.ShiftNumber != 2 {
		t.Errorf("shift_number = %v, want 2", u.ShiftNumber)
	}
}

// ═════════════════════════════════════════════════════════════════════════
// F18: Reservation status side-effect on table
// ═════════════════════════════════════════════════════════════════════════

func TestPhase18_ReservationStatusSideEffect(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, _, _ := seedForWrite(t, f)

	// Create table directly in DB.
	tableID := uuid.NewString()
	num := 99
	free := "free"
	if err := gdb.Create(&models.Table{
		ID: tableID, Number: &num, Status: &free,
		RestaurantID: &f.rid, CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC(),
	}).Error; err != nil {
		t.Fatal(err)
	}

	// Create reservation.
	rp, bp := f.post(t, "/api/v1/reservations", tok, uuid.NewString(), map[string]any{
		"table_id":   tableID,
		"guest_name": "John",
		"status":     "pending",
	})
	if rp.StatusCode != 201 && rp.StatusCode != 200 {
		t.Fatalf("create reservation: %d %s", rp.StatusCode, bp)
	}
	var res models.Reservation
	_ = json.Unmarshal(bp, &res)

	// PATCH status to 'seated' → table should become 'occupied'.
	rp2, bp2 := f.patch(t, fmt.Sprintf("/api/v1/reservations/%s", res.ID), tok, uuid.NewString(), map[string]any{
		"status": "seated",
	})
	if rp2.StatusCode != 200 {
		t.Fatalf("patch reservation: %d %s", rp2.StatusCode, bp2)
	}

	var tbl models.Table
	if err := gdb.Where("id = ?", tableID).First(&tbl).Error; err != nil {
		t.Fatal(err)
	}
	if tbl.Status == nil || *tbl.Status != "occupied" {
		t.Errorf("table.status = %v, want 'occupied'", tbl.Status)
	}
}

// ═════════════════════════════════════════════════════════════════════════
// F19: order status transitions (new → cooking → ready → served)
// ═════════════════════════════════════════════════════════════════════════

func TestPhase18_OrderTransitions(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	_, menuItemID, _, _ := seedForWrite(t, f)

	// Create
	r, b := f.post(t, "/api/v1/orders", tok, uuid.NewString(), map[string]any{
		"items": []map[string]any{{"menu_item_id": menuItemID, "qty": "1"}},
	})
	if r.StatusCode != 201 {
		t.Fatalf("create: %d %s", r.StatusCode, b)
	}
	var created models.Order
	_ = json.Unmarshal(b, &created)

	// start-cooking
	r1, b1 := f.post(t, fmt.Sprintf("/api/v1/orders/%s/start-cooking", created.ID), tok, uuid.NewString(), map[string]any{})
	if r1.StatusCode != 200 {
		t.Fatalf("start-cooking: %d %s", r1.StatusCode, b1)
	}
	var o1 models.Order
	_ = json.Unmarshal(b1, &o1)
	if o1.Status == nil || *o1.Status != "cooking" {
		t.Errorf("after start-cooking, status = %v, want 'cooking'", o1.Status)
	}
	if o1.KitchenStartedAt == nil {
		t.Errorf("kitchen_started_at not set")
	}

	// mark-ready
	r2, b2 := f.post(t, fmt.Sprintf("/api/v1/orders/%s/mark-ready", created.ID), tok, uuid.NewString(), map[string]any{})
	if r2.StatusCode != 200 {
		t.Fatalf("mark-ready: %d %s", r2.StatusCode, b2)
	}
	var o2 models.Order
	_ = json.Unmarshal(b2, &o2)
	if o2.Status == nil || *o2.Status != "ready" {
		t.Errorf("after mark-ready, status = %v, want 'ready'", o2.Status)
	}
	if o2.ReadyAt == nil {
		t.Errorf("ready_at not set")
	}

	// mark-served
	r3, b3 := f.post(t, fmt.Sprintf("/api/v1/orders/%s/mark-served", created.ID), tok, uuid.NewString(), map[string]any{})
	if r3.StatusCode != 200 {
		t.Fatalf("mark-served: %d %s", r3.StatusCode, b3)
	}
	var o3 models.Order
	_ = json.Unmarshal(b3, &o3)
	if o3.Status == nil || *o3.Status != "served" {
		t.Errorf("after mark-served, status = %v, want 'served'", o3.Status)
	}
}

// ═════════════════════════════════════════════════════════════════════════
// F20: customer.stats endpoint
// ═════════════════════════════════════════════════════════════════════════

func TestPhase18_CustomerStats(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)

	rp, bp := f.post(t, "/api/v1/customers", tok, uuid.NewString(), map[string]any{
		"name":  "Alice",
		"phone": "+1",
	})
	if rp.StatusCode != 201 && rp.StatusCode != 200 {
		t.Fatalf("create customer: %d %s", rp.StatusCode, bp)
	}
	var c models.Customer
	_ = json.Unmarshal(bp, &c)

	// Bump twice.
	for _, amt := range []string{"50", "30"} {
		r, b := f.post(t, fmt.Sprintf("/api/v1/customers/%s/stats", c.ID), tok, uuid.NewString(), map[string]any{
			"order_total": amt,
		})
		if r.StatusCode != 200 {
			t.Fatalf("stats: %d %s", r.StatusCode, b)
		}
	}

	r, b := f.get(t, "/api/v1/customers?limit=100", tok)
	if r.StatusCode != 200 {
		t.Fatalf("list: %d %s", r.StatusCode, b)
	}
	var env struct {
		Data []models.Customer `json:"data"`
	}
	_ = json.Unmarshal(b, &env)
	var got *models.Customer
	for i := range env.Data {
		if env.Data[i].ID == c.ID {
			got = &env.Data[i]
			break
		}
	}
	if got == nil {
		t.Fatalf("customer not found in list")
	}
	if got.VisitsCount == nil || *got.VisitsCount != 2 {
		t.Errorf("visits_count = %v, want 2", got.VisitsCount)
	}
	if !got.TotalSpent.Equal(decimal.MustFromString("80")) {
		t.Errorf("total_spent = %s, want 80", got.TotalSpent.String())
	}
}

// ═════════════════════════════════════════════════════════════════════════
// F21: AssignWaiter records old/new in audit details
// ═════════════════════════════════════════════════════════════════════════

func TestPhase18_AssignWaiterAudit(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, _, _ := seedForWrite(t, f)

	// Create table.
	tableID := uuid.NewString()
	num := 7
	free := "free"
	if err := gdb.Create(&models.Table{
		ID: tableID, Number: &num, Status: &free,
		RestaurantID: &f.rid, CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC(),
	}).Error; err != nil {
		t.Fatal(err)
	}

	// Create two waiters.
	waiterRole := "waiter"
	oldName := "Old"
	oldID := uuid.NewString()
	if err := gdb.Create(&models.User{ID: oldID, Name: &oldName, Role: &waiterRole, RestaurantID: &f.rid}).Error; err != nil {
		t.Fatal(err)
	}
	newID := uuid.NewString()
	newName := "New"
	if err := gdb.Create(&models.User{ID: newID, Name: &newName, Role: &waiterRole, RestaurantID: &f.rid}).Error; err != nil {
		t.Fatal(err)
	}

	// Assign old waiter first.
	if err := gdb.Model(&models.Table{}).Where("id = ?", tableID).Update("waiter_id", oldID).Error; err != nil {
		t.Fatal(err)
	}

	// API call: assign new waiter.
	r, b := f.post(t, fmt.Sprintf("/api/v1/tables/%s/assign-waiter", tableID), tok, uuid.NewString(), map[string]any{
		"waiter_id": newID,
	})
	if r.StatusCode != 200 {
		t.Fatalf("assign-waiter: %d %s", r.StatusCode, b)
	}

	// Find audit entry with action 'table.assign_waiter'.
	var entries []models.AuditLog
	if err := gdb.Where("entity_id = ? AND action = ?", tableID, "table.assign_waiter").Find(&entries).Error; err != nil {
		t.Fatal(err)
	}
	if len(entries) == 0 {
		t.Fatalf("no audit entry for table.assign_waiter")
	}
	found := false
	for _, e := range entries {
		s := string(e.Details)
		if len(s) > 0 && contains(s, oldID) && contains(s, newID) {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("audit details missing old/new waiter ids; entries: %d", len(entries))
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}

// ═════════════════════════════════════════════════════════════════════════
// F22: seed demo dataset
// ═════════════════════════════════════════════════════════════════════════

func TestPhase18_SeedDemo(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, _, _ := seedForWrite(t, f)
	// seedForWrite already creates a menu_item in setupE2E — so seed should fail
	// CONFLICT on this restaurant. Create a fresh restaurant to seed.
	otherID := uuid.NewString()
	if err := gdb.Create(&models.Restaurant{ID: otherID, Name: "Other"}).Error; err != nil {
		t.Fatal(err)
	}

	r, b := f.post(t, fmt.Sprintf("/api/v1/restaurants/%s/seed?dataset=demo", otherID), tok, uuid.NewString(), map[string]any{})
	if r.StatusCode != 200 {
		t.Fatalf("seed: %d %s", r.StatusCode, b)
	}
	var counts struct {
		Zones       int `json:"zones"`
		Tables      int `json:"tables"`
		MenuItems   int `json:"menu_items"`
		Ingredients int `json:"ingredients"`
	}
	_ = json.Unmarshal(b, &counts)
	if counts.Zones < 2 || counts.Tables < 8 || counts.MenuItems < 5 || counts.Ingredients < 10 {
		t.Errorf("seed counts: zones=%d tables=%d menu=%d ing=%d (want >=2/8/5/10)",
			counts.Zones, counts.Tables, counts.MenuItems, counts.Ingredients)
	}
}
