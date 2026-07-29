//go:build integration

package service_test

import (
	"context"
	"os"
	"testing"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/audit"
	"github.com/restos/restos-v4/server/internal/db"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
	"github.com/restos/restos-v4/server/internal/repo"
	"github.com/restos/restos-v4/server/internal/service"
	"github.com/restos/restos-v4/server/internal/synclog"
)

func transferTestDSN() string {
	if v := os.Getenv("RESTOS_TEST_DSN"); v != "" {
		return v
	}
	return "host=127.0.0.1 port=5432 user=restos dbname=restos_v4_test sslmode=disable"
}

// TestStockTransfer_Flow — сквозной тест перемещения между филиалами сети
// (ADR-003, Фаза 1): центральный склад → филиал.
//
// Проверяет: списание у источника (transfer_out), приём у получателя
// (transfer_in) с авто-созданием ингредиента по nomenclature_id, парные
// stock_movements, идемпотентность Receive, защиту «только получатель примет».
func TestStockTransfer_Flow(t *testing.T) {
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
	for _, tbl := range []string{
		"sync_log", "stock_transfer_lines", "stock_transfers", "stock_movements",
		"ingredients", "nomenclature", "restaurants", "company_accounts",
	} {
		if err := gdb.Exec("DELETE FROM " + tbl).Error; err != nil {
			t.Fatalf("clean %s: %v", tbl, err)
		}
	}

	// Сеть: account + центральный склад + филиал.
	accountID := uuid.NewString()
	if err := gdb.Create(&models.CompanyAccount{ID: accountID, Name: "Сеть"}).Error; err != nil {
		t.Fatal(err)
	}
	centralID, outletID := uuid.NewString(), uuid.NewString()
	cw, ot := "central_warehouse", "outlet"
	if err := gdb.Create(&models.Restaurant{ID: centralID, Name: "Склад", AccountID: &accountID, Kind: &cw}).Error; err != nil {
		t.Fatal(err)
	}
	if err := gdb.Create(&models.Restaurant{ID: outletID, Name: "Филиал-1", AccountID: &accountID, Kind: &ot}).Error; err != nil {
		t.Fatal(err)
	}

	// Сетевая номенклатура «Мясо» + ингредиент источника (qty 100).
	nomID := uuid.NewString()
	meat, kg := "Мясо", "kg"
	if err := gdb.Create(&models.Nomenclature{ID: nomID, AccountID: &accountID, Name: meat, Unit: &kg}).Error; err != nil {
		t.Fatal(err)
	}
	srcIngID := uuid.NewString()
	if err := gdb.Create(&models.Ingredient{
		ID: srcIngID, Name: &meat, Unit: &kg, Qty: decimal.MustFromString("100"),
		PricePerUnit: decimal.MustFromString("20"), RestaurantID: &centralID, NomenclatureID: &nomID,
	}).Error; err != nil {
		t.Fatal(err)
	}

	synclog.SetEnabled(true) // проверяем запись дельт
	t.Cleanup(func() { synclog.SetEnabled(false) })

	svc := service.NewTransferService(repo.New(gdb))
	ctxCentral := tenant.WithRestaurant(context.Background(), centralID)
	outletUserID := uuid.NewString()
	ctxOutlet := audit.WithActor(tenant.WithRestaurant(context.Background(), outletID), audit.Actor{UserID: outletUserID})

	// ─── Отправка: центральный склад → филиал, 30 кг ─────────────────────
	tr, err := svc.CreateTransfer(ctxCentral, service.CreateTransferInput{
		ToRestaurantID: outletID,
		Lines:          []service.TransferLineInput{{IngredientID: srcIngID, Qty: "30"}},
	})
	if err != nil {
		t.Fatalf("CreateTransfer: %v", err)
	}
	if tr.Status != "sent" {
		t.Errorf("status = %s, want sent", tr.Status)
	}
	if len(tr.Lines) != 1 {
		t.Fatalf("lines = %d, want 1", len(tr.Lines))
	}

	// Остаток источника: 100 - 30 = 70.
	var src models.Ingredient
	gdb.First(&src, "id = ?", srcIngID)
	if !src.Qty.Equal(decimal.MustFromString("70")) {
		t.Errorf("source qty = %s, want 70", src.Qty.String())
	}

	// transfer_out движение есть, qty = -30.
	var outMv models.StockMovement
	if err := gdb.Where("restaurant_id = ? AND type = ?", centralID, "transfer_out").First(&outMv).Error; err != nil {
		t.Fatalf("transfer_out movement not found: %v", err)
	}
	if !outMv.Qty.Equal(decimal.MustFromString("-30")) {
		t.Errorf("transfer_out qty = %s, want -30", outMv.Qty.String())
	}

	// Получатель ещё ничего не получил.
	var destCount int64
	gdb.Model(&models.Ingredient{}).Where("restaurant_id = ?", outletID).Count(&destCount)
	if destCount != 0 {
		t.Errorf("dest ingredients before receive = %d, want 0", destCount)
	}

	// ─── Защита: источник не может «принять» ─────────────────────────────
	if _, err := svc.Receive(ctxCentral, tr.ID); err == nil {
		t.Errorf("Receive by sender should be forbidden")
	}

	// ─── Приём филиалом ──────────────────────────────────────────────────
	got, err := svc.Receive(ctxOutlet, tr.ID)
	if err != nil {
		t.Fatalf("Receive: %v", err)
	}
	if got.Status != "received" {
		t.Errorf("status = %s, want received", got.Status)
	}
	if got.ReceivedBy == nil || *got.ReceivedBy != outletUserID {
		t.Errorf("received_by = %v, want %s", got.ReceivedBy, outletUserID)
	}

	// У получателя появился ингредиент по nomenclature_id с qty 30.
	var dest models.Ingredient
	if err := gdb.Where("restaurant_id = ? AND nomenclature_id = ?", outletID, nomID).First(&dest).Error; err != nil {
		t.Fatalf("dest ingredient not created: %v", err)
	}
	if !dest.Qty.Equal(decimal.MustFromString("30")) {
		t.Errorf("dest qty = %s, want 30", dest.Qty.String())
	}

	// ─── Идемпотентность: повторный приём не задваивает ──────────────────
	if _, err := svc.Receive(ctxOutlet, tr.ID); err != nil {
		t.Fatalf("Receive (repeat): %v", err)
	}
	gdb.First(&dest, "id = ?", dest.ID)
	if !dest.Qty.Equal(decimal.MustFromString("30")) {
		t.Errorf("dest qty after repeat receive = %s, want 30 (no double)", dest.Qty.String())
	}

	// ─── sync_log: дельты записаны (insert при отправке + update при приёме) ──
	var syncRows []models.SyncLog
	if err := gdb.Where("table_name = ? AND row_id = ?", "stock_transfers", tr.ID).
		Order("created_at ASC").Find(&syncRows).Error; err != nil {
		t.Fatal(err)
	}
	if len(syncRows) != 2 {
		t.Fatalf("sync_log rows = %d, want 2 (insert+update)", len(syncRows))
	}
	if syncRows[0].Op != "insert" || syncRows[1].Op != "update" {
		t.Errorf("sync_log ops = %s,%s, want insert,update", syncRows[0].Op, syncRows[1].Op)
	}
	for _, r := range syncRows {
		if r.SyncedAt != nil {
			t.Errorf("sync_log row should be unsynced (synced_at NULL)")
		}
		if len(r.Payload) == 0 {
			t.Errorf("sync_log payload is empty")
		}
	}
}

// TestStockTransfer_ListIncludesLines — List() обязан отдавать Lines для
// каждого перемещения, а не только Get() для одного. Раньше List() делал
// голый Find(&out) без загрузки строк, и экран «Перемещения» показывал
// «Позиций: 0» для абсолютно любого перемещения независимо от состава —
// баг нашли вживую (создали перемещение из 1 позиции, список показал 0,
// хотя stock_transfer_lines в БД содержала строку корректно).
func TestStockTransfer_ListIncludesLines(t *testing.T) {
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
	for _, tbl := range []string{
		"sync_log", "stock_transfer_lines", "stock_transfers", "stock_movements",
		"ingredients", "nomenclature", "restaurants", "company_accounts",
	} {
		if err := gdb.Exec("DELETE FROM " + tbl).Error; err != nil {
			t.Fatalf("clean %s: %v", tbl, err)
		}
	}

	accountID := uuid.NewString()
	if err := gdb.Create(&models.CompanyAccount{ID: accountID, Name: "Сеть"}).Error; err != nil {
		t.Fatal(err)
	}
	centralID, outletID := uuid.NewString(), uuid.NewString()
	cw, ot := "central_warehouse", "outlet"
	if err := gdb.Create(&models.Restaurant{ID: centralID, Name: "Склад", AccountID: &accountID, Kind: &cw}).Error; err != nil {
		t.Fatal(err)
	}
	if err := gdb.Create(&models.Restaurant{ID: outletID, Name: "Филиал-1", AccountID: &accountID, Kind: &ot}).Error; err != nil {
		t.Fatal(err)
	}
	nomID := uuid.NewString()
	potato, kg := "Картофель", "kg"
	if err := gdb.Create(&models.Nomenclature{ID: nomID, AccountID: &accountID, Name: potato, Unit: &kg}).Error; err != nil {
		t.Fatal(err)
	}
	srcIngID := uuid.NewString()
	if err := gdb.Create(&models.Ingredient{
		ID: srcIngID, Name: &potato, Unit: &kg, Qty: decimal.MustFromString("10"),
		PricePerUnit: decimal.MustFromString("15"), RestaurantID: &centralID, NomenclatureID: &nomID,
	}).Error; err != nil {
		t.Fatal(err)
	}

	svc := service.NewTransferService(repo.New(gdb))
	ctxCentral := tenant.WithRestaurant(context.Background(), centralID)
	if _, err := svc.CreateTransfer(ctxCentral, service.CreateTransferInput{
		ToRestaurantID: outletID,
		Lines:          []service.TransferLineInput{{IngredientID: srcIngID, Qty: "3"}},
	}); err != nil {
		t.Fatalf("CreateTransfer: %v", err)
	}

	// List() — свежий вызов, а не переиспользование объекта из CreateTransfer.
	list, err := svc.List(ctxCentral)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("list length = %d, want 1", len(list))
	}
	if len(list[0].Lines) != 1 {
		t.Fatalf("list[0].Lines = %d, want 1 (List() must load lines like Get())", len(list[0].Lines))
	}
	if !list[0].Lines[0].Qty.Equal(decimal.MustFromString("3")) {
		t.Errorf("list[0].Lines[0].Qty = %s, want 3", list[0].Lines[0].Qty.String())
	}
}
