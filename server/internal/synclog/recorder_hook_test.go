//go:build integration

package synclog_test

import (
	"testing"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/db"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
	"github.com/restos/restos-v4/server/internal/synclog"
)

// TestRecorderHook_FinancialOp — AfterCreate-хук пишет финоп в sync_log
// (для сводки владельцу), и только когда запись включена (ADR-003, Фаза 2).
func TestRecorderHook_FinancialOp(t *testing.T) {
	gdb, err := db.Open(dsn())
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

	synclog.SetEnabled(true)
	t.Cleanup(func() { synclog.SetEnabled(false) })

	rid := uuid.NewString()
	typ, cat := "in", "revenue"

	// ─── Включено: финоп попадает в sync_log ─────────────────────────────
	op := &models.FinancialOperation{
		ID: uuid.NewString(), Type: &typ, Category: &cat,
		Amount: decimal.MustFromString("150"), RestaurantID: &rid,
	}
	if err := gdb.Create(op).Error; err != nil {
		t.Fatalf("create finop: %v", err)
	}
	var rows []models.SyncLog
	if err := gdb.Where("table_name = ? AND row_id = ?", "financial_operations", op.ID).Find(&rows).Error; err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 {
		t.Fatalf("sync_log rows = %d, want 1", len(rows))
	}
	if rows[0].Op != "insert" || rows[0].RestaurantID == nil || *rows[0].RestaurantID != rid {
		t.Errorf("bad sync_log row: op=%s rid=%v", rows[0].Op, rows[0].RestaurantID)
	}
	if len(rows[0].Payload) == 0 {
		t.Errorf("empty payload")
	}

	// ─── Выключено: не пишем (автономный режим) ──────────────────────────
	synclog.SetEnabled(false)
	op2 := &models.FinancialOperation{ID: uuid.NewString(), Type: &typ, RestaurantID: &rid}
	if err := gdb.Create(op2).Error; err != nil {
		t.Fatal(err)
	}
	var c int64
	gdb.Model(&models.SyncLog{}).Where("row_id = ?", op2.ID).Count(&c)
	if c != 0 {
		t.Errorf("recorded while disabled: %d rows, want 0", c)
	}
}
