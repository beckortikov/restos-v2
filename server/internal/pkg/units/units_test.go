package units

import (
	"testing"

	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

func TestConvert(t *testing.T) {
	d := decimal.MustFromString
	cases := []struct {
		name           string
		qty, from, to  string
		want           string
	}{
		{"г→кг", "300", "г", "кг", "0.3"},
		{"кг→г", "3", "кг", "г", "3000"},
		{"кг→кг", "3", "кг", "кг", "3"},
		{"мл→л", "500", "мл", "л", "0.5"},
		{"л→мл", "2", "л", "мл", "2000"},
		{"латиница g→kg", "250", "g", "kg", "0.25"},
		{"алиас гр→кг", "1500", "гр", "кг", "1.5"},
		{"регистр/пробелы ' КГ '→г", "1", " КГ ", "г", "1000"},
		{"шт без конвертации", "5", "шт.", "кг", "5"},
		{"разные размерности кг→л — без конвертации", "2", "кг", "л", "2"},
		{"пустая единица — без конвертации", "7", "", "кг", "7"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := Convert(d(c.qty), c.from, c.to)
			if !got.Equal(d(c.want)) {
				t.Fatalf("Convert(%s, %q, %q) = %s, want %s", c.qty, c.from, c.to, got.String(), c.want)
			}
		})
	}
}

func TestConvertible(t *testing.T) {
	cases := []struct {
		from, to string
		want     bool
	}{
		{"кг", "г", true},
		{"л", "мл", true},
		{"кг", "кг", true},
		{"кг", "л", false},
		{"шт", "кг", false},
		{"", "кг", false},
	}
	for _, c := range cases {
		if got := Convertible(c.from, c.to); got != c.want {
			t.Errorf("Convertible(%q, %q) = %v, want %v", c.from, c.to, got, c.want)
		}
	}
}

func TestConvertToStock(t *testing.T) {
	d := decimal.MustFromString
	cases := []struct {
		name                          string
		qty, recipeUnit, stockUnit    string
		perUnit, perUnitUnit          string
		want                          string
	}{
		// Ветка 1: одна размерность → метрическая конвертация, фактор игнорируется.
		{"г→кг игнор фактор", "300", "г", "кг", "340", "г", "0.3"},
		{"совпадение единиц", "5", "шт", "шт", "0", "", "5"},
		// Ветка 2: штучный склад + фактор.
		{"10 г ÷ 340 г/банку", "10", "г", "шт", "340", "г", "0.0294"},
		{"1 кг ÷ 340 г/банку (recipe кг → perUnit г)", "1", "кг", "шт", "340", "г", "2.9412"},
		{"500 мл ÷ 1000 мл/бут", "500", "мл", "бут", "1000", "мл", "0.5"},
		// Ветка 3: фолбэк — фактор не задан или несводим.
		{"фактор 0 → фолбэк без изменений", "10", "г", "шт", "0", "", "10"},
		{"perUnitUnit другой размерности → фолбэк", "10", "г", "шт", "340", "мл", "10"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := ConvertToStock(d(c.qty), c.recipeUnit, c.stockUnit, d(c.perUnit), c.perUnitUnit)
			if !got.Equal(d(c.want)) {
				t.Fatalf("ConvertToStock(%s, %q, %q, %s, %q) = %s, want %s",
					c.qty, c.recipeUnit, c.stockUnit, c.perUnit, c.perUnitUnit, got.String(), c.want)
			}
		})
	}
}
