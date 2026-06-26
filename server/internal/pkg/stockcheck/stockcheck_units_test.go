package stockcheck

import (
	"testing"

	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// ─── ПРОБЛЕМА 3: конвертация единиц измерения (кг↔г) ────────────────────────
//
// Баг (со слов пользователя): «если товар кг, но в блюде тех-карте пишу
// граммовый расход — пишет, что не хватает ингредиентов, хотя 3 кг это 3000 гр».
//
// Фикс: ComputeShortages приводит расход строки тех-карты (TechLine.Unit) к
// единице склада ингредиента (IngredientInfo.Unit) через pkg/units перед
// сравнением. Тесты ниже фиксируют корректное поведение.

// ingU — IngredientInfo с явной единицей склада.
func ingU(qty decimal.Decimal, unit, name string) *IngredientInfo {
	i := ing(qty, decimal.Zero, name)
	i.Unit = strPtr(unit)
	return i
}

// TestComputeShortages_Problem3_SameUnit_Control — контроль: граммы vs граммы.
// 3000 г на складе хватает на 300 г по рецепту → нехваток нет.
func TestComputeShortages_Problem3_SameUnit_Control(t *testing.T) {
	r := ComputeShortages(
		[]OrderItem{{MenuItemID: "d1", Name: "Шашлык", Qty: decimal.FromInt(1)}},
		Opts{
			Mode:     ModeStrict,
			MenuByID: map[string]MenuMeta{"d1": {}},
			TclByMenu: map[string][]TechLine{
				"d1": {{
					IngredientID: strPtr("guhsh"),
					Qty:          decimal.FromInt(300), // 300 г по тех-карте
					Unit:         strPtr("г"),
					Name:         "Гуш",
					Ingredient:   ingU(decimal.FromInt(3000), "г", "Гуш"), // 3000 г на складе
				}},
			},
		},
	)
	R.Empty(t, r)
}

// TestComputeShortages_Problem3_KgStock_GramRecipe_NoFalseShortage —
// ингредиент на складе в КГ (3 кг), расход в тех-карте в Г (300 г).
// 3 кг = 3000 г ≥ 300 г → нехватки быть НЕ должно.
func TestComputeShortages_Problem3_KgStock_GramRecipe_NoFalseShortage(t *testing.T) {
	r := ComputeShortages(
		[]OrderItem{{MenuItemID: "d1", Name: "Шашлык", Qty: decimal.FromInt(1)}},
		Opts{
			Mode:     ModeStrict,
			MenuByID: map[string]MenuMeta{"d1": {}},
			TclByMenu: map[string][]TechLine{
				"d1": {{
					IngredientID: strPtr("guhsh"),
					Qty:          decimal.FromInt(300), // 300 г по тех-карте
					Unit:         strPtr("г"),
					Name:         "Гуш",
					Ingredient:   ingU(decimal.FromInt(3), "кг", "Гуш"), // 3 кг на складе
				}},
			},
		},
	)
	R.Empty(t, r) // 3 кг = 3000 г ≥ 300 г → нехваток нет
}

// TestComputeShortages_Problem3_KgStock_GramRecipe_RealShortage — обратная
// проверка: при кг-складе и граммовом рецепте нехватка ВСЁ ЕЩЁ ловится, когда
// её реально не хватает. 0.2 кг = 200 г, рецепт 300 г → не хватает.
func TestComputeShortages_Problem3_KgStock_GramRecipe_RealShortage(t *testing.T) {
	r := ComputeShortages(
		[]OrderItem{{MenuItemID: "d1", Name: "Шашлык", Qty: decimal.FromInt(1)}},
		Opts{
			Mode:     ModeStrict,
			MenuByID: map[string]MenuMeta{"d1": {}},
			TclByMenu: map[string][]TechLine{
				"d1": {{
					IngredientID: strPtr("guhsh"),
					Qty:          decimal.FromInt(300), // 300 г по тех-карте
					Unit:         strPtr("г"),
					Name:         "Гуш",
					Ingredient:   ingU(decimal.MustFromString("0.2"), "кг", "Гуш"), // 0.2 кг = 200 г
				}},
			},
		},
	)
	R.Len(t, r, 1)
	R.Regexp(t, "Гуш", r[0])
}
