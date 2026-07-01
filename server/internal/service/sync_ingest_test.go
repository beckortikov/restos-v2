//go:build integration

package service_test

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/db"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
	"github.com/restos/restos-v4/server/internal/repo"
	"github.com/restos/restos-v4/server/internal/service"
)

// TestSyncIngest — приём дельт на центральном узле (ADR-003, Фаза 2):
// upsert перемещения из payload, идемпотентность, пропуск неизвестной сущности.
func TestSyncIngest(t *testing.T) {
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
	for _, tbl := range []string{"stock_transfer_lines", "stock_transfers", "financial_operations"} {
		if err := gdb.Exec("DELETE FROM " + tbl).Error; err != nil {
			t.Fatalf("clean %s: %v", tbl, err)
		}
	}

	svc := service.NewSyncService(repo.New(gdb))
	ctx := context.Background()

	// Собираем перемещение, каким его прислал бы филиал (payload sync_log).
	accountID := uuid.NewString()
	fromID, toID := uuid.NewString(), uuid.NewString()
	transferID := uuid.NewString()
	lineID := uuid.NewString()
	nomID := uuid.NewString()
	meat := "Мясо"
	transfer := models.StockTransfer{
		ID: transferID, AccountID: &accountID, FromRestaurantID: &fromID, ToRestaurantID: &toID,
		Status: "sent",
		Lines: []models.StockTransferLine{{
			ID: lineID, TransferID: &transferID, NomenclatureID: &nomID,
			IngredientName: &meat, Qty: decimal.MustFromString("30"),
		}},
	}
	payload, _ := json.Marshal(transfer)

	batch := service.IngestInput{Entries: []service.SyncEntry{
		{Entity: "stock_transfers", RowID: transferID, Op: "insert", Payload: payload},
		{Entity: "unknown_thing", RowID: "x", Op: "insert", Payload: json.RawMessage(`{}`)},
	}}

	// ─── Первый ingest ───────────────────────────────────────────────────
	res, err := svc.Ingest(ctx, batch)
	if err != nil {
		t.Fatalf("Ingest: %v", err)
	}
	if res.Applied != 1 || res.Skipped != 1 {
		t.Errorf("applied=%d skipped=%d, want 1/1", res.Applied, res.Skipped)
	}
	var got models.StockTransfer
	if err := gdb.First(&got, "id = ?", transferID).Error; err != nil {
		t.Fatalf("transfer not upserted: %v", err)
	}
	if got.Status != "sent" {
		t.Errorf("status = %s, want sent", got.Status)
	}
	var lineCount int64
	gdb.Model(&models.StockTransferLine{}).Where("transfer_id = ?", transferID).Count(&lineCount)
	if lineCount != 1 {
		t.Errorf("lines = %d, want 1", lineCount)
	}

	// ─── Повторный ingest с обновлённым статусом (идемпотентно, upsert) ──
	transfer.Status = "received"
	payload2, _ := json.Marshal(transfer)
	if _, err := svc.Ingest(ctx, service.IngestInput{Entries: []service.SyncEntry{
		{Entity: "stock_transfers", RowID: transferID, Op: "update", Payload: payload2},
	}}); err != nil {
		t.Fatalf("Ingest (repeat): %v", err)
	}
	gdb.First(&got, "id = ?", transferID)
	if got.Status != "received" {
		t.Errorf("status after upsert = %s, want received", got.Status)
	}

	// ─── financial_operations: upsert для сводки владельцу ───────────────
	rid := uuid.NewString()
	typ, cat := "in", "revenue"
	finID := uuid.NewString()
	finPayload, _ := json.Marshal(models.FinancialOperation{
		ID: finID, Type: &typ, Category: &cat, Amount: decimal.MustFromString("275"), RestaurantID: &rid,
	})
	fr, err := svc.Ingest(ctx, service.IngestInput{Entries: []service.SyncEntry{
		{Entity: "financial_operations", RowID: finID, Op: "insert", Payload: finPayload},
	}})
	if err != nil {
		t.Fatalf("Ingest finop: %v", err)
	}
	if fr.Applied != 1 {
		t.Errorf("finop applied = %d, want 1", fr.Applied)
	}
	var fin models.FinancialOperation
	if err := gdb.First(&fin, "id = ?", finID).Error; err != nil {
		t.Fatalf("finop not upserted: %v", err)
	}
	if !fin.Amount.Equal(decimal.MustFromString("275")) {
		t.Errorf("finop amount = %s, want 275", fin.Amount.String())
	}
	// Не задвоилось.
	var transferCount, lineCount2 int64
	gdb.Model(&models.StockTransfer{}).Where("id = ?", transferID).Count(&transferCount)
	gdb.Model(&models.StockTransferLine{}).Where("transfer_id = ?", transferID).Count(&lineCount2)
	if transferCount != 1 || lineCount2 != 1 {
		t.Errorf("after repeat: transfers=%d lines=%d, want 1/1", transferCount, lineCount2)
	}
}
