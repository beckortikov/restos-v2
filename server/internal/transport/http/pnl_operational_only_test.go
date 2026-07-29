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

// operational_only=true → в opex ОПиУ учитываются только операционные расходы.
// Капвложения (activity='investment' — оборудование) и финансовая активность
// исключаются, чтобы разовая крупная покупка не проваливала операционную
// прибыль месяца. Без флага (по умолчанию) — считаются все, как раньше.
func TestPnL_OperationalOnlyExcludesInvestment(t *testing.T) {
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
	mkOut := func(cat, activity, amt string) {
		outType := "out"
		c, act := cat, activity
		if err := gdb.Create(&models.FinancialOperation{
			ID: uuid.NewString(), Type: &outType, Activity: &act, Category: &c,
			Amount: decimal.MustFromString(amt), Date: &today,
			RestaurantID: &f.rid, CreatedAt: now, UpdatedAt: now,
		}).Error; err != nil {
			t.Fatal(err)
		}
	}
	mkOut("rent", "operational", "50")       // операционный расход
	mkOut("equipment", "investment", "1000") // капвложение — крупная разовая покупка

	opexTotal := func(url string) decimal.Decimal {
		resp, b := f.get(t, url, tok)
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("pnl: %d %s", resp.StatusCode, b)
		}
		var out struct {
			Opex struct {
				Total decimal.Decimal `json:"total"`
			} `json:"opex"`
		}
		if err := json.Unmarshal(b, &out); err != nil {
			t.Fatal(err)
		}
		return out.Opex.Total
	}

	// Без флага — обе статьи в opex (50 + 1000 = 1050).
	full := opexTotal("/api/v1/finance/pnl?from=" + today + "&to=" + today)
	if !full.Equal(decimal.MustFromString("1050")) {
		t.Fatalf("без operational_only opex должен быть 1050 (аренда+оборудование), получили %s",
			decimal.Normalize(full).String())
	}

	// С флагом — только операционная аренда (50), капвложение исключено.
	oper := opexTotal("/api/v1/finance/pnl?from=" + today + "&to=" + today + "&operational_only=true")
	if !oper.Equal(decimal.MustFromString("50")) {
		t.Fatalf("с operational_only=true opex должен быть 50 (только аренда), получили %s — капвложение не исключено",
			decimal.Normalize(oper).String())
	}
}
