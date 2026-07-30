package service

import (
	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/synclog"
)

// recordTableSync/recordZoneSync — точки записи для structural CRUD столов и
// зон (ADR-003 «Central видит всё», Ф2). Реплицируем ТОЛЬКО из Create/Patch/
// Delete (структурные атрибуты: имя/номер/вместимость/зона) — НЕ из
// SetStatus/AssignWaiter/OpenForOrder/Merge/Unmerge/CleanupStuck: это живая
// операционка конкретной кассы (кто сейчас сидит, какой заказ открыт),
// central её не показывает (см. «Принятая модель» плана). Снапшот стола на
// central может нести устаревший status/waiter_id/current_order_id с
// момента последнего структурного изменения — не проблема, эти поля central
// не читает вовсе (только name/capacity/zone_id для аналитики).
//
// tables/zones — единственные из Ф2, где удаление НАСТОЯЩЕЕ (hard delete,
// не soft — в отличие от menu_items), поэтому нужна explicit delete-запись,
// как у cash_shift_operations в Ф1.
func recordTableSync(tx *gorm.DB, t *models.Table, op string) error {
	return synclog.Record(tx, synclog.Entry{
		Entity:       "tables",
		RowID:        t.ID,
		Op:           op,
		RestaurantID: t.RestaurantID,
		Payload:      *t,
	})
}

func recordTableDeleteSync(tx *gorm.DB, tableID string, restaurantID string) error {
	return synclog.Record(tx, synclog.Entry{
		Entity:       "tables",
		RowID:        tableID,
		Op:           "delete",
		RestaurantID: &restaurantID,
	})
}

func recordZoneSync(tx *gorm.DB, z *models.Zone, op string) error {
	return synclog.Record(tx, synclog.Entry{
		Entity:       "zones",
		RowID:        z.ID,
		Op:           op,
		RestaurantID: z.RestaurantID,
		Payload:      *z,
	})
}

func recordZoneDeleteSync(tx *gorm.DB, zoneID string, restaurantID string) error {
	return synclog.Record(tx, synclog.Entry{
		Entity:       "zones",
		RowID:        zoneID,
		Op:           "delete",
		RestaurantID: &restaurantID,
	})
}
