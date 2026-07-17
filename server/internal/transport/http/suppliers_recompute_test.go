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

// POST /suppliers/recompute-debts чинит денормализованный current_debt, приводя
// его к первоисточнику: Σ(stock_receipts.debt_amount данного поставщика).
// Нужен, когда поле разошлось с реальностью (восстановление из бэкапа, дрейф).
//
// v3.16.89: из формулы убрано вычитание оплат (supplier_payment по counterparty).
// Раньше debt_amount был НАЧИСЛЕННЫМ долгом, оплаты вычитались отдельно, и это
// давало три беды: экраны, читавшие debt_amount как остаток, врали; сверка шла по
// ИМЕНИ поставщика (переименование воскрешало весь долг); долг по конкретной
// накладной был неизвестен в принципе. Теперь PayDebt раскладывает оплату по
// накладным (allocateDebtPayment), debt_amount = остаток, и пересчёт — просто
// сумма. Вычитать оплаты второй раз нельзя: они уже учтены в debt_amount.
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

	// current_debt заведомо неверен (999) — его и должен починить пересчёт.
	if err := nohook.Create(&models.Supplier{
		ID: supID, Name: &supName, CurrentDebt: decimal.MustFromString("999"), RestaurantID: &f.rid,
	}).Error; err != nil {
		t.Fatal(err)
	}
	// Две накладные с остатками долга 300 и 200 → истина 500.
	for _, debt := range []string{"300", "200"} {
		if err := nohook.Create(&models.StockReceipt{
			ID: uuid.NewString(), SupplierID: &supID, SupplierName: &supName,
			TotalAmount: decimal.MustFromString("500"), PaidAmount: decimal.MustFromString("200"),
			DebtAmount: decimal.MustFromString(debt), PaymentType: &credit, RestaurantID: &f.rid,
		}).Error; err != nil {
			t.Fatal(err)
		}
	}
	// Оплата долга уже учтена в debt_amount выше. Пересчёт обязан её ПРОИГНОРИРОВАТЬ:
	// вычтет второй раз — долг занизится до 300 и поставщику недоплатят.
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
	if !sup.CurrentDebt.Equal(decimal.MustFromString("500")) {
		t.Errorf("current_debt после пересчёта = %s, want 500 (Σ остатков накладных 300+200). "+
			"Если 300 — оплата вычтена повторно, хотя уже учтена в debt_amount", sup.CurrentDebt.String())
	}
}
