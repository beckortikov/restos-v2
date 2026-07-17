//go:build integration

package http_test

import (
	"encoding/json"
	"fmt"
	"net/url"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/db"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// TestFinancialFlow_Full — сквозной e2e-тест арифметики «продажа +
// закуп + списание + тех-карта + ДДС/ОПиУ + зарплата + бонус».
//
// Цель — ловить регрессии в арифметике. Ассертим конкретные числа
// на каждом шаге. Если endpoint не реализован — t.Skipf c причиной.
// Если число не совпадает с ожиданием — НЕ подгоняем; ассертим как
// есть и логируем MISMATCH.
//
// Сценарий (в TJS):
//   - Setup: restaurant, cash+bank accounts, ингредиент «Мясо» (cost 20),
//     menu_item «Плов» (price 50, cogs 4=0.2*20), tech-card 0.2 kg/порция.
//   - Flow 1: приёмка 10kg × 25 = 250.
//   - Flow 2: списание 1 kg × cost 20.
//   - Flow 3: открытие смены (opening 100).
//   - Flow 4: продажа 5×Плов (250) с service 10% → 275, оплата cash.
//   - Flow 5: зарплата 200 с bank (manual finance op).
//   - Flow 6: бонус повару 50 с cash.
//   - Flow 7: закрытие смены.
//   - Flow 8: ОПиУ за период.
//   - Flow 9: ДДС за период.
func TestFinancialFlow_Full(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)

	gdb, _ := db.Open(testDSN())
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})

	// Включить tech-cards для деdукции на close (setupE2E ставит false).
	techOn := true
	if err := gdb.Model(&models.Restaurant{}).
		Where("id = ?", f.rid).
		Updates(map[string]any{"tech_cards_enabled": &techOn, "service_percent": decimal.MustFromString("10")}).
		Error; err != nil {
		t.Fatal(err)
	}

	periodStart := time.Now().UTC().Add(-1 * time.Hour)

	// ─── Setup: ingredients, menu item, tech_card, accounts ─────────────
	// Используем прямой gdb-доступ для seed (как в seedForWrite).
	// «Мясо», unit=kg, qty=0.
	meatName := "Мясо"
	meatUnit := "kg"
	meatPPU := decimal.MustFromString("20") // price_per_unit (используется для supply expenses)
	meat := &models.Ingredient{
		ID:           uuid.NewString(),
		Name:         &meatName,
		Unit:         &meatUnit,
		PricePerUnit: meatPPU,
		RestaurantID: &f.rid,
	}
	if err := gdb.Create(meat).Error; err != nil {
		t.Fatal(err)
	}

	// menu_item «Плов» уже создан в setupE2E с price=25. Обновим: price=50, cogs=4.
	var plov models.MenuItem
	if err := gdb.Where("restaurant_id = ?", f.rid).First(&plov).Error; err != nil {
		t.Fatal(err)
	}
	plov.Price = decimal.MustFromString("50")
	plov.COGS = decimal.MustFromString("4") // 0.2 kg × 20 = 4
	if err := gdb.Save(&plov).Error; err != nil {
		t.Fatal(err)
	}

	// tech_card_line: «Плов» × 0.2 kg «Мясо».
	tcName := "Мясо"
	if err := gdb.Create(&models.TechCardLine{
		ID:           uuid.NewString(),
		MenuItemID:   &plov.ID,
		IngredientID: &meat.ID,
		Name:         &tcName,
		Qty:          decimal.MustFromString("0.2"),
		Unit:         &meatUnit,
		RestaurantID: &f.rid,
	}).Error; err != nil {
		t.Fatal(err)
	}

	// Financial accounts: cash + bank. bank пополняем 1000 (на зарплату).
	cashAccID := uuid.NewString()
	cashName := "Касса"
	cashType := "cash"
	if err := gdb.Create(&models.FinancialAccount{
		ID: cashAccID, Name: &cashName, Type: &cashType,
		RestaurantID: &f.rid, Balance: decimal.MustFromString("1000"),
	}).Error; err != nil {
		t.Fatal(err)
	}
	bankAccID := uuid.NewString()
	bankName := "Банк"
	bankType := "bank"
	if err := gdb.Create(&models.FinancialAccount{
		ID: bankAccID, Name: &bankName, Type: &bankType,
		RestaurantID: &f.rid, Balance: decimal.MustFromString("1000"),
	}).Error; err != nil {
		t.Fatal(err)
	}

	// ─── Flow 1: приёмка (атомарная — v2.0.87) ───────────────────────────
	t.Run("Flow1_Receipt", func(t *testing.T) {
		// v2.0.87: account_id + paid=true → CreateReceipt сам создаёт
		// financial_operation type="out" category="stock_purchase"
		// source_ref="receipt:<id>" и списывает баланс счёта в той же tx.
		// Никаких ручных POST /finance/operations больше не нужно.
		body := map[string]any{
			"payment_type":  "paid",
			"supplier_name": "Поставщик-Мясо",
			"account_id":    cashAccID,
			"paid":          true,
			"lines": []map[string]any{{
				"ingredient_id":  meat.ID,
				"name":           meatName,
				"qty":            "10",
				"unit":           "kg",
				"price_per_unit": "25",
			}},
		}
		r, b := f.post(t, "/api/v1/stock/receipts", tok, uuid.NewString(), body)
		if r.StatusCode != 201 {
			t.Fatalf("receipt %d: %s", r.StatusCode, b)
		}
		var receipt models.StockReceipt
		_ = json.Unmarshal(b, &receipt)
		if !receipt.TotalAmount.Equal(decimal.MustFromString("250")) {
			t.Errorf("MISMATCH receipt.total_amount = %s, want 250", receipt.TotalAmount.String())
		}

		// ingredient.qty +10.
		var after models.Ingredient
		gdb.First(&after, "id = ?", meat.ID)
		if !after.Qty.Equal(decimal.MustFromString("10")) {
			t.Errorf("MISMATCH ingredient.qty after receipt = %s, want 10", after.Qty.String())
		}

		// stock_movements: один с type=receipt, qty=+10.
		var mv []models.StockMovement
		gdb.Where("restaurant_id = ? AND ingredient_id = ? AND description = ?",
			f.rid, meat.ID, "receipt:"+receipt.ID).Find(&mv)
		if len(mv) != 1 {
			t.Errorf("expected 1 receipt movement, got %d", len(mv))
		}
		if len(mv) == 1 && !mv[0].Qty.Equal(decimal.MustFromString("10")) {
			t.Errorf("MISMATCH receipt movement qty = %s, want 10", mv[0].Qty.String())
		}

		// Атомарный финоп.
		var finOps []models.FinancialOperation
		gdb.Where("restaurant_id = ? AND source_ref = ?", f.rid, "receipt:"+receipt.ID).Find(&finOps)
		if len(finOps) != 1 {
			t.Fatalf("expected 1 auto fin-op for receipt, got %d", len(finOps))
		}
		op := finOps[0]
		if !op.Amount.Equal(decimal.MustFromString("250")) {
			t.Errorf("MISMATCH receipt finop amount = %s, want 250", op.Amount.String())
		}
		if op.Type == nil || *op.Type != "out" {
			t.Errorf("receipt finop type = %v, want out", op.Type)
		}
		if op.Category == nil || *op.Category != "stock_purchase" {
			t.Errorf("receipt finop category = %v, want stock_purchase", op.Category)
		}
		if op.AccountID == nil || *op.AccountID != cashAccID {
			t.Errorf("receipt finop account_id mismatch")
		}

		// Баланс кассы должен снизиться: 1000 - 250 = 750.
		var cashAfter models.FinancialAccount
		gdb.First(&cashAfter, "id = ?", cashAccID)
		if !cashAfter.Balance.Equal(decimal.MustFromString("750")) {
			t.Errorf("MISMATCH cash balance after receipt = %s, want 750", cashAfter.Balance.String())
		}

		// /stock/receipts list — приёмка видна.
		lr, lb := f.get(t, "/api/v1/stock/receipts", tok)
		if lr.StatusCode != 200 {
			t.Fatalf("list receipts %d: %s", lr.StatusCode, lb)
		}
	})

	// ─── Flow 2: списание ────────────────────────────────────────────────
	t.Run("Flow2_Writeoff", func(t *testing.T) {
		body := map[string]any{
			"reason": "брак",
			"lines": []map[string]any{{
				"ingredient_id": meat.ID,
				"name":          meatName,
				"qty":           "1",
				"unit":          "kg",
				"cost":          "20", // 1 kg × 20 cost
			}},
		}
		r, b := f.post(t, "/api/v1/stock/writeoffs", tok, uuid.NewString(), body)
		if r.StatusCode != 201 {
			t.Fatalf("writeoff %d: %s", r.StatusCode, b)
		}
		var wo models.StockWriteoff
		_ = json.Unmarshal(b, &wo)
		if !wo.TotalCost.Equal(decimal.MustFromString("20")) {
			t.Errorf("MISMATCH writeoff.total_cost = %s, want 20", wo.TotalCost.String())
		}

		// ingredient.qty 10 - 1 = 9.
		var after models.Ingredient
		gdb.First(&after, "id = ?", meat.ID)
		if !after.Qty.Equal(decimal.MustFromString("9")) {
			t.Errorf("MISMATCH ingredient.qty after writeoff = %s, want 9", after.Qty.String())
		}

		// stock_movements: -1 с type=writeoff.
		var mv []models.StockMovement
		gdb.Where("restaurant_id = ? AND description = ?", f.rid, "writeoff:"+wo.ID).Find(&mv)
		if len(mv) != 1 {
			t.Errorf("expected 1 writeoff movement, got %d", len(mv))
		}
		if len(mv) == 1 && !mv[0].Qty.Equal(decimal.MustFromString("-1")) {
			t.Errorf("MISMATCH writeoff movement qty = %s, want -1", mv[0].Qty.String())
		}

		// Note: CreateWriteoff не создаёт financial_operation авто.
		// Это design choice (writeoff = «увеличение себестоимости», уже
		// учитывается в ОПиУ через stock_writeoffs.total_cost). Не пишем.
	})

	// ─── Flow 3: открытие смены ──────────────────────────────────────────
	var shiftID string
	t.Run("Flow3_OpenShift", func(t *testing.T) {
		r, b := f.post(t, "/api/v1/shifts", tok, uuid.NewString(),
			map[string]any{"opening_balance": "100", "account_id": cashAccID})
		if r.StatusCode != 201 {
			t.Fatalf("open shift %d: %s", r.StatusCode, b)
		}
		var shift models.CashShift
		_ = json.Unmarshal(b, &shift)
		shiftID = shift.ID
		if !shift.OpeningBalance.Equal(decimal.MustFromString("100")) {
			t.Errorf("MISMATCH opening_balance = %s, want 100", shift.OpeningBalance.String())
		}
		if shift.Status == nil || *shift.Status != "open" {
			t.Errorf("shift status = %v, want open", shift.Status)
		}
	})

	// ─── Flow 4: продажа (5 × Плов, cash) ────────────────────────────────
	var orderID string
	t.Run("Flow4_Sale", func(t *testing.T) {
		// Create order: 5 шт. Плов.
		createBody := map[string]any{
			"items": []map[string]any{{"menu_item_id": plov.ID, "qty": "5"}},
		}
		r, b := f.post(t, "/api/v1/orders", tok, uuid.NewString(), createBody)
		if r.StatusCode != 201 {
			t.Fatalf("create order %d: %s", r.StatusCode, b)
		}
		var ord models.Order
		_ = json.Unmarshal(b, &ord)
		orderID = ord.ID
		if !ord.Total.Equal(decimal.MustFromString("250")) {
			t.Errorf("MISMATCH order.total = %s, want 250", ord.Total.String())
		}

		// Close с service 10% и оплатой cash. Ожидаем total_with_service=275.
		closePath := fmt.Sprintf("/api/v1/orders/%s/close", orderID)
		closeBody := map[string]any{
			"payment_method":  "cash",
			"account_id":      cashAccID,
			"shift_id":        shiftID,
			"service_percent": "10",
		}
		cr, cb := f.post(t, closePath, tok, uuid.NewString(), closeBody)
		if cr.StatusCode != 200 {
			t.Fatalf("close order %d: %s", cr.StatusCode, cb)
		}
		var closed models.Order
		_ = json.Unmarshal(cb, &closed)
		if !closed.TotalWithService.Equal(decimal.MustFromString("275")) {
			t.Errorf("MISMATCH total_with_service = %s, want 275", closed.TotalWithService.String())
		}
		if !closed.ServiceAmount.Equal(decimal.MustFromString("25")) {
			t.Errorf("MISMATCH service_amount = %s, want 25", closed.ServiceAmount.String())
		}

		// financial_operation type=in, category=revenue, amount=275, account=cash.
		var finOps []models.FinancialOperation
		gdb.Where("source_ref = ?", "order:"+orderID).Find(&finOps)
		if len(finOps) != 1 {
			t.Errorf("expected 1 finop for order, got %d", len(finOps))
		}
		if len(finOps) == 1 {
			op := finOps[0]
			if !op.Amount.Equal(decimal.MustFromString("275")) {
				t.Errorf("MISMATCH revenue finop amount = %s, want 275", op.Amount.String())
			}
			if op.Type == nil || *op.Type != "in" {
				t.Errorf("revenue finop type = %v, want in", op.Type)
			}
			if op.Category == nil || *op.Category != "revenue" {
				t.Errorf("revenue finop category = %v, want revenue", op.Category)
			}
			if op.AccountID == nil || *op.AccountID != cashAccID {
				t.Errorf("revenue finop account_id mismatch")
			}
		}

		// stock_movements для деdукции: 5 порций × 0.2 kg.
		// service/orders_close.go создаёт по строке на каждую tech_card_line × order_item.
		// Здесь tech_card_lines=1, order_items=1 (qty=5) → 1 movement -1.0 kg
		// ИЛИ 5 movements по -0.2 — зависит от реализации (см. write_test
		// был 3 movements при qty=3, значит per-portion).
		var movs []models.StockMovement
		gdb.Where("restaurant_id = ? AND description LIKE ?", f.rid, "order:"+orderID+"%").Find(&movs)
		totalDeducted := decimal.Zero
		for _, m := range movs {
			totalDeducted = decimal.Add(totalDeducted, m.Qty)
		}
		if !totalDeducted.Equal(decimal.MustFromString("-1")) {
			t.Errorf("MISMATCH total stock deduction = %s, want -1 (5 × 0.2)", totalDeducted.String())
		}

		// ingredient.qty = 9 - 1 = 8.
		var meatAfter models.Ingredient
		gdb.First(&meatAfter, "id = ?", meat.ID)
		if !meatAfter.Qty.Equal(decimal.MustFromString("8")) {
			t.Errorf("MISMATCH ingredient.qty after sale = %s, want 8", meatAfter.Qty.String())
		}

		// shift aggregates: cash_revenue=275, orders_count=1.
		var sh models.CashShift
		gdb.First(&sh, "id = ?", shiftID)
		if !sh.CashRevenue.Equal(decimal.MustFromString("275")) {
			t.Errorf("MISMATCH shift.cash_revenue = %s, want 275", sh.CashRevenue.String())
		}
		if sh.OrdersCount == nil || *sh.OrdersCount != 1 {
			t.Errorf("MISMATCH shift.orders_count = %v, want 1", sh.OrdersCount)
		}
	})

	// ─── Flow 5: зарплата кассиру (out 200 с bank) ───────────────────────
	t.Run("Flow5_Salary", func(t *testing.T) {
		body := map[string]any{
			"type":        "out",
			"amount":      "200",
			"category":    "salary",
			"account_id":  bankAccID,
			"activity":    "operational",
			"description": "ЗП кассиру",
		}
		r, b := f.post(t, "/api/v1/finance/operations", tok, uuid.NewString(), body)
		if r.StatusCode != 201 {
			t.Fatalf("salary op %d: %s", r.StatusCode, b)
		}
		var op models.FinancialOperation
		_ = json.Unmarshal(b, &op)
		if !op.Amount.Equal(decimal.MustFromString("200")) {
			t.Errorf("MISMATCH salary amount = %s, want 200", op.Amount.String())
		}
		if op.Category == nil || *op.Category != "salary" {
			t.Errorf("salary category = %v, want salary", op.Category)
		}

		// Bank balance: 1000 - 200 = 800.
		var bank models.FinancialAccount
		gdb.First(&bank, "id = ?", bankAccID)
		if !bank.Balance.Equal(decimal.MustFromString("800")) {
			t.Errorf("MISMATCH bank balance after salary = %s, want 800", bank.Balance.String())
		}
	})

	// ─── Flow 6: бонус повару (out 50 с cash) ────────────────────────────
	t.Run("Flow6_Bonus", func(t *testing.T) {
		body := map[string]any{
			"type":        "out",
			"amount":      "50",
			"category":    "bonus",
			"account_id":  cashAccID,
			"activity":    "operational",
			"description": "Бонус повару",
		}
		r, b := f.post(t, "/api/v1/finance/operations", tok, uuid.NewString(), body)
		if r.StatusCode != 201 {
			t.Fatalf("bonus op %d: %s", r.StatusCode, b)
		}
		var op models.FinancialOperation
		_ = json.Unmarshal(b, &op)
		if !op.Amount.Equal(decimal.MustFromString("50")) {
			t.Errorf("MISMATCH bonus amount = %s, want 50", op.Amount.String())
		}

		// Cash balance после всех операций:
		// start 1000 - 250 (закуп) + 275 (выручка) - 50 (бонус) = 975.
		var cash models.FinancialAccount
		gdb.First(&cash, "id = ?", cashAccID)
		if !cash.Balance.Equal(decimal.MustFromString("975")) {
			t.Errorf("MISMATCH cash balance after bonus = %s, want 975", cash.Balance.String())
		}
	})

	// ─── Flow 7: закрытие смены ──────────────────────────────────────────
	t.Run("Flow7_CloseShift", func(t *testing.T) {
		// expected_cash = opening 100 + cash_revenue 275 = 375.
		closeBody := map[string]any{"closing_balance": "375"}
		path := fmt.Sprintf("/api/v1/shifts/%s/close", shiftID)
		r, b := f.post(t, path, tok, uuid.NewString(), closeBody)
		if r.StatusCode != 200 {
			t.Fatalf("close shift %d: %s", r.StatusCode, b)
		}
		var sh models.CashShift
		_ = json.Unmarshal(b, &sh)
		if sh.Status == nil || *sh.Status != "closed" {
			t.Errorf("shift status = %v, want closed", sh.Status)
		}
		if !sh.CashRevenue.Equal(decimal.MustFromString("275")) {
			t.Errorf("MISMATCH cash_revenue at close = %s, want 275", sh.CashRevenue.String())
		}
		if sh.ExpectedCash == nil || !sh.ExpectedCash.Equal(decimal.MustFromString("325")) {
			t.Errorf("MISMATCH expected_cash = %v, want 325 (#27: наличный бонус зеркалится в смену)", sh.ExpectedCash)
		}
	})

	// ─── Flow 8: ОПиУ ────────────────────────────────────────────────────
	t.Run("Flow8_PnL", func(t *testing.T) {
		from := periodStart.Format(time.RFC3339)
		to := time.Now().UTC().Add(1 * time.Hour).Format(time.RFC3339)
		q := url.Values{}
		q.Set("from", from)
		q.Set("to", to)
		r, b := f.get(t, "/api/v1/finance/pnl?"+q.Encode(), tok)
		if r.StatusCode != 200 {
			t.Fatalf("pnl %d: %s", r.StatusCode, b)
		}
		var pnl struct {
			Revenue struct {
				Total decimal.Decimal `json:"total"`
			} `json:"revenue"`
			COGS struct {
				Total decimal.Decimal `json:"total"`
			} `json:"cogs"`
			Writeoffs decimal.Decimal `json:"writeoffs"`
			Opex      struct {
				Total      decimal.Decimal `json:"total"`
				ByCategory []struct {
					Category string          `json:"category"`
					Amount   decimal.Decimal `json:"amount"`
				} `json:"by_category"`
			} `json:"opex"`
			GrossProfit decimal.Decimal `json:"gross_profit"`
			NetProfit   decimal.Decimal `json:"net_profit"`
		}
		if err := json.Unmarshal(b, &pnl); err != nil {
			t.Fatalf("decode pnl: %v\n%s", err, b)
		}

		// Revenue = 275 (total_with_service).
		if !pnl.Revenue.Total.Equal(decimal.MustFromString("275")) {
			t.Errorf("MISMATCH PnL revenue = %s, want 275", pnl.Revenue.Total.String())
		}
		// COGS = sum(oi.cogs × oi.qty) = 4 × 5 = 20.
		if !pnl.COGS.Total.Equal(decimal.MustFromString("20")) {
			t.Errorf("MISMATCH PnL cogs = %s, want 20 (4×5)", pnl.COGS.Total.String())
		}
		// Writeoffs = 1 kg × 20 cost = 20 (Flow2). v2.0.87: отдельной строкой.
		if !pnl.Writeoffs.Equal(decimal.MustFromString("20")) {
			t.Errorf("MISMATCH PnL writeoffs = %s, want 20", pnl.Writeoffs.String())
		}
		// Gross = 275 - 20 (COGS) - 20 (writeoffs) = 235.
		if !pnl.GrossProfit.Equal(decimal.MustFromString("235")) {
			t.Errorf("MISMATCH PnL gross_profit = %s, want 235", pnl.GrossProfit.String())
		}
		// Opex = salary 200 + bonus 50 = 250. Закупки (stock_purchase 250) в ОПиУ
		// НЕ входят — это движение запасов, а не расход (учитываются как COGS при
		// продаже; в ДДС закупка остаётся, см. Flow9).
		if !pnl.Opex.Total.Equal(decimal.MustFromString("250")) {
			t.Errorf("MISMATCH PnL opex.total = %s, want 250 (без stock_purchase)", pnl.Opex.Total.String())
		}
		// Net = 235 - 250 = -15.
		if !pnl.NetProfit.Equal(decimal.MustFromString("-15")) {
			t.Errorf("MISMATCH PnL net_profit = %s, want -15", pnl.NetProfit.String())
		}
		// By category coverage.
		cats := map[string]decimal.Decimal{}
		for _, c := range pnl.Opex.ByCategory {
			cats[c.Category] = c.Amount
		}
		if v, ok := cats["salary"]; !ok || !v.Equal(decimal.MustFromString("200")) {
			t.Errorf("MISMATCH opex.salary = %v, want 200", v)
		}
		if v, ok := cats["bonus"]; !ok || !v.Equal(decimal.MustFromString("50")) {
			t.Errorf("MISMATCH opex.bonus = %v, want 50", v)
		}
		if _, ok := cats["stock_purchase"]; ok {
			t.Errorf("stock_purchase не должен быть в расходах ОПиУ (закупка — не расход)")
		}
	})

	// ─── Flow 9: ДДС ─────────────────────────────────────────────────────
	t.Run("Flow9_Cashflow", func(t *testing.T) {
		from := periodStart.Format(time.RFC3339)
		to := time.Now().UTC().Add(1 * time.Hour).Format(time.RFC3339)
		q := url.Values{}
		q.Set("from", from)
		q.Set("to", to)
		r, b := f.get(t, "/api/v1/finance/cashflow?"+q.Encode(), tok)
		if r.StatusCode != 200 {
			t.Fatalf("cashflow %d: %s", r.StatusCode, b)
		}
		var cf struct {
			ByActivity map[string]struct {
				In  decimal.Decimal `json:"in"`
				Out decimal.Decimal `json:"out"`
				Net decimal.Decimal `json:"net"`
			} `json:"by_activity"`
			NetTotal decimal.Decimal `json:"net_total"`
		}
		if err := json.Unmarshal(b, &cf); err != nil {
			t.Fatalf("decode cashflow: %v\n%s", err, b)
		}
		op, ok := cf.ByActivity["operational"]
		if !ok {
			t.Fatalf("no operational activity in cashflow: %s", b)
		}
		// In = revenue 275.
		if !op.In.Equal(decimal.MustFromString("275")) {
			t.Errorf("MISMATCH cashflow operational.in = %s, want 275", op.In.String())
		}
		// Out = 250 + 200 + 50 = 500.
		if !op.Out.Equal(decimal.MustFromString("500")) {
			t.Errorf("MISMATCH cashflow operational.out = %s, want 500", op.Out.String())
		}
		// Net = 275 - 500 = -225.
		if !op.Net.Equal(decimal.MustFromString("-225")) {
			t.Errorf("MISMATCH cashflow operational.net = %s, want -225", op.Net.String())
		}
		if !cf.NetTotal.Equal(decimal.MustFromString("-225")) {
			t.Errorf("MISMATCH cashflow net_total = %s, want -225", cf.NetTotal.String())
		}
	})

	// ─── Bonus: проверка балансов счётов как контрольная сумма ───────────
	t.Run("Flow10_AccountBalances", func(t *testing.T) {
		// Cash: 1000 - 250 + 275 - 50 = 975.
		// Bank: 1000 - 200 = 800.
		var cash, bank models.FinancialAccount
		gdb.First(&cash, "id = ?", cashAccID)
		gdb.First(&bank, "id = ?", bankAccID)
		if !cash.Balance.Equal(decimal.MustFromString("975")) {
			t.Errorf("MISMATCH cash final balance = %s, want 975", cash.Balance.String())
		}
		if !bank.Balance.Equal(decimal.MustFromString("800")) {
			t.Errorf("MISMATCH bank final balance = %s, want 800", bank.Balance.String())
		}
	})
}
