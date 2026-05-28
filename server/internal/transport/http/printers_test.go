//go:build integration

package http_test

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/db/models"
)

// TestPrinters_CRUD — basic CRUD + uniqueness invariants.
func TestPrinters_CRUD(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)

	// Create receipt printer.
	resp, body := f.post(t, "/api/v1/printers", tok, uuid.NewString(),
		map[string]any{
			"name":       "Main receipt",
			"kind":       "receipt",
			"driver":     "virtual",
			"target":     t.TempDir(),
			"is_default": true,
		})
	if resp.StatusCode != 201 {
		t.Fatalf("create %d: %s", resp.StatusCode, body)
	}
	var p models.Printer
	_ = json.Unmarshal(body, &p)

	// Second default receipt → CONFLICT (unique index).
	resp2, _ := f.post(t, "/api/v1/printers", tok, uuid.NewString(),
		map[string]any{
			"name":       "Backup receipt",
			"kind":       "receipt",
			"driver":     "virtual",
			"target":     t.TempDir(),
			"is_default": true,
		})
	if resp2.StatusCode != 409 {
		t.Errorf("second default expected 409, got %d", resp2.StatusCode)
	}

	// Create station printer.
	resp3, body3 := f.post(t, "/api/v1/printers", tok, uuid.NewString(),
		map[string]any{
			"name":    "Hot kitchen",
			"kind":    "station",
			"station": "hot_kitchen",
			"driver":  "virtual",
			"target":  t.TempDir(),
		})
	if resp3.StatusCode != 201 {
		t.Fatalf("station create %d: %s", resp3.StatusCode, body3)
	}

	// Second printer for same station → CONFLICT.
	resp4, _ := f.post(t, "/api/v1/printers", tok, uuid.NewString(),
		map[string]any{
			"name":    "Hot 2",
			"kind":    "station",
			"station": "hot_kitchen",
			"driver":  "virtual",
			"target":  t.TempDir(),
		})
	if resp4.StatusCode != 409 {
		t.Errorf("dup station expected 409, got %d", resp4.StatusCode)
	}

	// List.
	listResp, listBody := f.get(t, "/api/v1/printers", tok)
	if listResp.StatusCode != 200 {
		t.Fatal(listResp.StatusCode)
	}
	var env struct {
		Data []models.Printer `json:"data"`
	}
	_ = json.Unmarshal(listBody, &env)
	if len(env.Data) != 2 {
		t.Errorf("list want 2, got %d", len(env.Data))
	}

	// Patch — enable=false.
	patchPath := fmt.Sprintf("/api/v1/printers/%s", p.ID)
	resp5, _ := f.patch(t, patchPath, tok, uuid.NewString(), map[string]any{"enabled": false})
	if resp5.StatusCode != 200 {
		t.Errorf("patch %d", resp5.StatusCode)
	}

	// Delete.
	resp6, _ := f.del(t, patchPath, tok, uuid.NewString())
	if resp6.StatusCode != 204 {
		t.Errorf("delete %d", resp6.StatusCode)
	}
}

// TestRunner_AutoEmit — Create order → runner-print_job появляется автоматически
// на нужном station-принтере.
func TestRunner_AutoEmit(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, menuItemID, _, _ := seedForWrite(t, f)

	// Настраиваем menu_item.station=hot_kitchen.
	hot := "hot_kitchen"
	if err := gdb.Model(&models.MenuItem{}).
		Where("id = ?", menuItemID).
		Update("station", hot).Error; err != nil {
		t.Fatal(err)
	}
	// Создаём station-принтер hot_kitchen.
	resp, body := f.post(t, "/api/v1/printers", tok, uuid.NewString(),
		map[string]any{
			"name":    "Hot kitchen",
			"kind":    "station",
			"station": "hot_kitchen",
			"driver":  "virtual",
			"target":  t.TempDir(),
		})
	if resp.StatusCode != 201 {
		t.Fatalf("create printer %d: %s", resp.StatusCode, body)
	}
	var hotPrinter models.Printer
	_ = json.Unmarshal(body, &hotPrinter)

	// Создаём заказ — runner должен автоматически появиться.
	resp2, body2 := f.post(t, "/api/v1/orders", tok, uuid.NewString(),
		map[string]any{
			"items": []map[string]any{{"menu_item_id": menuItemID, "qty": "1"}},
		})
	if resp2.StatusCode != 201 {
		t.Fatalf("create order %d: %s", resp2.StatusCode, body2)
	}
	var order models.Order
	_ = json.Unmarshal(body2, &order)

	// Проверяем: в print_jobs появилась runner-запись на hot_kitchen printer.
	var jobs []models.PrintJob
	if err := gdb.Where("order_id = ? AND type = ?", order.ID, "runner").
		Find(&jobs).Error; err != nil {
		t.Fatal(err)
	}
	if len(jobs) != 1 {
		t.Fatalf("want 1 runner job, got %d", len(jobs))
	}
	if jobs[0].PrinterID == nil || *jobs[0].PrinterID != hotPrinter.ID {
		t.Errorf("runner not routed to hot_kitchen printer (got %v)", jobs[0].PrinterID)
	}
}

// TestPrintJobs_ListAndRetry — admin видит failed, может перезапустить.
func TestPrintJobs_ListAndRetry(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, _, _ := seedForWrite(t, f)

	// Создадим вручную failed job — имитируем сбой принтера.
	jobID := uuid.NewString()
	failed := "failed"
	rid := f.rid
	errStr := "tcp dial: refused"
	if err := gdb.Create(&models.PrintJob{
		ID:           jobID,
		Type:         "receipt",
		Payload:      []byte{0x1B, 0x40},
		Status:       failed,
		Attempts:     5,
		LastError:    &errStr,
		RestaurantID: &rid,
		CreatedAt:    time.Now().UTC(),
		UpdatedAt:    time.Now().UTC(),
	}).Error; err != nil {
		t.Fatal(err)
	}

	// GET /print/jobs?status=failed.
	listResp, listBody := f.get(t, "/api/v1/print/jobs?status=failed", tok)
	if listResp.StatusCode != 200 {
		t.Fatalf("list %d", listResp.StatusCode)
	}
	var env struct {
		Data []models.PrintJob `json:"data"`
	}
	_ = json.Unmarshal(listBody, &env)
	if len(env.Data) != 1 {
		t.Fatalf("want 1 failed, got %d", len(env.Data))
	}

	// Retry.
	retryPath := fmt.Sprintf("/api/v1/print/jobs/%s/retry", jobID)
	resp, body := f.post(t, retryPath, tok, uuid.NewString(), nil)
	if resp.StatusCode != 200 {
		t.Fatalf("retry %d: %s", resp.StatusCode, body)
	}
	var j models.PrintJob
	_ = json.Unmarshal(body, &j)
	if j.Status != "pending" {
		t.Errorf("status = %s, want pending", j.Status)
	}
	if j.Attempts != 0 {
		t.Errorf("attempts = %d, want 0", j.Attempts)
	}

	// Retry на уже pending — 409.
	resp2, _ := f.post(t, retryPath, tok, uuid.NewString(), nil)
	if resp2.StatusCode != 409 {
		t.Errorf("retry-pending expected 409, got %d", resp2.StatusCode)
	}
}
