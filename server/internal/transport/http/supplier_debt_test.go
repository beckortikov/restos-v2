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
