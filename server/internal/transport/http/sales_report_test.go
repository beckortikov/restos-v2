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

// Н21: серверный «Отчёт продаж» учитывает скидку заказа и исключает отменённые
// позиции (voids). Раньше страница считалась клиентски из последних 5000 заказов
// без скидок/voids — выручка завышалась.
func TestSalesReport_DiscountAndVoidsExcluded(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb := openTestDB(t)

	now := time.Date(2025, 6, 15, 12, 0, 0, 0, time.UTC)
	closed := "closed"
	ordID := uuid.NewString()
	// Валовый субтотал 100, скидка 20 → фактор после скидки 0.8.
	if err := gdb.Create(&models.Order{
		ID: ordID, Status: &closed, ClosedAt: &now, RestaurantID: &f.rid,
		Total: decimal.MustFromString("100"), DiscountAmount: decimal.MustFromString("20"),
		TotalWithService: decimal.MustFromString("80"),
	}).Error; err != nil {
		t.Fatal(err)
	}
	miID, mn := uuid.NewString(), "Плов"
	if err := gdb.Create(&models.MenuItem{ID: miID, Name: &mn, Price: decimal.MustFromString("100"), RestaurantID: &f.rid}).Error; err != nil {
		t.Fatal(err)
	}
	// Проданная позиция price 100 × qty 1.
	if err := gdb.Create(&models.OrderItem{
		ID: uuid.NewString(), OrderID: &ordID, MenuItemID: &miID, Name: &mn,
		Qty: decimal.MustFromString("1"), Price: decimal.MustFromString("100"),
	}).Error; err != nil {
		t.Fatal(err)
	}
	// Отменённая позиция (void) — не должна попасть в отчёт.
	cancelName := "Отменёнка"
	if err := gdb.Create(&models.OrderItem{
		ID: uuid.NewString(), OrderID: &ordID, Name: &cancelName,
		Qty: decimal.MustFromString("1"), Price: decimal.MustFromString("999"), CancelledAt: &now,
	}).Error; err != nil {
		t.Fatal(err)
	}

	resp, b := f.get(t, "/api/v1/analytics/sales-report?from=2025-06-01&to=2025-06-30", tok)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("sales-report: %d %s", resp.StatusCode, b)
	}
	var rep struct {
		Rows []struct {
			Name    string          `json:"name"`
			Revenue decimal.Decimal `json:"revenue"`
		} `json:"rows"`
		Totals struct {
			Revenue decimal.Decimal `json:"revenue"`
			Orders  int             `json:"orders"`
		} `json:"totals"`
	}
	if err := json.Unmarshal(b, &rep); err != nil {
		t.Fatal(err)
	}
	for _, r := range rep.Rows {
		if r.Name == "Отменёнка" {
			t.Errorf("отменённая позиция (void) попала в отчёт продаж")
		}
	}
	// Выручка = 100 × (100−20)/100 = 80 (скидка учтена).
	if !rep.Totals.Revenue.Equal(decimal.MustFromString("80")) {
		t.Errorf("выручка = %s, want 80 (скидка 20 учтена, void исключён)", rep.Totals.Revenue)
	}
	if rep.Totals.Orders != 1 {
		t.Errorf("заказов = %d, want 1", rep.Totals.Orders)
	}
}

// TestSalesReport_OrderTypeFilter — владелец 2026-08-29: «доставка — что было
// продано, детальный отчёт» → переключатель типов внутри «Отчёта продаж»
// (?order_type=hall|takeaway|delivery). Без параметра — поведение прежнее
// (все типы), см. TestSalesReport_DiscountAndVoidsExcluded выше.
func TestSalesReport_OrderTypeFilter(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb := openTestDB(t)

	now := time.Date(2025, 7, 10, 12, 0, 0, 0, time.UTC)
	closed, hall, delivery := "closed", "hall", "delivery"
	miID, mn := uuid.NewString(), "Плов"
	if err := gdb.Create(&models.MenuItem{ID: miID, Name: &mn, Price: decimal.MustFromString("50"), RestaurantID: &f.rid}).Error; err != nil {
		t.Fatal(err)
	}

	hallOrderID := uuid.NewString()
	if err := gdb.Create(&models.Order{
		ID: hallOrderID, Status: &closed, Type: &hall, ClosedAt: &now, RestaurantID: &f.rid,
		Total: decimal.MustFromString("50"), TotalWithService: decimal.MustFromString("50"),
	}).Error; err != nil {
		t.Fatal(err)
	}
	if err := gdb.Create(&models.OrderItem{
		ID: uuid.NewString(), OrderID: &hallOrderID, MenuItemID: &miID, Name: &mn,
		Qty: decimal.MustFromString("1"), Price: decimal.MustFromString("50"),
	}).Error; err != nil {
		t.Fatal(err)
	}

	deliveryOrderID := uuid.NewString()
	if err := gdb.Create(&models.Order{
		ID: deliveryOrderID, Status: &closed, Type: &delivery, ClosedAt: &now, RestaurantID: &f.rid,
		Total: decimal.MustFromString("70"), TotalWithService: decimal.MustFromString("70"),
	}).Error; err != nil {
		t.Fatal(err)
	}
	if err := gdb.Create(&models.OrderItem{
		ID: uuid.NewString(), OrderID: &deliveryOrderID, MenuItemID: &miID, Name: &mn,
		Qty: decimal.MustFromString("1"), Price: decimal.MustFromString("70"),
	}).Error; err != nil {
		t.Fatal(err)
	}

	type report struct {
		Totals struct {
			Revenue decimal.Decimal `json:"revenue"`
			Orders  int             `json:"orders"`
		} `json:"totals"`
	}

	// Без фильтра — оба заказа.
	resp, b := f.get(t, "/api/v1/analytics/sales-report?from=2025-07-01&to=2025-07-31", tok)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("sales-report: %d %s", resp.StatusCode, b)
	}
	var all report
	if err := json.Unmarshal(b, &all); err != nil {
		t.Fatal(err)
	}
	if all.Totals.Orders != 2 || !all.Totals.Revenue.Equal(decimal.MustFromString("120")) {
		t.Errorf("без фильтра: orders=%d revenue=%s, want 2/120", all.Totals.Orders, all.Totals.Revenue)
	}

	// order_type=delivery — только доставка.
	resp, b = f.get(t, "/api/v1/analytics/sales-report?from=2025-07-01&to=2025-07-31&order_type=delivery", tok)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("sales-report?order_type=delivery: %d %s", resp.StatusCode, b)
	}
	var deliv report
	if err := json.Unmarshal(b, &deliv); err != nil {
		t.Fatal(err)
	}
	if deliv.Totals.Orders != 1 || !deliv.Totals.Revenue.Equal(decimal.MustFromString("70")) {
		t.Errorf("order_type=delivery: orders=%d revenue=%s, want 1/70", deliv.Totals.Orders, deliv.Totals.Revenue)
	}

	// order_type=hall — только зал.
	resp, b = f.get(t, "/api/v1/analytics/sales-report?from=2025-07-01&to=2025-07-31&order_type=hall", tok)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("sales-report?order_type=hall: %d %s", resp.StatusCode, b)
	}
	var hallRep report
	if err := json.Unmarshal(b, &hallRep); err != nil {
		t.Fatal(err)
	}
	if hallRep.Totals.Orders != 1 || !hallRep.Totals.Revenue.Equal(decimal.MustFromString("50")) {
		t.Errorf("order_type=hall: orders=%d revenue=%s, want 1/50", hallRep.Totals.Orders, hallRep.Totals.Revenue)
	}
}
