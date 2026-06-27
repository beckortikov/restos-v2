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

// «Динамика»: эндпоинт собирает дневной ряд выручки/заказов/среднего чека и
// расходов, согласованный с ОПиУ (revenue/orders) и ДДС (expenses=out).
func TestTrends_DailySeries(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _ := db.Open(testDSN())
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})

	day := time.Date(2025, 6, 15, 12, 0, 0, 0, time.UTC) // полдень UTC — безопасно к tz
	closed := "closed"
	for _, total := range []string{"1000", "500"} { // выручка 1500, 2 чека → ср.чек 750
		if err := gdb.Create(&models.Order{
			ID: uuid.NewString(), Status: &closed, ClosedAt: &day,
			TotalWithService: decimal.MustFromString(total), RestaurantID: &f.rid,
		}).Error; err != nil {
			t.Fatal(err)
		}
	}
	out := "out"
	if err := gdb.Create(&models.FinancialOperation{
		ID: uuid.NewString(), Type: &out, Amount: decimal.MustFromString("300"),
		CreatedAt: day, RestaurantID: &f.rid,
	}).Error; err != nil {
		t.Fatal(err)
	}

	resp, b := f.get(t, "/api/v1/analytics/trends?from=2025-06-01&to=2025-06-30&granularity=day", tok)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("trends: %d %s", resp.StatusCode, b)
	}
	var rep struct {
		Buckets []struct {
			Date        string          `json:"date"`
			Revenue     decimal.Decimal `json:"revenue"`
			OrdersCount int             `json:"orders_count"`
			AvgCheck    decimal.Decimal `json:"avg_check"`
			Expenses    decimal.Decimal `json:"expenses"`
		} `json:"buckets"`
		Totals struct {
			Revenue     decimal.Decimal `json:"revenue"`
			OrdersCount int             `json:"orders_count"`
			AvgCheck    decimal.Decimal `json:"avg_check"`
			Expenses    decimal.Decimal `json:"expenses"`
		} `json:"totals"`
	}
	if err := json.Unmarshal(b, &rep); err != nil {
		t.Fatal(err)
	}

	// Дневной ряд должен покрывать весь период (зеро-филл) — 29 дней (01..29, to эксклюзивно).
	if len(rep.Buckets) < 20 {
		t.Fatalf("ожидали посуточный ряд с зеро-филлом, получили %d бакетов", len(rep.Buckets))
	}
	var got bool
	for _, bk := range rep.Buckets {
		if bk.Date != "2025-06-15" {
			continue
		}
		got = true
		if !bk.Revenue.Equal(decimal.MustFromString("1500")) {
			t.Errorf("revenue=%s, ожидали 1500", decimal.Normalize(bk.Revenue))
		}
		if bk.OrdersCount != 2 {
			t.Errorf("orders=%d, ожидали 2", bk.OrdersCount)
		}
		if !bk.AvgCheck.Equal(decimal.MustFromString("750")) {
			t.Errorf("avg_check=%s, ожидали 750", decimal.Normalize(bk.AvgCheck))
		}
		if !bk.Expenses.Equal(decimal.MustFromString("300")) {
			t.Errorf("expenses=%s, ожидали 300", decimal.Normalize(bk.Expenses))
		}
	}
	if !got {
		t.Fatal("бакет 2025-06-15 не найден в ряду")
	}
	if !rep.Totals.Revenue.Equal(decimal.MustFromString("1500")) || rep.Totals.OrdersCount != 2 ||
		!rep.Totals.AvgCheck.Equal(decimal.MustFromString("750")) || !rep.Totals.Expenses.Equal(decimal.MustFromString("300")) {
		t.Fatalf("totals неверны: %+v", rep.Totals)
	}
}
