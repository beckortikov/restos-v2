//go:build integration

package http_test

import (
	"testing"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/db"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// POST /suppliers/recompute-debts пересчитывает current_debt из первоисточника:
// Σ(stock_receipts.debt_amount) − Σ(оплат долга supplier_payment). Нужен, когда
// денормализованное поле разошлось (бэкфилл-миграция не отработала после
// восстановления/обновления).
func TestSuppliersRecomputeDebts(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, err := db.Open(testDSN())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if s, e := gdb.DB(); e == nil {
			_ = s.Close()
		}
	})
	nohook := gdb.Session(&gorm.Session{SkipHooks: true})

	supID := uuid.NewString()
	supName := "RecomputeSup-" + supID[:8]
	credit := "credit"
	outT, cat := "out", "supplier_payment"

	if err := nohook.Create(&models.Supplier{
		ID: supID, Name: &supName, CurrentDebt: decimal.Zero, RestaurantID: &f.rid,
	}).Error; err != nil {
		t.Fatal(err)
	}
	// Накладная в кредит на 500 (долг 500).
	if err := nohook.Create(&models.StockReceipt{
		ID: uuid.NewString(), SupplierID: &supID, SupplierName: &supName,
		TotalAmount: decimal.MustFromString("500"), PaidAmount: decimal.Zero,
		DebtAmount: decimal.MustFromString("500"), PaymentType: &credit, RestaurantID: &f.rid,
	}).Error; err != nil {
		t.Fatal(err)
	}
	// Частичная оплата долга 200 → долг должен стать 300.
	if err := nohook.Create(&models.FinancialOperation{
		ID: uuid.NewString(), Type: &outT, Category: &cat, Counterparty: &supName,
		Amount: decimal.MustFromString("200"), RestaurantID: &f.rid,
	}).Error; err != nil {
		t.Fatal(err)
	}

	resp, body := f.post(t, "/api/v1/suppliers/recompute-debts", tok, uuid.NewString(), map[string]any{})
	if resp.StatusCode != 200 {
		t.Fatalf("recompute %d: %s", resp.StatusCode, body)
	}

	var sup models.Supplier
	if err := gdb.Where("id = ?", supID).First(&sup).Error; err != nil {
		t.Fatal(err)
	}
	if !sup.CurrentDebt.Equal(decimal.MustFromString("300")) {
		t.Errorf("current_debt после пересчёта = %s, want 300 (500 долг − 200 оплата)", sup.CurrentDebt.String())
	}
}
