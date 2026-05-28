//go:build integration

package http_test

import (
	"encoding/json"
	"fmt"
	"testing"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/db/models"
)

// TestPhase46_CancelRunnerOnVoid — при void item должен появиться cancel_runner
// print_job на нужном station-принтере.
func TestPhase46_CancelRunnerOnVoid(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, menuItemID, _, _ := seedForWrite(t, f)

	hot := "hot_kitchen"
	if err := gdb.Model(&models.MenuItem{}).
		Where("id = ?", menuItemID).
		Update("station", hot).Error; err != nil {
		t.Fatal(err)
	}
	// Создаём station-принтер.
	resp, body := f.post(t, "/api/v1/printers", tok, uuid.NewString(),
		map[string]any{
			"name":    "Hot kitchen",
			"kind":    "station",
			"station": "hot_kitchen",
			"driver":  "virtual",
			"target":  t.TempDir(),
		})
	if resp.StatusCode != 201 {
		t.Fatalf("printer create %d: %s", resp.StatusCode, body)
	}
	var hotPrinter models.Printer
	_ = json.Unmarshal(body, &hotPrinter)

	// Создаём заказ → runner-job.
	resp2, body2 := f.post(t, "/api/v1/orders", tok, uuid.NewString(),
		map[string]any{
			"items": []map[string]any{{"menu_item_id": menuItemID, "qty": "1"}},
		})
	if resp2.StatusCode != 201 {
		t.Fatalf("create %d: %s", resp2.StatusCode, body2)
	}
	var order models.Order
	_ = json.Unmarshal(body2, &order)

	// Найдём созданный item.
	var item models.OrderItem
	if err := gdb.Where("order_id = ?", order.ID).First(&item).Error; err != nil {
		t.Fatal(err)
	}

	// Void item.
	voidPath := fmt.Sprintf("/api/v1/orders/%s/items/%s/void", order.ID, item.ID)
	resp3, body3 := f.post(t, voidPath, tok, uuid.NewString(),
		map[string]any{"reason": "ошибка кассира", "approved_by": "manager-1"})
	if resp3.StatusCode != 200 {
		t.Fatalf("void %d: %s", resp3.StatusCode, body3)
	}

	// Проверяем: появился cancel_runner job на hot_kitchen printer.
	var jobs []models.PrintJob
	if err := gdb.Where("order_id = ? AND type = ?", order.ID, "cancel_runner").
		Find(&jobs).Error; err != nil {
		t.Fatal(err)
	}
	if len(jobs) != 1 {
		t.Fatalf("want 1 cancel_runner job, got %d", len(jobs))
	}
	if jobs[0].PrinterID == nil || *jobs[0].PrinterID != hotPrinter.ID {
		t.Errorf("cancel_runner not routed to hot_kitchen printer")
	}
}

// TestPhase46_CancelRunnerOnCancelOrder — отмена всего заказа эмитит
// cancel_runner для всех live items, сгруппированный по станциям.
func TestPhase46_CancelRunnerOnCancelOrder(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, menuItemID, _, _ := seedForWrite(t, f)

	hot := "hot_kitchen"
	if err := gdb.Model(&models.MenuItem{}).
		Where("id = ?", menuItemID).
		Update("station", hot).Error; err != nil {
		t.Fatal(err)
	}
	resp, _ := f.post(t, "/api/v1/printers", tok, uuid.NewString(),
		map[string]any{
			"name": "Hot kitchen", "kind": "station", "station": "hot_kitchen",
			"driver": "virtual", "target": t.TempDir(),
		})
	if resp.StatusCode != 201 {
		t.Fatal(resp.StatusCode)
	}

	// Создаём заказ с 2 позициями.
	respO, bodyO := f.post(t, "/api/v1/orders", tok, uuid.NewString(),
		map[string]any{
			"items": []map[string]any{
				{"menu_item_id": menuItemID, "qty": "1"},
				{"menu_item_id": menuItemID, "qty": "1"},
			},
		})
	if respO.StatusCode != 201 {
		t.Fatalf("create %d: %s", respO.StatusCode, bodyO)
	}
	var order models.Order
	_ = json.Unmarshal(bodyO, &order)

	// Cancel order.
	cancelPath := fmt.Sprintf("/api/v1/orders/%s/cancel", order.ID)
	respC, _ := f.post(t, cancelPath, tok, uuid.NewString(),
		map[string]any{"reason": "клиент ушёл"})
	if respC.StatusCode != 200 {
		t.Fatalf("cancel %d", respC.StatusCode)
	}

	// Ожидаем: 1 cancel_runner job (т.к. обе позиции на hot_kitchen → одна станция).
	var jobs []models.PrintJob
	if err := gdb.Where("order_id = ? AND type = ?", order.ID, "cancel_runner").
		Find(&jobs).Error; err != nil {
		t.Fatal(err)
	}
	if len(jobs) != 1 {
		t.Fatalf("want 1 cancel_runner, got %d", len(jobs))
	}
}

// TestPhase46_PrinterTestPage — POST /printers/{id}/test создаёт pending job
// с TestPageLayout байтами.
func TestPhase46_PrinterTestPage(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, _, _ := seedForWrite(t, f)

	resp, body := f.post(t, "/api/v1/printers", tok, uuid.NewString(),
		map[string]any{
			"name":   "Main receipt",
			"kind":   "receipt",
			"driver": "virtual",
			"target": t.TempDir(),
		})
	if resp.StatusCode != 201 {
		t.Fatalf("create %d: %s", resp.StatusCode, body)
	}
	var p models.Printer
	_ = json.Unmarshal(body, &p)

	testPath := fmt.Sprintf("/api/v1/printers/%s/test", p.ID)
	resp2, body2 := f.post(t, testPath, tok, uuid.NewString(), nil)
	if resp2.StatusCode != 202 {
		t.Fatalf("test %d: %s", resp2.StatusCode, body2)
	}
	var job models.PrintJob
	_ = json.Unmarshal(body2, &job)
	if job.Type != "test" {
		t.Errorf("type = %s, want test", job.Type)
	}
	if job.PrinterID == nil || *job.PrinterID != p.ID {
		t.Errorf("printer_id mismatch")
	}
	if job.Status != "pending" {
		t.Errorf("status = %s, want pending", job.Status)
	}
	if len(job.Payload) == 0 {
		t.Errorf("empty payload")
	}

	// Проверим, что запись в БД совпадает.
	var stored models.PrintJob
	if err := gdb.First(&stored, "id = ?", job.ID).Error; err != nil {
		t.Fatal(err)
	}
	if len(stored.Payload) == 0 {
		t.Errorf("DB payload empty")
	}

	// Test на disabled принтере → 409.
	disablePath := fmt.Sprintf("/api/v1/printers/%s", p.ID)
	respD, _ := f.patch(t, disablePath, tok, uuid.NewString(), map[string]any{"enabled": false})
	if respD.StatusCode != 200 {
		t.Fatal(respD.StatusCode)
	}
	respT, _ := f.post(t, testPath, tok, uuid.NewString(), nil)
	if respT.StatusCode != 409 {
		t.Errorf("test on disabled expected 409, got %d", respT.StatusCode)
	}
}
