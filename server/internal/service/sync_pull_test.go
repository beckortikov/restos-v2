//go:build integration

package service_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/db"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
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
	}}, ""); err != nil {
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
	}}, ""); err != nil {
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
	res, err := svc.PullFor(ctx, to, nil)
	if err != nil {
		t.Fatalf("PullFor: %v", err)
	}
	if len(res.Entries) != 1 || res.Entries[0].RowID != id1 {
		t.Errorf("PullFor returned %d entries, want 1 (only sent id1)", len(res.Entries))
	}
}

// TestSyncStatusEcho — Фаза Д2: отправитель узнаёт, что его документ приняли.
//
// Регресс-пруф: PullFor отдавал только доки, адресованные текущему узлу, а
// ApplyPulled принципиально не перезатирал локальные строки (insert-if-absent)
// — поэтому у ОТПРАВИТЕЛЯ статус навсегда оставался «отправлено», сколько бы
// раз получатель ни принял. Проверяем оба типа документов и оба инварианта
// эха: переход sent→received проходит, откат received→sent невозможен.
func TestSyncStatusEcho(t *testing.T) {
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
	for _, tbl := range []string{"stock_transfer_lines", "stock_transfers", "money_transfers"} {
		gdb.Exec("DELETE FROM " + tbl)
	}

	svc := service.NewSyncService(repo.New(gdb))
	ctx := context.Background()
	me, peer := uuid.NewString(), uuid.NewString()

	// Локально у ОТПРАВИТЕЛЯ оба документа — в статусе sent.
	stockID, moneyID := uuid.NewString(), uuid.NewString()
	if err := gdb.Create(&models.StockTransfer{
		ID: stockID, FromRestaurantID: &me, ToRestaurantID: &peer, Status: "sent",
	}).Error; err != nil {
		t.Fatal(err)
	}
	if err := gdb.Create(&models.MoneyTransfer{
		ID: moneyID, FromRestaurantID: &me, ToRestaurantID: &peer, Status: "sent",
		Amount: decimal.MustFromString("500"),
	}).Error; err != nil {
		t.Fatal(err)
	}

	// Central присылает их же со статусом received (получатель принял у себя).
	recvBy := uuid.NewString()
	now := time.Now().UTC()
	sp, _ := json.Marshal(models.StockTransfer{
		ID: stockID, FromRestaurantID: &me, ToRestaurantID: &peer, Status: "received",
		ReceivedAt: &now, ReceivedBy: &recvBy,
	})
	mp, _ := json.Marshal(models.MoneyTransfer{
		ID: moneyID, FromRestaurantID: &me, ToRestaurantID: &peer, Status: "received",
		Amount: decimal.MustFromString("500"), ReceivedAt: &now, ReceivedBy: &recvBy,
	})
	if _, err := svc.ApplyPulled(ctx, service.IngestInput{Entries: []service.SyncEntry{
		{Entity: "stock_transfers", RowID: stockID, Op: "insert", Payload: sp},
		{Entity: "money_transfers", RowID: moneyID, Op: "insert", Payload: mp},
	}}, me); err != nil {
		t.Fatalf("ApplyPulled: %v", err)
	}

	var gotStock models.StockTransfer
	gdb.First(&gotStock, "id = ?", stockID)
	if gotStock.Status != "received" {
		t.Errorf("stock_transfers status = %s, want received (эхо приёма не дошло до отправителя)", gotStock.Status)
	}
	if gotStock.ReceivedBy == nil || *gotStock.ReceivedBy != recvBy {
		t.Errorf("stock received_by = %v, want %s", gotStock.ReceivedBy, recvBy)
	}
	var gotMoney models.MoneyTransfer
	gdb.First(&gotMoney, "id = ?", moneyID)
	if gotMoney.Status != "received" {
		t.Errorf("money_transfers status = %s, want received", gotMoney.Status)
	}

	// ─── Откат received→sent невозможен (гонка «central ещё sent») ────────
	spStale, _ := json.Marshal(models.StockTransfer{
		ID: stockID, FromRestaurantID: &me, ToRestaurantID: &peer, Status: "sent",
	})
	mpStale, _ := json.Marshal(models.MoneyTransfer{
		ID: moneyID, FromRestaurantID: &me, ToRestaurantID: &peer, Status: "sent",
		Amount: decimal.MustFromString("500"),
	})
	if _, err := svc.ApplyPulled(ctx, service.IngestInput{Entries: []service.SyncEntry{
		{Entity: "stock_transfers", RowID: stockID, Op: "insert", Payload: spStale},
		{Entity: "money_transfers", RowID: moneyID, Op: "insert", Payload: mpStale},
	}}, me); err != nil {
		t.Fatalf("ApplyPulled (stale): %v", err)
	}
	gdb.First(&gotStock, "id = ?", stockID)
	if gotStock.Status != "received" {
		t.Errorf("устаревший pull откатил stock в %s — insert-if-absent нарушен", gotStock.Status)
	}
	gdb.First(&gotMoney, "id = ?", moneyID)
	if gotMoney.Status != "received" {
		t.Errorf("устаревший pull откатил money в %s", gotMoney.Status)
	}
}
