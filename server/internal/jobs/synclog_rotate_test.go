//go:build integration

package jobs_test

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"gorm.io/datatypes"

	"github.com/restos/restos-v4/server/internal/db"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/jobs"
)

// TestSyncLogRotate — ротация журнала синка (ADR-003, Фаза О) удаляет только
// СТАРОЕ и УЖЕ ОТПРАВЛЕННОЕ.
//
// Критично, что именно она НЕ трогает: неотправленные дельты (касса могла
// простоять без интернета месяц — это ровно те данные, которые ещё должны
// уехать на central; удалить их значит потерять историю филиала безвозвратно)
// и карантинные строки (материал для разбора, их удаление скрыло бы проблему).
func TestSyncLogRotate(t *testing.T) {
	gdb, err := db.Open(testDSN())
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
	gdb.Exec("DELETE FROM sync_log")

	mk := func(name string, ageDays int, synced, quarantined bool) string {
		id := uuid.NewString()
		row := &models.SyncLog{
			ID: id, Entity: "orders", RowID: name, Op: "insert",
			Payload: datatypes.JSON(`{"id":"x"}`),
		}
		if err := gdb.Create(row).Error; err != nil {
			t.Fatal(err)
		}
		age := time.Duration(ageDays) * 24 * time.Hour
		ts := time.Now().UTC().Add(-age)
		upd := map[string]any{"created_at": ts}
		if synced {
			upd["synced_at"] = ts
		}
		if quarantined {
			upd["failed_at"] = ts
		}
		if err := gdb.Model(&models.SyncLog{}).Where("id = ?", id).Updates(upd).Error; err != nil {
			t.Fatal(err)
		}
		return id
	}

	oldSynced := mk("old-synced", 60, true, false)    // → удалить
	freshSynced := mk("fresh-synced", 3, true, false) // → оставить (свежее retention)
	oldPending := mk("old-pending", 60, false, false) // → оставить (ещё не уехало!)
	oldFailed := mk("old-failed", 60, false, true)    // → оставить (карантин, разбор)

	n, err := jobs.RunSyncLogRotateOnce(context.Background(), gdb, 30*24*time.Hour)
	if err != nil {
		t.Fatalf("RunSyncLogRotateOnce: %v", err)
	}
	if n != 1 {
		t.Errorf("удалено = %d, want 1", n)
	}

	exists := func(id string) bool {
		var c int64
		gdb.Model(&models.SyncLog{}).Where("id = ?", id).Count(&c)
		return c > 0
	}
	if exists(oldSynced) {
		t.Error("старая отправленная дельта не удалена — журнал продолжит расти")
	}
	if !exists(freshSynced) {
		t.Error("свежая отправленная удалена — retention не соблюдён")
	}
	if !exists(oldPending) {
		t.Error("УДАЛЕНА НЕОТПРАВЛЕННАЯ ДЕЛЬТА — потеря данных филиала, который был долго без связи")
	}
	if !exists(oldFailed) {
		t.Error("удалена карантинная строка — причина сбоя потеряна")
	}
}
