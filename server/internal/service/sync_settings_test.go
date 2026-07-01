//go:build integration

package service_test

import (
	"context"
	"testing"

	"github.com/restos/restos-v4/server/internal/db"
	"github.com/restos/restos-v4/server/internal/repo"
	"github.com/restos/restos-v4/server/internal/service"
)

// TestSyncSettings — конфиг sync из UI: дефолт → сохранить → прочитать (ADR-003/004).
func TestSyncSettings(t *testing.T) {
	gdb, err := db.Open(transferTestDSN())
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
	gdb.Exec("DELETE FROM sync_settings")

	svc := service.NewSyncSettingsService(repo.New(gdb))
	ctx := context.Background()

	// Дефолт: выключено, интервал 30.
	def, err := svc.Get(ctx)
	if err != nil {
		t.Fatalf("Get default: %v", err)
	}
	if def.Enabled || def.IntervalSec != 30 {
		t.Errorf("defaults = enabled:%v interval:%d, want false/30", def.Enabled, def.IntervalSec)
	}

	// Сохранить.
	if _, err := svc.Update(ctx, service.UpdateSyncSettingsInput{
		Enabled: true, CentralURL: "https://central.example.com", Token: "sekret",
		RestaurantID: "11111111-1111-1111-1111-111111111111", IntervalSec: 60,
	}); err != nil {
		t.Fatalf("Update: %v", err)
	}

	// Прочитать сохранённое.
	got, err := svc.Get(ctx)
	if err != nil {
		t.Fatalf("Get after save: %v", err)
	}
	if !got.Enabled || got.CentralURL == nil || *got.CentralURL != "https://central.example.com" ||
		got.Token == nil || *got.Token != "sekret" || got.IntervalSec != 60 {
		t.Errorf("saved settings mismatch: %+v", got)
	}

	// Повторное сохранение — singleton (upsert), не задваивается.
	if _, err := svc.Update(ctx, service.UpdateSyncSettingsInput{Enabled: false, IntervalSec: 30}); err != nil {
		t.Fatalf("Update 2: %v", err)
	}
	var cnt int64
	gdb.Table("sync_settings").Count(&cnt)
	if cnt != 1 {
		t.Errorf("sync_settings rows = %d, want 1 (singleton)", cnt)
	}
}
