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

// TestStockTransfer_AutoCreatesNomenclature — CreateTransfer больше не требует
// заранее привязанной nomenclature_id (упрощение UX, ADR-004): ингредиент без
// неё должен автоматически завести запись в сетевом каталоге (из своего же
// имени/единицы) и привязаться к ней, а не откатывать перемещение ошибкой.
// Повторное перемещение того же (уже привязанного) ингредиента не должно
// создавать вторую запись каталога.
func TestStockTransfer_AutoCreatesNomenclature(t *testing.T) {
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

	// Ингредиент источника БЕЗ nomenclature_id — раньше CreateTransfer падал
	// на нём VALIDATION-ошибкой.
	srcIngID := uuid.NewString()
	onion, kg := "Лук репчатый", "kg"
	if err := gdb.Create(&models.Ingredient{
		ID: srcIngID, Name: &onion, Unit: &kg, Qty: decimal.MustFromString("50"),
		PricePerUnit: decimal.MustFromString("8"), RestaurantID: &centralID,
	}).Error; err != nil {
		t.Fatal(err)
	}

	svc := service.NewTransferService(repo.New(gdb))
	ctxCentral := tenant.WithRestaurant(context.Background(), centralID)

	tr, err := svc.CreateTransfer(ctxCentral, service.CreateTransferInput{
		ToRestaurantID: outletID,
		Lines:          []service.TransferLineInput{{IngredientID: srcIngID, Qty: "5"}},
	})
	if err != nil {
		t.Fatalf("CreateTransfer should auto-create nomenclature, not fail: %v", err)
	}
	if len(tr.Lines) != 1 || tr.Lines[0].NomenclatureID == nil {
		t.Fatalf("transfer line has no nomenclature_id: %+v", tr.Lines)
	}

	// Ингредиент источника теперь привязан.
	var src models.Ingredient
	if err := gdb.First(&src, "id = ?", srcIngID).Error; err != nil {
		t.Fatal(err)
	}
	if src.NomenclatureID == nil {
		t.Fatal("source ingredient nomenclature_id was not linked")
	}

	// Ровно одна запись каталога, с именем/единицей ингредиента.
	var noms []models.Nomenclature
	if err := gdb.Where("account_id = ?", accountID).Find(&noms).Error; err != nil {
		t.Fatal(err)
	}
	if len(noms) != 1 {
		t.Fatalf("nomenclature rows = %d, want 1", len(noms))
	}
	if noms[0].Name != onion {
		t.Errorf("nomenclature name = %q, want %q", noms[0].Name, onion)
	}
	if noms[0].Unit == nil || *noms[0].Unit != kg {
		t.Errorf("nomenclature unit = %v, want %q", noms[0].Unit, kg)
	}
	if *src.NomenclatureID != noms[0].ID {
		t.Errorf("ingredient nomenclature_id = %s, want %s", *src.NomenclatureID, noms[0].ID)
	}

	// ─── Второе перемещение того же ингредиента — без нового дубля каталога ──
	if _, err := svc.CreateTransfer(ctxCentral, service.CreateTransferInput{
		ToRestaurantID: outletID,
		Lines:          []service.TransferLineInput{{IngredientID: srcIngID, Qty: "2"}},
	}); err != nil {
		t.Fatalf("second CreateTransfer: %v", err)
	}
	var nomCount int64
	gdb.Model(&models.Nomenclature{}).Where("account_id = ?", accountID).Count(&nomCount)
	if nomCount != 1 {
		t.Errorf("nomenclature rows after second transfer = %d, want 1 (no duplicate)", nomCount)
	}
}

// TestStockTransfer_ReceiveMatchesExistingUnlinkedIngredient — получатель уже
// сам завёл у себя ингредиент с тем же именем/единицей (до какого-либо
// перемещения, nomenclature_id = NULL). Receive() обязан связать его с
// сетевой номенклатурой и зачислить приход НА НЕГО, а не создавать второй
// (дублирующий) ингредиент рядом.
func TestStockTransfer_ReceiveMatchesExistingUnlinkedIngredient(t *testing.T) {
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
	sugar, kg := "Сахар", "kg"
	if err := gdb.Create(&models.Nomenclature{ID: nomID, AccountID: &accountID, Name: sugar, Unit: &kg}).Error; err != nil {
		t.Fatal(err)
	}
	srcIngID := uuid.NewString()
	if err := gdb.Create(&models.Ingredient{
		ID: srcIngID, Name: &sugar, Unit: &kg, Qty: decimal.MustFromString("100"),
		PricePerUnit: decimal.MustFromString("10"), RestaurantID: &centralID, NomenclatureID: &nomID,
	}).Error; err != nil {
		t.Fatal(err)
	}

	// Получатель уже независимо завёл «Сахар» (kg) у себя, качество 5, ещё
	// НЕ привязанный ни к какой номенклатуре.
	preExistingID := uuid.NewString()
	if err := gdb.Create(&models.Ingredient{
		ID: preExistingID, Name: &sugar, Unit: &kg, Qty: decimal.MustFromString("5"),
		PricePerUnit: decimal.MustFromString("9"), RestaurantID: &outletID,
	}).Error; err != nil {
		t.Fatal(err)
	}

	svc := service.NewTransferService(repo.New(gdb))
	ctxCentral := tenant.WithRestaurant(context.Background(), centralID)
	ctxOutlet := tenant.WithRestaurant(context.Background(), outletID)

	tr, err := svc.CreateTransfer(ctxCentral, service.CreateTransferInput{
		ToRestaurantID: outletID,
		Lines:          []service.TransferLineInput{{IngredientID: srcIngID, Qty: "10"}},
	})
	if err != nil {
		t.Fatalf("CreateTransfer: %v", err)
	}
	if _, err := svc.Receive(ctxOutlet, tr.ID); err != nil {
		t.Fatalf("Receive: %v", err)
	}

	// Ровно один ингредиент «Сахар» у получателя — никакого дубля.
	var count int64
	gdb.Model(&models.Ingredient{}).Where("restaurant_id = ? AND name = ?", outletID, sugar).Count(&count)
	if count != 1 {
		t.Fatalf("outlet ingredients named %q = %d, want 1 (no duplicate)", sugar, count)
	}

	// Приход зачислен НА существующий ингредиент: qty 5 + 10 = 15, и он
	// теперь привязан к сетевой номенклатуре.
	var dest models.Ingredient
	if err := gdb.First(&dest, "id = ?", preExistingID).Error; err != nil {
		t.Fatal(err)
	}
	if !dest.Qty.Equal(decimal.MustFromString("15")) {
		t.Errorf("dest qty = %s, want 15 (5 existing + 10 transfer_in)", dest.Qty.String())
	}
	if dest.NomenclatureID == nil || *dest.NomenclatureID != nomID {
		t.Errorf("dest nomenclature_id = %v, want %s (linked, not left NULL)", dest.NomenclatureID, nomID)
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

// TestStockTransfer_RepricesOnReceive — приход перемещением участвует в
// средневзвешенной себестоимости получателя.
//
// Критично для ЦЕНТРАЛИЗОВАННОЙ ЗАКУПКИ (товар приходит в центр, оттуда
// перемещается по филиалам): филиал сам не закупает, и раньше цена ставилась
// ему один раз — при первом появлении товара — и держалась вечно. Центр берёт
// мясо по 50, передаёт; через месяц берёт по 70 и передаёт — у филиала в
// себестоимости остаётся 50. Фудкост занижен, прибыль завышена, и молча.
func TestStockTransfer_RepricesOnReceive(t *testing.T) {
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
		gdb.Exec("DELETE FROM " + tbl)
	}

	accountID := uuid.NewString()
	gdb.Create(&models.CompanyAccount{ID: accountID, Name: "Сеть"})
	centralID, branchID := uuid.NewString(), uuid.NewString()
	cw, ot := "central_warehouse", "outlet"
	gdb.Create(&models.Restaurant{ID: centralID, Name: "Центр", AccountID: &accountID, Kind: &cw})
	gdb.Create(&models.Restaurant{ID: branchID, Name: "Филиал", AccountID: &accountID, Kind: &ot})

	meat, kg := "Мясо", "kg"
	nomID := uuid.NewString()
	gdb.Create(&models.Nomenclature{ID: nomID, AccountID: &accountID, Name: meat, Unit: &kg})
	srcID := uuid.NewString()
	gdb.Create(&models.Ingredient{
		ID: srcID, Name: &meat, Unit: &kg, Qty: decimal.MustFromString("1000"),
		PricePerUnit: decimal.MustFromString("50"), RestaurantID: &centralID, NomenclatureID: &nomID,
	})

	svc := service.NewTransferService(repo.New(gdb))
	ctxCentral := audit.WithActor(tenant.WithRestaurant(context.Background(), centralID), audit.Actor{UserID: uuid.NewString()})
	ctxBranch := audit.WithActor(tenant.WithRestaurant(context.Background(), branchID), audit.Actor{UserID: uuid.NewString()})

	send := func(qty, cost string) {
		t.Helper()
		tr, err := svc.CreateTransfer(ctxCentral, service.CreateTransferInput{
			ToRestaurantID: branchID,
			Lines:          []service.TransferLineInput{{IngredientID: srcID, Qty: qty, CostPerUnit: cost}},
		})
		if err != nil {
			t.Fatalf("CreateTransfer: %v", err)
		}
		if _, err := svc.Receive(ctxBranch, tr.ID); err != nil {
			t.Fatalf("Receive: %v", err)
		}
	}

	// Первая передача: 10 кг по 50 → у филиала 10 кг по 50.
	send("10", "50")
	var dst models.Ingredient
	if err := gdb.Where("restaurant_id = ? AND nomenclature_id = ?", branchID, nomID).First(&dst).Error; err != nil {
		t.Fatalf("товар филиала не создан: %v", err)
	}
	if !dst.PricePerUnit.Equal(decimal.MustFromString("50")) {
		t.Fatalf("цена после первой передачи = %s, want 50", dst.PricePerUnit.String())
	}

	// Вторая передача: ещё 10 кг, но уже по 70.
	// Средневзвешенная: (10*50 + 10*70) / 20 = 60.
	send("10", "70")
	gdb.First(&dst, "id = ?", dst.ID)
	if !dst.Qty.Equal(decimal.MustFromString("20")) {
		t.Errorf("остаток = %s, want 20", dst.Qty.String())
	}
	if !dst.PricePerUnit.Equal(decimal.MustFromString("60")) {
		t.Errorf("СЕБЕСТОИМОСТЬ НЕ ПЕРЕОЦЕНЕНА: цена = %s, want 60 — фудкост филиала занижен",
			dst.PricePerUnit.String())
	}

	// Передача без явной цены берёт цену ИСТОЧНИКА (см. CreateTransfer), то
	// есть перемещение всегда несёт настоящую стоимость, а не ноль. Здесь у
	// центра 50 → (20*60 + 5*50) / 25 = 58.
	send("5", "")
	gdb.First(&dst, "id = ?", dst.ID)
	if !dst.PricePerUnit.Equal(decimal.MustFromString("58")) {
		t.Errorf("цена после передачи по цене источника = %s, want 58", dst.PricePerUnit.String())
	}
}
