package units

import (
	"testing"

	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

func TestConvert(t *testing.T) {
	d := decimal.MustFromString
	cases := []struct {
		name          string
		qty, from, to string
		want          string
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
