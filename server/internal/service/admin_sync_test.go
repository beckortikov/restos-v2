//go:build integration

package service_test

import (
	"bytes"
	"encoding/json"
	"testing"

	"github.com/google/uuid"
	"github.com/xuri/excelize/v2"

	"github.com/restos/restos-v4/server/internal/db"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
	"github.com/restos/restos-v4/server/internal/repo"
	"github.com/restos/restos-v4/server/internal/service"
	"github.com/restos/restos-v4/server/internal/synclog"
)

// buildXLSXUsers — минимальный xlsx-билдер для ImportUsers (см. аналог в
// transport/http/phase6_test.go — тот живёт в другом Go-пакете, копия проще
// шаринга через internal/).
func buildXLSXUsers(t *testing.T, header []string, rows [][]string) []byte {
	t.Helper()
	f := excelize.NewFile()
	for i, h := range header {
		cell, _ := excelize.CoordinatesToCellName(i+1, 1)
		f.SetCellValue("Sheet1", cell, h)
	}
	for ri, row := range rows {
		for ci, v := range row {
			cell, _ := excelize.CoordinatesToCellName(ci+1, ri+2)
			f.SetCellValue("Sheet1", cell, v)
		}
	}
	var buf bytes.Buffer
	if err := f.Write(&buf); err != nil {
		t.Fatalf("buildXLSXUsers: %v", err)
	}
	return buf.Bytes()
}

// TestUsersDelete_RecordsSync — UsersService.Delete (мягкое удаление,
// role='deleted') обязан писать дельту в sync_log, иначе central продолжает
// показывать уволенного сотрудника активным и не подтягивает его имя ни в
// одном сетевом отчёте (найдено 2026-08-29 через сетевую аналитику
// официантов — реальный сотрудник с 88 заказами отображался пустым именем).
func TestUsersDelete_RecordsSync(t *testing.T) {
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
	for _, tbl := range []string{"sync_log", "users", "restaurants"} {
		gdb.Exec("DELETE FROM " + tbl)
	}
	synclog.SetEnabled(true)
	t.Cleanup(func() { synclog.SetEnabled(false) })

	rid := uuid.NewString()
	gdb.Create(&models.Restaurant{ID: rid, Name: "Тест"})
	waiterName, waiterRole := "Официант", "waiter"
	userID := uuid.NewString()
	gdb.Create(&models.User{ID: userID, Name: &waiterName, Role: &waiterRole, RestaurantID: &rid})

	svc := service.NewUsersService(repo.New(gdb))
	ctx := tenant.WithRestaurant(t.Context(), rid)
	if err := svc.Delete(ctx, userID); err != nil {
		t.Fatalf("Delete: %v", err)
	}

	var rows []models.SyncLog
	if err := gdb.Where("table_name = ? AND row_id = ?", "users", userID).Find(&rows).Error; err != nil {
		t.Fatalf("query sync_log: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("sync_log rows = %d, want 1 (Delete должен записать ровно одну дельту)", len(rows))
	}
	if rows[0].Op != "update" {
		t.Errorf("Op = %q, want update (soft-delete — это UPDATE строки, не DELETE)", rows[0].Op)
	}
	var payload map[string]any
	if err := json.Unmarshal(rows[0].Payload, &payload); err != nil {
		t.Fatalf("payload не парсится: %v (%s)", err, rows[0].Payload)
	}
	if payload["role"] != "deleted" {
		t.Errorf("payload.role = %v, want deleted", payload["role"])
	}
	if _, ok := payload["pin"]; ok {
		t.Errorf("PIN не должен попадать в sync_log payload (json:\"-\"): %s", rows[0].Payload)
	}
}

// TestImportUsers_RecordsSync — bulk-импорт персонала (Настройки →
// Пользователи → Импорт) обязан синкать КАЖДУЮ созданную/обновлённую строку,
// иначе сотрудники, заведённые массово (не через ручное Create/Patch),
// central никогда не видит — та же дыра, что у Delete выше.
func TestImportUsers_RecordsSync(t *testing.T) {
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
	for _, tbl := range []string{"sync_log", "users", "restaurants"} {
		gdb.Exec("DELETE FROM " + tbl)
	}
	synclog.SetEnabled(true)
	t.Cleanup(func() { synclog.SetEnabled(false) })

	rid := uuid.NewString()
	gdb.Create(&models.Restaurant{ID: rid, Name: "Тест"})
	existingName, existingRole := "Существующий", "waiter"
	existingID := uuid.NewString()
	gdb.Create(&models.User{ID: existingID, Name: &existingName, Role: &existingRole, RestaurantID: &rid})

	xlsxBytes := buildXLSXUsers(t,
		[]string{"name", "role"},
		[][]string{
			{"Существующий", "cashier"}, // матчится по имени — update-ветка
			{"Новый", "waiter"},         // create-ветка
		},
	)

	svc := service.NewImportService(repo.New(gdb))
	ctx := tenant.WithRestaurant(t.Context(), rid)
	res, err := svc.ImportUsers(ctx, bytes.NewReader(xlsxBytes))
	if err != nil {
		t.Fatalf("ImportUsers: %v", err)
	}
	if res.Updated != 1 || res.Created != 1 {
		t.Fatalf("Updated=%d Created=%d, want 1/1: %+v", res.Updated, res.Created, res.Errors)
	}

	var rows []models.SyncLog
	if err := gdb.Where("table_name = ?", "users").Find(&rows).Error; err != nil {
		t.Fatalf("query sync_log: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("sync_log rows = %d, want 2 (1 update + 1 insert)", len(rows))
	}
	byOp := map[string]int{}
	for _, r := range rows {
		byOp[r.Op]++
	}
	if byOp["update"] != 1 || byOp["insert"] != 1 {
		t.Errorf("ops: %+v, want update=1 insert=1", byOp)
	}
}
