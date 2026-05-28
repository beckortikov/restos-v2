// Package stockcheck — порт чистой логики валидации stock + tech-card из v1
// (см. ../restos/lib/stock-check.ts).
//
// Behaviour matrix:
//
//	tech_cards_enabled | enforce_stock_check | tech card? | result
//	-------------------|---------------------|------------|-----------------------
//	OFF                | *                   | *          | (caller skips check)
//	ON                 | OFF                 | yes        | allow (may go negative)
//	ON                 | OFF                 | NO         | block — "нет техкарты"
//	ON                 | ON                  | yes        | check stock w/ reserves
//	ON                 | ON                  | NO         | block — "нет техкарты"
//
// Caller decides whether to call (based on tech_cards_enabled) and passes Mode:
//   - ModeTechCardOnly: only "техкарта обязана быть" rule
//   - ModeStrict:       also enforce stock availability with reservations
package stockcheck

import (
	"fmt"

	sd "github.com/shopspring/decimal"

	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// Mode — режим проверки.
type Mode string

const (
	ModeTechCardOnly Mode = "tech-card-only"
	ModeStrict       Mode = "strict"
)

// OrderItem — input-структура для одной позиции заказа.
type OrderItem struct {
	MenuItemID string
	Name       string
	Qty        decimal.Decimal
}

// MenuMeta — мета-информация о блюде (для batch-cooking логики).
type MenuMeta struct {
	IsBatchCooking bool
	PreparedQty    int
}

// IngredientInfo — состояние ингредиента (склад + waste + flags).
type IngredientInfo struct {
	Qty          decimal.Decimal
	WastePercent decimal.Decimal
	Name         string
	IsFood       bool
}

// TechLine — строка тех. карты. Ingredient может быть nil — это случай
// «строка ссылается на semi_finished или вообще без ингредиента», такие
// строки игнорируются при подсчёте техкарт (см. v1 stock-check.ts).
type TechLine struct {
	IngredientID *string
	Qty          decimal.Decimal
	Name         string
	Ingredient   *IngredientInfo
}

// Opts — параметры расчёта.
type Opts struct {
	Mode                 Mode
	MenuByID             map[string]MenuMeta
	TclByMenu            map[string][]TechLine
	ReservedByIngredient map[string]decimal.Decimal // только для ModeStrict
	ReservedBatchByMenu  map[string]decimal.Decimal // только для ModeStrict (key: menu_item_id, value: portions)
}

// ComputeShortages возвращает список русскоязычных описаний нехваток.
// Пустой слайс = всё ок.
//
// Зеркало `computeShortages` из v1 (TypeScript). При портировании сохраняем:
//   - тексты сообщений (точные русские строки),
//   - порядок проверок,
//   - rule "нет техкарты → блок" в обоих режимах,
//   - non-food ингредиенты (is_food=false) пропускаются,
//   - waste_percent: needed = recipeQty / (1 - waste/100).
func ComputeShortages(items []OrderItem, opts Opts) []string {
	var shortages []string
	for _, item := range items {
		// Берём только строки техкарты, у которых есть ingredient_id.
		// Строки с ingredient_id=NULL — это semi-fin или «свободная» строка, не считаются.
		allLines := opts.TclByMenu[item.MenuItemID]
		techLines := make([]TechLine, 0, len(allLines))
		for _, l := range allLines {
			if l.IngredientID != nil && *l.IngredientID != "" {
				techLines = append(techLines, l)
			}
		}

		// Rule (оба режима): блюдо без техкарты не продаётся когда tech-cards ON.
		if len(techLines) == 0 {
			shortages = append(shortages, fmt.Sprintf("%s: не настроена техкарта", item.Name))
			continue
		}

		// tech-card-only — остановка после проверки наличия техкарты.
		if opts.Mode == ModeTechCardOnly {
			continue
		}

		// strict: batch-блюда проверяются по prepared_qty - reserved.
		menuMeta := opts.MenuByID[item.MenuItemID]
		if menuMeta.IsBatchCooking {
			prepQty := decimal.FromInt(int64(menuMeta.PreparedQty))
			reserved := opts.ReservedBatchByMenu[item.MenuItemID]
			available := decimal.Sub(prepQty, reserved)
			if available.LessThan(item.Qty) {
				shortages = append(shortages, fmt.Sprintf(
					"%s: готово %s порц., нужно %s",
					item.Name,
					formatPortions(available),
					formatPortions(item.Qty),
				))
			}
			continue
		}

		// strict: ingredient-based — проверяем каждую строку техкарты.
		for _, line := range techLines {
			recipeQty := decimal.Mul(line.Qty, item.Qty)
			ing := line.Ingredient
			if ing == nil {
				continue
			}
			if !ing.IsFood {
				continue
			}
			needed := applyWaste(recipeQty, ing.WastePercent)
			stock := ing.Qty
			reserved := opts.ReservedByIngredient[*line.IngredientID]
			available := decimal.Sub(stock, reserved)

			if available.LessThan(needed) {
				msg := fmt.Sprintf(`%s: не хватает "%s" (нужно %s`, item.Name, ing.Name, formatInt(needed))
				if available.IsPositive() {
					msg += fmt.Sprintf(", есть %s)", formatInt(available))
				} else {
					msg += ", нет на складе)"
				}
				shortages = append(shortages, msg)
			}
		}
	}
	return shortages
}

// applyWaste возвращает recipeQty / (1 - waste/100). Если waste <= 0 — recipeQty без изменений.
func applyWaste(recipeQty, wastePercent decimal.Decimal) decimal.Decimal {
	if !wastePercent.IsPositive() {
		return recipeQty
	}
	hundred := sd.NewFromInt(100)
	one := sd.NewFromInt(1)
	divisor := one.Sub(wastePercent.Div(hundred))
	if divisor.IsZero() || divisor.IsNegative() {
		// waste >= 100% — деление невозможно; возвращаем «бесконечно нужно», но
		// здесь чтобы не паниковать, возвращаем recipeQty * 1000.
		return recipeQty.Mul(sd.NewFromInt(1000))
	}
	return recipeQty.DivRound(divisor, 8)
}

// formatInt — аналог JS .toFixed(0) (округление к ближайшему, half-away-from-zero).
func formatInt(d decimal.Decimal) string {
	return d.Round(0).String()
}

// formatPortions — для порций batch-блюд (целое число, без дробей).
func formatPortions(d decimal.Decimal) string {
	return d.Round(0).String()
}
