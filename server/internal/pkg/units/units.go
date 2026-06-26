// Package units — конвертация количеств между единицами измерения одной
// размерности (масса: кг↔г, объём: л↔мл).
//
// Зачем: остаток ингредиента на складе хранится в одной единице (например, кг),
// а расход в тех-карте может быть записан в другой (граммы). Без приведения к
// общей единице сравнение «хватает / не хватает» и списание считаются неверно
// (3 кг ≠ 3, когда рецепт требует 300 г). Зеркалит фронтовый convertToStock
// (app/(app)/operations/batch-cooking, warehouse/semi).
package units

import (
	"strings"

	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// dimension — размерность единицы; конвертация возможна только внутри одной.
type dimension int

const (
	dimNone dimension = iota
	dimMass
	dimVolume
)

// spec — размерность единицы и её множитель к базовой (масса → грамм, объём → мл).
type spec struct {
	dim    dimension
	factor decimal.Decimal
}

var (
	one      = decimal.FromInt(1)
	thousand = decimal.FromInt(1000)

	// table — нормализованная единица → spec. Латинские и кириллические алиасы.
	table = map[string]spec{
		"кг": {dimMass, thousand},
		"kg": {dimMass, thousand},
		"г":  {dimMass, one},
		"гр": {dimMass, one},
		"g":  {dimMass, one},
		"gr": {dimMass, one},
		"л":  {dimVolume, thousand},
		"l":  {dimVolume, thousand},
		"lt": {dimVolume, thousand},
		"мл": {dimVolume, one},
		"ml": {dimVolume, one},
	}
)

func norm(u string) string {
	return strings.TrimRight(strings.ToLower(strings.TrimSpace(u)), ".")
}

// Convert переводит qty из единицы from в единицу to.
//
// Возвращает qty без изменений, если:
//   - единицы совпадают;
//   - одна из единиц неизвестна (шт, порц, уп, бут, пустая строка);
//   - единицы относятся к разным размерностям (кг → л).
//
// Это безопасный фолбэк: для неконвертируемых случаев поведение остаётся
// прежним (как до введения конвертации).
func Convert(qty decimal.Decimal, from, to string) decimal.Decimal {
	f, t := norm(from), norm(to)
	if f == t {
		return qty
	}
	sf, okF := table[f]
	st, okT := table[t]
	if !okF || !okT || sf.dim != st.dim {
		return qty
	}
	// qty * factor(from) / factor(to) — в базовую единицу и обратно.
	base := decimal.Mul(qty, sf.factor)
	return decimal.DivRound(base, st.factor)
}

// Convertible сообщает, можно ли привести from к to (одна размерность, обе
// единицы известны). Полезно, чтобы не «молча» сравнивать несравнимое.
func Convertible(from, to string) bool {
	f, t := norm(from), norm(to)
	if f == t {
		return true
	}
	sf, okF := table[f]
	st, okT := table[t]
	return okF && okT && sf.dim == st.dim
}
