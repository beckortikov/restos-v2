//go:build integration

package http_test

import (
	"encoding/json"
	"testing"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/db/models"
)

// TestRunner_DisabledStationNoPaper — если принтер станции ОТКЛЮЧЁН, кухонный
// бегунок НЕ создаётся и НЕ уходит на другой включённый станционный принтер.
// Регрессия: горячий цех печатал на чужом (холодном) принтере, когда свой
// выключали для теста KDS. Теперь отключённая станция бесбумажная — только KDS.
func TestRunner_DisabledStationNoPaper(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, menuItemID, _, _ := seedForWrite(t, f)

	// Блюдо → станция горячего цеха.
	if err := gdb.Model(&models.MenuItem{}).Where("id = ?", menuItemID).
		Update("station", "hot_kitchen").Error; err != nil {
		t.Fatal(err)
	}
	// Принтер горячего цеха.
	resp, body := f.post(t, "/api/v1/printers", tok, uuid.NewString(), map[string]any{
		"name": "Hot", "kind": "station", "station": "hot_kitchen", "driver": "virtual", "target": t.TempDir(),
	})
	if resp.StatusCode != 201 {
		t.Fatalf("hot printer %d: %s", resp.StatusCode, body)
	}
	var hot models.Printer
	_ = json.Unmarshal(body, &hot)

	// Второй, ВКЛЮЧЁННЫЙ станционный принтер (холодный цех) — «другой принтер»,
	// на который сейчас лез бегунок.
	if r, b := f.post(t, "/api/v1/printers", tok, uuid.NewString(), map[string]any{
		"name": "Cold", "kind": "station", "station": "cold_kitchen", "driver": "virtual", "target": t.TempDir(),
	}); r.StatusCode != 201 {
		t.Fatalf("cold printer %d: %s", r.StatusCode, b)
	}

	// Отключаем горячий цех.
	if r, b := f.patch(t, "/api/v1/printers/"+hot.ID, tok, uuid.NewString(), map[string]any{"enabled": false}); r.StatusCode != 200 {
		t.Fatalf("disable hot %d: %s", r.StatusCode, b)
	}

	// Заказ с горячей позицией.
	respO, bodyO := f.post(t, "/api/v1/orders", tok, uuid.NewString(), map[string]any{
		"items": []map[string]any{{"menu_item_id": menuItemID, "qty": "1"}},
	})
	if respO.StatusCode != 201 {
		t.Fatalf("order %d: %s", respO.StatusCode, bodyO)
	}
	var order models.Order
	_ = json.Unmarshal(bodyO, &order)

	// Бегунков быть не должно.
	var jobs []models.PrintJob
	if err := gdb.Where("order_id = ? AND type = ?", order.ID, "runner").Find(&jobs).Error; err != nil {
		t.Fatal(err)
	}
	if len(jobs) != 0 {
		t.Fatalf("отключённая станция создала %d runner-заданий (ожидалось 0)", len(jobs))
	}
}

// TestRunner_EnabledStationPrints — контроль: включённая станция печатает
// бегунок на свой принтер (не сломали happy-path).
func TestRunner_EnabledStationPrints(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, menuItemID, _, _ := seedForWrite(t, f)

	if err := gdb.Model(&models.MenuItem{}).Where("id = ?", menuItemID).
		Update("station", "hot_kitchen").Error; err != nil {
		t.Fatal(err)
	}
	resp, body := f.post(t, "/api/v1/printers", tok, uuid.NewString(), map[string]any{
		"name": "Hot", "kind": "station", "station": "hot_kitchen", "driver": "virtual", "target": t.TempDir(),
	})
	if resp.StatusCode != 201 {
		t.Fatalf("printer %d: %s", resp.StatusCode, body)
	}
	var hot models.Printer
	_ = json.Unmarshal(body, &hot)

	respO, bodyO := f.post(t, "/api/v1/orders", tok, uuid.NewString(), map[string]any{
		"items": []map[string]any{{"menu_item_id": menuItemID, "qty": "1"}},
	})
	if respO.StatusCode != 201 {
		t.Fatalf("order %d: %s", respO.StatusCode, bodyO)
	}
	var order models.Order
	_ = json.Unmarshal(bodyO, &order)

	var jobs []models.PrintJob
	if err := gdb.Where("order_id = ? AND type = ?", order.ID, "runner").Find(&jobs).Error; err != nil {
		t.Fatal(err)
	}
	if len(jobs) != 1 {
		t.Fatalf("want 1 runner, got %d", len(jobs))
	}
	if jobs[0].PrinterID == nil || *jobs[0].PrinterID != hot.ID {
		t.Errorf("runner не привязан к принтеру станции")
	}
}
