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

// TestPayReceipt — адресная оплата долга по конкретной накладной.
//
// Проверяет полный цикл: частичная оплата → долг/оплачено/payment_type
// пересчитаны и на накладной, и у поставщика, деньги списаны, финоп создан;
// оплата с переплатой клампится к остатку долга; оплата без долга → 409.
// Инвариант Σ receipt.debt_amount = supplier.current_debt держится под
// RecomputeDebts.
func TestPayReceipt(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, _, accountID := seedForWrite(t, f)
	topUp(t, gdb, accountID) // баланс счёта = 10000

	supName := "Лютик"
	sup := &models.Supplier{
		ID: uuid.NewString(), Name: &supName,
		CurrentDebt: decimal.Zero, RestaurantID: &f.rid,
	}
	if err := gdb.Create(sup).Error; err != nil {
		t.Fatal(err)
	}
	flour := seedReturnIngredient(t, gdb, f.rid, "Мука", "kg")

	// Приёмка в долг: 20 кг × 8 = 160.
	r, b := f.post(t, "/api/v1/stock/receipts", tok, uuid.NewString(), map[string]any{
		"payment_type":  "credit",
		"supplier_id":   sup.ID,
		"supplier_name": supName,
		"lines": []map[string]any{{
			"ingredient_id": flour.ID, "name": "Мука",
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

	// Долг начислен на 160 обеим сторонам.
	var afterSup models.Supplier
	gdb.First(&afterSup, "id = ?", sup.ID)
	if !afterSup.CurrentDebt.Equal(decimal.MustFromString("160")) {
		t.Fatalf("current_debt после приёмки = %s, want 160", afterSup.CurrentDebt)
	}

	// ─── Частичная оплата 100 ───────────────────────────────────────────────
	r, b = f.post(t, "/api/v1/stock/receipts/"+receipt.ID+"/pay", tok, uuid.NewString(), map[string]any{
		"amount": "100", "account_id": accountID,
	})
	if r.StatusCode != http.StatusOK {
		t.Fatalf("pay 100: %d %s", r.StatusCode, b)
	}

	var afterReceipt models.StockReceipt
	gdb.First(&afterReceipt, "id = ?", receipt.ID)
	if !afterReceipt.DebtAmount.Equal(decimal.MustFromString("60")) {
		t.Errorf("debt_amount после оплаты 100 = %s, want 60", afterReceipt.DebtAmount)
	}
	if !afterReceipt.PaidAmount.Equal(decimal.MustFromString("100")) {
		t.Errorf("paid_amount = %s, want 100", afterReceipt.PaidAmount)
	}
	if afterReceipt.PaymentType == nil || *afterReceipt.PaymentType != "partial" {
		t.Errorf("payment_type = %v, want partial", afterReceipt.PaymentType)
	}
	gdb.First(&afterSup, "id = ?", sup.ID)
	if !afterSup.CurrentDebt.Equal(decimal.MustFromString("60")) {
		t.Errorf("current_debt после оплаты 100 = %s, want 60", afterSup.CurrentDebt)
	}

	// Деньги списаны со счёта: 10000 − 100 = 9900.
	var acc models.FinancialAccount
	gdb.First(&acc, "id = ?", accountID)
	if !acc.Balance.Equal(decimal.MustFromString("9900")) {
		t.Errorf("баланс счёта = %s, want 9900", acc.Balance)
	}

	// Финоп: out / supplier_payment / 100.
	var fo models.FinancialOperation
	if err := gdb.Where("restaurant_id = ? AND category = ? AND amount = ?",
		f.rid, "supplier_payment", decimal.MustFromString("100")).First(&fo).Error; err != nil {
		t.Fatalf("финоп оплаты не создан: %v", err)
	}
	if fo.Type == nil || *fo.Type != "out" {
		t.Errorf("финоп type = %v, want out", fo.Type)
	}

	// ─── Переплата: платим 500, остаток долга 60 → клампится к 60 ────────────
	r, b = f.post(t, "/api/v1/stock/receipts/"+receipt.ID+"/pay", tok, uuid.NewString(), map[string]any{
		"amount": "500", "account_id": accountID,
	})
	if r.StatusCode != http.StatusOK {
		t.Fatalf("pay 500 (клампится): %d %s", r.StatusCode, b)
	}
	gdb.First(&afterReceipt, "id = ?", receipt.ID)
	if !afterReceipt.DebtAmount.Equal(decimal.Zero) {
		t.Errorf("debt_amount после доплаты = %s, want 0", afterReceipt.DebtAmount)
	}
	if !afterReceipt.PaidAmount.Equal(decimal.MustFromString("160")) {
		t.Errorf("paid_amount = %s, want 160 (не переплатили)", afterReceipt.PaidAmount)
	}
	if afterReceipt.PaymentType == nil || *afterReceipt.PaymentType != "paid" {
		t.Errorf("payment_type = %v, want paid", afterReceipt.PaymentType)
	}
	gdb.First(&afterSup, "id = ?", sup.ID)
	if !afterSup.CurrentDebt.Equal(decimal.Zero) {
		t.Errorf("current_debt после доплаты = %s, want 0", afterSup.CurrentDebt)
	}
	// Списано ровно 60, а не 500: 9900 − 60 = 9840.
	gdb.First(&acc, "id = ?", accountID)
	if !acc.Balance.Equal(decimal.MustFromString("9840")) {
		t.Errorf("баланс счёта = %s, want 9840 (переплата не ушла)", acc.Balance)
	}

	// ─── Оплата накладной без долга → 409 ───────────────────────────────────
	r, b = f.post(t, "/api/v1/stock/receipts/"+receipt.ID+"/pay", tok, uuid.NewString(), map[string]any{
		"amount": "10", "account_id": accountID,
	})
	if r.StatusCode != http.StatusConflict {
		t.Fatalf("оплата без долга: %d %s, want 409", r.StatusCode, b)
	}

	// ─── Инвариант: RecomputeDebts не воскрешает погашенный долг ─────────────
	r, b = f.post(t, "/api/v1/suppliers/recompute-debts", tok, uuid.NewString(), map[string]any{})
	if r.StatusCode != http.StatusOK {
		t.Fatalf("recompute-debts: %d %s", r.StatusCode, b)
	}
	gdb.First(&afterSup, "id = ?", sup.ID)
	if !afterSup.CurrentDebt.Equal(decimal.Zero) {
		t.Errorf("current_debt после RecomputeDebts = %s, want 0 (долг воскрес)", afterSup.CurrentDebt)
	}
}
