//go:build integration

package http_test

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/db"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// Закупки склада (stock_purchase) НЕ должны попадать в расходы ОПиУ — иначе
// двойной счёт себестоимости (COGS + закупка). В ДДС закупка остаётся.
func TestPnL_ExcludesStockPurchaseFromOpex(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _ := db.Open(testDSN())
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})

	now := time.Now().UTC()
	today := now.Format("2006-01-02")
	mkOut := func(cat string, amt string) {
		outType, act := "out", "operational"
		c := cat
		if err := gdb.Create(&models.FinancialOperation{
			ID: uuid.NewString(), Type: &outType, Activity: &act, Category: &c,
			Amount: decimal.MustFromString(amt), Date: &today,
			RestaurantID: &f.rid, CreatedAt: now, UpdatedAt: now,
		}).Error; err != nil {
			t.Fatal(err)
		}
	}
	mkOut("stock_purchase", "100") // закупка — в ОПиУ не должна попасть
	mkOut("rent", "50")            // аренда — обычный OPEX

	resp, b := f.get(t, "/api/v1/finance/pnl?from="+today+"&to="+today, tok)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("pnl: %d %s", resp.StatusCode, b)
	}
	var out struct {
		Opex struct {
			Total      decimal.Decimal `json:"total"`
			ByCategory []struct {
				Category string `json:"category"`
			} `json:"by_category"`
		} `json:"opex"`
	}
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	if !out.Opex.Total.Equal(decimal.MustFromString("50")) {
		t.Fatalf("OPEX ОПиУ должен быть 50 (только аренда), получили %s — stock_purchase не исключён",
			decimal.Normalize(out.Opex.Total).String())
	}
	for _, c := range out.Opex.ByCategory {
		if c.Category == "stock_purchase" {
			t.Fatalf("stock_purchase не должен быть в расходах ОПиУ: %+v", out.Opex.ByCategory)
		}
	}
}
