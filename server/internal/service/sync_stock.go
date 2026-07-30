package service

import (
	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/synclog"
)

// recordIngredientSync пишет снапшот АКТУАЛЬНОГО состояния (после всех
// изменений В ЭТОЙ ЖЕ транзакции — Postgres read-your-own-writes) для
// каждой строки из ids в sync_log. По образцу recordMenuItemsSync (Ф2) —
// снапшот-подход, один вызов со списком id вместо инструментирования каждой
// точки отдельно.
//
// Это ВТОРАЯ точка записи для ingredients (первая — внутри самого хука
// денормализации qty, audit/stock_hook.go, для случаев когда qty меняется
// через stock_movements). Эта — для НЕ-qty полей (name/category/min_qty/
// unit/price_per_unit/waste_percent/is_food/warehouse_id/nomenclature_id),
// которые меняются напрямую через Create/Updates на самой модели Ingredient
// в service-слое (импорт, покупные товары меню, приёмка/возврат — переоценка
// средневзвешенной цены, ручной CRUD склада, перемещение целиком на другой
// склад).
func recordIngredientSync(tx *gorm.DB, ids []string) error {
	if len(ids) == 0 {
		return nil
	}
	var rows []models.Ingredient
	if err := tx.Where("id IN ?", ids).Find(&rows).Error; err != nil {
		return err
	}
	for i := range rows {
		if err := synclog.Record(tx, synclog.Entry{
			Entity:       "ingredients",
			RowID:        rows[i].ID,
			Op:           "update",
			RestaurantID: rows[i].RestaurantID,
			Payload:      rows[i],
		}); err != nil {
			return err
		}
	}
	return nil
}

// recordIngredientDeleteSync — явная запись удаления ингредиента (hard
// delete, см. IngredientsWriteService.Delete и removeParentPhantomBacking).
func recordIngredientDeleteSync(tx *gorm.DB, ingredientID string, restaurantID string) error {
	return synclog.Record(tx, synclog.Entry{
		Entity:       "ingredients",
		RowID:        ingredientID,
		Op:           "delete",
		RestaurantID: &restaurantID,
	})
}
