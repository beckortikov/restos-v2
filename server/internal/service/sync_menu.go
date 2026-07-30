package service

import (
	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/synclog"
)

// recordMenuItemsSync пишет снапшот АКТУАЛЬНОГО состояния (после всех
// изменений В ЭТОЙ ЖЕ транзакции — Postgres read-your-own-writes) для
// каждой строки из ids в sync_log. Универсальная точка для menu_items —
// в отличие от cash_shifts (Ф1, ровно 9 фиксированных мест), тут мутации
// разбросаны по CreateItem/PatchItem/patchPurchased (menu_write.go),
// syncVariants (menu_variants.go, десятки комбинаций за один SyncAttributes),
// SoftDeleteItem (родитель + все варианты одним UPDATE) и импорту xlsx —
// вместо инструментирования каждой map-based Updates() внутри плотных
// циклов, вызывающий код просто передаёт СПИСОК затронутых id одним вызовом
// в конце своей транзакции.
//
// menu_items не нуждается в отдельной delete-семантике: удаление всегда
// soft (is_deleted=true через обычный UPDATE, см. SoftDeleteItem) — попадает
// в тот же upsert-путь на central.
func recordMenuItemsSync(tx *gorm.DB, ids []string) error {
	if len(ids) == 0 {
		return nil
	}
	var rows []models.MenuItem
	if err := tx.Where("id IN ?", ids).Find(&rows).Error; err != nil {
		return err
	}
	for i := range rows {
		if err := synclog.Record(tx, synclog.Entry{
			Entity:       "menu_items",
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

// strPtrEqual сравнивает два *string с учётом nil на любой стороне
// (nil и "" — РАЗНЫЕ значения, сравниваем строго). Используется для
// определения, реально ли изменились наследуемые поля в applyNetworkMenu,
// вызываемом на каждый down-pull НЕЗАВИСИМО от того, есть ли изменения —
// без такой проверки recordMenuItemsSync писал бы дельту каждый цикл синка.
func strPtrEqual(a, b *string) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}
