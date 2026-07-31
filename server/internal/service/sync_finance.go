package service

import (
	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/synclog"
)

// financial_accounts (ADR-003 «Central видит всё», Ф5) синкается generic
// trackedSave-хуком (synclog/recorder_hook.go) на Create/Update — см.
// комментарий там. Explicit нужен ТОЛЬКО для Delete (hard delete, хук его не
// ловит — trackedSave реагирует только на Create/Update, как и везде в этом
// плане: удаление всегда явное, см. Ф2-Ф4).

// recordFinancialAccountDeleteSync — FinancialAccountsService.Delete делает
// hard DELETE (единственная точка, после гардов «баланс=0» и «нет операций»).
func recordFinancialAccountDeleteSync(tx *gorm.DB, accountID string, restaurantID string) error {
	return synclog.Record(tx, synclog.Entry{
		Entity:       "financial_accounts",
		RowID:        accountID,
		Op:           "delete",
		RestaurantID: &restaurantID,
	})
}

// recordFinancialOpDeleteSync — закрывает известный пробел: generic
// trackedInsert-хук на financial_operations ловит только INSERT (append-only
// предположение), но DeleteExpense/DeleteOperation (shifts_extras.go) реально
// удаляют связанную финоперацию при отмене кассового расхода. Без этого
// вызова central хранил бы призрачную операцию вечно после того, как филиал
// её убрал.
func recordFinancialOpDeleteSync(tx *gorm.DB, opID string, restaurantID string) error {
	return synclog.Record(tx, synclog.Entry{
		Entity:       "financial_operations",
		RowID:        opID,
		Op:           "delete",
		RestaurantID: &restaurantID,
	})
}

// recurring_payments — плоский снапшот, explicit (не generic-хук): всего 4
// точки мутации (Create/Patch/Delete/Pay), в отличие от financial_accounts
// (~20 точек) — explicit здесь проще и безопаснее, тот же выбор что в Ф1-Ф4.
func recordRecurringPaymentSync(tx *gorm.DB, ids []string) error {
	if len(ids) == 0 {
		return nil
	}
	var rows []models.RecurringPayment
	if err := tx.Where("id IN ?", ids).Find(&rows).Error; err != nil {
		return err
	}
	for i := range rows {
		if err := synclog.Record(tx, synclog.Entry{
			Entity:       "recurring_payments",
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

// recordRecurringPaymentDeleteSync — RecurringPaymentsService.Delete делает
// hard DELETE (нет soft-delete поля на модели).
func recordRecurringPaymentDeleteSync(tx *gorm.DB, id string, restaurantID string) error {
	return synclog.Record(tx, synclog.Entry{
		Entity:       "recurring_payments",
		RowID:        id,
		Op:           "delete",
		RestaurantID: &restaurantID,
	})
}
