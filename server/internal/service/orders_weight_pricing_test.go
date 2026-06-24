package service

import (
	"testing"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

func wpPtr(s string) *string { return &s }

// TestEffectivePortions — формула «порций» для денежных расчётов: весовые
// блюда (g/kg) делятся на unitSize, штучные остаются как есть.
func TestEffectivePortions(t *testing.T) {
	d := decimal.MustFromString
	cases := []struct {
		name           string
		unit           *string
		qty, size, exp string
	}{
		{"g 100/100 = 1 порция", wpPtr("g"), "100", "100", "1"},
		{"g 250/100 = 2.5", wpPtr("g"), "250", "100", "2.5"},
		{"kg 0.5/1 = 0.5", wpPtr("kg"), "0.5", "1", "0.5"},
		{"piece qty без изменений", wpPtr("piece"), "3", "1", "3"},
		{"nil unit qty без изменений", nil, "3", "1", "3"},
		{"гард unitSize=0 → qty", wpPtr("g"), "100", "0", "100"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := effectivePortions(c.unit, d(c.qty), d(c.size))
			if !got.Equal(d(c.exp)) {
				t.Fatalf("ожидали %s, получили %s", c.exp, got.String())
			}
		})
	}
}

// TestComputeSubtotalWeightItem — регрессия на баг: блюдо 40с за 100 г,
// пробитое как «100 г × 1», должно давать 40, а не 4000.
func TestComputeSubtotalWeightItem(t *testing.T) {
	d := decimal.MustFromString
	items := []models.OrderItem{
		{Unit: wpPtr("g"), UnitSize: d("100"), Qty: d("100"), Price: d("40")},
	}
	if got := computeSubtotal(items); !got.Equal(d("40")) {
		t.Fatalf("100г при 40с/100г = 40, получили %s", got.String())
	}

	// + штучное 12с × 2 = 24 → подытог 64.
	items = append(items, models.OrderItem{Unit: wpPtr("piece"), UnitSize: d("1"), Qty: d("2"), Price: d("12")})
	if got := computeSubtotal(items); !got.Equal(d("64")) {
		t.Fatalf("ожидали 64, получили %s", got.String())
	}
}
