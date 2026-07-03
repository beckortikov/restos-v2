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

// ConvertToStock переводит расход из рецептурной единицы recipeUnit в единицу
// склада ингредиента stockUnit, используя per-unit фактор веса/объёма, когда
// единицы относятся к разным размерностям (штучный склад vs весовой рецепт).
//
// perUnit — вес/объём ОДНОЙ складской единицы (например 340 — нетто банки),
// perUnitUnit — единица, в которой задан perUnit (г/мл).
//
// Логика:
//  1. recipeUnit и stockUnit одной размерности (или совпадают) → обычная
//     метрическая конвертация Convert (10 г → 0.01 кг), фактор не нужен.
//  2. Иначе, если фактор задан (perUnit>0) и recipeUnit сводится к perUnitUnit
//     (одна размерность): приводим qty к perUnitUnit и делим на perUnit —
//     получаем дробное число складских единиц (10 г ÷ 340 г/банку = 0.0294 банки).
//  3. Иначе — безопасный фолбэк: Convert (qty без изменений для несводимых пар),
//     как было до введения фактора.
func ConvertToStock(qty decimal.Decimal, recipeUnit, stockUnit string, perUnit decimal.Decimal, perUnitUnit string) decimal.Decimal {
	if Convertible(recipeUnit, stockUnit) {
		return Convert(qty, recipeUnit, stockUnit)
	}
	if perUnit.IsPositive() && Convertible(recipeUnit, perUnitUnit) {
		return decimal.DivRound(Convert(qty, recipeUnit, perUnitUnit), perUnit)
	}
	return Convert(qty, recipeUnit, stockUnit)
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
