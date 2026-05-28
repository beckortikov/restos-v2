// Package decimal — тонкая обёртка над shopspring/decimal под правила CLAUDE.md.
//
// Правила:
//   - В БД храним NUMERIC(14,4). На уровне Go — Decimal с scale=4 после нормализации.
//   - Округление — half-even (banker's rounding) — стандарт для финансовой математики.
//   - Сложение/вычитание/умножение — точные. Деление — Round(...) с явным scale.
//   - Из float НИКОГДА не конвертируем (float64 → Decimal через NewFromFloat запрещён).
//     Если фронт прислал число — пришлёт его строкой; используем FromString.
package decimal

import (
	"fmt"

	sd "github.com/shopspring/decimal"
)

// Scale — стандартный масштаб в RestOS (4 знака после запятой).
// Согласовано с миграцией 001_init.sql (NUMERIC(14,4)).
const Scale = 4

// Decimal — алиас для shopspring-Decimal. Все методы доступны напрямую.
type Decimal = sd.Decimal

// Zero — нулевое значение с правильным scale.
var Zero = sd.NewFromInt(0)

// FromString парсит десятичное число из строки. Это единственный безопасный путь
// конверсии из произвольного источника (HTTP-payload, БД-string-cast).
func FromString(s string) (Decimal, error) {
	d, err := sd.NewFromString(s)
	if err != nil {
		return Zero, fmt.Errorf("decimal.FromString(%q): %w", s, err)
	}
	return d, nil
}

// MustFromString — конструктор для констант/тестов. Паника на ошибке.
// В продакшен-коде использовать FromString.
func MustFromString(s string) Decimal {
	d, err := FromString(s)
	if err != nil {
		panic(err)
	}
	return d
}

// FromInt — конверсия из int64. Безопасна (целые → точные decimal).
func FromInt(i int64) Decimal { return sd.NewFromInt(i) }

// Normalize округляет до Scale через half-even и возвращает каноническую форму.
// Используется перед записью в БД, чтобы scale в Go и в NUMERIC(14,4) совпадал.
func Normalize(d Decimal) Decimal {
	return d.RoundBank(Scale)
}

// Add — d1 + d2 (точная операция).
func Add(d1, d2 Decimal) Decimal { return d1.Add(d2) }

// Sub — d1 - d2 (точная операция).
func Sub(d1, d2 Decimal) Decimal { return d1.Sub(d2) }

// Mul — d1 * d2 (точная операция, scale = scale(d1) + scale(d2)).
// После умножения обычно нужно Normalize.
func Mul(d1, d2 Decimal) Decimal { return d1.Mul(d2) }

// DivRound — d1 / d2 с явным округлением half-even до Scale.
// На div-by-zero паникует — это программная ошибка, валидировать ДО вызова.
func DivRound(d1, d2 Decimal) Decimal {
	if d2.IsZero() {
		panic("decimal.DivRound: division by zero")
	}
	return d1.DivRound(d2, Scale)
}

// Percent возвращает amount * (percent/100), normalized.
// Пример: Percent("100","10") = 10.0000.
func Percent(amount, percent Decimal) Decimal {
	hundred := sd.NewFromInt(100)
	return Normalize(amount.Mul(percent).Div(hundred))
}

// IsNegative — true если d < 0.
func IsNegative(d Decimal) bool { return d.IsNegative() }

// IsPositive — true если d > 0.
func IsPositive(d Decimal) bool { return d.IsPositive() }
