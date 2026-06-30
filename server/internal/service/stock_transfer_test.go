//go:build integration

package service_test

import (
	"context"
	"os"
	"testing"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/db"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
	"github.com/restos/restos-v4/server/internal/repo"
	"github.com/restos/restos-v4/server/internal/service"
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
		"stock_transfer_lines", "stock_transfers", "stock_movements",
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

	svc := service.NewTransferService(repo.New(gdb))
	ctxCentral := tenant.WithRestaurant(context.Background(), centralID)
	ctxOutlet := tenant.WithRestaurant(context.Background(), outletID)

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
}
