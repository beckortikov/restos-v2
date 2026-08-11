package service

import (
	"context"
	"time"

	"github.com/rs/zerolog/log"
	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
	"github.com/restos/restos-v4/server/internal/pkg/units"
	"github.com/restos/restos-v4/server/internal/repo"
)

// menu_cogs.go — единое ядро расчёта себестоимости блюда по тех-карте.
//
// До этого файла cogs блюда (menu_items.cogs) был денормализованным полем,
// которое НИКТО не пересчитывал при изменении строк тех-карты, цены
// ингредиента или партии полуфабриката — единственный "живой" путь был на
// фронте (calcCogsFromTechCard), но он ничего не писал обратно в БД. Реальные
// продажи (order_items.cogs) и все финансовые отчёты брали "замороженное"
// значение — иногда актуальное, иногда нет, без единого признака расхождения.
//
// computeTechCardCogsFor — общее ядро; recomputeMenuItemCogs — пишет
// результат в menu_items.cogs; recomputeCogsForIngredient/-ForSemiType —
// каскад "цена ингредиента/п-ф изменилась → пересчитать все блюда на ней".

// techCardCogsBreakdown — итог расчёта: сумма + число строк, пропущенных
// из-за несводимых единиц измерения (напр. рецепт в граммах, склад
// ингредиента в штуках без указанного веса штуки).
type techCardCogsBreakdown struct {
	total   decimal.Decimal
	skipped int
}

// computeTechCardCogsFor — себестоимость блюда menuItemID по его строкам
// тех-карты (batch-запрос по всем ingredient_id/semi_type_id строк).
func computeTechCardCogsFor(tx *gorm.DB, rid, menuItemID string) techCardCogsBreakdown {
	var lines []models.TechCardLine
	if err := tx.Where("restaurant_id = ? AND menu_item_id = ?", rid, menuItemID).
		Find(&lines).Error; err != nil {
		return techCardCogsBreakdown{}
	}
	return computeTechCardCogsLines(tx, rid, lines)
}

// semiCostInfo — себестоимость полуфабриката за его складскую единицу
// (price_per_unit + unit из semi_finished_stock).
type semiCostInfo struct {
	price decimal.Decimal
	unit  string
}

// computeTechCardCogsLines грузит цены (batch-запросы) и делегирует расчёт
// чистой функции computeTechCardCogsPure — так формулу можно тестировать без
// БД (см. menu_cogs_test.go).
func computeTechCardCogsLines(tx *gorm.DB, rid string, lines []models.TechCardLine) techCardCogsBreakdown {
	ingIDs := make([]string, 0, len(lines))
	semiIDs := make([]string, 0, len(lines))
	for _, l := range lines {
		if l.IngredientID != nil && *l.IngredientID != "" {
			ingIDs = append(ingIDs, *l.IngredientID)
		} else if l.SemiTypeID != nil && *l.SemiTypeID != "" {
			semiIDs = append(semiIDs, *l.SemiTypeID)
		}
	}
	if len(ingIDs) == 0 && len(semiIDs) == 0 {
		return techCardCogsBreakdown{}
	}

	convByID := make(map[string]ingStockConv, len(ingIDs))
	if len(ingIDs) > 0 {
		if conv, err := loadIngStockConv(tx, ingIDs); err == nil {
			convByID = conv
		}
	}

	// Полуфабрикаты: цена/ед. из semi_finished_stock (yield уже зашит в цену —
	// см. semi_ops.go Prepare — поэтому waste к семи-строкам не применяется).
	semiByType := make(map[string]semiCostInfo, len(semiIDs))
	if len(semiIDs) > 0 {
		var stocks []models.SemiFinishedStock
		if err := tx.Where("restaurant_id = ? AND semi_type_id IN ?", rid, semiIDs).
			Find(&stocks).Error; err == nil {
			for _, s := range stocks {
				if s.SemiTypeID != nil {
					semiByType[*s.SemiTypeID] = semiCostInfo{price: s.PricePerUnit, unit: deref(s.Unit)}
				}
			}
		}
	}

	return computeTechCardCogsPure(lines, convByID, semiByType)
}

// computeTechCardCogsPure — формула: Σ(расход_брутто × цена_ингредиента) +
// Σ(расход × себестоимость_п/ф). Расход_брутто = qty/(1−waste%) — та же
// формула, что и в writeIngredientDeduct (orders_close.go, #18), приведённая
// к складской единице тем же ingStockConv.toStock, что и там.
//
// Guard несводимых единиц (#20 в orders_close.go тоже его использует для
// самого списания) — здесь применяется симметрично: строка, для которой
// рецептурная единица не сводится к складской (и нет per-unit фактора веса),
// пропускается и считается в skipped, а НЕ берётся "как есть" (иначе "200 г"
// тихо стало бы "200 шт" и умножилось на цену за штуку — кратно неверный
// итог без единой ошибки). Чистая функция — без БД, чтобы формулу можно было
// протестировать напрямую.
func computeTechCardCogsPure(lines []models.TechCardLine, convByID map[string]ingStockConv, semiByType map[string]semiCostInfo) techCardCogsBreakdown {
	total := decimal.Zero
	skipped := 0
	for _, l := range lines {
		switch {
		case l.IngredientID != nil && *l.IngredientID != "":
			conv, ok := convByID[*l.IngredientID]
			if !ok {
				continue // ингредиент удалён/не найден — не считаем строку (как и раньше)
			}
			recipeUnit := deref(l.Unit)
			if !conv.convertible(recipeUnit) {
				skipped++
				continue
			}
			qty := l.Qty
			if conv.wastePercent.IsPositive() {
				divisor := decimal.Sub(decimal.FromInt(1), decimal.DivRound(conv.wastePercent, decimal.FromInt(100)))
				if divisor.IsPositive() {
					qty = decimal.DivRound(qty, divisor)
				}
			}
			qtyStock := conv.toStock(qty, recipeUnit)
			total = decimal.Add(total, decimal.Mul(qtyStock, conv.pricePerUnit))
		case l.SemiTypeID != nil && *l.SemiTypeID != "":
			sc, ok := semiByType[*l.SemiTypeID]
			if !ok || !sc.price.IsPositive() {
				continue // п/ф ещё ни разу не готовили — вклад строки не считаем (не 0 "любой ценой")
			}
			recipeUnit := deref(l.Unit)
			if !units.Convertible(recipeUnit, sc.unit) {
				skipped++
				continue
			}
			qtyStock := units.Convert(l.Qty, recipeUnit, sc.unit)
			total = decimal.Add(total, decimal.Mul(qtyStock, sc.price))
		}
	}
	return techCardCogsBreakdown{total: decimal.Normalize(total), skipped: skipped}
}

// recomputeMenuItemCogs пересчитывает и ЗАПИСЫВАЕТ menu_items.cogs блюда по
// его тех-карте. Пишет, только если расчёт полный и положительный:
//   - нет строк тех-карты → no-op (блюдо без тех-карты — cogs как был, это
//     легитимный ручной/покупной путь, не наша забота);
//   - есть пропущенные строки (несводимые единицы) → NOT пишем — частичная
//     сумма выглядела бы как полная себестоимость, а на деле занижена;
//     логируем предупреждение, чтобы было видно в логах, какую тех-карту
//     нужно поправить;
//   - итог 0 (например, все ингредиенты без цены) → не пишем — 0 не отличить
//     от "не считалось", лучше оставить прежнее значение, чем обнулить.
//
// Вызывается ВНУТРИ транзакции — на изменение строки тех-карты, цены
// ингредиента, партии полуфабриката (см. вызывающих). Возвращает true, только
// если cogs реально ИЗМЕНИЛСЯ (не просто пересчитан с тем же значением) — на
// это опирается счётчик RecomputeCogs, чтобы «Обновлено: N» означало именно N
// изменившихся блюд, а не общее число блюд с тех-картой.
func recomputeMenuItemCogs(tx *gorm.DB, rid, menuItemID string, now time.Time) bool {
	res := computeTechCardCogsFor(tx, rid, menuItemID)
	if res.skipped > 0 {
		log.Warn().Str("menu_item_id", menuItemID).Int("skipped_lines", res.skipped).
			Msg("cogs: тех-карта содержит несводимые единицы измерения — себестоимость не обновлена")
		return false
	}
	if !res.total.IsPositive() {
		return false
	}
	var current models.MenuItem
	if err := tx.Select("cogs").Where("id = ? AND restaurant_id = ?", menuItemID, rid).First(&current).Error; err != nil {
		log.Error().Err(err).Str("menu_item_id", menuItemID).Msg("cogs: не удалось прочитать текущее значение")
		return false
	}
	if current.COGS.Equal(res.total) {
		return false // уже актуально
	}
	if err := tx.Model(&models.MenuItem{}).Where("id = ? AND restaurant_id = ?", menuItemID, rid).
		Updates(map[string]any{"cogs": res.total, "updated_at": now}).Error; err != nil {
		log.Error().Err(err).Str("menu_item_id", menuItemID).Msg("cogs: не удалось записать пересчитанную себестоимость")
		return false
	}
	return true
}

// recomputeCogsForIngredient — каскад "цена/waste/единица ингредиента
// изменилась → пересчитать cogs всех блюд, чья тех-карта на него ссылается".
// Вызывается ВНУТРИ той же транзакции, что и сам UPDATE ingredients.
func recomputeCogsForIngredient(tx *gorm.DB, rid, ingredientID string, now time.Time) {
	var menuItemIDs []string
	if err := tx.Model(&models.TechCardLine{}).
		Where("restaurant_id = ? AND ingredient_id = ?", rid, ingredientID).
		Distinct().Pluck("menu_item_id", &menuItemIDs).Error; err != nil {
		log.Error().Err(err).Str("ingredient_id", ingredientID).Msg("cogs: не удалось найти блюда для пересчёта")
		return
	}
	for _, id := range menuItemIDs {
		if id == "" {
			continue
		}
		recomputeMenuItemCogs(tx, rid, id, now)
	}
}

// recomputeCogsForSemiType — тот же каскад для полуфабриката: вызывается
// после того как semi_finished_stock.price_per_unit обновился (Prepare).
func recomputeCogsForSemiType(tx *gorm.DB, rid, semiTypeID string, now time.Time) {
	var menuItemIDs []string
	if err := tx.Model(&models.TechCardLine{}).
		Where("restaurant_id = ? AND semi_type_id = ?", rid, semiTypeID).
		Distinct().Pluck("menu_item_id", &menuItemIDs).Error; err != nil {
		log.Error().Err(err).Str("semi_type_id", semiTypeID).Msg("cogs: не удалось найти блюда для пересчёта")
		return
	}
	for _, id := range menuItemIDs {
		if id == "" {
			continue
		}
		recomputeMenuItemCogs(tx, rid, id, now)
	}
}

// RecomputeCogs — POST /api/v1/menu/recompute-cogs. Разовый бэкфилл: проходит
// по всем блюдам ресторана, у которых есть тех-карта, и пересчитывает cogs —
// как и recomputeMenuItemCogs при точечных изменениях, но для существующих
// блюд, заведённых ДО того как автопересчёт появился (импорт, ручной ввод,
// давно не трогавшиеся тех-карты). Возвращает число реально обновлённых блюд.
//
// Тот же safety-net, что и SuppliersService.RecomputeDebts — "в один клик"
// синхронизировать денормализованное поле с первоисточником, если что-то
// когда-то разошлось.
func (s *MenuService) RecomputeCogs(ctx context.Context) (int64, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return 0, err
	}
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return 0, err
	}
	var ids []string
	if err := scoped.Model(&models.TechCardLine{}).Distinct().Pluck("menu_item_id", &ids).Error; err != nil {
		return 0, err
	}
	var updated int64
	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)
		now := time.Now().UTC()
		for _, id := range ids {
			if id == "" {
				continue
			}
			if recomputeMenuItemCogs(tx, rid, id, now) {
				updated++
			}
		}
		return nil
	})
	if err != nil {
		return 0, err
	}
	return updated, nil
}
