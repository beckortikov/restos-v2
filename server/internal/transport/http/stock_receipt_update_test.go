//go:build integration

package http_test

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

func TestStockReceipt_Update_HeaderAndDateCascade(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, _, accID := seedForWrite(t, f)
	topUp(t, gdb, accID)
	makeOwner(t, f.rid)

	ingID := uuid.NewString()
	ingName, ingUnit := "Мука", "kg"
	if err := gdb.Create(&models.Ingredient{ID: ingID, Name: &ingName, Unit: &ingUnit, RestaurantID: &f.rid}).Error; err != nil {
		t.Fatal(err)
	}

	cr, cb := f.post(t, "/api/v1/stock/receipts", tok, uuid.NewString(), map[string]any{
		"payment_type": "paid", "account_id": accID, "date": "2026-07-01",
		"lines": []map[string]any{{"ingredient_id": ingID, "name": ingName, "qty": "10", "price_per_unit": "100"}},
	})
	if cr.StatusCode != http.StatusCreated {
		t.Fatalf("create receipt: %d %s", cr.StatusCode, cb)
	}
	var receipt models.StockReceipt
	_ = json.Unmarshal(cb, &receipt)

	// Связанная проводка легла на дату накладной (2026-07-01).
	var goodsOp models.FinancialOperation
	if err := gdb.Where("source_ref = ?", "receipt:"+receipt.ID).First(&goodsOp).Error; err != nil {
		t.Fatal(err)
	}
	if derefStr(goodsOp.Date) != "2026-07-01" {
		t.Errorf("goodsOp.Date = %s, want 2026-07-01", derefStr(goodsOp.Date))
	}

	// Правим note/due_date/date — каскад на связанную проводку.
	ur, ub := f.patch(t, "/api/v1/stock/receipts/"+receipt.ID, tok, uuid.NewString(), map[string]any{
		"note": "испр. дата", "due_date": "2026-08-01", "date": "2026-07-15",
	})
	if ur.StatusCode != http.StatusOK {
		t.Fatalf("update: %d %s", ur.StatusCode, ub)
	}
	var updated models.StockReceipt
	_ = json.Unmarshal(ub, &updated)
	if derefStr(updated.Note) != "испр. дата" {
		t.Errorf("note = %s, want 'испр. дата'", derefStr(updated.Note))
	}
	if derefStr(updated.Date) != "2026-07-15" {
		t.Errorf("date = %s, want 2026-07-15", derefStr(updated.Date))
	}

	var goodsOp2 models.FinancialOperation
	if err := gdb.Where("source_ref = ?", "receipt:"+receipt.ID).First(&goodsOp2).Error; err != nil {
		t.Fatal(err)
	}
	if derefStr(goodsOp2.Date) != "2026-07-15" {
		t.Errorf("goodsOp.Date после правки = %s, want 2026-07-15 (каскад)", derefStr(goodsOp2.Date))
	}
}

func TestStockReceipt_Update_NotOwner_Forbidden(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t) // дефолтная фикстура — кассир, не владелец.
	gdb, _, _, accID := seedForWrite(t, f)
	topUp(t, gdb, accID)

	ingID := uuid.NewString()
	ingName, ingUnit := "Сахар", "kg"
	if err := gdb.Create(&models.Ingredient{ID: ingID, Name: &ingName, Unit: &ingUnit, RestaurantID: &f.rid}).Error; err != nil {
		t.Fatal(err)
	}
	cr, cb := f.post(t, "/api/v1/stock/receipts", tok, uuid.NewString(), map[string]any{
		"payment_type": "paid", "account_id": accID,
		"lines": []map[string]any{{"ingredient_id": ingID, "name": ingName, "qty": "5", "price_per_unit": "10"}},
	})
	if cr.StatusCode != http.StatusCreated {
		t.Fatalf("create: %d %s", cr.StatusCode, cb)
	}
	var receipt models.StockReceipt
	_ = json.Unmarshal(cb, &receipt)

	if r, b := f.patch(t, "/api/v1/stock/receipts/"+receipt.ID, tok, uuid.NewString(),
		map[string]any{"note": "x"}); r.StatusCode != http.StatusForbidden {
		t.Errorf("не-владелец: %d %s, want 403", r.StatusCode, b)
	}
}

func TestStockReceipt_Update_LineQtyIncrease_RecomputesWeightedAverage(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, _, accID := seedForWrite(t, f)
	topUp(t, gdb, accID)
	makeOwner(t, f.rid)

	ingID := uuid.NewString()
	ingName, ingUnit := "Масло", "kg"
	if err := gdb.Create(&models.Ingredient{ID: ingID, Name: &ingName, Unit: &ingUnit, RestaurantID: &f.rid}).Error; err != nil {
		t.Fatal(err)
	}

	// Приёмка 10кг по 100 → остаток 10, цена 100.
	cr, cb := f.post(t, "/api/v1/stock/receipts", tok, uuid.NewString(), map[string]any{
		"payment_type": "paid", "account_id": accID,
		"lines": []map[string]any{{"ingredient_id": ingID, "name": ingName, "qty": "10", "price_per_unit": "100"}},
	})
	if cr.StatusCode != http.StatusCreated {
		t.Fatalf("create: %d %s", cr.StatusCode, cb)
	}
	var receipt struct {
		ID    string `json:"id"`
		Lines []struct {
			ID string `json:"id"`
		} `json:"lines"`
	}
	_ = json.Unmarshal(cb, &receipt)
	lineID := receiptLineID(t, gdb, receipt.ID, ingID)

	var ing models.Ingredient
	gdb.Where("id = ?", ingID).First(&ing)
	if !ing.Qty.Equal(decimal.MustFromString("10")) || !ing.PricePerUnit.Equal(decimal.MustFromString("100")) {
		t.Fatalf("baseline qty=%s price=%s, want 10/100", ing.Qty, ing.PricePerUnit)
	}

	// Исправляем: было недосчитано, реально приняли 15кг (не 10) по той же цене.
	ur, ub := f.patch(t, "/api/v1/stock/receipts/"+receipt.ID, tok, uuid.NewString(), map[string]any{
		"lines": []map[string]any{{"line_id": lineID, "qty": "15"}},
	})
	if ur.StatusCode != http.StatusOK {
		t.Fatalf("update: %d %s", ur.StatusCode, ub)
	}
	gdb.Where("id = ?", ingID).First(&ing)
	if !ing.Qty.Equal(decimal.MustFromString("15")) {
		t.Errorf("qty после увеличения = %s, want 15", ing.Qty)
	}
	if !ing.PricePerUnit.Equal(decimal.MustFromString("100")) {
		t.Errorf("price после увеличения (та же цена) = %s, want 100", ing.PricePerUnit)
	}

	// Новое движение receipt_correction на разницу (+5).
	var mv models.StockMovement
	if err := gdb.Where("ingredient_id = ? AND type = ?", ingID, "receipt_correction").First(&mv).Error; err != nil {
		t.Fatalf("receipt_correction movement не найдено: %v", err)
	}
	if !mv.Qty.Equal(decimal.MustFromString("5")) {
		t.Errorf("movement qty = %s, want 5", mv.Qty)
	}

	// total_amount накладной пересчитан (15*100=1500), проводка stock_purchase тоже.
	var updated models.StockReceipt
	gdb.Where("id = ?", receipt.ID).First(&updated)
	if !updated.TotalAmount.Equal(decimal.MustFromString("1500")) {
		t.Errorf("total_amount = %s, want 1500", updated.TotalAmount)
	}
	var goodsOp models.FinancialOperation
	gdb.Where("source_ref = ?", "receipt:"+receipt.ID).First(&goodsOp)
	if !goodsOp.Amount.Equal(decimal.MustFromString("1500")) {
		t.Errorf("goodsOp.Amount = %s, want 1500", goodsOp.Amount)
	}
	// Счёт списан ещё на 500 (было 1000 за 10кг, стало 1500 за 15кг).
	if bal := accBalance(t, gdb, accID); !bal.Equal(decimal.MustFromString("8500")) {
		t.Errorf("баланс счёта = %s, want 8500 (10000-1500)", bal)
	}
}

func TestStockReceipt_Update_LineQtyDecrease_BoundedByOnHandAndReturns(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, _, accID := seedForWrite(t, f)
	topUp(t, gdb, accID)
	makeOwner(t, f.rid)

	ingID := uuid.NewString()
	ingName, ingUnit := "Сыр", "kg"
	if err := gdb.Create(&models.Ingredient{ID: ingID, Name: &ingName, Unit: &ingUnit, RestaurantID: &f.rid}).Error; err != nil {
		t.Fatal(err)
	}
	cr, cb := f.post(t, "/api/v1/stock/receipts", tok, uuid.NewString(), map[string]any{
		"payment_type": "paid", "account_id": accID,
		"lines": []map[string]any{{"ingredient_id": ingID, "name": ingName, "qty": "10", "price_per_unit": "50"}},
	})
	if cr.StatusCode != http.StatusCreated {
		t.Fatalf("create: %d %s", cr.StatusCode, cb)
	}
	var receipt models.StockReceipt
	_ = json.Unmarshal(cb, &receipt)
	lineID := receiptLineID(t, gdb, receipt.ID, ingID)

	// Уменьшаем на складе физически (списание 3кг) — остаток 7.
	wr, wb := f.post(t, "/api/v1/stock/writeoffs", tok, uuid.NewString(), map[string]any{
		"reason": "spoilage",
		"lines":  []map[string]any{{"ingredient_id": ingID, "name": ingName, "qty": "3", "unit": ingUnit, "cost": "150"}},
	})
	if wr.StatusCode != http.StatusCreated {
		t.Fatalf("writeoff: %d %s", wr.StatusCode, wb)
	}

	// Уменьшить строку до 2 (decrease=8) — больше остатка (7) → 409.
	if r, b := f.patch(t, "/api/v1/stock/receipts/"+receipt.ID, tok, uuid.NewString(),
		map[string]any{"lines": []map[string]any{{"line_id": lineID, "qty": "2"}}}); r.StatusCode != http.StatusConflict {
		t.Errorf("уменьшение больше остатка: %d %s, want 409", r.StatusCode, b)
	}

	// Уменьшить строку до 5 (decrease=5, остаток 7 — влезает) — OK.
	if r, b := f.patch(t, "/api/v1/stock/receipts/"+receipt.ID, tok, uuid.NewString(),
		map[string]any{"lines": []map[string]any{{"line_id": lineID, "qty": "5"}}}); r.StatusCode != http.StatusOK {
		t.Errorf("уменьшение в пределах остатка: %d %s, want 200", r.StatusCode, b)
	}
	var ing models.Ingredient
	gdb.Where("id = ?", ingID).First(&ing)
	if !ing.Qty.Equal(decimal.MustFromString("2")) {
		t.Errorf("qty после уменьшения = %s, want 2 (7-5)", ing.Qty)
	}
}

func TestStockReceipt_Update_LinePrice_BlockedAfterConsumption(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, _, accID := seedForWrite(t, f)
	topUp(t, gdb, accID)
	makeOwner(t, f.rid)

	ingID := uuid.NewString()
	ingName, ingUnit := "Помидоры", "kg"
	if err := gdb.Create(&models.Ingredient{ID: ingID, Name: &ingName, Unit: &ingUnit, RestaurantID: &f.rid}).Error; err != nil {
		t.Fatal(err)
	}
	cr, cb := f.post(t, "/api/v1/stock/receipts", tok, uuid.NewString(), map[string]any{
		"payment_type": "paid", "account_id": accID,
		"lines": []map[string]any{{"ingredient_id": ingID, "name": ingName, "qty": "10", "price_per_unit": "20"}},
	})
	if cr.StatusCode != http.StatusCreated {
		t.Fatalf("create: %d %s", cr.StatusCode, cb)
	}
	var receipt models.StockReceipt
	_ = json.Unmarshal(cb, &receipt)
	lineID := receiptLineID(t, gdb, receipt.ID, ingID)

	// Правка цены ДО потребления — разрешена и пересчитывает средневзвешенную.
	if r, b := f.patch(t, "/api/v1/stock/receipts/"+receipt.ID, tok, uuid.NewString(),
		map[string]any{"lines": []map[string]any{{"line_id": lineID, "price_per_unit": "25"}}}); r.StatusCode != http.StatusOK {
		t.Fatalf("правка цены до потребления: %d %s, want 200", r.StatusCode, b)
	}
	var ing models.Ingredient
	gdb.Where("id = ?", ingID).First(&ing)
	if !ing.PricePerUnit.Equal(decimal.MustFromString("25")) {
		t.Errorf("price после правки = %s, want 25", ing.PricePerUnit)
	}

	// Потребление (списание 1кг).
	wr, wb := f.post(t, "/api/v1/stock/writeoffs", tok, uuid.NewString(), map[string]any{
		"reason": "spoilage",
		"lines":  []map[string]any{{"ingredient_id": ingID, "name": ingName, "qty": "1", "unit": ingUnit, "cost": "25"}},
	})
	if wr.StatusCode != http.StatusCreated {
		t.Fatalf("writeoff: %d %s", wr.StatusCode, wb)
	}

	// Повторная правка цены ПОСЛЕ потребления — блокируется 409.
	if r, b := f.patch(t, "/api/v1/stock/receipts/"+receipt.ID, tok, uuid.NewString(),
		map[string]any{"lines": []map[string]any{{"line_id": lineID, "price_per_unit": "30"}}}); r.StatusCode != http.StatusConflict {
		t.Errorf("правка цены после потребления: %d %s, want 409", r.StatusCode, b)
	}
}

func TestStockReceipt_Update_Payment_AdjustsBalanceAndDebt(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, _, accID := seedForWrite(t, f)
	topUp(t, gdb, accID)
	makeOwner(t, f.rid)

	supID := uuid.NewString()
	supName := "Поставщик 1"
	if err := gdb.Create(&models.Supplier{ID: supID, Name: &supName, RestaurantID: &f.rid}).Error; err != nil {
		t.Fatal(err)
	}
	ingID := uuid.NewString()
	ingName, ingUnit := "Рис", "kg"
	if err := gdb.Create(&models.Ingredient{ID: ingID, Name: &ingName, Unit: &ingUnit, RestaurantID: &f.rid}).Error; err != nil {
		t.Fatal(err)
	}

	// Приёмка в долг 1000 (10кг по 100), поставщик известен.
	cr, cb := f.post(t, "/api/v1/stock/receipts", tok, uuid.NewString(), map[string]any{
		"payment_type": "credit", "supplier_id": supID,
		"lines": []map[string]any{{"ingredient_id": ingID, "name": ingName, "qty": "10", "price_per_unit": "100"}},
	})
	if cr.StatusCode != http.StatusCreated {
		t.Fatalf("create: %d %s", cr.StatusCode, cb)
	}
	var receipt models.StockReceipt
	_ = json.Unmarshal(cb, &receipt)

	var sup models.Supplier
	gdb.Where("id = ?", supID).First(&sup)
	if !sup.CurrentDebt.Equal(decimal.MustFromString("1000")) {
		t.Fatalf("supplier.CurrentDebt = %s, want 1000", sup.CurrentDebt)
	}

	// Частично оплачиваем 600 через Update (было 0 оплачено).
	ur, ub := f.patch(t, "/api/v1/stock/receipts/"+receipt.ID, tok, uuid.NewString(), map[string]any{
		"payment_type": "partial", "paid_amount": "600", "account_id": accID,
	})
	if ur.StatusCode != http.StatusOK {
		t.Fatalf("update payment: %d %s", ur.StatusCode, ub)
	}
	if bal := accBalance(t, gdb, accID); !bal.Equal(decimal.MustFromString("9400")) {
		t.Errorf("баланс счёта = %s, want 9400 (10000-600)", bal)
	}
	gdb.Where("id = ?", supID).First(&sup)
	if !sup.CurrentDebt.Equal(decimal.MustFromString("400")) {
		t.Errorf("supplier.CurrentDebt после частичной оплаты = %s, want 400", sup.CurrentDebt)
	}
	var goodsOp models.FinancialOperation
	gdb.Where("source_ref = ?", "receipt:"+receipt.ID).First(&goodsOp)
	if !goodsOp.Amount.Equal(decimal.MustFromString("600")) {
		t.Errorf("goodsOp.Amount = %s, want 600", goodsOp.Amount)
	}
}

func TestStockReceipt_Update_SupplierChange_BlockedByDebt(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, _, _ := seedForWrite(t, f)
	makeOwner(t, f.rid)

	sup1ID, sup2ID := uuid.NewString(), uuid.NewString()
	n1, n2 := "П1", "П2"
	if err := gdb.Create(&models.Supplier{ID: sup1ID, Name: &n1, RestaurantID: &f.rid}).Error; err != nil {
		t.Fatal(err)
	}
	if err := gdb.Create(&models.Supplier{ID: sup2ID, Name: &n2, RestaurantID: &f.rid}).Error; err != nil {
		t.Fatal(err)
	}
	ingID := uuid.NewString()
	ingName, ingUnit := "Мясо", "kg"
	if err := gdb.Create(&models.Ingredient{ID: ingID, Name: &ingName, Unit: &ingUnit, RestaurantID: &f.rid}).Error; err != nil {
		t.Fatal(err)
	}
	cr, cb := f.post(t, "/api/v1/stock/receipts", tok, uuid.NewString(), map[string]any{
		"payment_type": "credit", "supplier_id": sup1ID,
		"lines": []map[string]any{{"ingredient_id": ingID, "name": ingName, "qty": "5", "price_per_unit": "200"}},
	})
	if cr.StatusCode != http.StatusCreated {
		t.Fatalf("create: %d %s", cr.StatusCode, cb)
	}
	var receipt models.StockReceipt
	_ = json.Unmarshal(cb, &receipt)

	if r, b := f.patch(t, "/api/v1/stock/receipts/"+receipt.ID, tok, uuid.NewString(),
		map[string]any{"supplier_id": sup2ID}); r.StatusCode != http.StatusBadRequest {
		t.Errorf("смена поставщика при долге: %d %s, want 400", r.StatusCode, b)
	}
}

// TestStockReceipt_Update_PaidToCredit_ReturnsMoneyAndRaisesDebt — перевод
// ОПЛАЧЕННОЙ накладной в «Кредит» обязан вернуть деньги на счёт и начислить
// долг поставщику. Владелец сообщил обратное: «оплаченные не уменьшается, а
// долг не повышается». Причина — тип оплаты не форсировал paid_amount:
// диалог правки префилливал поле текущей оплатой и слал paid_amount=total,
// бэк ему верил → accountDelta=0, newDebt=0, а в заголовке оседало
// противоречие credit + paid=total + debt=0.
//
// Тест шлёт ИМЕННО тот payload, что слал баговый диалог (paid_amount=total
// вместе с payment_type=credit) — фикс обязан игнорировать присланную сумму,
// а не полагаться на исправленный клиент.
func TestStockReceipt_Update_PaidToCredit_ReturnsMoneyAndRaisesDebt(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, _, accID := seedForWrite(t, f)
	topUp(t, gdb, accID) // 10000
	makeOwner(t, f.rid)

	supID := uuid.NewString()
	supName := "Поставщик"
	if err := gdb.Create(&models.Supplier{ID: supID, Name: &supName, RestaurantID: &f.rid}).Error; err != nil {
		t.Fatal(err)
	}
	ingID := uuid.NewString()
	ingName, ingUnit := "Сахар", "kg"
	if err := gdb.Create(&models.Ingredient{ID: ingID, Name: &ingName, Unit: &ingUnit, RestaurantID: &f.rid}).Error; err != nil {
		t.Fatal(err)
	}

	// Оплаченная приёмка на 1000: деньги списаны, долга нет.
	cr, cb := f.post(t, "/api/v1/stock/receipts", tok, uuid.NewString(), map[string]any{
		"payment_type": "paid", "account_id": accID, "supplier_id": supID,
		"lines": []map[string]any{{"ingredient_id": ingID, "name": ingName, "qty": "10", "price_per_unit": "100"}},
	})
	if cr.StatusCode != http.StatusCreated {
		t.Fatalf("create: %d %s", cr.StatusCode, cb)
	}
	var receipt models.StockReceipt
	_ = json.Unmarshal(cb, &receipt)
	if bal := accBalance(t, gdb, accID); !bal.Equal(decimal.MustFromString("9000")) {
		t.Fatalf("баланс после оплаченной приёмки = %s, want 9000", bal)
	}
	var sup models.Supplier
	gdb.Where("id = ?", supID).First(&sup)
	if !sup.CurrentDebt.IsZero() {
		t.Fatalf("долг поставщика после оплаченной приёмки = %s, want 0", sup.CurrentDebt)
	}

	// Переводим в кредит, повторяя баговый payload (paid_amount=total).
	ur, ub := f.patch(t, "/api/v1/stock/receipts/"+receipt.ID, tok, uuid.NewString(), map[string]any{
		"payment_type": "credit", "paid_amount": "1000", "account_id": accID,
	})
	if ur.StatusCode != http.StatusOK {
		t.Fatalf("update to credit: %d %s", ur.StatusCode, ub)
	}
	var updated models.StockReceipt
	_ = json.Unmarshal(ub, &updated)
	if !updated.PaidAmount.IsZero() {
		t.Errorf("paid_amount = %s, want 0 («кредит» = не платили)", updated.PaidAmount)
	}
	if !updated.DebtAmount.Equal(decimal.MustFromString("1000")) {
		t.Errorf("debt_amount = %s, want 1000", updated.DebtAmount)
	}
	if derefStr(updated.PaymentType) != "credit" {
		t.Errorf("payment_type = %s, want credit", derefStr(updated.PaymentType))
	}
	// Деньги вернулись на счёт.
	if bal := accBalance(t, gdb, accID); !bal.Equal(decimal.MustFromString("10000")) {
		t.Errorf("баланс после перевода в кредит = %s, want 10000 (деньги вернулись)", bal)
	}
	// Долг поставщика вырос на всю сумму накладной.
	gdb.Where("id = ?", supID).First(&sup)
	if !sup.CurrentDebt.Equal(decimal.MustFromString("1000")) {
		t.Errorf("долг поставщика = %s, want 1000", sup.CurrentDebt)
	}
	// Связанная проводка обнулена: за товар больше не заплачено.
	var goodsOp models.FinancialOperation
	gdb.Where("source_ref = ?", "receipt:"+receipt.ID).First(&goodsOp)
	if !goodsOp.Amount.IsZero() {
		t.Errorf("goodsOp.Amount = %s, want 0", goodsOp.Amount)
	}

	// Обратно в «Оплачено» — деньги снова списываются, долг гасится.
	br, bb := f.patch(t, "/api/v1/stock/receipts/"+receipt.ID, tok, uuid.NewString(), map[string]any{
		"payment_type": "paid", "account_id": accID,
	})
	if br.StatusCode != http.StatusOK {
		t.Fatalf("update back to paid: %d %s", br.StatusCode, bb)
	}
	if bal := accBalance(t, gdb, accID); !bal.Equal(decimal.MustFromString("9000")) {
		t.Errorf("баланс после возврата в «оплачено» = %s, want 9000", bal)
	}
	gdb.Where("id = ?", supID).First(&sup)
	if !sup.CurrentDebt.IsZero() {
		t.Errorf("долг поставщика после возврата в «оплачено» = %s, want 0", sup.CurrentDebt)
	}
}

// TestStockReceipt_Update_CreditWithoutSupplier_Rejected — «кредит» без
// поставщика отбивается: долг не на кого записать (тот же инвариант, что в
// CreateReceipt). Раньше такая накладная молча проходила с paid=total и
// debt=0 — долга не возникало вовсе, поэтому гейт не срабатывал.
func TestStockReceipt_Update_CreditWithoutSupplier_Rejected(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, _, accID := seedForWrite(t, f)
	topUp(t, gdb, accID)
	makeOwner(t, f.rid)

	ingID := uuid.NewString()
	ingName, ingUnit := "Соль", "kg"
	if err := gdb.Create(&models.Ingredient{ID: ingID, Name: &ingName, Unit: &ingUnit, RestaurantID: &f.rid}).Error; err != nil {
		t.Fatal(err)
	}
	cr, cb := f.post(t, "/api/v1/stock/receipts", tok, uuid.NewString(), map[string]any{
		"payment_type": "paid", "account_id": accID,
		"lines": []map[string]any{{"ingredient_id": ingID, "name": ingName, "qty": "2", "price_per_unit": "50"}},
	})
	if cr.StatusCode != http.StatusCreated {
		t.Fatalf("create: %d %s", cr.StatusCode, cb)
	}
	var receipt models.StockReceipt
	_ = json.Unmarshal(cb, &receipt)

	r, b := f.patch(t, "/api/v1/stock/receipts/"+receipt.ID, tok, uuid.NewString(), map[string]any{
		"payment_type": "credit", "account_id": accID,
	})
	if r.StatusCode != http.StatusBadRequest {
		t.Fatalf("кредит без поставщика: %d %s, want 400", r.StatusCode, b)
	}
	// Баланс не тронут отбитой правкой.
	if bal := accBalance(t, gdb, accID); !bal.Equal(decimal.MustFromString("9900")) {
		t.Errorf("баланс после отбитой правки = %s, want 9900 (не тронут)", bal)
	}
}

func derefStr(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
