package service

import (
	"testing"

	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// TestIngStockConvToStock — приведение рецептурного расхода к складской единице
// в точках списания (order-close, semi, batch). Штучный склад с per-unit
// фактором — критичный кейс: 10 г кукурузы при «1 банка = 340 г» → 0.0294 банки.
func TestIngStockConvToStock(t *testing.T) {
	d := decimal.MustFromString
	cases := []struct {
		name       string
		conv       ingStockConv
		qty        string
		recipeUnit string
		want       string
	}{
		{
			name: "штучный склад + фактор 340 г/шт",
			conv: ingStockConv{unit: "шт", unitWeight: d("340"), weightUnit: "г"},
			qty:  "10", recipeUnit: "г", want: "0.0294",
		},
		{
			name: "штучный склад, рецепт в кг → per-unit г",
			conv: ingStockConv{unit: "шт", unitWeight: d("340"), weightUnit: "г"},
			qty:  "1", recipeUnit: "кг", want: "2.9412",
		},
		{
			name: "метрический склад кг, рецепт г — фактор игнорируется",
			conv: ingStockConv{unit: "кг", unitWeight: d("340"), weightUnit: "г"},
			qty:  "300", recipeUnit: "г", want: "0.3",
		},
		{
			name: "штучный склад без фактора → фолбэк без изменений",
			conv: ingStockConv{unit: "шт"},
			qty:  "10", recipeUnit: "г", want: "10",
		},
		{
			name: "неизвестный ингредиент (zero-value) → qty без изменений",
			conv: ingStockConv{},
			qty:  "5", recipeUnit: "г", want: "5",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := c.conv.toStock(d(c.qty), c.recipeUnit)
			if !got.Equal(d(c.want)) {
				t.Fatalf("toStock(%s, %q) = %s, want %s", c.qty, c.recipeUnit, got.String(), c.want)
			}
		})
	}
}
