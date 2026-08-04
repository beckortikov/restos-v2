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
	for _, tbl := range []string{"stock_transfer_lines", "stock_transfers", "financial_operations", "order_items", "orders"} {
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

// orderSyncTestPayload — форма payload'а "orders" ровно как её реально
// строит recordOrderSync (server/internal/service/sync_orders.go): models.Order
// + срез Items. Тип объявлен здесь (не в service — orderSyncPayload
// неэкспортирован), но даёт идентичный JSON, потому что оба встраивают
// models.Order и добавляют одно поле items.
type orderSyncTestPayload struct {
	models.Order
	Items []models.OrderItem `json:"items"`
}

// TestSyncIngest_Orders — приём заказа филиала на central (ADR-003, Фаза 5):
// upsert заказа + позиций, идемпотентность повторного приёма (central — не
// авторитет по этим данным, только зеркало филиала).
func TestSyncIngest_Orders(t *testing.T) {
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
	for _, tbl := range []string{"order_items", "orders"} {
		if err := gdb.Exec("DELETE FROM " + tbl).Error; err != nil {
			t.Fatalf("clean %s: %v", tbl, err)
		}
	}

	svc := service.NewSyncService(repo.New(gdb))
	ctx := context.Background()

	branchID := uuid.NewString()
	orderID := uuid.NewString()
	itemID := uuid.NewString()
	closedStatus := "closed"
	dishName := "Плов"
	payload := orderSyncTestPayload{
		Order: models.Order{
			ID: orderID, OrderNumber: 7, Status: &closedStatus, RestaurantID: &branchID,
			Total: decimal.MustFromString("350"), TotalWithService: decimal.MustFromString("350"),
		},
		Items: []models.OrderItem{{
			ID: itemID, OrderID: &orderID, Name: &dishName,
			Qty: decimal.MustFromString("1"), Price: decimal.MustFromString("350"),
		}},
	}
	body, _ := json.Marshal(payload)

	res, err := svc.Ingest(ctx, service.IngestInput{Entries: []service.SyncEntry{
		{Entity: "orders", RowID: orderID, Op: "insert", Payload: body},
	}})
	if err != nil {
		t.Fatalf("Ingest: %v", err)
	}
	if res.Applied != 1 {
		t.Errorf("applied = %d, want 1", res.Applied)
	}

	var got models.Order
	if err := gdb.First(&got, "id = ?", orderID).Error; err != nil {
		t.Fatalf("order not upserted: %v", err)
	}
	if got.Status == nil || *got.Status != "closed" {
		t.Errorf("status = %v, want closed", got.Status)
	}
	if got.RestaurantID == nil || *got.RestaurantID != branchID {
		t.Errorf("restaurant_id = %v, want %s (реплицированная строка несёт restaurant_id филиала)", got.RestaurantID, branchID)
	}
	var items []models.OrderItem
	if err := gdb.Where("order_id = ?", orderID).Find(&items).Error; err != nil {
		t.Fatalf("find items: %v", err)
	}
	if len(items) != 1 || items[0].Name == nil || *items[0].Name != dishName {
		t.Fatalf("items = %+v, want 1 item %q", items, dishName)
	}

	// ─── Повторный приём того же заказа (напр. Refund после Close) — upsert,
	// не задваивает строки. ───────────────────────────────────────────────
	refundedStatus := "refunded"
	payload.Status = &refundedStatus
	payload.RefundedTotal = decimal.MustFromString("100")
	body2, _ := json.Marshal(payload)
	if _, err := svc.Ingest(ctx, service.IngestInput{Entries: []service.SyncEntry{
		{Entity: "orders", RowID: orderID, Op: "update", Payload: body2},
	}}); err != nil {
		t.Fatalf("Ingest (repeat): %v", err)
	}
	gdb.First(&got, "id = ?", orderID)
	if got.Status == nil || *got.Status != "refunded" {
		t.Errorf("status after upsert = %v, want refunded", got.Status)
	}
	var orderCount, itemCount int64
	gdb.Model(&models.Order{}).Where("id = ?", orderID).Count(&orderCount)
	gdb.Model(&models.OrderItem{}).Where("order_id = ?", orderID).Count(&itemCount)
	if orderCount != 1 || itemCount != 1 {
		t.Errorf("after repeat: orders=%d items=%d, want 1/1", orderCount, itemCount)
	}
}

// TestSyncIngest_Shift — приём кассовой смены на central (ADR-003 «Central
// видит всё», Ф1): upsert, идемпотентный повтор с обновлёнными агрегатами
// (central должен видеть свежую выручку ЕЩЁ открытой смены — см. recordShiftSync).
func TestSyncIngest_Shift(t *testing.T) {
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
	for _, tbl := range []string{"cash_shifts"} {
		if err := gdb.Exec("DELETE FROM " + tbl).Error; err != nil {
			t.Fatalf("clean %s: %v", tbl, err)
		}
	}

	svc := service.NewSyncService(repo.New(gdb))
	ctx := context.Background()

	branchID := uuid.NewString()
	shiftID := uuid.NewString()
	openStatus := "open"
	shift := models.CashShift{
		ID: shiftID, RestaurantID: &branchID, Status: &openStatus,
		OpeningBalance: decimal.MustFromString("500"),
		CashRevenue:    decimal.MustFromString("1200"),
		CardRevenue:    decimal.MustFromString("800"),
	}
	body, _ := json.Marshal(shift)

	res, err := svc.Ingest(ctx, service.IngestInput{Entries: []service.SyncEntry{
		{Entity: "cash_shifts", RowID: shiftID, Op: "insert", Payload: body},
	}})
	if err != nil {
		t.Fatalf("Ingest: %v", err)
	}
	if res.Applied != 1 {
		t.Errorf("applied = %d, want 1", res.Applied)
	}
	var got models.CashShift
	if err := gdb.First(&got, "id = ?", shiftID).Error; err != nil {
		t.Fatalf("shift not upserted: %v", err)
	}
	if !got.CashRevenue.Equal(decimal.MustFromString("1200")) {
		t.Errorf("cash_revenue = %s, want 1200", got.CashRevenue.String())
	}

	// ─── Смена ещё открыта, но агрегаты подросли (следующий order close) ──
	shift.CashRevenue = decimal.MustFromString("1550")
	closedStatus := "closed"
	shift.Status = &closedStatus
	body2, _ := json.Marshal(shift)
	if _, err := svc.Ingest(ctx, service.IngestInput{Entries: []service.SyncEntry{
		{Entity: "cash_shifts", RowID: shiftID, Op: "update", Payload: body2},
	}}); err != nil {
		t.Fatalf("Ingest (repeat): %v", err)
	}
	gdb.First(&got, "id = ?", shiftID)
	if !got.CashRevenue.Equal(decimal.MustFromString("1550")) {
		t.Errorf("cash_revenue after upsert = %s, want 1550", got.CashRevenue.String())
	}
	if got.Status == nil || *got.Status != "closed" {
		t.Errorf("status after upsert = %v, want closed", got.Status)
	}
	var shiftCount int64
	gdb.Model(&models.CashShift{}).Where("id = ?", shiftID).Count(&shiftCount)
	if shiftCount != 1 {
		t.Errorf("shifts = %d, want 1 (не задвоилось)", shiftCount)
	}
}

// TestSyncIngest_ShiftOp — приём операции смены: upsert на insert (генерируется
// generic-хуком trackedInsert на филиале), явный delete (DeleteExpense/
// DeleteOperation шлют Op:"delete" без payload — см. recordShiftOpDeleteSync).
func TestSyncIngest_ShiftOp(t *testing.T) {
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
	for _, tbl := range []string{"cash_shift_operations", "cash_shifts"} {
		if err := gdb.Exec("DELETE FROM " + tbl).Error; err != nil {
			t.Fatalf("clean %s: %v", tbl, err)
		}
	}

	svc := service.NewSyncService(repo.New(gdb))
	ctx := context.Background()

	shiftID := uuid.NewString()
	opID := uuid.NewString()
	typ := "cash_out"
	op := models.CashShiftOperation{
		ID: opID, ShiftID: &shiftID, Type: &typ, Amount: decimal.MustFromString("100"),
	}
	body, _ := json.Marshal(op)

	res, err := svc.Ingest(ctx, service.IngestInput{Entries: []service.SyncEntry{
		{Entity: "cash_shift_operations", RowID: opID, Op: "insert", Payload: body},
	}})
	if err != nil {
		t.Fatalf("Ingest: %v", err)
	}
	if res.Applied != 1 {
		t.Errorf("applied = %d, want 1", res.Applied)
	}
	var count int64
	gdb.Model(&models.CashShiftOperation{}).Where("id = ?", opID).Count(&count)
	if count != 1 {
		t.Fatalf("operation not upserted: count = %d", count)
	}

	// ─── Удаление (DeleteExpense/DeleteOperation на филиале) — payload пуст ─
	res2, err := svc.Ingest(ctx, service.IngestInput{Entries: []service.SyncEntry{
		{Entity: "cash_shift_operations", RowID: opID, Op: "delete", Payload: nil},
	}})
	if err != nil {
		t.Fatalf("Ingest (delete): %v", err)
	}
	if res2.Applied != 1 {
		t.Errorf("delete applied = %d, want 1", res2.Applied)
	}
	gdb.Model(&models.CashShiftOperation{}).Where("id = ?", opID).Count(&count)
	if count != 0 {
		t.Errorf("operation still present after delete: count = %d", count)
	}
}

// TestSyncIngest_User — приём сотрудника на central: upsert, и защитная
// проверка, что PIN/Password физически отсутствуют в payload (json:"-" на
// models.User — см. recordUserSync) → на central эти колонки NULL, реплицированный
// сотрудник филиала не может залогиниться на central (LoginByPIN фильтрует
// "pin IS NOT NULL", см. auth.go).
func TestSyncIngest_User(t *testing.T) {
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
	for _, tbl := range []string{"users"} {
		if err := gdb.Exec("DELETE FROM " + tbl).Error; err != nil {
			t.Fatalf("clean %s: %v", tbl, err)
		}
	}

	svc := service.NewSyncService(repo.New(gdb))
	ctx := context.Background()

	branchID := uuid.NewString()
	userID := uuid.NewString()
	name := "Официант Азиз"
	role := "waiter"
	// PIN/Password намеренно НЕ в payload'е — так их и не увидит
	// recordUserSync (json:"-" на models.User), симулируем реальный payload.
	rawPayload := []byte(`{"id":"` + userID + `","name":"` + name + `","role":"` + role + `","restaurant_id":"` + branchID + `"}`)

	res, err := svc.Ingest(ctx, service.IngestInput{Entries: []service.SyncEntry{
		{Entity: "users", RowID: userID, Op: "insert", Payload: rawPayload},
	}})
	if err != nil {
		t.Fatalf("Ingest: %v", err)
	}
	if res.Applied != 1 {
		t.Errorf("applied = %d, want 1", res.Applied)
	}
	var got models.User
	if err := gdb.First(&got, "id = ?", userID).Error; err != nil {
		t.Fatalf("user not upserted: %v", err)
	}
	if got.Name == nil || *got.Name != name {
		t.Errorf("name = %v, want %s", got.Name, name)
	}
	if got.PIN != nil {
		t.Errorf("PIN = %v, want nil (реплицированный сотрудник не должен логиниться на central)", *got.PIN)
	}
}

// TestSyncIngest_MenuItem — приём блюда меню на central (Ф2): upsert,
// идемпотентный повтор с изменившимися полями (цена/is_deleted).
func TestSyncIngest_MenuItem(t *testing.T) {
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
	for _, tbl := range []string{"menu_items"} {
		if err := gdb.Exec("DELETE FROM " + tbl).Error; err != nil {
			t.Fatalf("clean %s: %v", tbl, err)
		}
	}

	svc := service.NewSyncService(repo.New(gdb))
	ctx := context.Background()

	branchID := uuid.NewString()
	itemID := uuid.NewString()
	name := "Плов"
	category := "Основные блюда"
	mi := models.MenuItem{
		ID: itemID, Name: &name, Category: &category, RestaurantID: &branchID,
		Price: decimal.MustFromString("45"),
	}
	body, _ := json.Marshal(mi)

	res, err := svc.Ingest(ctx, service.IngestInput{Entries: []service.SyncEntry{
		{Entity: "menu_items", RowID: itemID, Op: "update", Payload: body},
	}})
	if err != nil {
		t.Fatalf("Ingest: %v", err)
	}
	if res.Applied != 1 {
		t.Errorf("applied = %d, want 1", res.Applied)
	}
	var got models.MenuItem
	if err := gdb.First(&got, "id = ?", itemID).Error; err != nil {
		t.Fatalf("menu item not upserted: %v", err)
	}
	if !got.Price.Equal(decimal.MustFromString("45")) {
		t.Errorf("price = %s, want 45", got.Price.String())
	}

	// ─── Повтор: цена изменилась + архивация (is_deleted=true) — soft-delete
	// приезжает обычным upsert'ом, отдельная delete-ветка не нужна. ─────────
	mi.Price = decimal.MustFromString("50")
	mi.IsDeleted = true
	body2, _ := json.Marshal(mi)
	if _, err := svc.Ingest(ctx, service.IngestInput{Entries: []service.SyncEntry{
		{Entity: "menu_items", RowID: itemID, Op: "update", Payload: body2},
	}}); err != nil {
		t.Fatalf("Ingest (repeat): %v", err)
	}
	gdb.First(&got, "id = ?", itemID)
	if !got.Price.Equal(decimal.MustFromString("50")) {
		t.Errorf("price after upsert = %s, want 50", got.Price.String())
	}
	if !got.IsDeleted {
		t.Errorf("is_deleted after upsert = false, want true")
	}
	var count int64
	gdb.Model(&models.MenuItem{}).Where("id = ?", itemID).Count(&count)
	if count != 1 {
		t.Errorf("menu_items = %d, want 1 (не задвоилось)", count)
	}
}

// TestSyncIngest_Table — приём стола на central (Ф2): upsert + hard delete
// (в отличие от menu_items — здесь настоящий DELETE).
func TestSyncIngest_Table(t *testing.T) {
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
	for _, tbl := range []string{"tables"} {
		if err := gdb.Exec("DELETE FROM " + tbl).Error; err != nil {
			t.Fatalf("clean %s: %v", tbl, err)
		}
	}

	svc := service.NewSyncService(repo.New(gdb))
	ctx := context.Background()

	branchID := uuid.NewString()
	tableID := uuid.NewString()
	num := 7
	tbl := models.Table{ID: tableID, Number: &num, RestaurantID: &branchID}
	body, _ := json.Marshal(tbl)

	res, err := svc.Ingest(ctx, service.IngestInput{Entries: []service.SyncEntry{
		{Entity: "tables", RowID: tableID, Op: "insert", Payload: body},
	}})
	if err != nil {
		t.Fatalf("Ingest: %v", err)
	}
	if res.Applied != 1 {
		t.Errorf("applied = %d, want 1", res.Applied)
	}
	var count int64
	gdb.Model(&models.Table{}).Where("id = ?", tableID).Count(&count)
	if count != 1 {
		t.Fatalf("table not upserted: count = %d", count)
	}

	res2, err := svc.Ingest(ctx, service.IngestInput{Entries: []service.SyncEntry{
		{Entity: "tables", RowID: tableID, Op: "delete", Payload: nil},
	}})
	if err != nil {
		t.Fatalf("Ingest (delete): %v", err)
	}
	if res2.Applied != 1 {
		t.Errorf("delete applied = %d, want 1", res2.Applied)
	}
	gdb.Model(&models.Table{}).Where("id = ?", tableID).Count(&count)
	if count != 0 {
		t.Errorf("table still present after delete: count = %d", count)
	}
}

// TestSyncIngest_Zone — приём зоны на central (Ф2): upsert + hard delete.
func TestSyncIngest_Zone(t *testing.T) {
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
	for _, tbl := range []string{"zones"} {
		if err := gdb.Exec("DELETE FROM " + tbl).Error; err != nil {
			t.Fatalf("clean %s: %v", tbl, err)
		}
	}

	svc := service.NewSyncService(repo.New(gdb))
	ctx := context.Background()

	branchID := uuid.NewString()
	zoneID := uuid.NewString()
	z := models.Zone{ID: zoneID, Name: "Летняя веранда", RestaurantID: &branchID}
	body, _ := json.Marshal(z)

	res, err := svc.Ingest(ctx, service.IngestInput{Entries: []service.SyncEntry{
		{Entity: "zones", RowID: zoneID, Op: "insert", Payload: body},
	}})
	if err != nil {
		t.Fatalf("Ingest: %v", err)
	}
	if res.Applied != 1 {
		t.Errorf("applied = %d, want 1", res.Applied)
	}
	var count int64
	gdb.Model(&models.Zone{}).Where("id = ?", zoneID).Count(&count)
	if count != 1 {
		t.Fatalf("zone not upserted: count = %d", count)
	}

	res2, err := svc.Ingest(ctx, service.IngestInput{Entries: []service.SyncEntry{
		{Entity: "zones", RowID: zoneID, Op: "delete", Payload: nil},
	}})
	if err != nil {
		t.Fatalf("Ingest (delete): %v", err)
	}
	if res2.Applied != 1 {
		t.Errorf("delete applied = %d, want 1", res2.Applied)
	}
	gdb.Model(&models.Zone{}).Where("id = ?", zoneID).Count(&count)
	if count != 0 {
		t.Errorf("zone still present after delete: count = %d", count)
	}
}

// TestSyncIngest_Ingredient — приём ингредиента на central (Ф3): upsert +
// hard delete.
func TestSyncIngest_Ingredient(t *testing.T) {
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
	for _, tbl := range []string{"ingredients"} {
		if err := gdb.Exec("DELETE FROM " + tbl).Error; err != nil {
			t.Fatalf("clean %s: %v", tbl, err)
		}
	}

	svc := service.NewSyncService(repo.New(gdb))
	ctx := context.Background()

	branchID := uuid.NewString()
	ingID := uuid.NewString()
	name := "Мука"
	ing := models.Ingredient{ID: ingID, Name: &name, RestaurantID: &branchID, Qty: decimal.MustFromString("20")}
	body, _ := json.Marshal(ing)

	res, err := svc.Ingest(ctx, service.IngestInput{Entries: []service.SyncEntry{
		{Entity: "ingredients", RowID: ingID, Op: "update", Payload: body},
	}})
	if err != nil {
		t.Fatalf("Ingest: %v", err)
	}
	if res.Applied != 1 {
		t.Errorf("applied = %d, want 1", res.Applied)
	}
	var got models.Ingredient
	if err := gdb.First(&got, "id = ?", ingID).Error; err != nil {
		t.Fatalf("ingredient not upserted: %v", err)
	}
	if !got.Qty.Equal(decimal.MustFromString("20")) {
		t.Errorf("qty = %s, want 20", got.Qty.String())
	}

	// Повтор с изменённым qty (снапшот после следующего движения) — upsert.
	ing.Qty = decimal.MustFromString("35")
	body2, _ := json.Marshal(ing)
	if _, err := svc.Ingest(ctx, service.IngestInput{Entries: []service.SyncEntry{
		{Entity: "ingredients", RowID: ingID, Op: "update", Payload: body2},
	}}); err != nil {
		t.Fatalf("Ingest (repeat): %v", err)
	}
	gdb.First(&got, "id = ?", ingID)
	if !got.Qty.Equal(decimal.MustFromString("35")) {
		t.Errorf("qty after upsert = %s, want 35", got.Qty.String())
	}

	res2, err := svc.Ingest(ctx, service.IngestInput{Entries: []service.SyncEntry{
		{Entity: "ingredients", RowID: ingID, Op: "delete", Payload: nil},
	}})
	if err != nil {
		t.Fatalf("Ingest (delete): %v", err)
	}
	if res2.Applied != 1 {
		t.Errorf("delete applied = %d, want 1", res2.Applied)
	}
	var count int64
	gdb.Model(&models.Ingredient{}).Where("id = ?", ingID).Count(&count)
	if count != 0 {
		t.Errorf("ingredient still present after delete: count = %d", count)
	}
}

// TestSyncIngest_StockMovement — приём движения склада на central (Ф3):
// upsert, append-only (нет delete-ветки — движения не удаляются).
func TestSyncIngest_StockMovement(t *testing.T) {
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
	for _, tbl := range []string{"stock_movements"} {
		if err := gdb.Exec("DELETE FROM " + tbl).Error; err != nil {
			t.Fatalf("clean %s: %v", tbl, err)
		}
	}

	svc := service.NewSyncService(repo.New(gdb))
	ctx := context.Background()

	branchID := uuid.NewString()
	ingID := uuid.NewString()
	mvID := uuid.NewString()
	mvType := "receipt"
	mv := models.StockMovement{
		ID: mvID, Type: &mvType, IngredientID: &ingID, Qty: decimal.MustFromString("8"), RestaurantID: &branchID,
	}
	body, _ := json.Marshal(mv)

	res, err := svc.Ingest(ctx, service.IngestInput{Entries: []service.SyncEntry{
		{Entity: "stock_movements", RowID: mvID, Op: "insert", Payload: body},
	}})
	if err != nil {
		t.Fatalf("Ingest: %v", err)
	}
	if res.Applied != 1 {
		t.Errorf("applied = %d, want 1", res.Applied)
	}
	var got models.StockMovement
	if err := gdb.First(&got, "id = ?", mvID).Error; err != nil {
		t.Fatalf("movement not upserted: %v", err)
	}
	if !got.Qty.Equal(decimal.MustFromString("8")) {
		t.Errorf("qty = %s, want 8", got.Qty.String())
	}
	// Повторный приём (идемпотентность Pusher'а) — не задваивает строку, и
	// НЕ должен повторно денормализовать central-копию ingredient (проверено
	// отдельно в TestStockMovementSkipHooksNoDoubleCount — applyStockMovement
	// использует ту же Session(SkipHooks:true), что и остальные apply*).
	if _, err := svc.Ingest(ctx, service.IngestInput{Entries: []service.SyncEntry{
		{Entity: "stock_movements", RowID: mvID, Op: "insert", Payload: body},
	}}); err != nil {
		t.Fatalf("Ingest (repeat): %v", err)
	}
	var count int64
	gdb.Model(&models.StockMovement{}).Where("id = ?", mvID).Count(&count)
	if count != 1 {
		t.Errorf("stock_movements = %d, want 1 (не задвоилось)", count)
	}
}

// receiptSyncTestPayload — форма payload'а "stock_receipts", как её строит
// recordReceiptSync (sync_docs.go): models.StockReceipt + срез Lines.
type receiptSyncTestPayload struct {
	models.StockReceipt
	Lines []models.StockReceiptLine `json:"lines"`
}

// TestSyncIngest_StockReceipt — приём накладной приёмки на central (Ф4):
// upsert шапки + строк, идемпотентный повтор (напр. после PayReceipt меняется
// debt_amount, строки те же).
func TestSyncIngest_StockReceipt(t *testing.T) {
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
	for _, tbl := range []string{"stock_receipt_lines", "stock_receipts"} {
		if err := gdb.Exec("DELETE FROM " + tbl).Error; err != nil {
			t.Fatalf("clean %s: %v", tbl, err)
		}
	}

	svc := service.NewSyncService(repo.New(gdb))
	ctx := context.Background()

	branchID := uuid.NewString()
	receiptID := uuid.NewString()
	lineID := uuid.NewString()
	flour := "Мука"
	payload := receiptSyncTestPayload{
		StockReceipt: models.StockReceipt{
			ID: receiptID, RestaurantID: &branchID,
			TotalAmount: decimal.MustFromString("1000"), DebtAmount: decimal.MustFromString("1000"),
		},
		Lines: []models.StockReceiptLine{{
			ID: lineID, ReceiptID: &receiptID, Name: &flour,
			Qty: decimal.MustFromString("10"), PricePerUnit: decimal.MustFromString("100"),
		}},
	}
	body, _ := json.Marshal(payload)

	res, err := svc.Ingest(ctx, service.IngestInput{Entries: []service.SyncEntry{
		{Entity: "stock_receipts", RowID: receiptID, Op: "insert", Payload: body},
	}})
	if err != nil {
		t.Fatalf("Ingest: %v", err)
	}
	if res.Applied != 1 {
		t.Errorf("applied = %d, want 1", res.Applied)
	}
	var got models.StockReceipt
	if err := gdb.First(&got, "id = ?", receiptID).Error; err != nil {
		t.Fatalf("receipt not upserted: %v", err)
	}
	if !got.DebtAmount.Equal(decimal.MustFromString("1000")) {
		t.Errorf("debt_amount = %s, want 1000", got.DebtAmount.String())
	}
	var lines []models.StockReceiptLine
	gdb.Where("receipt_id = ?", receiptID).Find(&lines)
	if len(lines) != 1 {
		t.Fatalf("lines = %d, want 1", len(lines))
	}

	// Повтор после PayReceipt (debt_amount уменьшился, строки не изменились).
	payload.DebtAmount = decimal.Zero
	body2, _ := json.Marshal(payload)
	if _, err := svc.Ingest(ctx, service.IngestInput{Entries: []service.SyncEntry{
		{Entity: "stock_receipts", RowID: receiptID, Op: "update", Payload: body2},
	}}); err != nil {
		t.Fatalf("Ingest (repeat): %v", err)
	}
	gdb.First(&got, "id = ?", receiptID)
	if !got.DebtAmount.IsZero() {
		t.Errorf("debt_amount after upsert = %s, want 0", got.DebtAmount.String())
	}
	var receiptCount, lineCount int64
	gdb.Model(&models.StockReceipt{}).Where("id = ?", receiptID).Count(&receiptCount)
	gdb.Model(&models.StockReceiptLine{}).Where("receipt_id = ?", receiptID).Count(&lineCount)
	if receiptCount != 1 || lineCount != 1 {
		t.Errorf("after repeat: receipts=%d lines=%d, want 1/1", receiptCount, lineCount)
	}
}

// writeoffSyncTestPayload — форма payload'а "stock_writeoffs" (sync_docs.go).
type writeoffSyncTestPayload struct {
	models.StockWriteoff
	Lines []models.StockWriteoffLine `json:"lines"`
}

// TestSyncIngest_StockWriteoff — приём списания на central (Ф4): upsert
// шапки (с уже пересчитанным total_cost) + строк.
func TestSyncIngest_StockWriteoff(t *testing.T) {
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
	for _, tbl := range []string{"stock_writeoff_lines", "stock_writeoffs"} {
		if err := gdb.Exec("DELETE FROM " + tbl).Error; err != nil {
			t.Fatalf("clean %s: %v", tbl, err)
		}
	}

	svc := service.NewSyncService(repo.New(gdb))
	ctx := context.Background()

	branchID := uuid.NewString()
	writeoffID := uuid.NewString()
	lineID := uuid.NewString()
	sugar := "Сахар"
	payload := writeoffSyncTestPayload{
		StockWriteoff: models.StockWriteoff{
			ID: writeoffID, RestaurantID: &branchID, TotalCost: decimal.MustFromString("250"),
		},
		Lines: []models.StockWriteoffLine{{
			ID: lineID, WriteoffID: &writeoffID, Name: &sugar,
			Qty: decimal.MustFromString("5"), Cost: decimal.MustFromString("250"),
		}},
	}
	body, _ := json.Marshal(payload)

	res, err := svc.Ingest(ctx, service.IngestInput{Entries: []service.SyncEntry{
		{Entity: "stock_writeoffs", RowID: writeoffID, Op: "insert", Payload: body},
	}})
	if err != nil {
		t.Fatalf("Ingest: %v", err)
	}
	if res.Applied != 1 {
		t.Errorf("applied = %d, want 1", res.Applied)
	}
	var got models.StockWriteoff
	if err := gdb.First(&got, "id = ?", writeoffID).Error; err != nil {
		t.Fatalf("writeoff not upserted: %v", err)
	}
	if !got.TotalCost.Equal(decimal.MustFromString("250")) {
		t.Errorf("total_cost = %s, want 250", got.TotalCost.String())
	}
	var lineCount int64
	gdb.Model(&models.StockWriteoffLine{}).Where("writeoff_id = ?", writeoffID).Count(&lineCount)
	if lineCount != 1 {
		t.Errorf("lines = %d, want 1", lineCount)
	}
}

// inventorySyncTestPayload — форма payload'а "inventory_checks" (sync_docs.go).
type inventorySyncTestPayload struct {
	models.InventoryCheck
	Lines []models.InventoryCheckLine `json:"lines"`
}

// TestSyncIngest_InventoryCheck — приём инвентаризации на central (Ф4):
// upsert, приходит дважды за жизненный цикл (draft, потом applied) —
// повторный upsert меняет только status/applied_at.
func TestSyncIngest_InventoryCheck(t *testing.T) {
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
	for _, tbl := range []string{"inventory_check_lines", "inventory_checks"} {
		if err := gdb.Exec("DELETE FROM " + tbl).Error; err != nil {
			t.Fatalf("clean %s: %v", tbl, err)
		}
	}

	svc := service.NewSyncService(repo.New(gdb))
	ctx := context.Background()

	branchID := uuid.NewString()
	checkID := uuid.NewString()
	lineID := uuid.NewString()
	ingID := uuid.NewString()
	payload := inventorySyncTestPayload{
		InventoryCheck: models.InventoryCheck{
			ID: checkID, RestaurantID: branchID, ConductedBy: "Кладовщик", Status: "draft",
		},
		Lines: []models.InventoryCheckLine{{
			ID: lineID, CheckID: checkID, Kind: "ingredient", IngredientID: ingID,
			IngredientName: "Мука", Unit: "кг", RestaurantID: branchID,
			SystemQty: decimal.MustFromString("10"), ActualQty: decimal.MustFromString("9"),
			Diff: decimal.MustFromString("-1"),
		}},
	}
	body, _ := json.Marshal(payload)

	res, err := svc.Ingest(ctx, service.IngestInput{Entries: []service.SyncEntry{
		{Entity: "inventory_checks", RowID: checkID, Op: "insert", Payload: body},
	}})
	if err != nil {
		t.Fatalf("Ingest: %v", err)
	}
	if res.Applied != 1 {
		t.Errorf("applied = %d, want 1", res.Applied)
	}
	var got models.InventoryCheck
	if err := gdb.First(&got, "id = ?", checkID).Error; err != nil {
		t.Fatalf("check not upserted: %v", err)
	}
	if got.Status != "draft" {
		t.Errorf("status = %s, want draft", got.Status)
	}
	var lineCount int64
	gdb.Model(&models.InventoryCheckLine{}).Where("check_id = ?", checkID).Count(&lineCount)
	if lineCount != 1 {
		t.Errorf("lines = %d, want 1", lineCount)
	}

	// Повтор после Apply — status меняется на applied.
	payload.Status = "applied"
	body2, _ := json.Marshal(payload)
	if _, err := svc.Ingest(ctx, service.IngestInput{Entries: []service.SyncEntry{
		{Entity: "inventory_checks", RowID: checkID, Op: "update", Payload: body2},
	}}); err != nil {
		t.Fatalf("Ingest (repeat): %v", err)
	}
	gdb.First(&got, "id = ?", checkID)
	if got.Status != "applied" {
		t.Errorf("status after upsert = %s, want applied", got.Status)
	}
	var lineCount2 int64
	gdb.Model(&models.InventoryCheckLine{}).Where("check_id = ?", checkID).Count(&lineCount2)
	if lineCount2 != 1 {
		t.Errorf("lines after repeat = %d, want 1 (не задвоились)", lineCount2)
	}
}

// returnSyncTestPayload — форма payload'а "stock_returns" (sync_docs.go).
type returnSyncTestPayload struct {
	models.StockReturn
	Lines []models.StockReturnLine `json:"lines"`
}

// TestSyncIngest_StockReturn — приём возврата поставщику на central (Ф4):
// upsert, приходит дважды (CreateReturn, потом CancelReturn) — повторный
// upsert проставляет cancelled_at/cancelled_by.
func TestSyncIngest_StockReturn(t *testing.T) {
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
	for _, tbl := range []string{"stock_return_lines", "stock_returns"} {
		if err := gdb.Exec("DELETE FROM " + tbl).Error; err != nil {
			t.Fatalf("clean %s: %v", tbl, err)
		}
	}

	svc := service.NewSyncService(repo.New(gdb))
	ctx := context.Background()

	branchID := uuid.NewString()
	receiptID := uuid.NewString()
	returnID := uuid.NewString()
	lineID := uuid.NewString()
	receiptLineID := uuid.NewString()
	payload := returnSyncTestPayload{
		StockReturn: models.StockReturn{
			ID: returnID, ReceiptID: receiptID, RestaurantID: &branchID,
			Reason: "spoilage", RefundType: "debt", TotalAmount: decimal.MustFromString("50"),
		},
		Lines: []models.StockReturnLine{{
			ID: lineID, ReturnID: returnID, ReceiptLineID: receiptLineID,
			Qty: decimal.MustFromString("1"), PricePerUnit: decimal.MustFromString("50"),
		}},
	}
	body, _ := json.Marshal(payload)

	res, err := svc.Ingest(ctx, service.IngestInput{Entries: []service.SyncEntry{
		{Entity: "stock_returns", RowID: returnID, Op: "insert", Payload: body},
	}})
	if err != nil {
		t.Fatalf("Ingest: %v", err)
	}
	if res.Applied != 1 {
		t.Errorf("applied = %d, want 1", res.Applied)
	}
	var got models.StockReturn
	if err := gdb.First(&got, "id = ?", returnID).Error; err != nil {
		t.Fatalf("return not upserted: %v", err)
	}
	if got.CancelledAt != nil {
		t.Errorf("cancelled_at = %v, want nil (ещё активен)", got.CancelledAt)
	}

	// Повтор после CancelReturn.
	now := got.CreatedAt
	payload.CancelledAt = &now
	cancelledBy := "Кладовщик"
	payload.CancelledBy = &cancelledBy
	body2, _ := json.Marshal(payload)
	if _, err := svc.Ingest(ctx, service.IngestInput{Entries: []service.SyncEntry{
		{Entity: "stock_returns", RowID: returnID, Op: "update", Payload: body2},
	}}); err != nil {
		t.Fatalf("Ingest (repeat): %v", err)
	}
	gdb.First(&got, "id = ?", returnID)
	if got.CancelledAt == nil {
		t.Errorf("cancelled_at after upsert = nil, want set")
	}
	var lineCount int64
	gdb.Model(&models.StockReturnLine{}).Where("return_id = ?", returnID).Count(&lineCount)
	if lineCount != 1 {
		t.Errorf("lines after repeat = %d, want 1 (не задвоились)", lineCount)
	}
}

// TestSyncIngest_Supplier — приём поставщика на central (Ф4): upsert +
// hard delete (SuppliersService.Delete).
func TestSyncIngest_Supplier(t *testing.T) {
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
	for _, tbl := range []string{"suppliers"} {
		if err := gdb.Exec("DELETE FROM " + tbl).Error; err != nil {
			t.Fatalf("clean %s: %v", tbl, err)
		}
	}

	svc := service.NewSyncService(repo.New(gdb))
	ctx := context.Background()

	branchID := uuid.NewString()
	supID := uuid.NewString()
	name := "ООО Молоко"
	sup := models.Supplier{ID: supID, Name: &name, RestaurantID: &branchID, CurrentDebt: decimal.MustFromString("500")}
	body, _ := json.Marshal(sup)

	res, err := svc.Ingest(ctx, service.IngestInput{Entries: []service.SyncEntry{
		{Entity: "suppliers", RowID: supID, Op: "update", Payload: body},
	}})
	if err != nil {
		t.Fatalf("Ingest: %v", err)
	}
	if res.Applied != 1 {
		t.Errorf("applied = %d, want 1", res.Applied)
	}
	var got models.Supplier
	if err := gdb.First(&got, "id = ?", supID).Error; err != nil {
		t.Fatalf("supplier not upserted: %v", err)
	}
	if !got.CurrentDebt.Equal(decimal.MustFromString("500")) {
		t.Errorf("current_debt = %s, want 500", got.CurrentDebt.String())
	}

	// Повтор с изменённым долгом (после PayDebt) — upsert.
	sup.CurrentDebt = decimal.MustFromString("200")
	body2, _ := json.Marshal(sup)
	if _, err := svc.Ingest(ctx, service.IngestInput{Entries: []service.SyncEntry{
		{Entity: "suppliers", RowID: supID, Op: "update", Payload: body2},
	}}); err != nil {
		t.Fatalf("Ingest (repeat): %v", err)
	}
	gdb.First(&got, "id = ?", supID)
	if !got.CurrentDebt.Equal(decimal.MustFromString("200")) {
		t.Errorf("current_debt after upsert = %s, want 200", got.CurrentDebt.String())
	}

	res2, err := svc.Ingest(ctx, service.IngestInput{Entries: []service.SyncEntry{
		{Entity: "suppliers", RowID: supID, Op: "delete", Payload: nil},
	}})
	if err != nil {
		t.Fatalf("Ingest (delete): %v", err)
	}
	if res2.Applied != 1 {
		t.Errorf("delete applied = %d, want 1", res2.Applied)
	}
	var count int64
	gdb.Model(&models.Supplier{}).Where("id = ?", supID).Count(&count)
	if count != 0 {
		t.Errorf("supplier still present after delete: count = %d", count)
	}
}

// TestSyncIngest_SupplyExpense — приём расхода снабжения на central (Ф4):
// append-only, приходит через generic trackedInsert (не explicit recordXSync),
// но применяется тем же apply()-путём — upsert идемпотентен на повторе.
func TestSyncIngest_SupplyExpense(t *testing.T) {
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
	for _, tbl := range []string{"supply_expenses"} {
		if err := gdb.Exec("DELETE FROM " + tbl).Error; err != nil {
			t.Fatalf("clean %s: %v", tbl, err)
		}
	}

	svc := service.NewSyncService(repo.New(gdb))
	ctx := context.Background()

	branchID := uuid.NewString()
	seID := uuid.NewString()
	name := "Перчатки"
	se := models.SupplyExpense{
		ID: seID, IngredientName: &name, RestaurantID: &branchID,
		Qty: decimal.MustFromString("2"), Cost: decimal.MustFromString("60"),
	}
	body, _ := json.Marshal(se)

	res, err := svc.Ingest(ctx, service.IngestInput{Entries: []service.SyncEntry{
		{Entity: "supply_expenses", RowID: seID, Op: "insert", Payload: body},
	}})
	if err != nil {
		t.Fatalf("Ingest: %v", err)
	}
	if res.Applied != 1 {
		t.Errorf("applied = %d, want 1", res.Applied)
	}
	var got models.SupplyExpense
	if err := gdb.First(&got, "id = ?", seID).Error; err != nil {
		t.Fatalf("supply_expense not upserted: %v", err)
	}
	if !got.Cost.Equal(decimal.MustFromString("60")) {
		t.Errorf("cost = %s, want 60", got.Cost.String())
	}

	// Повторный приём (идемпотентность Pusher'а) — не задваивает строку.
	if _, err := svc.Ingest(ctx, service.IngestInput{Entries: []service.SyncEntry{
		{Entity: "supply_expenses", RowID: seID, Op: "insert", Payload: body},
	}}); err != nil {
		t.Fatalf("Ingest (repeat): %v", err)
	}
	var count int64
	gdb.Model(&models.SupplyExpense{}).Where("id = ?", seID).Count(&count)
	if count != 1 {
		t.Errorf("supply_expenses = %d, want 1 (не задвоилось)", count)
	}
}

// TestSyncIngest_FinancialAccount — приём снапшота счёта на central (Ф5):
// upsert (приходит с каждым Create/Update филиала через generic trackedSave-
// хук — central всегда видит текущий баланс) + hard delete.
func TestSyncIngest_FinancialAccount(t *testing.T) {
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
	for _, tbl := range []string{"financial_accounts"} {
		if err := gdb.Exec("DELETE FROM " + tbl).Error; err != nil {
			t.Fatalf("clean %s: %v", tbl, err)
		}
	}

	svc := service.NewSyncService(repo.New(gdb))
	ctx := context.Background()

	branchID := uuid.NewString()
	accID := uuid.NewString()
	name := "Касса"
	acc := models.FinancialAccount{ID: accID, Name: &name, RestaurantID: &branchID, Balance: decimal.MustFromString("1000"), IsEnabled: true}
	body, _ := json.Marshal(acc)

	res, err := svc.Ingest(ctx, service.IngestInput{Entries: []service.SyncEntry{
		{Entity: "financial_accounts", RowID: accID, Op: "update", Payload: body},
	}})
	if err != nil {
		t.Fatalf("Ingest: %v", err)
	}
	if res.Applied != 1 {
		t.Errorf("applied = %d, want 1", res.Applied)
	}
	var got models.FinancialAccount
	if err := gdb.First(&got, "id = ?", accID).Error; err != nil {
		t.Fatalf("account not upserted: %v", err)
	}
	if !got.Balance.Equal(decimal.MustFromString("1000")) {
		t.Errorf("balance = %s, want 1000", got.Balance.String())
	}

	// Повтор с изменённым балансом (после следующей операции на филиале) — upsert.
	acc.Balance = decimal.MustFromString("850")
	body2, _ := json.Marshal(acc)
	if _, err := svc.Ingest(ctx, service.IngestInput{Entries: []service.SyncEntry{
		{Entity: "financial_accounts", RowID: accID, Op: "update", Payload: body2},
	}}); err != nil {
		t.Fatalf("Ingest (repeat): %v", err)
	}
	gdb.First(&got, "id = ?", accID)
	if !got.Balance.Equal(decimal.MustFromString("850")) {
		t.Errorf("balance after upsert = %s, want 850", got.Balance.String())
	}

	// IsEnabled: true→false через upsert — регресс-проверка отдельного бага
	// (Ф5): IsEnabled — bool с gorm:"default:true", GORM's Create()/ON CONFLICT
	// подменяет zero-значение (false) значением из default-тега при наивном
	// struct-based upsert. applyFinancialAccount форсирует правильное значение
	// отдельным Update — без него этот блок ловил бы is_enabled=true (сломано).
	acc.IsEnabled = false
	body3, _ := json.Marshal(acc)
	if _, err := svc.Ingest(ctx, service.IngestInput{Entries: []service.SyncEntry{
		{Entity: "financial_accounts", RowID: accID, Op: "update", Payload: body3},
	}}); err != nil {
		t.Fatalf("Ingest (disable): %v", err)
	}
	gdb.First(&got, "id = ?", accID)
	if got.IsEnabled {
		t.Errorf("is_enabled after upsert = true, want false (см. комментарий: gorm default-substitution gotcha)")
	}

	res2, err := svc.Ingest(ctx, service.IngestInput{Entries: []service.SyncEntry{
		{Entity: "financial_accounts", RowID: accID, Op: "delete", Payload: nil},
	}})
	if err != nil {
		t.Fatalf("Ingest (delete): %v", err)
	}
	if res2.Applied != 1 {
		t.Errorf("delete applied = %d, want 1", res2.Applied)
	}
	var count int64
	gdb.Model(&models.FinancialAccount{}).Where("id = ?", accID).Count(&count)
	if count != 0 {
		t.Errorf("account still present after delete: count = %d", count)
	}
}

// TestSyncIngest_RecurringPayment — приём регулярного платежа на central (Ф5):
// upsert + hard delete.
func TestSyncIngest_RecurringPayment(t *testing.T) {
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
	for _, tbl := range []string{"recurring_payments"} {
		if err := gdb.Exec("DELETE FROM " + tbl).Error; err != nil {
			t.Fatalf("clean %s: %v", tbl, err)
		}
	}

	svc := service.NewSyncService(repo.New(gdb))
	ctx := context.Background()

	branchID := uuid.NewString()
	rpID := uuid.NewString()
	name := "Аренда"
	rp := models.RecurringPayment{ID: rpID, Name: &name, RestaurantID: &branchID, Amount: decimal.MustFromString("5000"), DayOfMonth: 5, Active: true}
	body, _ := json.Marshal(rp)

	res, err := svc.Ingest(ctx, service.IngestInput{Entries: []service.SyncEntry{
		{Entity: "recurring_payments", RowID: rpID, Op: "update", Payload: body},
	}})
	if err != nil {
		t.Fatalf("Ingest: %v", err)
	}
	if res.Applied != 1 {
		t.Errorf("applied = %d, want 1", res.Applied)
	}
	var got models.RecurringPayment
	if err := gdb.First(&got, "id = ?", rpID).Error; err != nil {
		t.Fatalf("recurring_payment not upserted: %v", err)
	}
	if !got.Active {
		t.Errorf("active = false, want true")
	}

	// Повтор после Pay (next_due/last_paid_at изменились) — upsert.
	rp.Active = false
	body2, _ := json.Marshal(rp)
	if _, err := svc.Ingest(ctx, service.IngestInput{Entries: []service.SyncEntry{
		{Entity: "recurring_payments", RowID: rpID, Op: "update", Payload: body2},
	}}); err != nil {
		t.Fatalf("Ingest (repeat): %v", err)
	}
	gdb.First(&got, "id = ?", rpID)
	if got.Active {
		t.Errorf("active after upsert = true, want false")
	}

	res2, err := svc.Ingest(ctx, service.IngestInput{Entries: []service.SyncEntry{
		{Entity: "recurring_payments", RowID: rpID, Op: "delete", Payload: nil},
	}})
	if err != nil {
		t.Fatalf("Ingest (delete): %v", err)
	}
	if res2.Applied != 1 {
		t.Errorf("delete applied = %d, want 1", res2.Applied)
	}
	var count int64
	gdb.Model(&models.RecurringPayment{}).Where("id = ?", rpID).Count(&count)
	if count != 0 {
		t.Errorf("recurring_payment still present after delete: count = %d", count)
	}
}

// TestSyncIngest_FinancialOpDelete — закрывает пробел (Ф5): удаление
// financial_operations на филиале (DeleteExpense/DeleteOperation) теперь
// реплицируется, а не только insert.
func TestSyncIngest_FinancialOpDelete(t *testing.T) {
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
	for _, tbl := range []string{"financial_operations"} {
		if err := gdb.Exec("DELETE FROM " + tbl).Error; err != nil {
			t.Fatalf("clean %s: %v", tbl, err)
		}
	}

	svc := service.NewSyncService(repo.New(gdb))
	ctx := context.Background()

	branchID := uuid.NewString()
	opID := uuid.NewString()
	typ, cat := "out", "shift_expense"
	fo := models.FinancialOperation{ID: opID, Type: &typ, Category: &cat, Amount: decimal.MustFromString("100"), RestaurantID: &branchID}
	body, _ := json.Marshal(fo)

	if _, err := svc.Ingest(ctx, service.IngestInput{Entries: []service.SyncEntry{
		{Entity: "financial_operations", RowID: opID, Op: "insert", Payload: body},
	}}); err != nil {
		t.Fatalf("Ingest (insert): %v", err)
	}
	var count int64
	gdb.Model(&models.FinancialOperation{}).Where("id = ?", opID).Count(&count)
	if count != 1 {
		t.Fatalf("count after insert = %d, want 1", count)
	}

	res, err := svc.Ingest(ctx, service.IngestInput{Entries: []service.SyncEntry{
		{Entity: "financial_operations", RowID: opID, Op: "delete", Payload: nil},
	}})
	if err != nil {
		t.Fatalf("Ingest (delete): %v", err)
	}
	if res.Applied != 1 {
		t.Errorf("delete applied = %d, want 1", res.Applied)
	}
	gdb.Model(&models.FinancialOperation{}).Where("id = ?", opID).Count(&count)
	if count != 0 {
		t.Errorf("financial_operation still present after delete: count = %d", count)
	}
}

// TestSyncIngest_TimeEntry — time_entries (Ф5б): upsert + hard delete
// (TimeEntriesService.Delete), тот же shape, что recurring_payments.
func TestSyncIngest_TimeEntry(t *testing.T) {
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
	gdb.Exec("DELETE FROM time_entries")

	svc := service.NewSyncService(repo.New(gdb))
	ctx := context.Background()

	branchID := uuid.NewString()
	userID := uuid.NewString()
	teID := uuid.NewString()
	active := "active"
	te := models.TimeEntry{ID: teID, UserID: &userID, Status: &active, RestaurantID: &branchID}
	body, _ := json.Marshal(te)

	res, err := svc.Ingest(ctx, service.IngestInput{Entries: []service.SyncEntry{
		{Entity: "time_entries", RowID: teID, Op: "update", Payload: body},
	}})
	if err != nil {
		t.Fatalf("Ingest: %v", err)
	}
	if res.Applied != 1 {
		t.Errorf("applied = %d, want 1", res.Applied)
	}
	var got models.TimeEntry
	if err := gdb.First(&got, "id = ?", teID).Error; err != nil {
		t.Fatalf("time_entry not upserted: %v", err)
	}
	if got.Status == nil || *got.Status != "active" {
		t.Errorf("status = %v, want active", got.Status)
	}

	// closed — тот же id, повтор как upsert (ClockOut).
	closed := "closed"
	te.Status = &closed
	body2, _ := json.Marshal(te)
	if _, err := svc.Ingest(ctx, service.IngestInput{Entries: []service.SyncEntry{
		{Entity: "time_entries", RowID: teID, Op: "update", Payload: body2},
	}}); err != nil {
		t.Fatalf("Ingest (repeat): %v", err)
	}
	gdb.First(&got, "id = ?", teID)
	if got.Status == nil || *got.Status != "closed" {
		t.Errorf("status after upsert = %v, want closed", got.Status)
	}

	res2, err := svc.Ingest(ctx, service.IngestInput{Entries: []service.SyncEntry{
		{Entity: "time_entries", RowID: teID, Op: "delete", Payload: nil},
	}})
	if err != nil {
		t.Fatalf("Ingest (delete): %v", err)
	}
	if res2.Applied != 1 {
		t.Errorf("delete applied = %d, want 1", res2.Applied)
	}
	var count int64
	gdb.Model(&models.TimeEntry{}).Where("id = ?", teID).Count(&count)
	if count != 0 {
		t.Errorf("time_entry still present after delete: count = %d", count)
	}
}

// TestSyncIngest_SalaryWorkedDay — override-таблица (Ф5б): upsert + hard
// delete (SetWorkedDays снимает отметку целиком, не патчит поле).
func TestSyncIngest_SalaryWorkedDay(t *testing.T) {
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
	gdb.Exec("DELETE FROM salary_worked_days")

	svc := service.NewSyncService(repo.New(gdb))
	ctx := context.Background()

	branchID := uuid.NewString()
	userID := uuid.NewString()
	rowID := uuid.NewString()
	row := models.SalaryWorkedDay{ID: rowID, RestaurantID: &branchID, UserID: &userID, WorkDate: "2026-08-01"}
	body, _ := json.Marshal(row)

	res, err := svc.Ingest(ctx, service.IngestInput{Entries: []service.SyncEntry{
		{Entity: "salary_worked_days", RowID: rowID, Op: "update", Payload: body},
	}})
	if err != nil {
		t.Fatalf("Ingest: %v", err)
	}
	if res.Applied != 1 {
		t.Errorf("applied = %d, want 1", res.Applied)
	}
	var count int64
	gdb.Model(&models.SalaryWorkedDay{}).Where("id = ?", rowID).Count(&count)
	if count != 1 {
		t.Fatalf("salary_worked_day not upserted: count = %d", count)
	}

	res2, err := svc.Ingest(ctx, service.IngestInput{Entries: []service.SyncEntry{
		{Entity: "salary_worked_days", RowID: rowID, Op: "delete", Payload: nil},
	}})
	if err != nil {
		t.Fatalf("Ingest (delete): %v", err)
	}
	if res2.Applied != 1 {
		t.Errorf("delete applied = %d, want 1", res2.Applied)
	}
	gdb.Model(&models.SalaryWorkedDay{}).Where("id = ?", rowID).Count(&count)
	if count != 0 {
		t.Errorf("salary_worked_day still present after delete: count = %d", count)
	}
}

// TestSyncIngest_SalaryDayMultiplier — тот же shape, что SalaryWorkedDay,
// отдельная таблица (066, merge из main).
func TestSyncIngest_SalaryDayMultiplier(t *testing.T) {
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
	gdb.Exec("DELETE FROM salary_day_multipliers")

	svc := service.NewSyncService(repo.New(gdb))
	ctx := context.Background()

	branchID := uuid.NewString()
	userID := uuid.NewString()
	rowID := uuid.NewString()
	row := models.SalaryDayMultiplier{ID: rowID, RestaurantID: &branchID, UserID: &userID, WorkDate: "2026-08-01", Multiplier: 2}
	body, _ := json.Marshal(row)

	res, err := svc.Ingest(ctx, service.IngestInput{Entries: []service.SyncEntry{
		{Entity: "salary_day_multipliers", RowID: rowID, Op: "update", Payload: body},
	}})
	if err != nil {
		t.Fatalf("Ingest: %v", err)
	}
	if res.Applied != 1 {
		t.Errorf("applied = %d, want 1", res.Applied)
	}
	var got models.SalaryDayMultiplier
	if err := gdb.First(&got, "id = ?", rowID).Error; err != nil {
		t.Fatalf("salary_day_multiplier not upserted: %v", err)
	}
	if got.Multiplier != 2 {
		t.Errorf("multiplier = %d, want 2 (проверка на GORM zero-value-default-tag ловушку — default:2 не должен подменить корректно пришедшее значение)", got.Multiplier)
	}

	res2, err := svc.Ingest(ctx, service.IngestInput{Entries: []service.SyncEntry{
		{Entity: "salary_day_multipliers", RowID: rowID, Op: "delete", Payload: nil},
	}})
	if err != nil {
		t.Fatalf("Ingest (delete): %v", err)
	}
	if res2.Applied != 1 {
		t.Errorf("delete applied = %d, want 1", res2.Applied)
	}
	var count int64
	gdb.Model(&models.SalaryDayMultiplier{}).Where("id = ?", rowID).Count(&count)
	if count != 0 {
		t.Errorf("salary_day_multiplier still present after delete: count = %d", count)
	}
}

// TestSyncIngest_SalaryDeduction — create + soft-cancel (Ф5б): НИКОГДА hard
// delete, оба состояния — upsert одного и того же id.
func TestSyncIngest_SalaryDeduction(t *testing.T) {
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
	gdb.Exec("DELETE FROM salary_deductions")

	svc := service.NewSyncService(repo.New(gdb))
	ctx := context.Background()

	branchID := uuid.NewString()
	userID := uuid.NewString()
	rowID := uuid.NewString()
	row := models.SalaryDeduction{
		ID: rowID, RestaurantID: &branchID, UserID: userID,
		Amount: decimal.MustFromString("100"), Reason: "опоздание",
	}
	body, _ := json.Marshal(row)

	if _, err := svc.Ingest(ctx, service.IngestInput{Entries: []service.SyncEntry{
		{Entity: "salary_deductions", RowID: rowID, Op: "update", Payload: body},
	}}); err != nil {
		t.Fatalf("Ingest: %v", err)
	}
	var got models.SalaryDeduction
	if err := gdb.First(&got, "id = ?", rowID).Error; err != nil {
		t.Fatalf("salary_deduction not upserted: %v", err)
	}
	if got.CancelledAt != nil {
		t.Errorf("cancelled_at = %v, want nil", got.CancelledAt)
	}

	// Отмена — повторный upsert с cancelled_at заполненным (CancelDeduction).
	now := got.CreatedAt
	row.CancelledAt = &now
	cancelledBy := uuid.NewString()
	row.CancelledBy = &cancelledBy
	body2, _ := json.Marshal(row)
	if _, err := svc.Ingest(ctx, service.IngestInput{Entries: []service.SyncEntry{
		{Entity: "salary_deductions", RowID: rowID, Op: "update", Payload: body2},
	}}); err != nil {
		t.Fatalf("Ingest (cancel): %v", err)
	}
	gdb.First(&got, "id = ?", rowID)
	if got.CancelledAt == nil {
		t.Errorf("cancelled_at after upsert = nil, want set")
	}
}

// TestSyncIngest_SalaryAdvance — тот же shape, что SalaryDeduction: create +
// soft-cancel, никогда hard delete.
func TestSyncIngest_SalaryAdvance(t *testing.T) {
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
	gdb.Exec("DELETE FROM salary_advances")

	svc := service.NewSyncService(repo.New(gdb))
	ctx := context.Background()

	branchID := uuid.NewString()
	userID := uuid.NewString()
	accID := uuid.NewString()
	rowID := uuid.NewString()
	row := models.SalaryAdvance{
		ID: rowID, RestaurantID: &branchID, UserID: userID,
		Amount: decimal.MustFromString("500"), Period: "2026-08", AccountID: accID,
	}
	body, _ := json.Marshal(row)

	if _, err := svc.Ingest(ctx, service.IngestInput{Entries: []service.SyncEntry{
		{Entity: "salary_advances", RowID: rowID, Op: "update", Payload: body},
	}}); err != nil {
		t.Fatalf("Ingest: %v", err)
	}
	var got models.SalaryAdvance
	if err := gdb.First(&got, "id = ?", rowID).Error; err != nil {
		t.Fatalf("salary_advance not upserted: %v", err)
	}
	if !got.Amount.Equal(decimal.MustFromString("500")) {
		t.Errorf("amount = %s, want 500", got.Amount.String())
	}

	// Отмена (CancelAdvance) — повторный upsert с cancelled_at.
	now := got.CreatedAt
	row.CancelledAt = &now
	cancelledBy := uuid.NewString()
	row.CancelledBy = &cancelledBy
	body2, _ := json.Marshal(row)
	if _, err := svc.Ingest(ctx, service.IngestInput{Entries: []service.SyncEntry{
		{Entity: "salary_advances", RowID: rowID, Op: "update", Payload: body2},
	}}); err != nil {
		t.Fatalf("Ingest (cancel): %v", err)
	}
	gdb.First(&got, "id = ?", rowID)
	if got.CancelledAt == nil {
		t.Errorf("cancelled_at after upsert = nil, want set")
	}
}
