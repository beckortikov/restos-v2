//go:build integration

package http_test

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// seedReturnIngredient — ингредиент с нулевым остатком (склад наберём приёмкой).
func seedReturnIngredient(t *testing.T, gdb *gorm.DB, rid, name, unit string) *models.Ingredient {
	t.Helper()
	ing := &models.Ingredient{
		ID:           uuid.NewString(),
		Name:         &name,
		Unit:         &unit,
		Qty:          decimal.Zero,
		PricePerUnit: decimal.Zero,
		RestaurantID: &rid,
	}
	if err := gdb.Create(ing).Error; err != nil {
		t.Fatal(err)
	}
	return ing
}

// topUp — счёт из seedForWrite создаётся с нулевым балансом, а оплаченная
// приёмка списывает деньги и отбивается на «insufficient funds».
func topUp(t *testing.T, gdb *gorm.DB, accountID string) {
	t.Helper()
	if err := gdb.Model(&models.FinancialAccount{}).Where("id = ?", accountID).
		Update("balance", decimal.MustFromString("10000")).Error; err != nil {
		t.Fatal(err)
	}
}

// receiptLineID — id строки накладной по ингредиенту (клиент берёт его из
// GET /stock/receipts?include=lines; в тесте короче через БД).
func receiptLineID(t *testing.T, gdb *gorm.DB, receiptID, ingredientID string) string {
	t.Helper()
	var line models.StockReceiptLine
	if err := gdb.Where("receipt_id = ? AND ingredient_id = ?", receiptID, ingredientID).
		First(&line).Error; err != nil {
		t.Fatal(err)
	}
	return line.ID
}

// TestStockReturn_Debt — возврат по накладной в долг: склад уменьшается, долг
// уменьшается И на накладной, И у поставщика, денежных проводок нет.
//
// Главный ассерт — RecomputeDebts ПОСЛЕ возврата: он пересчитывает current_debt
// как Σ(receipts.debt_amount) − Σ(оплат). Если возврат тронет только
// suppliers.current_debt, первый же пересчёт воскресит долг.
func TestStockReturn_Debt(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, _, _ := seedForWrite(t, f)

	supName := "Ромашка"
	sup := &models.Supplier{
		ID: uuid.NewString(), Name: &supName,
		CurrentDebt: decimal.Zero, RestaurantID: &f.rid,
	}
	if err := gdb.Create(sup).Error; err != nil {
		t.Fatal(err)
	}
	tomato := seedReturnIngredient(t, gdb, f.rid, "Помидоры", "kg")

	// Приёмка в долг: 20 кг × 8 = 160.
	r, b := f.post(t, "/api/v1/stock/receipts", tok, uuid.NewString(), map[string]any{
		"payment_type":  "credit",
		"supplier_id":   sup.ID,
		"supplier_name": supName,
		"lines": []map[string]any{{
			"ingredient_id": tomato.ID, "name": "Помидоры",
			"qty": "20", "unit": "kg", "price_per_unit": "8",
		}},
	})
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("receipt: %d %s", r.StatusCode, b)
	}
	var receipt models.StockReceipt
	if err := json.Unmarshal(b, &receipt); err != nil {
		t.Fatal(err)
	}
	if got := ingQty(t, gdb, tomato.ID); !got.Equal(decimal.MustFromString("20")) {
		t.Fatalf("qty после приёмки = %s, want 20", got)
	}

	// Возврат 3 кг из 20 — битые.
	r, b = f.post(t, "/api/v1/stock/returns", tok, uuid.NewString(), map[string]any{
		"receipt_id":  receipt.ID,
		"reason":      "breakage",
		"refund_type": "debt",
		"lines": []map[string]any{{
			"receipt_line_id": receiptLineID(t, gdb, receipt.ID, tomato.ID),
			"qty":             "3",
		}},
	})
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("return: %d %s", r.StatusCode, b)
	}
	var ret models.StockReturn
	if err := json.Unmarshal(b, &ret); err != nil {
		t.Fatal(err)
	}
	if !ret.TotalAmount.Equal(decimal.MustFromString("24")) {
		t.Errorf("total_amount = %s, want 24 (3 × 8 по цене накладной)", ret.TotalAmount)
	}

	// Склад: 20 − 3 = 17, движение return_supplier с отрицательным qty.
	if got := ingQty(t, gdb, tomato.ID); !got.Equal(decimal.MustFromString("17")) {
		t.Errorf("qty после возврата = %s, want 17", got)
	}
	var mv models.StockMovement
	if err := gdb.Where("description = ?", "return:"+ret.ID).First(&mv).Error; err != nil {
		t.Fatalf("движение возврата не создано: %v", err)
	}
	if mv.Type == nil || *mv.Type != "return_supplier" {
		t.Errorf("movement type = %v, want return_supplier", mv.Type)
	}
	if !mv.Qty.Equal(decimal.MustFromString("-3")) {
		t.Errorf("movement qty = %s, want -3", mv.Qty)
	}

	// Долг: 160 − 24 = 136 на обеих сторонах.
	var afterReceipt models.StockReceipt
	gdb.First(&afterReceipt, "id = ?", receipt.ID)
	if !afterReceipt.DebtAmount.Equal(decimal.MustFromString("136")) {
		t.Errorf("receipt.debt_amount = %s, want 136", afterReceipt.DebtAmount)
	}
	var afterSup models.Supplier
	gdb.First(&afterSup, "id = ?", sup.ID)
	if !afterSup.CurrentDebt.Equal(decimal.MustFromString("136")) {
		t.Errorf("supplier.current_debt = %s, want 136", afterSup.CurrentDebt)
	}

	// Возврат в долг не двигает деньги.
	var finops int64
	gdb.Model(&models.FinancialOperation{}).
		Where("source_ref = ?", "return:"+ret.ID).Count(&finops)
	if finops != 0 {
		t.Errorf("возврат в долг создал %d финопераций, want 0", finops)
	}

	// Регрессия: пересчёт долгов не должен воскресить возвращённые 24.
	r, b = f.post(t, "/api/v1/suppliers/recompute-debts", tok, uuid.NewString(), map[string]any{})
	if r.StatusCode != http.StatusOK {
		t.Fatalf("recompute-debts: %d %s", r.StatusCode, b)
	}
	gdb.First(&afterSup, "id = ?", sup.ID)
	if !afterSup.CurrentDebt.Equal(decimal.MustFromString("136")) {
		t.Errorf("current_debt после RecomputeDebts = %s, want 136 (долг воскрес)", afterSup.CurrentDebt)
	}
}

// TestStockReturn_Money — возврат по оплаченной накладной: деньги приходят на
// счёт + финоп type=in category=stock_purchase, и средневзвешенная себестоимость
// откатывается к цене оставшейся партии.
func TestStockReturn_Money(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, _, accountID := seedForWrite(t, f)
	topUp(t, gdb, accountID)
	tomato := seedReturnIngredient(t, gdb, f.rid, "Помидоры-2", "kg")

	// Партия 1: 10 кг × 10 → с/с 10.
	r, b := f.post(t, "/api/v1/stock/receipts", tok, uuid.NewString(), map[string]any{
		"payment_type": "paid", "supplier_name": "Ромашка",
		"account_id": accountID, "paid": true,
		"lines": []map[string]any{{
			"ingredient_id": tomato.ID, "name": "Помидоры-2",
			"qty": "10", "unit": "kg", "price_per_unit": "10",
		}},
	})
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("receipt1: %d %s", r.StatusCode, b)
	}

	// Партия 2: 10 кг × 20 → средневзвешенная (10*10 + 200)/20 = 15.
	r, b = f.post(t, "/api/v1/stock/receipts", tok, uuid.NewString(), map[string]any{
		"payment_type": "paid", "supplier_name": "Ромашка",
		"account_id": accountID, "paid": true,
		"lines": []map[string]any{{
			"ingredient_id": tomato.ID, "name": "Помидоры-2",
			"qty": "10", "unit": "kg", "price_per_unit": "20",
		}},
	})
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("receipt2: %d %s", r.StatusCode, b)
	}
	var receipt2 models.StockReceipt
	if err := json.Unmarshal(b, &receipt2); err != nil {
		t.Fatal(err)
	}
	var mid models.Ingredient
	gdb.First(&mid, "id = ?", tomato.ID)
	if !mid.PricePerUnit.Equal(decimal.MustFromString("15")) {
		t.Fatalf("с/с после двух приёмок = %s, want 15", mid.PricePerUnit)
	}

	var accMid models.FinancialAccount
	gdb.First(&accMid, "id = ?", accountID)

	// Возвращаем всю вторую партию (битая) деньгами.
	r, b = f.post(t, "/api/v1/stock/returns", tok, uuid.NewString(), map[string]any{
		"receipt_id":  receipt2.ID,
		"reason":      "spoilage",
		"refund_type": "money",
		"account_id":  accountID,
		"lines": []map[string]any{{
			"receipt_line_id": receiptLineID(t, gdb, receipt2.ID, tomato.ID),
			"qty":             "10",
		}},
	})
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("return: %d %s", r.StatusCode, b)
	}
	var ret models.StockReturn
	if err := json.Unmarshal(b, &ret); err != nil {
		t.Fatal(err)
	}

	// Склад 20 − 10 = 10, с/с откатилась 15 → 10 (осталась только первая партия).
	if got := ingQty(t, gdb, tomato.ID); !got.Equal(decimal.MustFromString("10")) {
		t.Errorf("qty после возврата = %s, want 10", got)
	}
	var after models.Ingredient
	gdb.First(&after, "id = ?", tomato.ID)
	if !after.PricePerUnit.Equal(decimal.MustFromString("10")) {
		t.Errorf("с/с после возврата = %s, want 10 (откат средневзвешенной)", after.PricePerUnit)
	}

	// Деньги вернулись на счёт: +200.
	var accAfter models.FinancialAccount
	gdb.First(&accAfter, "id = ?", accountID)
	want := decimal.Add(accMid.Balance, decimal.MustFromString("200"))
	if !accAfter.Balance.Equal(want) {
		t.Errorf("баланс = %s, want %s", accAfter.Balance, want)
	}

	// Финоп: in / stock_purchase — чтобы возврат схлопнулся с закупкой,
	// а не превратился в фейковую выручку в ОПиУ.
	var op models.FinancialOperation
	if err := gdb.Where("source_ref = ?", "return:"+ret.ID).First(&op).Error; err != nil {
		t.Fatalf("финоп возврата не создан: %v", err)
	}
	if op.Type == nil || *op.Type != "in" {
		t.Errorf("finop type = %v, want in", op.Type)
	}
	if op.Category == nil || *op.Category != "stock_purchase" {
		t.Errorf("finop category = %v, want stock_purchase", op.Category)
	}
	if !op.Amount.Equal(decimal.MustFromString("200")) {
		t.Errorf("finop amount = %s, want 200", op.Amount)
	}
}

// TestStockReturn_MoneyOnUnpaidCredit — деньгами нельзя вернуть то, за что не
// платили: иначе получаем и товар назад, и деньги, и долг остаётся висеть.
// Регрессия ревью 17.07.2026: ветка money не имела ни одного guard'а и отдавала
// 201 с +160 на счёт при непогашенном долге 160.
func TestStockReturn_MoneyOnUnpaidCredit(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, _, accountID := seedForWrite(t, f)
	topUp(t, gdb, accountID)

	supName := "Ромашка"
	sup := &models.Supplier{
		ID: uuid.NewString(), Name: &supName,
		CurrentDebt: decimal.Zero, RestaurantID: &f.rid,
	}
	if err := gdb.Create(sup).Error; err != nil {
		t.Fatal(err)
	}
	veg := seedReturnIngredient(t, gdb, f.rid, "Овощи", "kg")

	r, b := f.post(t, "/api/v1/stock/receipts", tok, uuid.NewString(), map[string]any{
		"payment_type": "credit", "supplier_id": sup.ID, "supplier_name": supName,
		"lines": []map[string]any{{
			"ingredient_id": veg.ID, "name": "Овощи", "qty": "20", "unit": "kg", "price_per_unit": "8",
		}},
	})
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("receipt: %d %s", r.StatusCode, b)
	}
	var receipt models.StockReceipt
	if err := json.Unmarshal(b, &receipt); err != nil {
		t.Fatal(err)
	}
	lineID := receiptLineID(t, gdb, receipt.ID, veg.ID)

	var accBefore models.FinancialAccount
	gdb.First(&accBefore, "id = ?", accountID)

	r, b = f.post(t, "/api/v1/stock/returns", tok, uuid.NewString(), map[string]any{
		"receipt_id": receipt.ID, "reason": "spoilage", "refund_type": "money", "account_id": accountID,
		"lines": []map[string]any{{"receipt_line_id": lineID, "qty": "5"}},
	})
	if r.StatusCode != http.StatusConflict {
		t.Fatalf("возврат деньгами по неоплаченной кредитной накладной: %d %s, want 409", r.StatusCode, b)
	}
	var accAfter models.FinancialAccount
	gdb.First(&accAfter, "id = ?", accountID)
	if !accAfter.Balance.Equal(accBefore.Balance) {
		t.Errorf("баланс изменился на отбитом возврате: %s → %s", accBefore.Balance, accAfter.Balance)
	}

	// Долг гасить можно — это и есть правильный путь для такой накладной.
	r, b = f.post(t, "/api/v1/stock/returns", tok, uuid.NewString(), map[string]any{
		"receipt_id": receipt.ID, "reason": "spoilage", "refund_type": "debt",
		"lines": []map[string]any{{"receipt_line_id": lineID, "qty": "5"}},
	})
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("возврат в долг: %d %s", r.StatusCode, b)
	}
}

// TestStockReturn_AfterPayDebt — накладная в долг, долг погашен через pay-debt:
// гасить нечего → долгом нельзя, деньгами можно. Самый частый жизненный поток
// кредитной накладной: взял в долг → оплатил → нашёл брак.
func TestStockReturn_AfterPayDebt(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, _, accountID := seedForWrite(t, f)
	topUp(t, gdb, accountID)

	supName := "Ромашка"
	sup := &models.Supplier{
		ID: uuid.NewString(), Name: &supName,
		CurrentDebt: decimal.Zero, RestaurantID: &f.rid,
	}
	if err := gdb.Create(sup).Error; err != nil {
		t.Fatal(err)
	}
	veg := seedReturnIngredient(t, gdb, f.rid, "Овощи-2", "kg")

	r, b := f.post(t, "/api/v1/stock/receipts", tok, uuid.NewString(), map[string]any{
		"payment_type": "credit", "supplier_id": sup.ID, "supplier_name": supName,
		"lines": []map[string]any{{
			"ingredient_id": veg.ID, "name": "Овощи-2", "qty": "20", "unit": "kg", "price_per_unit": "8",
		}},
	})
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("receipt: %d %s", r.StatusCode, b)
	}
	var receipt models.StockReceipt
	if err := json.Unmarshal(b, &receipt); err != nil {
		t.Fatal(err)
	}
	lineID := receiptLineID(t, gdb, receipt.ID, veg.ID)

	if r, b := f.post(t, "/api/v1/suppliers/"+sup.ID+"/pay-debt", tok, uuid.NewString(),
		map[string]any{"amount": "160", "account_id": accountID}); r.StatusCode != http.StatusOK {
		t.Fatalf("pay-debt: %d %s", r.StatusCode, b)
	}
	// PayDebt раскладывает оплату по накладным (v3.16.89), поэтому долг накладной
	// обнулился вместе с долгом поставщика. До фикса тут навсегда оставалось 160,
	// и диалог на это ловился: предлагал гасить давно погашенный долг.
	var afterPay models.StockReceipt
	gdb.First(&afterPay, "id = ?", receipt.ID)
	if !afterPay.DebtAmount.Equal(decimal.Zero) {
		t.Fatalf("предусловие: receipt.debt_amount = %s, ожидалось 0 (оплата раскладывается по накладным)", afterPay.DebtAmount)
	}

	if r, _ := f.post(t, "/api/v1/stock/returns", tok, uuid.NewString(), map[string]any{
		"receipt_id": receipt.ID, "reason": "spoilage", "refund_type": "debt",
		"lines": []map[string]any{{"receipt_line_id": lineID, "qty": "3"}},
	}); r.StatusCode != http.StatusConflict {
		t.Errorf("возврат в долг при погашенном долге: %d, want 409", r.StatusCode)
	}

	var accBefore models.FinancialAccount
	gdb.First(&accBefore, "id = ?", accountID)
	r, b = f.post(t, "/api/v1/stock/returns", tok, uuid.NewString(), map[string]any{
		"receipt_id": receipt.ID, "reason": "spoilage", "refund_type": "money", "account_id": accountID,
		"lines": []map[string]any{{"receipt_line_id": lineID, "qty": "3"}},
	})
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("возврат деньгами после гашения долга: %d %s, want 201", r.StatusCode, b)
	}
	var accAfter models.FinancialAccount
	gdb.First(&accAfter, "id = ?", accountID)
	want := decimal.Add(accBefore.Balance, decimal.MustFromString("24"))
	if !accAfter.Balance.Equal(want) {
		t.Errorf("баланс = %s, want %s", accAfter.Balance, want)
	}
}

// TestStockReturn_NotEnoughStock — нельзя вернуть то, чего нет: приняли 20,
// израсходовали 18, осталось 2. Guard «Σ ≤ принятому» это пропускал и выдавал
// деньги за физически несуществующий товар (остаток уходил в −18).
func TestStockReturn_NotEnoughStock(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, _, accountID := seedForWrite(t, f)
	topUp(t, gdb, accountID)
	ing := seedReturnIngredient(t, gdb, f.rid, "Дефицит", "kg")

	r, b := f.post(t, "/api/v1/stock/receipts", tok, uuid.NewString(), map[string]any{
		"payment_type": "paid", "supplier_name": "Ромашка", "account_id": accountID, "paid": true,
		"lines": []map[string]any{{
			"ingredient_id": ing.ID, "name": "Дефицит", "qty": "20", "unit": "kg", "price_per_unit": "5",
		}},
	})
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("receipt: %d %s", r.StatusCode, b)
	}
	var receipt models.StockReceipt
	if err := json.Unmarshal(b, &receipt); err != nil {
		t.Fatal(err)
	}

	if r, b := f.post(t, "/api/v1/stock/writeoffs", tok, uuid.NewString(), map[string]any{
		"reason": "spoilage",
		"lines":  []map[string]any{{"ingredient_id": ing.ID, "name": "Дефицит", "qty": "18", "unit": "kg", "cost": "90"}},
	}); r.StatusCode != http.StatusCreated {
		t.Fatalf("writeoff: %d %s", r.StatusCode, b)
	}

	r, b = f.post(t, "/api/v1/stock/returns", tok, uuid.NewString(), map[string]any{
		"receipt_id": receipt.ID, "reason": "spoilage", "refund_type": "money", "account_id": accountID,
		"lines": []map[string]any{{"receipt_line_id": receiptLineID(t, gdb, receipt.ID, ing.ID), "qty": "20"}},
	})
	if r.StatusCode != http.StatusConflict {
		t.Fatalf("возврат 20 при остатке 2: %d %s, want 409", r.StatusCode, b)
	}
	if got := ingQty(t, gdb, ing.ID); !got.Equal(decimal.MustFromString("2")) {
		t.Errorf("остаток после отбитого возврата = %s, want 2", got)
	}
}

// TestStockReturn_NoCostRollbackAfterConsumption — если между приёмкой и
// возвратом был расход, откат средневзвешенной НЕ применяется.
//
// Формула точна лишь пока остаток не расходовали: расход снимает стоимость по
// средней, а не из партии, и связь «остаток ↔ партия» рвётся. Раньше здесь
// получалась цена 5.00 — которой не было ни в одной накладной, — и стоимость
// остатка занижалась вдвое. Оставляем последнюю реальную среднюю (15).
func TestStockReturn_NoCostRollbackAfterConsumption(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, _, accountID := seedForWrite(t, f)
	topUp(t, gdb, accountID)
	ing := seedReturnIngredient(t, gdb, f.rid, "Мясо-партии", "kg")

	mkReceipt := func(qty, price string) models.StockReceipt {
		r, b := f.post(t, "/api/v1/stock/receipts", tok, uuid.NewString(), map[string]any{
			"payment_type": "paid", "supplier_name": "Ромашка", "account_id": accountID, "paid": true,
			"lines": []map[string]any{{
				"ingredient_id": ing.ID, "name": "Мясо-партии", "qty": qty, "unit": "kg", "price_per_unit": price,
			}},
		})
		if r.StatusCode != http.StatusCreated {
			t.Fatalf("receipt: %d %s", r.StatusCode, b)
		}
		var rc models.StockReceipt
		if err := json.Unmarshal(b, &rc); err != nil {
			t.Fatal(err)
		}
		return rc
	}

	mkReceipt("10", "10")       // qty=10, с/с 10
	r2 := mkReceipt("10", "20") // qty=20, с/с (100+200)/20 = 15
	if r, b := f.post(t, "/api/v1/stock/writeoffs", tok, uuid.NewString(), map[string]any{
		"reason": "spoilage",
		"lines":  []map[string]any{{"ingredient_id": ing.ID, "name": "Мясо-партии", "qty": "5", "unit": "kg", "cost": "75"}},
	}); r.StatusCode != http.StatusCreated {
		t.Fatalf("writeoff: %d %s", r.StatusCode, b)
	} // qty=15, с/с 15

	if r, b := f.post(t, "/api/v1/stock/returns", tok, uuid.NewString(), map[string]any{
		"receipt_id": r2.ID, "reason": "spoilage", "refund_type": "money", "account_id": accountID,
		"lines": []map[string]any{{"receipt_line_id": receiptLineID(t, gdb, r2.ID, ing.ID), "qty": "10"}},
	}); r.StatusCode != http.StatusCreated {
		t.Fatalf("return: %d %s", r.StatusCode, b)
	}

	var after models.Ingredient
	gdb.First(&after, "id = ?", ing.ID)
	if !after.Qty.Equal(decimal.MustFromString("5")) {
		t.Errorf("остаток = %s, want 5", after.Qty)
	}
	if !after.PricePerUnit.Equal(decimal.MustFromString("15")) {
		t.Errorf("с/с после возврата с расходом = %s, want 15 (откат не применяется). "+
			"Если тут 5 — вернулась регрессия: цена, которой не было ни в одной накладной", after.PricePerUnit)
	}
}

// TestStockReturn_Guards — нельзя вернуть больше, чем пришло (в т.ч. по сумме
// нескольких возвратов), и нельзя списать в долг то, за что уже заплачено.
func TestStockReturn_Guards(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, _, accountID := seedForWrite(t, f)
	topUp(t, gdb, accountID)
	milk := seedReturnIngredient(t, gdb, f.rid, "Молоко", "l")

	r, b := f.post(t, "/api/v1/stock/receipts", tok, uuid.NewString(), map[string]any{
		"payment_type": "paid", "supplier_name": "Ромашка",
		"account_id": accountID, "paid": true,
		"lines": []map[string]any{{
			"ingredient_id": milk.ID, "name": "Молоко",
			"qty": "10", "unit": "l", "price_per_unit": "6",
		}},
	})
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("receipt: %d %s", r.StatusCode, b)
	}
	var receipt models.StockReceipt
	if err := json.Unmarshal(b, &receipt); err != nil {
		t.Fatal(err)
	}
	lineID := receiptLineID(t, gdb, receipt.ID, milk.ID)

	mkReturn := func(qty, refund string) (*http.Response, []byte) {
		body := map[string]any{
			"receipt_id": receipt.ID, "reason": "spoilage", "refund_type": refund,
			"lines": []map[string]any{{"receipt_line_id": lineID, "qty": qty}},
		}
		if refund == "money" {
			body["account_id"] = accountID
		}
		return f.post(t, "/api/v1/stock/returns", tok, uuid.NewString(), body)
	}

	// Больше, чем пришло, — сразу.
	if r, _ := mkReturn("11", "money"); r.StatusCode != http.StatusConflict {
		t.Errorf("возврат 11 из 10: %d, want 409", r.StatusCode)
	}
	// Накладная оплачена — долга нет, уменьшать нечего.
	if r, _ := mkReturn("1", "debt"); r.StatusCode != http.StatusConflict {
		t.Errorf("refund_type=debt по оплаченной накладной: %d, want 409", r.StatusCode)
	}
	// 4 из 10 — ок.
	if r, b := mkReturn("4", "money"); r.StatusCode != http.StatusCreated {
		t.Fatalf("возврат 4: %d %s", r.StatusCode, b)
	}
	// Ещё 7 — суммарно 11 из 10, guard считает уже возвращённое.
	if r, _ := mkReturn("7", "money"); r.StatusCode != http.StatusConflict {
		t.Errorf("второй возврат 7 (итого 11 из 10): %d, want 409", r.StatusCode)
	}
	// Остаток 6 — проходит.
	if r, b := mkReturn("6", "money"); r.StatusCode != http.StatusCreated {
		t.Fatalf("возврат остатка 6: %d %s", r.StatusCode, b)
	}
	if got := ingQty(t, gdb, milk.ID); !got.Equal(decimal.Zero) {
		t.Errorf("qty после возврата всех 10 = %s, want 0", got)
	}
}

// TestStockReturn_Cancel — сторно возврата: товар назад на склад, деньги назад
// поставщику, себестоимость на место, и количество снова доступно к возврату.
//
// До v3.16.90 отменить возврат было нечем — только руками в БД. Для документа,
// который двигает и склад, и деньги, это самая вероятная ошибка оператора.
func TestStockReturn_Cancel(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, _, accountID := seedForWrite(t, f)
	topUp(t, gdb, accountID)
	ing := seedReturnIngredient(t, gdb, f.rid, "Сторно-товар", "kg")

	r, b := f.post(t, "/api/v1/stock/receipts", tok, uuid.NewString(), map[string]any{
		"payment_type": "paid", "supplier_name": "Ромашка", "account_id": accountID, "paid": true,
		"lines": []map[string]any{{
			"ingredient_id": ing.ID, "name": "Сторно-товар", "qty": "20", "unit": "kg", "price_per_unit": "10",
		}},
	})
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("receipt: %d %s", r.StatusCode, b)
	}
	var receipt models.StockReceipt
	if err := json.Unmarshal(b, &receipt); err != nil {
		t.Fatal(err)
	}
	lineID := receiptLineID(t, gdb, receipt.ID, ing.ID)

	var accBefore models.FinancialAccount
	gdb.First(&accBefore, "id = ?", accountID)

	// Возврат 5 кг деньгами = 50.
	r, b = f.post(t, "/api/v1/stock/returns", tok, uuid.NewString(), map[string]any{
		"receipt_id": receipt.ID, "reason": "spoilage", "refund_type": "money", "account_id": accountID,
		"lines": []map[string]any{{"receipt_line_id": lineID, "qty": "5"}},
	})
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("return: %d %s", r.StatusCode, b)
	}
	var ret models.StockReturn
	if err := json.Unmarshal(b, &ret); err != nil {
		t.Fatal(err)
	}
	if got := ingQty(t, gdb, ing.ID); !got.Equal(decimal.MustFromString("15")) {
		t.Fatalf("предусловие: qty после возврата = %s, want 15", got)
	}

	// Сторно.
	r, b = f.post(t, "/api/v1/stock/returns/"+ret.ID+"/cancel", tok, uuid.NewString(), map[string]any{})
	if r.StatusCode != http.StatusOK {
		t.Fatalf("cancel: %d %s", r.StatusCode, b)
	}

	// Склад вернулся: 15 + 5 = 20.
	if got := ingQty(t, gdb, ing.ID); !got.Equal(decimal.MustFromString("20")) {
		t.Errorf("qty после сторно = %s, want 20", got)
	}
	// Себестоимость на месте: партия одна, цена 10.
	var after models.Ingredient
	gdb.First(&after, "id = ?", ing.ID)
	if !after.PricePerUnit.Equal(decimal.MustFromString("10")) {
		t.Errorf("с/с после сторно = %s, want 10", after.PricePerUnit)
	}
	// Деньги ушли обратно поставщику — баланс как до возврата.
	var accAfter models.FinancialAccount
	gdb.First(&accAfter, "id = ?", accountID)
	if !accAfter.Balance.Equal(accBefore.Balance) {
		t.Errorf("баланс после сторно = %s, want %s (как до возврата)", accAfter.Balance, accBefore.Balance)
	}
	// Встречная проводка создана и схлопывает приход возврата.
	var op models.FinancialOperation
	if err := gdb.Where("source_ref = ?", "return_cancel:"+ret.ID).First(&op).Error; err != nil {
		t.Fatalf("встречная проводка не создана: %v", err)
	}
	if op.Type == nil || *op.Type != "out" {
		t.Errorf("finop сторно type = %v, want out", op.Type)
	}
	// Помечен отменённым.
	var retAfter models.StockReturn
	gdb.First(&retAfter, "id = ?", ret.ID)
	if retAfter.CancelledAt == nil {
		t.Error("cancelled_at не проставлен")
	}
	// Повторное сторно — 409.
	if r, _ := f.post(t, "/api/v1/stock/returns/"+ret.ID+"/cancel", tok, uuid.NewString(),
		map[string]any{}); r.StatusCode != http.StatusConflict {
		t.Errorf("повторное сторно: %d, want 409", r.StatusCode)
	}

	// Главное: количество снова доступно к возврату. Без исключения отменённых
	// из guard'а ошибочный возврат навсегда «съел» бы 5 кг из накладной.
	r, b = f.post(t, "/api/v1/stock/returns", tok, uuid.NewString(), map[string]any{
		"receipt_id": receipt.ID, "reason": "spoilage", "refund_type": "money", "account_id": accountID,
		"lines": []map[string]any{{"receipt_line_id": lineID, "qty": "20"}},
	})
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("возврат всех 20 после сторно: %d %s, want 201 "+
			"(отменённый возврат всё ещё считается в guard'е)", r.StatusCode, b)
	}
}

// TestStockReturn_CancelMirrorsCost — цикл «возврат + сторно» обязан вернуть
// склад ровно в исходное состояние, а не завысить стоимость запасов.
//
// Регрессия ревью 17.07.2026: возврат откатывал цену только без расхода, а
// сторно ВСЕГДА применяло формулу приёмки. Асимметрия давала 225 → 75 → 274.9995
// (цена 18.3333 из ниоткуда) — и это уезжало в COGS всех блюд. Ошибся кладовщик,
// отменил — а след в себестоимости оставался, и увидеть его было неоткуда.
// Теперь возврат пишет на строку cost_rolled_back, и сторно его зеркалит.
func TestStockReturn_CancelMirrorsCost(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, _, accountID := seedForWrite(t, f)
	topUp(t, gdb, accountID)

	mkReceipt := func(ingID, name, qty, price string) models.StockReceipt {
		r, b := f.post(t, "/api/v1/stock/receipts", tok, uuid.NewString(), map[string]any{
			"payment_type": "paid", "supplier_name": "Ромашка", "account_id": accountID, "paid": true,
			"lines": []map[string]any{{
				"ingredient_id": ingID, "name": name, "qty": qty, "unit": "kg", "price_per_unit": price,
			}},
		})
		if r.StatusCode != http.StatusCreated {
			t.Fatalf("receipt: %d %s", r.StatusCode, b)
		}
		var rc models.StockReceipt
		if err := json.Unmarshal(b, &rc); err != nil {
			t.Fatal(err)
		}
		return rc
	}
	returnAll := func(rc models.StockReceipt, ingID, qty string) models.StockReturn {
		r, b := f.post(t, "/api/v1/stock/returns", tok, uuid.NewString(), map[string]any{
			"receipt_id": rc.ID, "reason": "spoilage", "refund_type": "money", "account_id": accountID,
			"lines": []map[string]any{{"receipt_line_id": receiptLineID(t, gdb, rc.ID, ingID), "qty": qty}},
		})
		if r.StatusCode != http.StatusCreated {
			t.Fatalf("return: %d %s", r.StatusCode, b)
		}
		var ret models.StockReturn
		if err := json.Unmarshal(b, &ret); err != nil {
			t.Fatal(err)
		}
		return ret
	}
	cancel := func(id string) {
		if r, b := f.post(t, "/api/v1/stock/returns/"+id+"/cancel", tok, uuid.NewString(),
			map[string]any{}); r.StatusCode != http.StatusOK {
			t.Fatalf("cancel: %d %s", r.StatusCode, b)
		}
	}
	priceOf := func(id string) decimal.Decimal {
		var i models.Ingredient
		gdb.First(&i, "id = ?", id)
		return i.PricePerUnit
	}

	t.Run("был расход — цену не трогает ни возврат, ни сторно", func(t *testing.T) {
		ing := seedReturnIngredient(t, gdb, f.rid, "Мясо-зеркало", "kg")
		mkReceipt(ing.ID, "Мясо-зеркало", "10", "10")
		r2 := mkReceipt(ing.ID, "Мясо-зеркало", "10", "20") // с/с 15
		if r, b := f.post(t, "/api/v1/stock/writeoffs", tok, uuid.NewString(), map[string]any{
			"reason": "spoilage",
			"lines":  []map[string]any{{"ingredient_id": ing.ID, "name": "Мясо-зеркало", "qty": "5", "unit": "kg", "cost": "75"}},
		}); r.StatusCode != http.StatusCreated {
			t.Fatalf("writeoff: %d %s", r.StatusCode, b)
		}
		// Исходное: qty=15, price=15 → стоимость 225.
		ret := returnAll(r2, ing.ID, "10")
		cancel(ret.ID)

		if got := ingQty(t, gdb, ing.ID); !got.Equal(decimal.MustFromString("15")) {
			t.Errorf("qty после цикла = %s, want 15", got)
		}
		if got := priceOf(ing.ID); !got.Equal(decimal.MustFromString("15")) {
			t.Errorf("с/с после цикла = %s, want 15. Если 18.3333 — вернулась регрессия: "+
				"сторно применило формулу приёмки к возврату, который цену не трогал", got)
		}
	})

	t.Run("расхода не было — возврат откатил, сторно вернуло как было", func(t *testing.T) {
		ing := seedReturnIngredient(t, gdb, f.rid, "Мясо-зеркало-2", "kg")
		mkReceipt(ing.ID, "Мясо-зеркало-2", "10", "10")
		r2 := mkReceipt(ing.ID, "Мясо-зеркало-2", "10", "20") // с/с 15
		if got := priceOf(ing.ID); !got.Equal(decimal.MustFromString("15")) {
			t.Fatalf("предусловие: с/с = %s, want 15", got)
		}
		ret := returnAll(r2, ing.ID, "10")
		// Расхода не было → возврат обязан откатить с/с к цене первой партии.
		if got := priceOf(ing.ID); !got.Equal(decimal.MustFromString("10")) {
			t.Fatalf("с/с после возврата = %s, want 10 (откат)", got)
		}
		cancel(ret.ID)
		if got := priceOf(ing.ID); !got.Equal(decimal.MustFromString("15")) {
			t.Errorf("с/с после сторно = %s, want 15 (откат отменён — операции взаимно обратны)", got)
		}
		if got := ingQty(t, gdb, ing.ID); !got.Equal(decimal.MustFromString("20")) {
			t.Errorf("qty после цикла = %s, want 20", got)
		}
	})
}

// TestReceiptLines_AvailableToReturn — бэк отдаёт «доступно к возврату» готовым
// полем, в единицах накладной, с учётом отменённых возвратов и остатка склада.
//
// Регрессия ревью 17.07.2026: считал клиент и ошибался дважды — не вычитал
// отменённые возвраты (после сторно занижал доступное и блокировал то, что бэк
// принимает) и сравнивал остаток в единицах СКЛАДА с принятым в единицах
// НАКЛАДНОЙ (накладная в граммах при складе в кг → «20» вместо 20000).
func TestReceiptLines_AvailableToReturn(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, _, accountID := seedForWrite(t, f)
	topUp(t, gdb, accountID)

	availOf := func(receiptID, lineID string) decimal.Decimal {
		r, b := f.get(t, "/api/v1/stock/receipts?include=lines&limit=200", tok)
		if r.StatusCode != http.StatusOK {
			t.Fatalf("list receipts: %d %s", r.StatusCode, b)
		}
		var out struct {
			Data []struct {
				ID    string `json:"id"`
				Lines []struct {
					ID        string          `json:"id"`
					Available decimal.Decimal `json:"available_to_return"`
				} `json:"lines"`
			} `json:"data"`
		}
		if err := json.Unmarshal(b, &out); err != nil {
			t.Fatal(err)
		}
		for _, rc := range out.Data {
			if rc.ID != receiptID {
				continue
			}
			for _, l := range rc.Lines {
				if l.ID == lineID {
					return l.Available
				}
			}
		}
		t.Fatalf("строка %s не найдена в накладной %s", lineID, receiptID)
		return decimal.Zero
	}

	t.Run("единицы накладной, а не склада", func(t *testing.T) {
		// Склад в кг, накладная в граммах: 20000 г = 20 кг.
		ing := seedReturnIngredient(t, gdb, f.rid, "Специи", "kg")
		r, b := f.post(t, "/api/v1/stock/receipts", tok, uuid.NewString(), map[string]any{
			"payment_type": "paid", "supplier_name": "Ромашка", "account_id": accountID, "paid": true,
			"lines": []map[string]any{{
				"ingredient_id": ing.ID, "name": "Специи", "qty": "20000", "unit": "g", "price_per_unit": "0.01",
			}},
		})
		if r.StatusCode != http.StatusCreated {
			t.Fatalf("receipt: %d %s", r.StatusCode, b)
		}
		var rc models.StockReceipt
		if err := json.Unmarshal(b, &rc); err != nil {
			t.Fatal(err)
		}
		if got := ingQty(t, gdb, ing.ID); !got.Equal(decimal.MustFromString("20")) {
			t.Fatalf("предусловие: остаток = %s кг, want 20", got)
		}
		got := availOf(rc.ID, receiptLineID(t, gdb, rc.ID, ing.ID))
		if !got.Equal(decimal.MustFromString("20000")) {
			t.Errorf("доступно = %s, want 20000 (граммы накладной). "+
				"Если 20 — остаток склада в кг сравнили с принятым в граммах", got)
		}
	})

	t.Run("отменённый возврат снова доступен", func(t *testing.T) {
		ing := seedReturnIngredient(t, gdb, f.rid, "Крупа", "kg")
		r, b := f.post(t, "/api/v1/stock/receipts", tok, uuid.NewString(), map[string]any{
			"payment_type": "paid", "supplier_name": "Ромашка", "account_id": accountID, "paid": true,
			"lines": []map[string]any{{
				"ingredient_id": ing.ID, "name": "Крупа", "qty": "20", "unit": "kg", "price_per_unit": "10",
			}},
		})
		if r.StatusCode != http.StatusCreated {
			t.Fatalf("receipt: %d %s", r.StatusCode, b)
		}
		var rc models.StockReceipt
		if err := json.Unmarshal(b, &rc); err != nil {
			t.Fatal(err)
		}
		lineID := receiptLineID(t, gdb, rc.ID, ing.ID)
		if got := availOf(rc.ID, lineID); !got.Equal(decimal.MustFromString("20")) {
			t.Fatalf("доступно до возврата = %s, want 20", got)
		}

		r, b = f.post(t, "/api/v1/stock/returns", tok, uuid.NewString(), map[string]any{
			"receipt_id": rc.ID, "reason": "spoilage", "refund_type": "money", "account_id": accountID,
			"lines": []map[string]any{{"receipt_line_id": lineID, "qty": "5"}},
		})
		if r.StatusCode != http.StatusCreated {
			t.Fatalf("return: %d %s", r.StatusCode, b)
		}
		var ret models.StockReturn
		if err := json.Unmarshal(b, &ret); err != nil {
			t.Fatal(err)
		}
		if got := availOf(rc.ID, lineID); !got.Equal(decimal.MustFromString("15")) {
			t.Errorf("доступно после возврата 5 = %s, want 15", got)
		}

		if r, b := f.post(t, "/api/v1/stock/returns/"+ret.ID+"/cancel", tok, uuid.NewString(),
			map[string]any{}); r.StatusCode != http.StatusOK {
			t.Fatalf("cancel: %d %s", r.StatusCode, b)
		}
		if got := availOf(rc.ID, lineID); !got.Equal(decimal.MustFromString("20")) {
			t.Errorf("доступно после сторно = %s, want 20 (товар вернулся — снова можно вернуть)", got)
		}
	})

	t.Run("ограничено фактическим остатком", func(t *testing.T) {
		ing := seedReturnIngredient(t, gdb, f.rid, "Масло", "kg")
		r, b := f.post(t, "/api/v1/stock/receipts", tok, uuid.NewString(), map[string]any{
			"payment_type": "paid", "supplier_name": "Ромашка", "account_id": accountID, "paid": true,
			"lines": []map[string]any{{
				"ingredient_id": ing.ID, "name": "Масло", "qty": "20", "unit": "kg", "price_per_unit": "10",
			}},
		})
		if r.StatusCode != http.StatusCreated {
			t.Fatalf("receipt: %d %s", r.StatusCode, b)
		}
		var rc models.StockReceipt
		if err := json.Unmarshal(b, &rc); err != nil {
			t.Fatal(err)
		}
		if r, b := f.post(t, "/api/v1/stock/writeoffs", tok, uuid.NewString(), map[string]any{
			"reason": "spoilage",
			"lines":  []map[string]any{{"ingredient_id": ing.ID, "name": "Масло", "qty": "18", "unit": "kg", "cost": "180"}},
		}); r.StatusCode != http.StatusCreated {
			t.Fatalf("writeoff: %d %s", r.StatusCode, b)
		}
		if got := availOf(rc.ID, receiptLineID(t, gdb, rc.ID, ing.ID)); !got.Equal(decimal.MustFromString("2")) {
			t.Errorf("доступно = %s, want 2 (приняли 20, съели 18 — вернуть можно только остаток)", got)
		}
	})
}
