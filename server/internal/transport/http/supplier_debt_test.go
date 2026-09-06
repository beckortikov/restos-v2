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

// Регрессии v3.16.89: PayDebt уменьшал только suppliers.current_debt, а
// stock_receipts.debt_amount оставался НАЧИСЛЕННЫМ навсегда. Из-за этого экран
// «Накладные» завышал «Задолженность» на всю сумму оплат, а карточка поставщика
// показывала рядом два разных долга. Теперь оплата раскладывается по накладным
// FIFO, и debt_amount означает остаток.

// receiptDebt — остаток долга накладной, ровно то число, что рисует UI в
// колонке «Долг» и суммирует в «Задолженность».
func receiptDebt(t *testing.T, gdb *gorm.DB, id string) decimal.Decimal {
	t.Helper()
	var r models.StockReceipt
	if err := gdb.First(&r, "id = ?", id).Error; err != nil {
		t.Fatal(err)
	}
	return r.DebtAmount
}

func supplierDebt(t *testing.T, gdb *gorm.DB, id string) decimal.Decimal {
	t.Helper()
	var s models.Supplier
	if err := gdb.First(&s, "id = ?", id).Error; err != nil {
		t.Fatal(err)
	}
	return s.CurrentDebt
}

// TestPayDebt_ReducesReceiptDebt — частичная оплата долга уменьшает долг самой
// накладной, а не только поставщика. Раньше: накладная показывала 420 после
// оплаты 200, то есть «Задолженность» на экране накладных врала на 200.
func TestPayDebt_ReducesReceiptDebt(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, _, accountID := seedForWrite(t, f)
	topUp(t, gdb, accountID)

	supName := "Ромашка-долг"
	sup := &models.Supplier{
		ID: uuid.NewString(), Name: &supName,
		CurrentDebt: decimal.Zero, RestaurantID: &f.rid,
	}
	if err := gdb.Create(sup).Error; err != nil {
		t.Fatal(err)
	}
	ing := seedReturnIngredient(t, gdb, f.rid, "Товар-долг", "kg")

	r, b := f.post(t, "/api/v1/stock/receipts", tok, uuid.NewString(), map[string]any{
		"payment_type": "credit", "supplier_id": sup.ID, "supplier_name": supName,
		"lines": []map[string]any{{
			"ingredient_id": ing.ID, "name": "Товар-долг", "qty": "42", "unit": "kg", "price_per_unit": "10",
		}},
	})
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("receipt: %d %s", r.StatusCode, b)
	}
	var receipt models.StockReceipt
	if err := json.Unmarshal(b, &receipt); err != nil {
		t.Fatal(err)
	}

	if r, b := f.post(t, "/api/v1/suppliers/"+sup.ID+"/pay-debt", tok, uuid.NewString(),
		map[string]any{"amount": "200", "account_id": accountID}); r.StatusCode != http.StatusOK {
		t.Fatalf("pay-debt: %d %s", r.StatusCode, b)
	}

	// Оба числа обязаны сойтись: 420 − 200 = 220.
	if got := receiptDebt(t, gdb, receipt.ID); !got.Equal(decimal.MustFromString("220")) {
		t.Errorf("receipt.debt_amount = %s, want 220 — экран «Накладные» показывает это число как «Долг»", got)
	}
	if got := supplierDebt(t, gdb, sup.ID); !got.Equal(decimal.MustFromString("220")) {
		t.Errorf("supplier.current_debt = %s, want 220", got)
	}

	// Пересчёт долгов не должен вычесть оплату второй раз (формула стала
	// Σ debt_amount, без вычитания supplier_payment).
	if r, b := f.post(t, "/api/v1/suppliers/recompute-debts", tok, uuid.NewString(),
		map[string]any{}); r.StatusCode != http.StatusOK {
		t.Fatalf("recompute-debts: %d %s", r.StatusCode, b)
	}
	if got := supplierDebt(t, gdb, sup.ID); !got.Equal(decimal.MustFromString("220")) {
		t.Errorf("current_debt после RecomputeDebts = %s, want 220 (двойное вычитание оплаты)", got)
	}
	if got := receiptDebt(t, gdb, receipt.ID); !got.Equal(decimal.MustFromString("220")) {
		t.Errorf("receipt.debt_amount после RecomputeDebts = %s, want 220", got)
	}

	// Догашиваем остаток — накладная обязана обнулиться.
	if r, b := f.post(t, "/api/v1/suppliers/"+sup.ID+"/pay-debt", tok, uuid.NewString(),
		map[string]any{"amount": "220", "account_id": accountID}); r.StatusCode != http.StatusOK {
		t.Fatalf("pay-debt 2: %d %s", r.StatusCode, b)
	}
	if got := receiptDebt(t, gdb, receipt.ID); !got.Equal(decimal.Zero) {
		t.Errorf("receipt.debt_amount после полного гашения = %s, want 0 "+
			"(погашенная накладная вечно висела должником)", got)
	}
	if got := supplierDebt(t, gdb, sup.ID); !got.Equal(decimal.Zero) {
		t.Errorf("supplier.current_debt = %s, want 0", got)
	}
}

// TestPayDebt_AllocatesFIFO — оплата гасит накладные от старых к новым, а не
// размазывается. Это то, что видно в «Истории закупок» карточки поставщика.
func TestPayDebt_AllocatesFIFO(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, _, accountID := seedForWrite(t, f)
	topUp(t, gdb, accountID)

	supName := "Ромашка-FIFO"
	sup := &models.Supplier{
		ID: uuid.NewString(), Name: &supName,
		CurrentDebt: decimal.Zero, RestaurantID: &f.rid,
	}
	if err := gdb.Create(sup).Error; err != nil {
		t.Fatal(err)
	}
	ing := seedReturnIngredient(t, gdb, f.rid, "Товар-FIFO", "kg")

	mkCredit := func(qty, price string) models.StockReceipt {
		r, b := f.post(t, "/api/v1/stock/receipts", tok, uuid.NewString(), map[string]any{
			"payment_type": "credit", "supplier_id": sup.ID, "supplier_name": supName,
			"lines": []map[string]any{{
				"ingredient_id": ing.ID, "name": "Товар-FIFO", "qty": qty, "unit": "kg", "price_per_unit": price,
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

	older := mkCredit("16", "10") // 160
	newer := mkCredit("50", "10") // 500 → всего долг 660

	// Платим 200: гасит старую (160) целиком и 40 от новой.
	if r, b := f.post(t, "/api/v1/suppliers/"+sup.ID+"/pay-debt", tok, uuid.NewString(),
		map[string]any{"amount": "200", "account_id": accountID}); r.StatusCode != http.StatusOK {
		t.Fatalf("pay-debt: %d %s", r.StatusCode, b)
	}

	if got := receiptDebt(t, gdb, older.ID); !got.Equal(decimal.Zero) {
		t.Errorf("старая накладная: долг = %s, want 0 (FIFO гасит её первой)", got)
	}
	if got := receiptDebt(t, gdb, newer.ID); !got.Equal(decimal.MustFromString("460")) {
		t.Errorf("новая накладная: долг = %s, want 460 (500 − остаток оплаты 40)", got)
	}
	// Инвариант: Σ долгов накладных == долг поставщика. Именно эти два числа
	// стояли рядом в карточке поставщика и противоречили друг другу.
	if got := supplierDebt(t, gdb, sup.ID); !got.Equal(decimal.MustFromString("460")) {
		t.Errorf("supplier.current_debt = %s, want 460 (Σ долгов накладных)", got)
	}
}

// TestSupplierOpeningDebt_NoLinesSurvivesRecomputeAndPaysDown — долг, внесённый
// вручную (067, без накладной, для переноса задолженности до перехода на
// систему), обязан: (1) не задевать склад (нет строк товара), (2) пережить
// «Пересчитать долги» (formula Σ stock_receipts.debt_amount уже включает его —
// не отдельная колонка, которую эта кнопка молча стёрла бы), (3) гаситься тем
// же /pay-debt, что и обычная накладная (FIFO-аллокатор работает по
// debt_amount, ему всё равно, откуда взялась строка).
func TestSupplierOpeningDebt_NoLinesSurvivesRecomputeAndPaysDown(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, _, accountID := seedForWrite(t, f)
	topUp(t, gdb, accountID)

	supName := "Ромашка-начальный-долг"
	sup := &models.Supplier{
		ID: uuid.NewString(), Name: &supName,
		CurrentDebt: decimal.Zero, RestaurantID: &f.rid,
	}
	if err := gdb.Create(sup).Error; err != nil {
		t.Fatal(err)
	}

	r, b := f.post(t, "/api/v1/suppliers/"+sup.ID+"/opening-debt", tok, uuid.NewString(),
		map[string]any{"amount": "500", "note": "Долг до перехода на новую кассу"})
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("opening-debt: %d %s", r.StatusCode, b)
	}
	var receipt models.StockReceipt
	if err := json.Unmarshal(b, &receipt); err != nil {
		t.Fatal(err)
	}
	if !receipt.IsOpeningDebt {
		t.Errorf("is_opening_debt = false, want true")
	}
	if !receipt.DebtAmount.Equal(decimal.MustFromString("500")) {
		t.Errorf("receipt.debt_amount = %s, want 500", receipt.DebtAmount)
	}
	if got := supplierDebt(t, gdb, sup.ID); !got.Equal(decimal.MustFromString("500")) {
		t.Errorf("supplier.current_debt = %s, want 500", got)
	}

	// Пересчёт не должен стереть долг без накладной — он такая же строка
	// stock_receipts, как обычная приёмка в кредит.
	if r, b := f.post(t, "/api/v1/suppliers/recompute-debts", tok, uuid.NewString(),
		map[string]any{}); r.StatusCode != http.StatusOK {
		t.Fatalf("recompute-debts: %d %s", r.StatusCode, b)
	}
	if got := supplierDebt(t, gdb, sup.ID); !got.Equal(decimal.MustFromString("500")) {
		t.Errorf("current_debt после RecomputeDebts = %s, want 500 (пересчёт стёр ручной долг)", got)
	}

	// Гасим обычным /pay-debt — FIFO-аллокатор обязан найти эту накладную.
	if r, b := f.post(t, "/api/v1/suppliers/"+sup.ID+"/pay-debt", tok, uuid.NewString(),
		map[string]any{"amount": "500", "account_id": accountID}); r.StatusCode != http.StatusOK {
		t.Fatalf("pay-debt: %d %s", r.StatusCode, b)
	}
	if got := receiptDebt(t, gdb, receipt.ID); !got.Equal(decimal.Zero) {
		t.Errorf("receipt.debt_amount после гашения = %s, want 0", got)
	}
	if got := supplierDebt(t, gdb, sup.ID); !got.Equal(decimal.Zero) {
		t.Errorf("supplier.current_debt после гашения = %s, want 0", got)
	}
}

// TestSupplyExpense_AllowNegativeFlag — флаг «📦 Хозтовары: разрешить минус»
// наконец работает. До v3.16.90 он писался в настройках и НИГДЕ не читался:
// тумблер обещал владельцу контроль, которого не было.
//
// Default true → у тех, кто его не трогал, поведение не меняется.
func TestSupplyExpense_AllowNegativeFlag(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, _, _ := seedForWrite(t, f)

	soap := seedReturnIngredient(t, gdb, f.rid, "Мыло", "kg")
	// Кладём 2 кг через движение (прямой UPDATE qty запрещён).
	mvType := "receipt"
	if err := gdb.Create(&models.StockMovement{
		ID: uuid.NewString(), Type: &mvType, IngredientID: &soap.ID,
		Qty: decimal.MustFromString("2"), RestaurantID: &f.rid,
	}).Error; err != nil {
		t.Fatal(err)
	}

	issue := func(qty string) int {
		r, _ := f.post(t, "/api/v1/supply-expenses", tok, uuid.NewString(), map[string]any{
			"ingredient_id": soap.ID, "qty": qty, "unit": "kg", "reason": "cleaning",
		})
		return r.StatusCode
	}

	// Флаг включён (default) — минус разрешён, поведение как раньше.
	if code := issue("5"); code != http.StatusCreated {
		t.Fatalf("выдача 5 при остатке 2 с разрешённым минусом: %d, want 201", code)
	}
	if got := ingQty(t, gdb, soap.ID); !got.Equal(decimal.MustFromString("-3")) {
		t.Errorf("остаток = %s, want -3 (минус разрешён)", got)
	}

	// Выключаем флаг — выдача сверх остатка должна отбиваться.
	if err := gdb.Model(&models.Restaurant{}).Where("id = ?", f.rid).
		Update("supply_allow_negative", false).Error; err != nil {
		t.Fatal(err)
	}
	if code := issue("1"); code != http.StatusConflict {
		t.Errorf("выдача 1 при остатке -3 с запрещённым минусом: %d, want 409 "+
			"(флаг снова ничего не делает)", code)
	}
	if got := ingQty(t, gdb, soap.ID); !got.Equal(decimal.MustFromString("-3")) {
		t.Errorf("остаток изменился на отбитой выдаче: %s", got)
	}
}

// TestCreateReceipt_CreditRequiresSupplier — накладная в долг без поставщика
// создавала долг, который некому предъявить: current_debt начисляется только при
// известном supplier_id, поэтому долг был невидим для пассивов, а возврат по
// такой накладной попадал в тупик (гасить не на кого, деньгами нельзя).
func TestCreateReceipt_CreditRequiresSupplier(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, _, _ := seedForWrite(t, f)
	ing := seedReturnIngredient(t, gdb, f.rid, "Товар-без-поставщика", "kg")

	line := []map[string]any{{
		"ingredient_id": ing.ID, "name": "Товар-без-поставщика",
		"qty": "10", "unit": "kg", "price_per_unit": "5",
	}}

	// В долг без поставщика — отбой.
	r, b := f.post(t, "/api/v1/stock/receipts", tok, uuid.NewString(), map[string]any{
		"payment_type": "credit", "supplier_name": "Просто текст", "lines": line,
	})
	if r.StatusCode != http.StatusBadRequest {
		t.Errorf("кредитная накладная без supplier_id: %d %s, want 400", r.StatusCode, b)
	}

	// Оплаченная без поставщика — можно: долга нет, предъявлять нечего.
	if r, b := f.post(t, "/api/v1/stock/receipts", tok, uuid.NewString(), map[string]any{
		"payment_type": "paid", "supplier_name": "Просто текст", "lines": line,
	}); r.StatusCode != http.StatusCreated {
		t.Errorf("оплаченная накладная без поставщика: %d %s, want 201", r.StatusCode, b)
	}
}

// TestSupplierOpeningDebt_Edit — правка уже внесённого начального долга
// (владелец ошибся в цифре при переносе задолженности). Отдельный путь от
// PATCH /stock/receipts/{id}: у записи нет товарных строк, а общий редактор
// выводит сумму именно из них — он бы обнулил долг. Проверяем: сумма вверх и
// вниз двигают и debt_amount записи, и supplier.current_debt на чистую дельту;
// частично погашенный долг нельзя опустить ниже оплаченного; обычную накладную
// в этот эндпоинт не пускают, а начальный долг — в общий редактор накладных.
func TestSupplierOpeningDebt_Edit(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, _, accountID := seedForWrite(t, f)
	topUp(t, gdb, accountID)
	makeOwner(t, f.rid)

	supName := "Ромашка-правка-долга"
	sup := &models.Supplier{ID: uuid.NewString(), Name: &supName, CurrentDebt: decimal.Zero, RestaurantID: &f.rid}
	if err := gdb.Create(sup).Error; err != nil {
		t.Fatal(err)
	}

	r, b := f.post(t, "/api/v1/suppliers/"+sup.ID+"/opening-debt", tok, uuid.NewString(),
		map[string]any{"amount": "500", "note": "было"})
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("opening-debt: %d %s", r.StatusCode, b)
	}
	var debt models.StockReceipt
	_ = json.Unmarshal(b, &debt)

	// ── Сумма вверх: 500 → 800 ──────────────────────────────────────────────
	ur, ub := f.patch(t, "/api/v1/suppliers/"+sup.ID+"/opening-debt/"+debt.ID, tok, uuid.NewString(),
		map[string]any{"amount": "800", "note": "стало", "date": "2026-01-31"})
	if ur.StatusCode != http.StatusOK {
		t.Fatalf("edit up: %d %s", ur.StatusCode, ub)
	}
	var edited models.StockReceipt
	_ = json.Unmarshal(ub, &edited)
	if !edited.TotalAmount.Equal(decimal.MustFromString("800")) || !edited.DebtAmount.Equal(decimal.MustFromString("800")) {
		t.Errorf("после правки вверх total=%s debt=%s, want 800/800", edited.TotalAmount, edited.DebtAmount)
	}
	if got := supplierDebt(t, gdb, sup.ID); !got.Equal(decimal.MustFromString("800")) {
		t.Errorf("current_debt после правки вверх = %s, want 800", got)
	}
	var fresh models.StockReceipt
	gdb.Where("id = ?", debt.ID).First(&fresh)
	if derefStr(fresh.Note) != "стало" || derefStr(fresh.Date) != "2026-01-31" {
		t.Errorf("note/date не сохранились: %q / %q", derefStr(fresh.Note), derefStr(fresh.Date))
	}
	if !fresh.IsOpeningDebt {
		t.Errorf("is_opening_debt сброшен правкой")
	}

	// ── Сумма вниз: 800 → 300 ───────────────────────────────────────────────
	if r, b := f.patch(t, "/api/v1/suppliers/"+sup.ID+"/opening-debt/"+debt.ID, tok, uuid.NewString(),
		map[string]any{"amount": "300"}); r.StatusCode != http.StatusOK {
		t.Fatalf("edit down: %d %s", r.StatusCode, b)
	}
	if got := supplierDebt(t, gdb, sup.ID); !got.Equal(decimal.MustFromString("300")) {
		t.Errorf("current_debt после правки вниз = %s, want 300", got)
	}

	// ── Частичное гашение, затем попытка опустить сумму ниже погашенного ────
	// ВАЖНО: /pay-debt уменьшает только debt_amount и paid_amount не ведёт,
	// поэтому «уже погашено» = total − debt (здесь 300 − 100 = 200), а по
	// paid_amount было бы 0 и гвард не сработал бы.
	if r, b := f.post(t, "/api/v1/suppliers/"+sup.ID+"/pay-debt", tok, uuid.NewString(),
		map[string]any{"amount": "200", "account_id": accountID}); r.StatusCode != http.StatusOK {
		t.Fatalf("pay-debt: %d %s", r.StatusCode, b)
	}
	if got := receiptDebt(t, gdb, debt.ID); !got.Equal(decimal.MustFromString("100")) {
		t.Fatalf("debt_amount после гашения 200 из 300 = %s, want 100", got)
	}
	if r, b := f.patch(t, "/api/v1/suppliers/"+sup.ID+"/opening-debt/"+debt.ID, tok, uuid.NewString(),
		map[string]any{"amount": "150"}); r.StatusCode != http.StatusConflict {
		t.Errorf("сумма ниже погашенного: %d %s, want 409", r.StatusCode, b)
	}
	// Ровно на погашенную сумму — можно, остаток долга схлопывается в ноль.
	if r, b := f.patch(t, "/api/v1/suppliers/"+sup.ID+"/opening-debt/"+debt.ID, tok, uuid.NewString(),
		map[string]any{"amount": "200"}); r.StatusCode != http.StatusOK {
		t.Fatalf("сумма ровно по погашенному: %d %s, want 200", r.StatusCode, b)
	}
	if got := receiptDebt(t, gdb, debt.ID); !got.Equal(decimal.Zero) {
		t.Errorf("debt_amount = %s, want 0", got)
	}
	if got := supplierDebt(t, gdb, sup.ID); !got.Equal(decimal.Zero) {
		t.Errorf("current_debt = %s, want 0", got)
	}

	// ── Границы эндпоинтов ──────────────────────────────────────────────────
	// Начальный долг в общий редактор накладных не пускаем: он вывел бы
	// total из строк (их нет) и обнулил бы долг.
	if r, b := f.patch(t, "/api/v1/stock/receipts/"+debt.ID, tok, uuid.NewString(),
		map[string]any{"note": "через общий редактор"}); r.StatusCode != http.StatusBadRequest {
		t.Errorf("UpdateReceipt на начальном долге: %d %s, want 400", r.StatusCode, b)
	}
	// И наоборот — обычную накладную не правим как начальный долг.
	ingID := uuid.NewString()
	ingName, ingUnit := "Гречка", "kg"
	if err := gdb.Create(&models.Ingredient{ID: ingID, Name: &ingName, Unit: &ingUnit, RestaurantID: &f.rid}).Error; err != nil {
		t.Fatal(err)
	}
	cr, cb := f.post(t, "/api/v1/stock/receipts", tok, uuid.NewString(), map[string]any{
		"payment_type": "credit", "supplier_id": sup.ID,
		"lines": []map[string]any{{"ingredient_id": ingID, "name": ingName, "qty": "1", "price_per_unit": "10"}},
	})
	if cr.StatusCode != http.StatusCreated {
		t.Fatalf("create receipt: %d %s", cr.StatusCode, cb)
	}
	var normal models.StockReceipt
	_ = json.Unmarshal(cb, &normal)
	if r, b := f.patch(t, "/api/v1/suppliers/"+sup.ID+"/opening-debt/"+normal.ID, tok, uuid.NewString(),
		map[string]any{"amount": "999"}); r.StatusCode != http.StatusBadRequest {
		t.Errorf("обычная накладная как начальный долг: %d %s, want 400", r.StatusCode, b)
	}
}
