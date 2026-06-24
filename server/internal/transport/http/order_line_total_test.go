//go:build integration

package http_test

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// Бэк — источник правды по сумме позиции: GET /orders/{id} должен отдавать
// line_total = price × (qty/unitSize) для веса, чтобы клиент не считал сам.
func TestOrderItem_LineTotal_WeightAware(t *testing.T) {
	f := setupE2E(t)
	gdb, _, shiftID, _ := seedForWrite(t, f)
	tok := f.login(t)

	now := time.Now().UTC()
	st, hall, g := "new", "hall", "g"
	orderID := uuid.NewString()
	if err := gdb.Create(&models.Order{
		ID: orderID, RestaurantID: &f.rid, Status: &st, Type: &hall, ShiftID: &shiftID,
		Total: decimal.MustFromString("35"), CreatedAt: now, UpdatedAt: now,
	}).Error; err != nil {
		t.Fatal(err)
	}
	dish := "Жиз Кавурдок 100г"
	// 100 г при цене 350/кг (unitSize=1000) → 350 × 0.1 = 35.
	if err := gdb.Create(&models.OrderItem{
		ID: uuid.NewString(), OrderID: &orderID, Name: &dish,
		Qty: decimal.MustFromString("100"), Price: decimal.MustFromString("350"),
		Unit: &g, UnitSize: decimal.MustFromString("1000"), CreatedAt: now, UpdatedAt: now,
	}).Error; err != nil {
		t.Fatal(err)
	}

	r, b := f.get(t, "/api/v1/orders/"+orderID, tok)
	if r.StatusCode != 200 {
		t.Fatalf("get order %d: %s", r.StatusCode, b)
	}
	var resp struct {
		Items []struct {
			LineTotal string `json:"line_total"`
			Qty       string `json:"qty"`
			Price     string `json:"price"`
		} `json:"items"`
	}
	if err := json.Unmarshal(b, &resp); err != nil {
		t.Fatalf("unmarshal: %v (%s)", err, b)
	}
	if len(resp.Items) != 1 {
		t.Fatalf("ожидали 1 позицию, получили %d", len(resp.Items))
	}
	if resp.Items[0].LineTotal != "35" {
		t.Errorf("line_total = %q, ожидали 35 (350 × 100/1000), а не qty×price=35000", resp.Items[0].LineTotal)
	}
}

// Разные граммовые/кг конфигурации — бэк всегда считает price × (qty/unitSize).
func TestOrderItem_LineTotal_WeightCases(t *testing.T) {
	cases := []struct {
		name     string
		unit     string
		qty      string
		price    string
		unitSize string
		want     string
	}{
		{"100г при 350/кг", "g", "100", "350", "1000", "35"},
		{"250г при 350/кг", "g", "250", "350", "1000", "87.5"},
		{"100г при 35/100г", "g", "100", "35", "100", "35"},
		{"500г при 200/кг", "g", "500", "200", "1000", "100"},
		{"0.5кг при 350/кг", "kg", "0.5", "350", "1", "175"},
		{"1.5кг при 200/кг", "kg", "1.5", "200", "1", "300"},
		{"штучное 3×25", "piece", "3", "25", "1", "75"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := setupE2E(t)
			gdb, _, shiftID, _ := seedForWrite(t, f)
			tok := f.login(t)
			now := time.Now().UTC()
			st, hall := "new", "hall"
			unit := c.unit
			orderID := uuid.NewString()
			if err := gdb.Create(&models.Order{ID: orderID, RestaurantID: &f.rid, Status: &st, Type: &hall, ShiftID: &shiftID, CreatedAt: now, UpdatedAt: now}).Error; err != nil {
				t.Fatal(err)
			}
			dish := "Блюдо"
			if err := gdb.Create(&models.OrderItem{
				ID: uuid.NewString(), OrderID: &orderID, Name: &dish,
				Qty: decimal.MustFromString(c.qty), Price: decimal.MustFromString(c.price),
				Unit: &unit, UnitSize: decimal.MustFromString(c.unitSize), CreatedAt: now, UpdatedAt: now,
			}).Error; err != nil {
				t.Fatal(err)
			}
			r, b := f.get(t, "/api/v1/orders/"+orderID, tok)
			if r.StatusCode != 200 {
				t.Fatalf("get %d: %s", r.StatusCode, b)
			}
			var resp struct {
				Items []struct {
					LineTotal string `json:"line_total"`
				} `json:"items"`
			}
			_ = json.Unmarshal(b, &resp)
			if len(resp.Items) != 1 {
				t.Fatalf("items=%d", len(resp.Items))
			}
			if resp.Items[0].LineTotal != c.want {
				t.Errorf("line_total = %q, ожидали %q", resp.Items[0].LineTotal, c.want)
			}
		})
	}
}

// «3 по 100г» (3 отдельные позиции) → каждая 35, сумма заказа 105.
func TestOrderItem_LineTotal_ThreePortionsSum(t *testing.T) {
	f := setupE2E(t)
	gdb, _, shiftID, _ := seedForWrite(t, f)
	tok := f.login(t)
	now := time.Now().UTC()
	st, hall, g := "new", "hall", "g"
	orderID := uuid.NewString()
	if err := gdb.Create(&models.Order{ID: orderID, RestaurantID: &f.rid, Status: &st, Type: &hall, ShiftID: &shiftID, CreatedAt: now, UpdatedAt: now}).Error; err != nil {
		t.Fatal(err)
	}
	dish := "Жиз Кавурдок 100г"
	for i := 0; i < 3; i++ {
		if err := gdb.Create(&models.OrderItem{
			ID: uuid.NewString(), OrderID: &orderID, Name: &dish,
			Qty: decimal.MustFromString("100"), Price: decimal.MustFromString("350"),
			Unit: &g, UnitSize: decimal.MustFromString("1000"),
			CreatedAt: now.Add(time.Duration(i) * time.Second), UpdatedAt: now,
		}).Error; err != nil {
			t.Fatal(err)
		}
	}
	r, b := f.get(t, "/api/v1/orders/"+orderID, tok)
	if r.StatusCode != 200 {
		t.Fatalf("get %d: %s", r.StatusCode, b)
	}
	var resp struct {
		Items []struct {
			LineTotal string `json:"line_total"`
		} `json:"items"`
	}
	_ = json.Unmarshal(b, &resp)
	if len(resp.Items) != 3 {
		t.Fatalf("ожидали 3 позиции, получили %d", len(resp.Items))
	}
	sum := decimal.Zero
	for _, it := range resp.Items {
		if it.LineTotal != "35" {
			t.Errorf("порция line_total = %q, ожидали 35", it.LineTotal)
		}
		sum = decimal.Add(sum, decimal.MustFromString(it.LineTotal))
	}
	if sum.String() != "105" {
		t.Errorf("сумма 3 порций = %s, ожидали 105", sum.String())
	}
}
