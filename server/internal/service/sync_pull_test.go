//go:build integration

package service_test

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/db"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/repo"
	"github.com/restos/restos-v4/server/internal/service"
)

// TestSyncDownSync — down-sync (ADR-003 Фаза 2): PullFor отдаёт входящие sent,
// ApplyPulled вставляет отсутствующее, но НЕ откатывает локальный received
// (защита от гонки «central ещё sent, филиал уже received»).
func TestSyncDownSync(t *testing.T) {
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
	for _, tbl := range []string{"stock_transfer_lines", "stock_transfers"} {
		gdb.Exec("DELETE FROM " + tbl)
	}

	svc := service.NewSyncService(repo.New(gdb))
	ctx := context.Background()
	to := uuid.NewString()

	// ─── 1. ApplyPulled вставляет отсутствующее перемещение ──────────────
	id1 := uuid.NewString()
	p1, _ := json.Marshal(models.StockTransfer{ID: id1, ToRestaurantID: &to, Status: "sent"})
	if _, err := svc.ApplyPulled(ctx, service.IngestInput{Entries: []service.SyncEntry{
		{Entity: "stock_transfers", RowID: id1, Op: "insert", Payload: p1},
	}}); err != nil {
		t.Fatalf("ApplyPulled insert: %v", err)
	}
	var got1 models.StockTransfer
	if err := gdb.First(&got1, "id = ?", id1).Error; err != nil {
		t.Fatalf("transfer not inserted: %v", err)
	}
	if got1.Status != "sent" {
		t.Errorf("status = %s, want sent", got1.Status)
	}

	// ─── 2. Insert-if-absent НЕ откатывает локальный received ────────────
	id2 := uuid.NewString()
	// филиал уже принял локально:
	if err := gdb.Create(&models.StockTransfer{ID: id2, ToRestaurantID: &to, Status: "received"}).Error; err != nil {
		t.Fatal(err)
	}
	// центр всё ещё отдаёт его как sent:
	pSent, _ := json.Marshal(models.StockTransfer{ID: id2, ToRestaurantID: &to, Status: "sent"})
	if _, err := svc.ApplyPulled(ctx, service.IngestInput{Entries: []service.SyncEntry{
		{Entity: "stock_transfers", RowID: id2, Op: "insert", Payload: pSent},
	}}); err != nil {
		t.Fatalf("ApplyPulled existing: %v", err)
	}
	var got2 models.StockTransfer
	if err := gdb.First(&got2, "id = ?", id2).Error; err != nil {
		t.Fatalf("transfer id2 missing: %v", err)
	}
	if got2.Status != "received" {
		t.Errorf("pull reverted received→%s (want received): insert-if-absent нарушен", got2.Status)
	}

	// ─── 3. PullFor отдаёт только sent, адресованные филиалу ──────────────
	res, err := svc.PullFor(ctx, to)
	if err != nil {
		t.Fatalf("PullFor: %v", err)
	}
	if len(res.Entries) != 1 || res.Entries[0].RowID != id1 {
		t.Errorf("PullFor returned %d entries, want 1 (only sent id1)", len(res.Entries))
	}
}
