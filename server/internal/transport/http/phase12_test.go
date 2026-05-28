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

// ─── Financial Accounts CRUD + Transfer ────────────────────────────────────

func TestPhase12_FinancialAccountsCRUD(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)

	// Create A.
	r1, b1 := f.post(t, "/api/v1/finance/accounts", tok, uuid.NewString(),
		map[string]any{"name": "Cash A", "type": "cash", "balance": "1000"})
	if r1.StatusCode != 201 {
		t.Fatalf("create A %d: %s", r1.StatusCode, b1)
	}
	var accA models.FinancialAccount
	_ = json.Unmarshal(b1, &accA)
	if !accA.Balance.Equal(decimal.MustFromString("1000")) {
		t.Errorf("balance A = %s, want 1000", accA.Balance.String())
	}

	// Create B.
	r2, b2 := f.post(t, "/api/v1/finance/accounts", tok, uuid.NewString(),
		map[string]any{"name": "Bank B", "type": "bank"})
	if r2.StatusCode != 201 {
		t.Fatalf("create B %d: %s", r2.StatusCode, b2)
	}
	var accB models.FinancialAccount
	_ = json.Unmarshal(b2, &accB)

	// List.
	lr, lb := f.get(t, "/api/v1/finance/accounts", tok)
	if lr.StatusCode != 200 {
		t.Fatalf("list %d: %s", lr.StatusCode, lb)
	}
	var env struct {
		Data []models.FinancialAccount `json:"data"`
	}
	_ = json.Unmarshal(lb, &env)
	if len(env.Data) < 2 {
		t.Errorf("expected >=2 accounts, got %d", len(env.Data))
	}

	// Patch.
	pr, _ := f.patch(t, fmt.Sprintf("/api/v1/finance/accounts/%s", accA.ID), tok, uuid.NewString(),
		map[string]any{"name": "Cash A renamed"})
	if pr.StatusCode != 200 {
		t.Errorf("patch %d", pr.StatusCode)
	}

	// Transfer 200 from A → B.
	tr, tb := f.post(t, "/api/v1/finance/accounts/transfer", tok, uuid.NewString(),
		map[string]any{"from_id": accA.ID, "to_id": accB.ID, "amount": "200"})
	if tr.StatusCode != 200 {
		t.Fatalf("transfer %d: %s", tr.StatusCode, tb)
	}
	var trRes struct {
		From models.FinancialOperation `json:"from"`
		To   models.FinancialOperation `json:"to"`
	}
	_ = json.Unmarshal(tb, &trRes)
	if trRes.From.Type == nil || *trRes.From.Type != "out" {
		t.Errorf("from op type want 'out', got %+v", trRes.From.Type)
	}
	if trRes.To.Type == nil || *trRes.To.Type != "in" {
		t.Errorf("to op type want 'in'")
	}

	// Verify balances.
	gr, gb := f.get(t, "/api/v1/finance/accounts", tok)
	if gr.StatusCode != 200 {
		t.Fatalf("list2 %d: %s", gr.StatusCode, gb)
	}
	var env2 struct {
		Data []models.FinancialAccount `json:"data"`
	}
	_ = json.Unmarshal(gb, &env2)
	for _, a := range env2.Data {
		if a.ID == accA.ID && !a.Balance.Equal(decimal.MustFromString("800")) {
			t.Errorf("A balance after transfer = %s, want 800", a.Balance.String())
		}
		if a.ID == accB.ID && !a.Balance.Equal(decimal.MustFromString("200")) {
			t.Errorf("B balance after transfer = %s, want 200", a.Balance.String())
		}
	}

	// Delete A → 409 (has operations).
	dr, _ := f.del(t, fmt.Sprintf("/api/v1/finance/accounts/%s", accA.ID), tok, uuid.NewString())
	if dr.StatusCode != 409 {
		t.Errorf("delete account with ops: %d, want 409", dr.StatusCode)
	}
}

// ─── Financial Operations: manual create + list ────────────────────────────

func TestPhase12_FinancialOperationsManual(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)

	// Account.
	r1, b1 := f.post(t, "/api/v1/finance/accounts", tok, uuid.NewString(),
		map[string]any{"name": "Cash", "balance": "500"})
	if r1.StatusCode != 201 {
		t.Fatalf("create acc %d: %s", r1.StatusCode, b1)
	}
	var acc models.FinancialAccount
	_ = json.Unmarshal(b1, &acc)

	// IN op.
	or, ob := f.post(t, "/api/v1/finance/operations", tok, uuid.NewString(),
		map[string]any{"type": "in", "amount": "100", "category": "Прочее", "account_id": acc.ID})
	if or.StatusCode != 201 {
		t.Fatalf("op in %d: %s", or.StatusCode, ob)
	}

	// OUT op.
	or2, ob2 := f.post(t, "/api/v1/finance/operations", tok, uuid.NewString(),
		map[string]any{"type": "out", "amount": "50", "category": "Закупка", "account_id": acc.ID})
	if or2.StatusCode != 201 {
		t.Fatalf("op out %d: %s", or2.StatusCode, ob2)
	}

	// Check balance = 500 + 100 - 50 = 550.
	gr, gb := f.get(t, "/api/v1/finance/accounts", tok)
	if gr.StatusCode != 200 {
		t.Fatalf("list %d", gr.StatusCode)
	}
	var env struct {
		Data []models.FinancialAccount `json:"data"`
	}
	_ = json.Unmarshal(gb, &env)
	found := false
	for _, a := range env.Data {
		if a.ID == acc.ID {
			found = true
			if !a.Balance.Equal(decimal.MustFromString("550")) {
				t.Errorf("balance after ops = %s, want 550", a.Balance.String())
			}
		}
	}
	if !found {
		t.Errorf("acc not found")
	}

	// List ops.
	lr, lb := f.get(t, "/api/v1/finance/operations?account_id="+acc.ID, tok)
	if lr.StatusCode != 200 {
		t.Fatalf("ops list %d: %s", lr.StatusCode, lb)
	}
	var lenv struct {
		Data []models.FinancialOperation `json:"data"`
	}
	_ = json.Unmarshal(lb, &lenv)
	if len(lenv.Data) != 2 {
		t.Errorf("expected 2 ops, got %d", len(lenv.Data))
	}
}

// ─── Custom Categories CRUD ────────────────────────────────────────────────

func TestPhase12_CustomCategoriesCRUD(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)

	cr, cb := f.post(t, "/api/v1/finance/custom-categories", tok, uuid.NewString(),
		map[string]any{"name": "Маркетинг", "type": "out"})
	if cr.StatusCode != 201 {
		t.Fatalf("create %d: %s", cr.StatusCode, cb)
	}
	var cat models.CustomCategory
	_ = json.Unmarshal(cb, &cat)
	if cat.Name != "Маркетинг" {
		t.Errorf("name mismatch: %s", cat.Name)
	}

	// Create IN one.
	cr2, _ := f.post(t, "/api/v1/finance/custom-categories", tok, uuid.NewString(),
		map[string]any{"name": "Прочий доход", "type": "in"})
	if cr2.StatusCode != 201 {
		t.Fatalf("create in %d", cr2.StatusCode)
	}

	// List type=out.
	lr, lb := f.get(t, "/api/v1/finance/custom-categories?type=out", tok)
	if lr.StatusCode != 200 {
		t.Fatalf("list %d", lr.StatusCode)
	}
	var env struct {
		Data []models.CustomCategory `json:"data"`
	}
	_ = json.Unmarshal(lb, &env)
	if len(env.Data) != 1 || env.Data[0].Type != "out" {
		t.Errorf("expected 1 out category, got %d", len(env.Data))
	}

	// Delete.
	dr, _ := f.del(t, fmt.Sprintf("/api/v1/finance/custom-categories/%s", cat.ID), tok, uuid.NewString())
	if dr.StatusCode != 204 {
		t.Errorf("delete %d", dr.StatusCode)
	}
}

// ─── Balance report ────────────────────────────────────────────────────────

func TestPhase12_BalanceReport(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)

	// Seed assets/liabilities/equity.
	if r, b := f.post(t, "/api/v1/assets", tok, uuid.NewString(),
		map[string]any{"name": "Oven", "amount": "5000"}); r.StatusCode != 201 {
		t.Fatalf("asset: %d %s", r.StatusCode, b)
	}
	if r, b := f.post(t, "/api/v1/liabilities", tok, uuid.NewString(),
		map[string]any{"name": "Loan", "total_amount": "2000", "paid_amount": "500"}); r.StatusCode != 201 {
		t.Fatalf("liab: %d %s", r.StatusCode, b)
	}
	if r, b := f.post(t, "/api/v1/equity", tok, uuid.NewString(),
		map[string]any{"name": "Owner", "amount": "1000"}); r.StatusCode != 201 {
		t.Fatalf("equity: %d %s", r.StatusCode, b)
	}

	br, bb := f.get(t, "/api/v1/finance/balance", tok)
	if br.StatusCode != 200 {
		t.Fatalf("balance %d: %s", br.StatusCode, bb)
	}
	var out struct {
		TotalAssets      string `json:"total_assets"`
		TotalLiabilities string `json:"total_liabilities"`
		TotalEquity      string `json:"total_equity"`
		ComputedEquity   string `json:"computed_equity"`
	}
	_ = json.Unmarshal(bb, &out)
	if d, _ := decimal.FromString(out.TotalAssets); !d.Equal(decimal.MustFromString("5000")) {
		t.Errorf("total_assets = %s, want 5000", out.TotalAssets)
	}
	// remaining = 2000 - 500 = 1500
	if d, _ := decimal.FromString(out.TotalLiabilities); !d.Equal(decimal.MustFromString("1500")) {
		t.Errorf("total_liabilities = %s, want 1500", out.TotalLiabilities)
	}
	// computed = 5000 - 1500 = 3500
	if d, _ := decimal.FromString(out.ComputedEquity); !d.Equal(decimal.MustFromString("3500")) {
		t.Errorf("computed_equity = %s, want 3500", out.ComputedEquity)
	}
}

// ─── Monthly revenue ───────────────────────────────────────────────────────

func TestPhase12_MonthlyRevenue(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, _, _ := seedForWrite(t, f)

	// Создаём закрытый заказ (текущий месяц).
	closed := "closed"
	now := time.Now().UTC()
	pm := "cash"
	if err := gdb.Create(&models.Order{
		ID: uuid.NewString(), Status: &closed, PaymentMethod: &pm,
		TotalWithService: decimal.MustFromString("123.45"),
		ClosedAt:         &now,
		CreatedAt:        now, UpdatedAt: now,
		RestaurantID: &f.rid,
	}).Error; err != nil {
		t.Fatal(err)
	}

	r, b := f.get(t, "/api/v1/finance/monthly-revenue?months=3", tok)
	if r.StatusCode != 200 {
		t.Fatalf("monthly %d: %s", r.StatusCode, b)
	}
	var env struct {
		Data []struct {
			Month       string `json:"month"`
			Revenue     string `json:"revenue"`
			OrdersCount int    `json:"orders_count"`
		} `json:"data"`
	}
	_ = json.Unmarshal(b, &env)
	if len(env.Data) != 3 {
		t.Errorf("expected 3 months, got %d", len(env.Data))
	}
	// Текущий месяц должен иметь выручку 123.45.
	curKey := now.Format("2006-01")
	found := false
	for _, m := range env.Data {
		if m.Month == curKey {
			found = true
			if m.OrdersCount != 1 {
				t.Errorf("current month orders = %d, want 1", m.OrdersCount)
			}
			if d, _ := decimal.FromString(m.Revenue); !d.Equal(decimal.MustFromString("123.45")) {
				t.Errorf("current month revenue = %s, want 123.45", m.Revenue)
			}
		}
	}
	if !found {
		t.Errorf("current month %s not in result", curKey)
	}
}

// ─── Salary pay ────────────────────────────────────────────────────────────

func TestPhase12_SalaryPay(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, _, accID := seedForWrite(t, f)

	// Top up account.
	if err := gdb.Model(&models.FinancialAccount{}).
		Where("id = ?", accID).
		Update("balance", decimal.MustFromString("1000")).Error; err != nil {
		t.Fatal(err)
	}

	// Get cashier user.
	var u models.User
	if err := gdb.Where("restaurant_id = ?", f.rid).First(&u).Error; err != nil {
		t.Fatal(err)
	}

	r, b := f.post(t, "/api/v1/finance/salary/pay", tok, uuid.NewString(),
		map[string]any{
			"user_id":       u.ID,
			"amount":        "300",
			"account_id":    accID,
			"employee_name": "Cashier",
			"period":        "2026-05",
		})
	if r.StatusCode != 201 {
		t.Fatalf("pay %d: %s", r.StatusCode, b)
	}
	var op models.FinancialOperation
	_ = json.Unmarshal(b, &op)
	if op.Category == nil || *op.Category != "Зарплата" {
		t.Errorf("category mismatch: %+v", op.Category)
	}
	if !op.Amount.Equal(decimal.MustFromString("300")) {
		t.Errorf("amount = %s", op.Amount.String())
	}

	// Account balance now 700.
	var acc models.FinancialAccount
	if err := gdb.Where("id = ?", accID).First(&acc).Error; err != nil {
		t.Fatal(err)
	}
	if !acc.Balance.Equal(decimal.MustFromString("700")) {
		t.Errorf("balance after salary = %s, want 700", acc.Balance.String())
	}
}

// ─── Cashflow / P&L smoke ──────────────────────────────────────────────────

func TestPhase12_CashflowPnL(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)

	// Seed account + operations.
	r1, b1 := f.post(t, "/api/v1/finance/accounts", tok, uuid.NewString(),
		map[string]any{"name": "Cash", "balance": "1000"})
	if r1.StatusCode != 201 {
		t.Fatalf("acc %d: %s", r1.StatusCode, b1)
	}
	var acc models.FinancialAccount
	_ = json.Unmarshal(b1, &acc)

	// IN 200 Прочее.
	f.post(t, "/api/v1/finance/operations", tok, uuid.NewString(),
		map[string]any{"type": "in", "amount": "200", "category": "Прочее", "account_id": acc.ID})
	// OUT 50 Закупка.
	f.post(t, "/api/v1/finance/operations", tok, uuid.NewString(),
		map[string]any{"type": "out", "amount": "50", "category": "Закупка", "account_id": acc.ID})

	// P&L.
	r, b := f.get(t, "/api/v1/finance/pnl", tok)
	if r.StatusCode != 200 {
		t.Fatalf("pnl %d: %s", r.StatusCode, b)
	}
	var pnl struct {
		Opex struct {
			Total string `json:"total"`
		} `json:"opex"`
	}
	_ = json.Unmarshal(b, &pnl)
	if d, _ := decimal.FromString(pnl.Opex.Total); !d.Equal(decimal.MustFromString("50")) {
		t.Errorf("opex total = %s, want 50", pnl.Opex.Total)
	}

	// Cashflow.
	r2, b2 := f.get(t, "/api/v1/finance/cashflow", tok)
	if r2.StatusCode != 200 {
		t.Fatalf("cashflow %d: %s", r2.StatusCode, b2)
	}
	var cf struct {
		NetTotal string `json:"net_total"`
	}
	_ = json.Unmarshal(b2, &cf)
	// net = 200 - 50 = 150
	if d, _ := decimal.FromString(cf.NetTotal); !d.Equal(decimal.MustFromString("150")) {
		t.Errorf("net_total = %s, want 150", cf.NetTotal)
	}
}
