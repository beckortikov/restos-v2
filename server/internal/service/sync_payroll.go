package service

import (
	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/synclog"
)

// Ф5б «Персонал» (ADR-003 «Central видит всё») — последняя отложенная
// под-фаза плана: time_entries (табель), salary_worked_days/
// salary_day_multipliers (дневная оплата — override-таблицы, строка есть
// только когда день отличается от дефолта), salary_deductions (удержания),
// salary_advances (авансы). Все explicit (не generic-хук), как cash_shifts в
// Ф1: у каждой таблицы РЕАЛЬНЫЕ update-точки (ClockOut/Patch, отмена
// удержания/аванса), а у override-таблиц ещё и hard delete как штатная,
// частая операция (тык по календарю снимает отметку) — generic
// trackedInsert (insert-only) не годится сразу по двум причинам.

// ─── time_entries ───────────────────────────────────────────────────────

// recordTimeEntrySync — перечитывает строку по id ПОСЛЕ Create/Update (не
// полагается на значение из map-based Updates — тот же принцип, что и в
// Ф5 trackedSave/afterUpdate).
func recordTimeEntrySync(tx *gorm.DB, id string) error {
	var row models.TimeEntry
	if err := tx.Where("id = ?", id).First(&row).Error; err != nil {
		return err
	}
	return synclog.Record(tx, synclog.Entry{
		Entity:       "time_entries",
		RowID:        row.ID,
		Op:           "update",
		RestaurantID: row.RestaurantID,
		Payload:      row,
	})
}

// recordTimeEntryDeleteSync — TimeEntriesService.Delete делает hard DELETE.
func recordTimeEntryDeleteSync(tx *gorm.DB, id, restaurantID string) error {
	return synclog.Record(tx, synclog.Entry{
		Entity:       "time_entries",
		RowID:        id,
		Op:           "delete",
		RestaurantID: &restaurantID,
	})
}

// ─── salary_worked_days / salary_day_multipliers ───────────────────────────
// Обе — чистые override-таблицы: WorkDate/Multiplier не правятся задним
// числом, только создаются и удаляются целиком (тык/снятие в календаре).

func recordSalaryWorkedDaySync(tx *gorm.DB, row *models.SalaryWorkedDay) error {
	return synclog.Record(tx, synclog.Entry{
		Entity:       "salary_worked_days",
		RowID:        row.ID,
		Op:           "update",
		RestaurantID: row.RestaurantID,
		Payload:      *row,
	})
}

func recordSalaryWorkedDayDeleteSync(tx *gorm.DB, id, restaurantID string) error {
	return synclog.Record(tx, synclog.Entry{
		Entity:       "salary_worked_days",
		RowID:        id,
		Op:           "delete",
		RestaurantID: &restaurantID,
	})
}

func recordSalaryDayMultiplierSync(tx *gorm.DB, row *models.SalaryDayMultiplier) error {
	return synclog.Record(tx, synclog.Entry{
		Entity:       "salary_day_multipliers",
		RowID:        row.ID,
		Op:           "update",
		RestaurantID: row.RestaurantID,
		Payload:      *row,
	})
}

func recordSalaryDayMultiplierDeleteSync(tx *gorm.DB, id, restaurantID string) error {
	return synclog.Record(tx, synclog.Entry{
		Entity:       "salary_day_multipliers",
		RowID:        id,
		Op:           "delete",
		RestaurantID: &restaurantID,
	})
}

// ─── salary_deductions / salary_advances ────────────────────────────────
// Обе — create + soft-cancel (cancelled_at/by), НИКОГДА hard delete — сам
// апдейт (отмена) синкается тем же upsert-вызовом с уже отменённым снапшотом.

func recordSalaryDeductionSync(tx *gorm.DB, row *models.SalaryDeduction) error {
	return synclog.Record(tx, synclog.Entry{
		Entity:       "salary_deductions",
		RowID:        row.ID,
		Op:           "update",
		RestaurantID: row.RestaurantID,
		Payload:      *row,
	})
}

func recordSalaryAdvanceSync(tx *gorm.DB, row *models.SalaryAdvance) error {
	return synclog.Record(tx, synclog.Entry{
		Entity:       "salary_advances",
		RowID:        row.ID,
		Op:           "update",
		RestaurantID: row.RestaurantID,
		Payload:      *row,
	})
}
