package service

import (
	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/synclog"
)

// recordShiftSync пишет дельту кассовой смены в sync_log (ADR-003 «Central
// видит всё», Ф1). В отличие от заказов (см. recordOrderSync) — смена
// синхронизируется на КАЖДОЕ сохранение, а не только на терминальный переход:
// у смены нет «черновика», её агрегаты (cash_revenue/card_revenue/orders_count)
// осмысленны и нужны центральному узлу даже пока смена ещё открыта — иначе
// Z-отчёт с центрального отставал бы от реальности вплоть до закрытия смены.
func recordShiftSync(tx *gorm.DB, shift *models.CashShift, op string) error {
	return synclog.Record(tx, synclog.Entry{
		Entity:       "cash_shifts",
		RowID:        shift.ID,
		Op:           op,
		RestaurantID: shift.RestaurantID,
		Payload:      *shift,
	})
}

// recordShiftOpDeleteSync — явная запись удаления операции смены. INSERT
// покрыт generic-хуком (trackedInsert в recorder_hook.go), но DELETE хук не
// видит (AfterCreate-only) — здесь же, явно, в момент удаления.
func recordShiftOpDeleteSync(tx *gorm.DB, opID string, restaurantID string) error {
	return synclog.Record(tx, synclog.Entry{
		Entity:       "cash_shift_operations",
		RowID:        opID,
		Op:           "delete",
		RestaurantID: &restaurantID,
	})
}

// recordUserSync пишет дельту сотрудника в sync_log. PIN/Password несут
// json:"-" (см. models.User) — json.Marshal внутри synclog.Record вычищает их
// автоматически, секреты филиала на central не попадают.
func recordUserSync(tx *gorm.DB, u *models.User, op string) error {
	return synclog.Record(tx, synclog.Entry{
		Entity:       "users",
		RowID:        u.ID,
		Op:           op,
		RestaurantID: u.RestaurantID,
		Payload:      *u,
	})
}
