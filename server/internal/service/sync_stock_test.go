//go:build integration

package service

import (
	"encoding/json"
	"testing"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/db"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
	"github.com/restos/restos-v4/server/internal/synclog"
)

// TestRecordIngredientSync — whitebox-тест recordIngredientSync/
// recordIngredientDeleteSync (Ф3): insert/update/delete пишут по строке в
// sync_log с правильными Entity/RowID/Op. По образцу
// TestRecordMenuItemsSync/TestRecordTableSync.
func TestRecordIngredientSync(t *testing.T) {
	gdb, err := db.Open(syncOrdersTestDSN())
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	if err := db.MigrateUp(t.Context(), gdb); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})
	for _, tbl := range []string{"sync_log", "ingredients"} {
		if err := gdb.Exec("DELETE FROM " + tbl).Error; err != nil {
			t.Fatalf("clean %s: %v", tbl, err)
		}
	}
	synclog.SetEnabled(true)
	t.Cleanup(func() { synclog.SetEnabled(false) })

	restID := uuid.NewString()
	ingID := uuid.NewString()
	name := "Мука"
	ing := models.Ingredient{ID: ingID, Name: &name, RestaurantID: &restID, PricePerUnit: decimal.MustFromString("12")}

	if err := gdb.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(&ing).Error; err != nil {
			return err
		}
		return recordIngredientSync(tx, []string{ingID})
	}); err != nil {
		t.Fatalf("transaction (insert): %v", err)
	}
	if err := gdb.Transaction(func(tx *gorm.DB) error {
		return recordIngredientDeleteSync(tx, ingID, restID)
	}); err != nil {
		t.Fatalf("transaction (delete): %v", err)
	}

	var rows []models.SyncLog
	if err := gdb.Where("table_name = ? AND row_id = ?", "ingredients", ingID).
		Order("created_at ASC").Find(&rows).Error; err != nil {
		t.Fatalf("find sync_log: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("sync_log rows = %d, want 2 (insert + delete)", len(rows))
	}
	if rows[0].Op != "update" || rows[1].Op != "delete" {
		t.Errorf("ops = %s/%s, want update/delete", rows[0].Op, rows[1].Op)
	}
	var payload models.Ingredient
	if err := json.Unmarshal(rows[0].Payload, &payload); err != nil {
		t.Fatalf("unmarshal payload: %v", err)
	}
	if !payload.PricePerUnit.Equal(decimal.MustFromString("12")) {
		t.Errorf("payload.PricePerUnit = %s, want 12", payload.PricePerUnit.String())
	}
	if len(rows[1].Payload) != 0 {
		t.Errorf("delete payload = %s, want empty", rows[1].Payload)
	}

	// recordIngredientSync с пустым списком — no-op, не должен упасть.
	if err := gdb.Transaction(func(tx *gorm.DB) error {
		return recordIngredientSync(tx, nil)
	}); err != nil {
		t.Fatalf("recordIngredientSync(nil): %v", err)
	}
}

// TestStockMovementDenormSyncsIngredient — интеграционный тест самого
// критичного взаимодействия Ф3: создание StockMovement денормализует
// ingredients.qty (существующая логика, audit/stock_hook.go) И синкает снапшот
// ingredient в sync_log (новая точка, тот же хук) — ОДНИМ создание движения
// central должен узнать и о самом движении (generic trackedInsert), и об
// актуальном остатке (явный снапшот).
func TestStockMovementDenormSyncsIngredient(t *testing.T) {
	gdb, err := db.Open(syncOrdersTestDSN())
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	if err := db.MigrateUp(t.Context(), gdb); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})
	for _, tbl := range []string{"sync_log", "stock_movements", "ingredients"} {
		if err := gdb.Exec("DELETE FROM " + tbl).Error; err != nil {
			t.Fatalf("clean %s: %v", tbl, err)
		}
	}
	synclog.SetEnabled(true)
	t.Cleanup(func() { synclog.SetEnabled(false) })

	restID := uuid.NewString()
	ingID := uuid.NewString()
	name := "Сахар"
	ing := models.Ingredient{ID: ingID, Name: &name, RestaurantID: &restID, Qty: decimal.MustFromString("10")}
	if err := gdb.Create(&ing).Error; err != nil {
		t.Fatalf("create ingredient: %v", err)
	}

	mvID := uuid.NewString()
	mvType := "receipt"
	mv := models.StockMovement{
		ID: mvID, Type: &mvType, IngredientID: &ingID, Qty: decimal.MustFromString("5"), RestaurantID: &restID,
	}
	if err := gdb.Transaction(func(tx *gorm.DB) error {
		return tx.Create(&mv).Error
	}); err != nil {
		t.Fatalf("create movement: %v", err)
	}

	// qty денормализован (существующая логика, не тронута этой фазой).
	var afterIng models.Ingredient
	if err := gdb.First(&afterIng, "id = ?", ingID).Error; err != nil {
		t.Fatalf("reload ingredient: %v", err)
	}
	if !afterIng.Qty.Equal(decimal.MustFromString("15")) {
		t.Fatalf("qty after movement = %s, want 15", afterIng.Qty.String())
	}

	// sync_log получил ОБЕ дельты: сам движение (generic trackedInsert) и
	// снапшот ingredient (explicit, внутри stockAfterCreate).
	var mvLog []models.SyncLog
	if err := gdb.Where("table_name = ? AND row_id = ?", "stock_movements", mvID).Find(&mvLog).Error; err != nil {
		t.Fatalf("find movement sync_log: %v", err)
	}
	if len(mvLog) != 1 {
		t.Fatalf("stock_movements sync_log rows = %d, want 1", len(mvLog))
	}
	var ingLog []models.SyncLog
	if err := gdb.Where("table_name = ? AND row_id = ?", "ingredients", ingID).Find(&ingLog).Error; err != nil {
		t.Fatalf("find ingredient sync_log: %v", err)
	}
	if len(ingLog) != 1 {
		t.Fatalf("ingredients sync_log rows = %d, want 1", len(ingLog))
	}
	var payload models.Ingredient
	if err := json.Unmarshal(ingLog[0].Payload, &payload); err != nil {
		t.Fatalf("unmarshal payload: %v", err)
	}
	if !payload.Qty.Equal(decimal.MustFromString("15")) {
		t.Errorf("synced qty = %s, want 15 (снапшот ПОСЛЕ денормализации)", payload.Qty.String())
	}
}

// TestStockMovementSkipHooksNoDoubleCount — критичный regression-тест
// пререквизита Ф3: движение, применяемое с SkipHooks (симулирует
// applyStockMovement на central при приёме реплицированного движения с
// филиала), НЕ должно денормализовать qty повторно — central получает
// актуальный остаток отдельным снапшотом (ingredients), а не «проигрывая»
// движение. Без SkipHooks-гарда в stockAfterCreate central задвоил бы delta.
func TestStockMovementSkipHooksNoDoubleCount(t *testing.T) {
	gdb, err := db.Open(syncOrdersTestDSN())
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	if err := db.MigrateUp(t.Context(), gdb); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})
	for _, tbl := range []string{"sync_log", "stock_movements", "ingredients"} {
		if err := gdb.Exec("DELETE FROM " + tbl).Error; err != nil {
			t.Fatalf("clean %s: %v", tbl, err)
		}
	}
	synclog.SetEnabled(true)
	t.Cleanup(func() { synclog.SetEnabled(false) })

	restID := uuid.NewString()
	ingID := uuid.NewString()
	name := "Соль"
	// qty уже "денормализован" — как будто снапшот с филиала central уже
	// применил ДО этого движения (реалистичный порядок: applyIngredient
	// снапшотом мог прийти раньше или позже applyStockMovement, гонки нет
	// смысла бояться — денорм всё равно должен быть no-op под SkipHooks).
	ing := models.Ingredient{ID: ingID, Name: &name, RestaurantID: &restID, Qty: decimal.MustFromString("15")}
	if err := gdb.Create(&ing).Error; err != nil {
		t.Fatalf("create ingredient: %v", err)
	}

	mvID := uuid.NewString()
	mvType := "receipt"
	mv := models.StockMovement{
		ID: mvID, Type: &mvType, IngredientID: &ingID, Qty: decimal.MustFromString("5"), RestaurantID: &restID,
	}
	// Симулируем applyStockMovement: Session с SkipHooks:true, как на central.
	if err := gdb.Transaction(func(tx *gorm.DB) error {
		return tx.Session(&gorm.Session{SkipHooks: true}).Create(&mv).Error
	}); err != nil {
		t.Fatalf("create movement (SkipHooks): %v", err)
	}

	var afterIng models.Ingredient
	if err := gdb.First(&afterIng, "id = ?", ingID).Error; err != nil {
		t.Fatalf("reload ingredient: %v", err)
	}
	if !afterIng.Qty.Equal(decimal.MustFromString("15")) {
		t.Fatalf("qty after SkipHooks movement = %s, want 15 (unchanged — denorm must be no-op)", afterIng.Qty.String())
	}

	// Оба механизма — generic-рекордер (synclog/recorder_hook.go) и снапшот
	// склада (audit/stock_hook.go) — теперь уважают SkipHooks одинаково:
	// пришедшее ИЗ синка обратно в свой sync_log не пишется.
	//
	// Раньше рекордер SkipHooks игнорировал и дельту всё-таки писал, а тест
	// это закреплял как норму. Нормой оно не было — просто не вредило:
	// на central рекордер и так молчит (enabled=false), а на филиал из
	// pull-сущностей ни одна в tracked-списки не входила. Фаза Р это совпадение
	// сломала: филиалу поехали financial_operations (tracked), и старое
	// поведение отправляло бы зеркало обратно наверх, где upsert затирал бы
	// исходную проводку центра её же зеркалом — платёж терял бы счёт и исчезал
	// из кассы. См. skipReplicated.
	var mvLog, ingLog []models.SyncLog
	gdb.Where("table_name = ? AND row_id = ?", "stock_movements", mvID).Find(&mvLog)
	gdb.Where("table_name = ? AND row_id = ?", "ingredients", ingID).Find(&ingLog)
	if len(mvLog) != 0 {
		t.Errorf("stock_movements sync_log rows = %d, want 0 (реплицированное не рекордится повторно)", len(mvLog))
	}
	if len(ingLog) != 0 {
		t.Errorf("ingredients sync_log rows = %d, want 0 (stockAfterCreate ДОЛЖЕН уважать SkipHooks)", len(ingLog))
	}
}
