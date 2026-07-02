package service

import (
	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
	"github.com/restos/restos-v4/server/internal/pkg/units"
)

// ingStockConv — складская единица ингредиента + опциональный per-unit фактор
// веса/объёма. Нужна, чтобы привести рецептурный расход (тех-карта в г/мл) к
// складской единице (шт/кг/...) в точках списания. См. units.ConvertToStock.
type ingStockConv struct {
	unit       string
	unitWeight decimal.Decimal
	weightUnit string
}

// toStock переводит qty из рецептурной единицы recipeUnit в складскую единицу
// ингредиента. Для неизвестного ингредиента (zero-value) поведение = как раньше
// (qty без изменений для несводимых пар).
func (c ingStockConv) toStock(qty decimal.Decimal, recipeUnit string) decimal.Decimal {
	return units.ConvertToStock(qty, recipeUnit, c.unit, c.unitWeight, c.weightUnit)
}

// loadIngStockConv загружает складские единицы + факторы для набора ингредиентов
// одним запросом. Отсутствующие в результате id дадут zero-value ingStockConv.
func loadIngStockConv(tx *gorm.DB, ingredientIDs []string) (map[string]ingStockConv, error) {
	out := make(map[string]ingStockConv, len(ingredientIDs))
	if len(ingredientIDs) == 0 {
		return out, nil
	}
	var ings []models.Ingredient
	if err := tx.Select("id, unit, unit_weight, unit_weight_unit").
		Where("id IN ?", ingredientIDs).Find(&ings).Error; err != nil {
		return nil, err
	}
	for _, i := range ings {
		out[i.ID] = ingStockConv{
			unit:       deref(i.Unit),
			unitWeight: i.UnitWeight,
			weightUnit: deref(i.UnitWeightUnit),
		}
	}
	return out, nil
}
