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

// GET /stock/receipts?include=lines должен отдавать returned_total — сумму
// НЕотменённых возвратов поставщику по накладной. UI по нему показывает статус
// «Возвращено»/«Возврат части» вместо статуса оплаты. Отменённый возврат в
// сумму не входит.
func TestListReceipts_ReturnedTotal(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, _, _ := seedForWrite(t, f)

	supName := "Возвраты-накл"
	sup := &models.Supplier{ID: uuid.NewString(), Name: &supName, CurrentDebt: decimal.Zero, RestaurantID: &f.rid}
	if err := gdb.Create(sup).Error; err != nil {
		t.Fatal(err)
	}
	ing := seedReturnIngredient(t, gdb, f.rid, "Огурцы-ret", "kg")

	// Приёмка в долг: 20 × 8 = 160.
	r, b := f.post(t, "/api/v1/stock/receipts", tok, uuid.NewString(), map[string]any{
		"payment_type": "credit", "supplier_id": sup.ID, "supplier_name": supName,
		"lines": []map[string]any{{
			"ingredient_id": ing.ID, "name": "Огурцы-ret",
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

	// Частичный возврат 3 × 8 = 24.
	if rr, rb := f.post(t, "/api/v1/stock/returns", tok, uuid.NewString(), map[string]any{
		"receipt_id": receipt.ID, "reason": "breakage", "refund_type": "debt",
		"lines": []map[string]any{{
			"receipt_line_id": receiptLineID(t, gdb, receipt.ID, ing.ID), "qty": "3",
		}},
	}); rr.StatusCode != http.StatusCreated {
		t.Fatalf("return: %d %s", rr.StatusCode, rb)
	}

	// Отменённый возврат в returned_total попадать не должен: заводим и отменяем.
	rr, rb := f.post(t, "/api/v1/stock/returns", tok, uuid.NewString(), map[string]any{
		"receipt_id": receipt.ID, "reason": "breakage", "refund_type": "debt",
		"lines": []map[string]any{{
			"receipt_line_id": receiptLineID(t, gdb, receipt.ID, ing.ID), "qty": "2",
		}},
	})
	if rr.StatusCode != http.StatusCreated {
		t.Fatalf("return2: %d %s", rr.StatusCode, rb)
	}
	var ret2 models.StockReturn
	if err := json.Unmarshal(rb, &ret2); err != nil {
		t.Fatal(err)
	}
	if cr, cb := f.post(t, "/api/v1/stock/returns/"+ret2.ID+"/cancel", tok, uuid.NewString(), map[string]any{}); cr.StatusCode != http.StatusOK {
		t.Fatalf("cancel return: %d %s", cr.StatusCode, cb)
	}

	// GET списка накладных → returned_total = 24 (только неотменённый возврат).
	resp, lb := f.get(t, "/api/v1/stock/receipts?include=lines", tok)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("list receipts: %d %s", resp.StatusCode, lb)
	}
	var env struct {
		Data []struct {
			ID            string          `json:"id"`
			ReturnedTotal decimal.Decimal `json:"returned_total"`
		} `json:"data"`
	}
	if err := json.Unmarshal(lb, &env); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, rc := range env.Data {
		if rc.ID == receipt.ID {
			found = true
			if !rc.ReturnedTotal.Equal(decimal.MustFromString("24")) {
				t.Errorf("returned_total = %s, want 24 (отменённый возврат не должен учитываться)",
					decimal.Normalize(rc.ReturnedTotal).String())
			}
		}
	}
	if !found {
		t.Fatalf("накладная %s не найдена в списке", receipt.ID)
	}
}
