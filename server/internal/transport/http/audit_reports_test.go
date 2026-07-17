//go:build integration

package http_test

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// Тесты аудита финансовых отчётов. Ассертят согласованность/корректность —
// падение = подтверждение бага.

// manualOut — ручной расход по счёту с заданной категорией/активностью.
func manualOut(t *testing.T, f *e2eFixture, tok, accountID, amount, category, activity string) {
	t.Helper()
	body := map[string]any{
		"type": "out", "amount": amount, "account_id": accountID,
		"category": category, "activity": activity,
	}
	r, b := f.post(t, "/api/v1/finance/operations", tok, uuid.NewString(), body)
	if r.StatusCode != http.StatusCreated && r.StatusCode != http.StatusOK {
		t.Fatalf("manual out (%s/%s): %d %s", category, activity, r.StatusCode, b)
	}
}

func pnlOpex(t *testing.T, f *e2eFixture, tok string) decimal.Decimal {
	t.Helper()
	r, b := f.get(t, "/api/v1/finance/pnl", tok)
	if r.StatusCode != http.StatusOK {
		t.Fatalf("pnl: %d %s", r.StatusCode, b)
	}
	var out struct {
		Opex struct {
			Total decimal.Decimal `json:"total"`
		} `json:"opex"`
		Revenue struct {
			Total decimal.Decimal `json:"total"`
		} `json:"revenue"`
	}
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	return out.Opex.Total
}

// БАГ #10: MonthlyRevenue кладёт закупку склада в расходы, а ОПиУ — нет.
// Один и тот же месяц даёт две разные прибыли.
func TestAudit_MonthlyRevenue_ExcludesStockPurchase(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, _, accountID := seedForWrite(t, f)
	topUp(t, gdb, accountID)

	// Оплаченная приёмка на 300 → finop out/stock_purchase/operational.
	ing := seedReturnIngredient(t, gdb, f.rid, "Крупа-мес", "kg")
	if r, b := f.post(t, "/api/v1/stock/receipts", tok, uuid.NewString(), map[string]any{
		"payment_type": "paid", "supplier_name": "Р", "account_id": accountID, "paid": true,
		"lines": []map[string]any{{"ingredient_id": ing.ID, "name": "Крупа-мес", "qty": "30", "unit": "kg", "price_per_unit": "10"}},
	}); r.StatusCode != http.StatusCreated {
		t.Fatalf("receipt: %d %s", r.StatusCode, b)
	}
	// Один легитимный opex — аренда 100.
	manualOut(t, f, tok, accountID, "100", "rent", "operational")

	opex := pnlOpex(t, f, tok) // должно быть 100 (аренда; закупка исключена)

	r, b := f.get(t, "/api/v1/finance/monthly-revenue", tok)
	if r.StatusCode != http.StatusOK {
		t.Fatalf("monthly: %d %s", r.StatusCode, b)
	}
	var resp struct {
		Data []struct {
			Month    string          `json:"month"`
			Expenses decimal.Decimal `json:"expenses"`
		} `json:"data"`
	}
	if err := json.Unmarshal(b, &resp); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Format("2006-01")
	var monthExp decimal.Decimal
	for _, row := range resp.Data {
		if row.Month == now {
			monthExp = row.Expenses
		}
	}
	// Расход месяца обязан совпадать с opex ОПиУ (оба = 100). Если MonthlyRevenue
	// включил закупку 300 → 400 ≠ 100.
	if !monthExp.Equal(opex) {
		t.Errorf("MonthlyRevenue.Expenses = %s, ОПиУ opex = %s — расходятся: закупка склада (300) попала в месячный расход",
			monthExp, opex)
	}
}

// БАГ #12: Trends «Расходы» = валовой отток ДДС, включая переводы/инкассации.
func TestAudit_Trends_ExpensesExcludeTransfers(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, _, accountID := seedForWrite(t, f)
	topUp(t, gdb, accountID)

	// Второй счёт + инкассация (перевод) 5000.
	r, b := f.post(t, "/api/v1/finance/accounts", tok, uuid.NewString(), map[string]any{
		"name": "Банк", "type": "bank", "balance": "0",
	})
	if r.StatusCode != http.StatusCreated && r.StatusCode != http.StatusOK {
		t.Fatalf("create account: %d %s", r.StatusCode, b)
	}
	var bank models.FinancialAccount
	_ = json.Unmarshal(b, &bank)
	if r, b := f.post(t, "/api/v1/finance/accounts/transfer", tok, uuid.NewString(), map[string]any{
		"from_id": accountID, "to_id": bank.ID, "amount": "5000",
	}); r.StatusCode != http.StatusOK && r.StatusCode != http.StatusCreated {
		t.Fatalf("transfer: %d %s", r.StatusCode, b)
	}
	// Один настоящий расход — 100.
	manualOut(t, f, tok, accountID, "100", "rent", "operational")

	from := time.Now().UTC().AddDate(0, 0, -2).Format("2006-01-02")
	to := time.Now().UTC().AddDate(0, 0, 1).Format("2006-01-02")
	r, b = f.get(t, "/api/v1/analytics/trends?from="+from+"&to="+to+"&granularity=day", tok)
	if r.StatusCode != http.StatusOK {
		t.Fatalf("trends: %d %s", r.StatusCode, b)
	}
	var tr struct {
		Buckets []struct {
			Expenses decimal.Decimal `json:"expenses"`
		} `json:"buckets"`
		Totals struct {
			Expenses decimal.Decimal `json:"expenses"`
		} `json:"totals"`
	}
	if err := json.Unmarshal(b, &tr); err != nil {
		t.Fatal(err)
	}
	sum := tr.Totals.Expenses
	if sum.IsZero() {
		for _, p := range tr.Buckets {
			sum = decimal.Add(sum, p.Expenses)
		}
	}
	// Расходы динамики обязаны быть 100 (аренда), без перевода 5000.
	if sum.GreaterThan(decimal.MustFromString("100")) {
		t.Errorf("Trends расходы = %s, want 100 — перевод/инкассация (5000) попала в расходы динамики", sum)
	}
}

// БАГ #16: Баланс суммирует отрицательные остатки склада → отрицательный актив.
func TestAudit_Balance_InventoryNotNegative(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, _, _ := seedForWrite(t, f)

	// Ингредиент, ушедший в минус (below_zero-движение при выключенном контроле).
	ing := seedReturnIngredient(t, gdb, f.rid, "Минус-товар", "kg")
	if err := gdb.Model(&models.Ingredient{}).Where("id = ?", ing.ID).
		Update("price_per_unit", decimal.MustFromString("10")).Error; err != nil {
		t.Fatal(err)
	}
	mvType := "writeoff"
	if err := gdb.Create(&models.StockMovement{
		ID: uuid.NewString(), Type: &mvType, IngredientID: &ing.ID,
		Qty: decimal.MustFromString("-20"), RestaurantID: &f.rid,
	}).Error; err != nil {
		t.Fatal(err)
	}
	if got := ingQty(t, gdb, ing.ID); !got.Equal(decimal.MustFromString("-20")) {
		t.Fatalf("предусловие: qty = %s, want -20", got)
	}

	r, b := f.get(t, "/api/v1/finance/balance", tok)
	if r.StatusCode != http.StatusOK {
		t.Fatalf("balance: %d %s", r.StatusCode, b)
	}
	var out struct {
		InventoryValue decimal.Decimal `json:"inventory_value"`
	}
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	// Стоимость склада (актив) не может быть отрицательной.
	if decimal.IsNegative(out.InventoryValue) {
		t.Errorf("inventory_value = %s — отрицательный остаток занизил актив ниже нуля", out.InventoryValue)
	}
}

// БАГ #17: Cashflow.out_by_category включает переводы как «расход» категории.
func TestAudit_Cashflow_OutByCategoryNoTransfer(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, _, accountID := seedForWrite(t, f)
	topUp(t, gdb, accountID)

	r, b := f.post(t, "/api/v1/finance/accounts", tok, uuid.NewString(), map[string]any{
		"name": "Банк2", "type": "bank", "balance": "0",
	})
	if r.StatusCode != http.StatusCreated && r.StatusCode != http.StatusOK {
		t.Fatalf("account: %d %s", r.StatusCode, b)
	}
	var bank models.FinancialAccount
	_ = json.Unmarshal(b, &bank)
	if r, b := f.post(t, "/api/v1/finance/accounts/transfer", tok, uuid.NewString(), map[string]any{
		"from_id": accountID, "to_id": bank.ID, "amount": "7000",
	}); r.StatusCode != http.StatusOK && r.StatusCode != http.StatusCreated {
		t.Fatalf("transfer: %d %s", r.StatusCode, b)
	}

	r, b = f.get(t, "/api/v1/finance/cashflow", tok)
	if r.StatusCode != http.StatusOK {
		t.Fatalf("cashflow: %d %s", r.StatusCode, b)
	}
	var out struct {
		OutByCategory []struct {
			Category string          `json:"category"`
			Amount   decimal.Decimal `json:"amount"`
		} `json:"out_by_category"`
	}
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	// Перевод не должен фигурировать в разбивке расходов по категориям —
	// иначе «итого расходы» на экране раздуты на 7000.
	for _, c := range out.OutByCategory {
		if c.Category == "Перевод" || c.Amount.Equal(decimal.MustFromString("7000")) {
			t.Errorf("out_by_category содержит «%s» = %s — перевод посчитан как расход", c.Category, c.Amount)
		}
	}
}

// БАГ #29: ручной out с зарезервированной категорией уводит деньги со счёта,
// но исчезает из прибыли ОПиУ.
func TestAudit_ManualOut_ReservedCategoryStillOpex(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, _, accountID := seedForWrite(t, f)
	topUp(t, gdb, accountID)

	var accBefore models.FinancialAccount
	gdb.First(&accBefore, "id = ?", accountID)

	// Ручной расход с зарезервированной категорией «stock_purchase» — способ
	// спрятать трату из прибыли. Должен быть отбит на входе.
	r, b := f.post(t, "/api/v1/finance/operations", tok, uuid.NewString(), map[string]any{
		"type": "out", "amount": "500", "account_id": accountID,
		"category": "stock_purchase", "activity": "operational",
	})
	if r.StatusCode != http.StatusBadRequest {
		t.Errorf("ручной out с category=stock_purchase: %d %s, want 400 (категория зарезервирована)", r.StatusCode, b)
	}
	// activity=financial тоже запрещена.
	if r, _ := f.post(t, "/api/v1/finance/operations", tok, uuid.NewString(), map[string]any{
		"type": "out", "amount": "500", "account_id": accountID, "category": "прочее", "activity": "financial",
	}); r.StatusCode != http.StatusBadRequest {
		t.Errorf("ручной out с activity=financial: %d, want 400", r.StatusCode)
	}
	// Деньги со счёта не должны были уйти.
	var accAfter models.FinancialAccount
	gdb.First(&accAfter, "id = ?", accountID)
	if !accAfter.Balance.Equal(accBefore.Balance) {
		t.Errorf("баланс изменился (%s→%s) — отбитая операция не должна трогать счёт", accBefore.Balance, accAfter.Balance)
	}
}

// #14 ОПРОВЕРГНУТ. Ревьюер заявил «нарезка в UTC → вечерняя выручка уезжает во
// вчера». Неверно: closed_at — timestamptz, а to_char уважает session timezone
// (Asia/Dushanbe, унаследованный embedded-postgres от хоста). Заказ в 20:00 UTC
// последнего дня месяца обязан попасть в ТЕКУЩИЙ месяц локально — и попадает.
// Тест это доказывает (проходит). Остаточный риск: приложение не пиннит tz на
// подключении, поэтому на UTC-кластере отчёт съедет — но embedded-PG наследует
// tz хоста (Душанбе), так что в реальном деплое отчёт корректен.
func TestAudit_MonthlyRevenue_BucketsLocalTZ(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, menuItemID, _, _ := seedForWrite(t, f)

	// Момент: последний день прошлого месяца 20:00 UTC = 1-е текущего месяца
	// 01:00 по Душанбе. Локально это ТЕКУЩИЙ месяц.
	now := time.Now().UTC()
	firstThisMonth := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
	boundary := firstThisMonth.Add(-4 * time.Hour) // прошлый месяц 20:00 UTC
	thisMonth := firstThisMonth.Format("2006-01")
	prevMonth := boundary.Format("2006-01")

	status := "closed"
	otype := "hall"
	total := decimal.MustFromString("100")
	ord := &models.Order{
		ID: uuid.NewString(), Status: &status, Type: &otype,
		Total: total, TotalWithService: total,
		ClosedAt: &boundary, RestaurantID: &f.rid,
	}
	_ = menuItemID
	if err := gdb.Create(ord).Error; err != nil {
		t.Fatal(err)
	}

	r, b := f.get(t, "/api/v1/finance/monthly-revenue", tok)
	if r.StatusCode != http.StatusOK {
		t.Fatalf("monthly: %d %s", r.StatusCode, b)
	}
	var resp struct {
		Data []struct {
			Month   string          `json:"month"`
			Revenue decimal.Decimal `json:"revenue"`
		} `json:"data"`
	}
	if err := json.Unmarshal(b, &resp); err != nil {
		t.Fatal(err)
	}
	byMonth := map[string]decimal.Decimal{}
	for _, row := range resp.Data {
		byMonth[row.Month] = row.Revenue
	}
	// Корректно: выручка в ТЕКУЩЕМ месяце (локально), а не в прошлом (UTC).
	if !byMonth[thisMonth].Equal(decimal.MustFromString("100")) || byMonth[prevMonth].GreaterThan(decimal.Zero) {
		t.Errorf("выручка попала в %s=%s / %s=%s — ожидалась в текущем месяце (session tz Asia/Dushanbe)",
			prevMonth, byMonth[prevMonth], thisMonth, byMonth[thisMonth])
	}
}

// pnlBoth — revenue и opex ОПиУ за период [from,to] (RFC3339 или пусто).
func pnlBoth(t *testing.T, f *e2eFixture, tok, from, to string) (rev, opex decimal.Decimal) {
	t.Helper()
	url := "/api/v1/finance/pnl"
	if from != "" || to != "" {
		url += "?from=" + from + "&to=" + to
	}
	r, b := f.get(t, url, tok)
	if r.StatusCode != http.StatusOK {
		t.Fatalf("pnl: %d %s", r.StatusCode, b)
	}
	var out struct {
		Revenue struct {
			Total decimal.Decimal `json:"total"`
		} `json:"revenue"`
		Opex struct {
			Total decimal.Decimal `json:"total"`
		} `json:"opex"`
	}
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	return out.Revenue.Total, out.Opex.Total
}

// БАГ #11: ОПиУ (finance.go) и «Динамика» (reports_pl, closed-only) дают разную
// выручку по возвращённому заказу — три поверхности показывают три прибыли.
func TestAudit_RefundedOrder_PnLvsTrends(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	_, menuItemID, shiftID, accountID := seedForWrite(t, f)

	orderID := auditCreateOrder(t, f, tok, menuItemID, "4") // 100
	if r, b := f.post(t, "/api/v1/orders/"+orderID+"/close", tok, uuid.NewString(), map[string]any{
		"payment_method": "cash", "account_id": accountID, "shift_id": shiftID,
	}); r.StatusCode != http.StatusOK {
		t.Fatalf("close: %d %s", r.StatusCode, b)
	}
	if r, b := f.post(t, "/api/v1/orders/"+orderID+"/refund", tok, uuid.NewString(),
		map[string]any{"reason": "полный возврат"}); r.StatusCode != http.StatusOK {
		t.Fatalf("refund: %d %s", r.StatusCode, b)
	}

	pnlRev, _ := pnlBoth(t, f, tok, "", "")

	from := time.Now().UTC().AddDate(0, 0, -1).Format("2006-01-02")
	to := time.Now().UTC().AddDate(0, 0, 1).Format("2006-01-02")
	r, b := f.get(t, "/api/v1/analytics/trends?from="+from+"&to="+to+"&granularity=day", tok)
	if r.StatusCode != http.StatusOK {
		t.Fatalf("trends: %d %s", r.StatusCode, b)
	}
	var tr struct {
		Totals struct {
			Revenue decimal.Decimal `json:"revenue"`
		} `json:"totals"`
	}
	if err := json.Unmarshal(b, &tr); err != nil {
		t.Fatal(err)
	}
	// Одна и та же выручка возвращённого заказа обязана совпасть в обоих отчётах.
	if !tr.Totals.Revenue.Equal(pnlRev) {
		t.Errorf("Trends revenue = %s, ОПиУ revenue = %s — расходятся на возвращённом заказе (три разные прибыли)",
			tr.Totals.Revenue, pnlRev)
	}
}

// БАГ #13: ОПиУ фильтрует по created_at, MonthlyRevenue — по полю date.
// Расход, датированный задним числом, попадает в разные месяцы разных отчётов.
func TestAudit_DateBasis_CreatedVsDate(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, _, accountID := seedForWrite(t, f)
	topUp(t, gdb, accountID)

	now := time.Now().UTC()
	past := now.AddDate(0, -2, 0) // 2 месяца назад — в окне 12 мес
	pastDate := past.Format("2006-01-02")
	pastMonth := past.Format("2006-01")

	// Ручной расход 500, датированный задним числом (created_at = сейчас).
	if r, b := f.post(t, "/api/v1/finance/operations", tok, uuid.NewString(), map[string]any{
		"type": "out", "amount": "500", "account_id": accountID,
		"category": "rent", "activity": "operational", "date": pastDate,
	}); r.StatusCode != http.StatusCreated && r.StatusCode != http.StatusOK {
		t.Fatalf("manual out: %d %s", r.StatusCode, b)
	}

	// MonthlyRevenue кладёт его в pastMonth (по полю date).
	r, b := f.get(t, "/api/v1/finance/monthly-revenue", tok)
	if r.StatusCode != http.StatusOK {
		t.Fatalf("monthly: %d %s", r.StatusCode, b)
	}
	var resp struct {
		Data []struct {
			Month    string          `json:"month"`
			Expenses decimal.Decimal `json:"expenses"`
		} `json:"data"`
	}
	if err := json.Unmarshal(b, &resp); err != nil {
		t.Fatal(err)
	}
	var monthlyPast decimal.Decimal
	for _, row := range resp.Data {
		if row.Month == pastMonth {
			monthlyPast = row.Expenses
		}
	}

	// ОПиУ за pastMonth (по created_at = сейчас) его НЕ видит.
	fromP := time.Date(past.Year(), past.Month(), 1, 0, 0, 0, 0, time.UTC).Format("2006-01-02")
	toP := time.Date(past.Year(), past.Month(), 28, 0, 0, 0, 0, time.UTC).Format("2006-01-02")
	_, pnlPastOpex := pnlBoth(t, f, tok, fromP, toP)

	// Оба отчёта за pastMonth обязаны согласиться про этот расход.
	if !monthlyPast.Equal(pnlPastOpex) {
		t.Errorf("за %s: MonthlyRevenue.Expenses = %s, ОПиУ opex = %s — расход задним числом попал в разные месяцы (date vs created_at)",
			pastMonth, monthlyPast, pnlPastOpex)
	}
}
