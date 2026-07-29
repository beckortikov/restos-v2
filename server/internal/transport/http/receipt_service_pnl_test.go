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

// Н14: свободная строка накладной («услуга/доставка без учёта на складе») должна
// книжиться как операционный расход (виден в ОПиУ), а не stock_purchase (который
// ОПиУ исключает как движение запасов). Иначе доставка/услуги «исчезают» из
// прибыли: не COGS и не opex. Товарная часть остаётся stock_purchase.
func TestReceiptServiceLine_BooksAsOpex(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, _, accID := seedForWrite(t, f)

	var ing models.Ingredient
	if err := gdb.Where("restaurant_id = ?", f.rid).First(&ing).Error; err != nil {
		t.Fatal(err)
	}
	// Гарантируем средства на счёте под списание 50.
	gdb.Model(&models.FinancialAccount{}).Where("id = ?", accID).
		Update("balance", decimal.MustFromString("1000"))
	var acc0 models.FinancialAccount
	gdb.Where("id = ?", accID).First(&acc0)

	// Накладная: товар (Rice 2×10=20) + услуга (доставка 1×30=30). Итого 50, оплачено.
	r, b := f.post(t, "/api/v1/stock/receipts", tok, uuid.NewString(), map[string]any{
		"payment_type": "paid",
		"account_id":   accID,
		"lines": []map[string]any{
			{"ingredient_id": ing.ID, "name": "Rice", "qty": "2", "unit": "kg", "price_per_unit": "10"},
			{"ingredient_id": "", "name": "Доставка", "qty": "1", "unit": "", "price_per_unit": "30"},
		},
	})
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("receipt: %d %s", r.StatusCode, b)
	}
	var rc models.StockReceipt
	_ = json.Unmarshal(b, &rc)

	// Счёт списан на весь total 50 (20 товар + 30 услуга).
	var acc1 models.FinancialAccount
	gdb.Where("id = ?", accID).First(&acc1)
	if diff := decimal.Normalize(decimal.Sub(acc0.Balance, acc1.Balance)); !diff.Equal(decimal.MustFromString("50")) {
		t.Fatalf("счёт списан на %s, want 50", diff)
	}

	// Два финопа: stock_purchase = 20 (товар), «Услуги/доставка» = 30 (услуга).
	var stockOp models.FinancialOperation
	if err := gdb.Where("restaurant_id = ? AND source_ref = ?", f.rid, "receipt:"+rc.ID).First(&stockOp).Error; err != nil {
		t.Fatalf("stock_purchase финоп не создан: %v", err)
	}
	if !stockOp.Amount.Equal(decimal.MustFromString("20")) {
		t.Errorf("stock_purchase amount = %s, want 20 (только товар)", stockOp.Amount)
	}
	var svcOp models.FinancialOperation
	if err := gdb.Where("restaurant_id = ? AND source_ref = ?", f.rid, "receipt_service:"+rc.ID).First(&svcOp).Error; err != nil {
		t.Fatalf("расход услуги не создан: %v", err)
	}
	if !svcOp.Amount.Equal(decimal.MustFromString("30")) || svcOp.Category == nil || *svcOp.Category != "Услуги/доставка" {
		t.Errorf("услуга: amount=%s cat=%v, want 30 / «Услуги/доставка»", svcOp.Amount, svcOp.Category)
	}

	// ОПиУ: услуга видна в opex категорией «Услуги/доставка», stock_purchase — нет.
	today := time.Now().UTC().Format("2006-01-02")
	rp, bp := f.get(t, "/api/v1/finance/pnl?from="+today+"&to="+today, tok)
	if rp.StatusCode != http.StatusOK {
		t.Fatalf("pnl: %d %s", rp.StatusCode, bp)
	}
	var pnl struct {
		Opex struct {
			ByCategory []struct {
				Category string          `json:"category"`
				Amount   decimal.Decimal `json:"amount"`
			} `json:"by_category"`
		} `json:"opex"`
	}
	if err := json.Unmarshal(bp, &pnl); err != nil {
		t.Fatal(err)
	}
	foundSvc := false
	for _, c := range pnl.Opex.ByCategory {
		if c.Category == "Услуги/доставка" && c.Amount.Equal(decimal.MustFromString("30")) {
			foundSvc = true
		}
		if c.Category == "stock_purchase" {
			t.Errorf("stock_purchase не должен быть в opex ОПиУ")
		}
	}
	if !foundSvc {
		t.Fatalf("услуга/доставка не найдена в opex ОПиУ: %+v", pnl.Opex.ByCategory)
	}
}
