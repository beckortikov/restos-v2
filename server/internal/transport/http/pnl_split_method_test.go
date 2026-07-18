//go:build integration

package http_test

import (
	"encoding/json"
	"net/http"
	"net/url"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// Владелец: «нет такого счёта — split». Заказ, оплаченный разделением счёта,
// имеет orders.payment_method='split' (это РЕЖИМ, не счёт). Реальные деньги
// ушли в наличные/карту через order_splits. PnL.by_method обязан раскладывать
// split на фактические методы, а не показывать псевдо-счёт «split».
func TestPnL_SplitPayment_DecomposedByRealMethod(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb := openTestDB(t)

	now := time.Now().UTC()
	closed, split := "closed", "split"
	cash, card := "cash", "card"

	// Split-заказ на 100 = наличные 60 + карта 40.
	oid := uuid.NewString()
	if err := gdb.Create(&models.Order{
		ID: oid, OrderNumber: 9001, Status: &closed, PaymentMethod: &split,
		TotalWithService: decimal.MustFromString("100"), ClosedAt: &now, RestaurantID: &f.rid,
	}).Error; err != nil {
		t.Fatal(err)
	}
	mkSplit := func(method string, total string) {
		m := method
		if err := gdb.Create(&models.OrderSplit{
			ID: uuid.NewString(), OrderID: &oid, PaymentMethod: &m,
			Total: decimal.MustFromString(total), RestaurantID: &f.rid,
		}).Error; err != nil {
			t.Fatal(err)
		}
	}
	mkSplit(cash, "60")
	mkSplit(card, "40")

	q := url.Values{}
	q.Set("from", now.Add(-1*time.Hour).Format(time.RFC3339))
	q.Set("to", now.Add(1*time.Hour).Format(time.RFC3339))
	r, b := f.get(t, "/api/v1/finance/pnl?"+q.Encode(), tok)
	if r.StatusCode != http.StatusOK {
		t.Fatalf("pnl: %d %s", r.StatusCode, b)
	}
	var pnl struct {
		Revenue struct {
			Total    decimal.Decimal `json:"total"`
			ByMethod []struct {
				Method string          `json:"method"`
				Amount decimal.Decimal `json:"amount"`
			} `json:"by_method"`
		} `json:"revenue"`
	}
	if err := json.Unmarshal(b, &pnl); err != nil {
		t.Fatalf("decode: %v\n%s", err, b)
	}

	byMethod := map[string]decimal.Decimal{}
	for _, m := range pnl.Revenue.ByMethod {
		byMethod[m.Method] = m.Amount
		if m.Method == "split" {
			t.Errorf("псевдо-счёт «split» не должен фигурировать в by_method (разложи на реальные методы)")
		}
	}
	if got := byMethod["cash"]; !got.Equal(decimal.MustFromString("60")) {
		t.Errorf("наличные = %s, want 60 (из сплита)", got)
	}
	if got := byMethod["card"]; !got.Equal(decimal.MustFromString("40")) {
		t.Errorf("карта = %s, want 40 (из сплита)", got)
	}
	// Σ методов === выручка (пропорция не теряет и не задваивает деньги).
	if !pnl.Revenue.Total.Equal(decimal.MustFromString("100")) {
		t.Errorf("revenue.total = %s, want 100", pnl.Revenue.Total)
	}
}
