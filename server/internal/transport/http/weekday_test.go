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

// Аналитика по дням недели (A1–A3): прибыль по дням (выручка−cogs−ФОТ),
// heatmap день×час по прибыли, день×категория.
func TestWeekday_OwnerAnalytics(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _ := db.Open(testDSN())
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})

	// Ставка сотрудника фикстуры → 100/час.
	if err := gdb.Model(&models.User{}).Where("restaurant_id = ?", f.rid).
		Update("hourly_rate", decimal.MustFromString("100")).Error; err != nil {
		t.Fatal(err)
	}
	var u models.User
	if err := gdb.Where("restaurant_id = ?", f.rid).First(&u).Error; err != nil {
		t.Fatal(err)
	}

	mon := time.Date(2025, 6, 16, 14, 0, 0, 0, time.UTC) // понедельник → DOW=1
	closed := "closed"
	oID := uuid.NewString()
	if err := gdb.Create(&models.Order{
		ID: oID, Status: &closed, ClosedAt: &mon, RestaurantID: &f.rid,
		TotalWithService: decimal.MustFromString("200"),
	}).Error; err != nil {
		t.Fatal(err)
	}
	cat, dish := "Горячее", "Плов"
	miID := uuid.NewString()
	if err := gdb.Create(&models.MenuItem{ID: miID, Name: &dish, Category: &cat, Price: decimal.MustFromString("200"), RestaurantID: &f.rid}).Error; err != nil {
		t.Fatal(err)
	}
	if err := gdb.Create(&models.OrderItem{
		ID: uuid.NewString(), OrderID: &oID, MenuItemID: &miID, Name: &dish,
		Qty: decimal.MustFromString("1"), Price: decimal.MustFromString("200"), COGS: decimal.MustFromString("50"),
	}).Error; err != nil {
		t.Fatal(err)
	}
	clockIn := time.Date(2025, 6, 16, 10, 0, 0, 0, time.UTC)
	if err := gdb.Create(&models.TimeEntry{
		ID: uuid.NewString(), UserID: &u.ID, ClockIn: &clockIn,
		TotalHours: decimal.MustFromString("1"), RestaurantID: &f.rid,
	}).Error; err != nil {
		t.Fatal(err)
	}

	resp, b := f.get(t, "/api/v1/analytics/weekday?from=2025-06-01&to=2025-06-30", tok)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("weekday: %d %s", resp.StatusCode, b)
	}
	var rep struct {
		ByWeekday []struct {
			Weekday     int             `json:"weekday"`
			Orders      int             `json:"orders"`
			Revenue     decimal.Decimal `json:"revenue"`
			COGS        decimal.Decimal `json:"cogs"`
			Labor       decimal.Decimal `json:"labor"`
			GrossProfit decimal.Decimal `json:"gross_profit"`
			NetProfit   decimal.Decimal `json:"net_profit"`
		} `json:"by_weekday"`
		Heatmap []struct {
			Weekday int             `json:"weekday"`
			Hour    int             `json:"hour"`
			Profit  decimal.Decimal `json:"profit"`
		} `json:"heatmap"`
		ByCategory []struct {
			Weekday  int             `json:"weekday"`
			Category string          `json:"category"`
			Profit   decimal.Decimal `json:"profit"`
		} `json:"by_category"`
	}
	if err := json.Unmarshal(b, &rep); err != nil {
		t.Fatal(err)
	}
	if len(rep.ByWeekday) != 7 {
		t.Fatalf("ожидали 7 строк по дням недели, получили %d", len(rep.ByWeekday))
	}
	var monRow *struct {
		Weekday     int
		Orders      int
		Revenue     decimal.Decimal
		COGS        decimal.Decimal
		Labor       decimal.Decimal
		GrossProfit decimal.Decimal
		NetProfit   decimal.Decimal
	}
	for _, r := range rep.ByWeekday {
		if r.Weekday == 1 {
			monRow = &struct {
				Weekday     int
				Orders      int
				Revenue     decimal.Decimal
				COGS        decimal.Decimal
				Labor       decimal.Decimal
				GrossProfit decimal.Decimal
				NetProfit   decimal.Decimal
			}{r.Weekday, r.Orders, r.Revenue, r.COGS, r.Labor, r.GrossProfit, r.NetProfit}
		}
	}
	if monRow == nil {
		t.Fatal("нет строки понедельника (weekday=1)")
	}
	eq := func(got decimal.Decimal, want string) bool { return got.Equal(decimal.MustFromString(want)) }
	if monRow.Orders != 1 || !eq(monRow.Revenue, "200") || !eq(monRow.COGS, "50") ||
		!eq(monRow.Labor, "100") || !eq(monRow.GrossProfit, "150") || !eq(monRow.NetProfit, "50") {
		t.Fatalf("понедельник неверен: %+v (ожидали orders 1, rev 200, cogs 50, labor 100, gross 150, net 50)", *monRow)
	}

	// Час берётся в локальной TZ сессии БД, поэтому конкретный час не фиксируем —
	// проверяем, что в понедельник есть ячейка с прибылью 150.
	var hcell bool
	for _, c := range rep.Heatmap {
		if c.Weekday == 1 && c.Profit.Equal(decimal.MustFromString("150")) {
			hcell = true
		}
	}
	if !hcell {
		t.Fatalf("ожидали ячейку heatmap пн с прибылью 150, получили %+v", rep.Heatmap)
	}
	var catOK bool
	for _, c := range rep.ByCategory {
		if c.Weekday == 1 && c.Category == "Горячее" && c.Profit.Equal(decimal.MustFromString("150")) {
			catOK = true
		}
	}
	if !catOK {
		t.Fatalf("ожидали по категории пн «Горячее» прибыль 150, получили %+v", rep.ByCategory)
	}
}
