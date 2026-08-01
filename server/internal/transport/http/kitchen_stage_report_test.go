//go:build integration

package http_test

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/db"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// TestKitchenStageReport_EndToEnd — заказ проходит через реальные переходы KDS
// (pending→cooking→ready→served с паузами), отчёт /analytics/kitchen-stage-report
// должен вернуть строку блюда со станцией, item_count=1, ненулевыми стадиями и
// корректно посчитанной Δ к тех-карте (cook_time_min).
func TestKitchenStageReport_EndToEnd(t *testing.T) {
	f := setupE2E(t)
	gdb, _ := db.Open(testDSN())
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})

	grill := "grill"
	dish := "Шашлык"
	techMin := 1 // тех-карта: 1 минута — заведомо меньше реальной готовки в тесте
	miID := uuid.NewString()
	if err := gdb.Create(&models.MenuItem{
		ID: miID, Name: &dish, Station: &grill, CookTimeMin: &techMin,
		Price: decimal.MustFromString("40"), RestaurantID: &f.rid,
	}).Error; err != nil {
		t.Fatal(err)
	}

	tok := f.login(t)

	// Заказ через реальный HTTP-флоу — только так пишется стартовое событие
	// "→pending" (buildOrderItem, Фаза A).
	r, b := f.post(t, "/api/v1/orders", tok, uuid.NewString(), map[string]any{
		"items": []map[string]any{{"menu_item_id": miID, "qty": "1"}},
	})
	if r.StatusCode != 201 {
		t.Fatalf("create order: %d %s", r.StatusCode, b)
	}
	var created struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(b, &created); err != nil || created.ID == "" {
		t.Fatalf("bad create response: %v %s", err, b)
	}
	itemID := firstOrderItemID(t, f, tok, created.ID)

	// pending → cooking → ready → served, с паузами, чтобы стадии были измеримо
	// не нулевыми (проверяем, что SUM по LEAD-окну реально считает интервалы).
	for _, status := range []string{"cooking", "ready", "served"} {
		time.Sleep(300 * time.Millisecond)
		code, body := postJSON(t, f.srv.URL+fmt.Sprintf("/api/v1/kds/items/%s/status", itemID), tok, map[string]string{"status": status})
		if code != 200 {
			t.Fatalf("set status %s: %d %s", status, code, body)
		}
	}

	from := time.Now().Add(-time.Hour).UTC().Format(time.RFC3339)
	to := time.Now().Add(time.Hour).UTC().Format(time.RFC3339)
	rr, bb := f.get(t, "/api/v1/analytics/kitchen-stage-report?from="+from+"&to="+to, tok)
	if rr.StatusCode != 200 {
		t.Fatalf("kitchen-stage-report: %d %s", rr.StatusCode, bb)
	}

	var out struct {
		Rows []struct {
			MenuItemID      string `json:"menu_item_id"`
			DishName        string `json:"dish_name"`
			Station         string `json:"station"`
			ItemCount       int    `json:"item_count"`
			AvgQueueMin     string `json:"avg_queue_min"`
			AvgCookMin      string `json:"avg_cook_min"`
			AvgHoldMin      string `json:"avg_hold_min"`
			AvgTotalMin     string `json:"avg_total_min"`
			TechCookTimeMin *int   `json:"tech_cook_time_min"`
			DeltaMin        string `json:"delta_min"`
		} `json:"rows"`
	}
	if err := json.Unmarshal(bb, &out); err != nil {
		t.Fatalf("bad report response: %v %s", err, bb)
	}
	if len(out.Rows) != 1 {
		t.Fatalf("rows = %d, want 1: %s", len(out.Rows), bb)
	}
	row := out.Rows[0]
	if row.MenuItemID != miID || row.DishName != dish || row.Station != "grill" {
		t.Errorf("row identity = %+v", row)
	}
	if row.ItemCount != 1 {
		t.Errorf("item_count = %d, want 1", row.ItemCount)
	}
	cookMin := decimal.MustFromString(row.AvgCookMin)
	if !cookMin.IsPositive() {
		t.Errorf("avg_cook_min = %s, want > 0 (готовка длилась ~300ms)", row.AvgCookMin)
	}
	holdMin := decimal.MustFromString(row.AvgHoldMin)
	if !holdMin.IsPositive() {
		t.Errorf("avg_hold_min = %s, want > 0 (ожидание выдачи длилось ~300ms)", row.AvgHoldMin)
	}
	if row.TechCookTimeMin == nil || *row.TechCookTimeMin != techMin {
		t.Fatalf("tech_cook_time_min = %v, want %d", row.TechCookTimeMin, techMin)
	}
	// Реальная готовка (~300ms ≈ 0.005 мин) МЕНЬШЕ тех-карты (1 мин) — Δ отрицательна.
	delta := decimal.MustFromString(row.DeltaMin)
	if !delta.IsNegative() {
		t.Errorf("delta_min = %s, want negative (факт быстрее тех-карты)", row.DeltaMin)
	}
	total := decimal.MustFromString(row.AvgTotalMin)
	wantTotal := decimal.Add(decimal.Add(decimal.MustFromString(row.AvgQueueMin), cookMin), holdMin)
	if decimal.Normalize(total).String() != decimal.Normalize(wantTotal).String() {
		t.Errorf("avg_total_min = %s, want queue+cook+hold = %s", total, wantTotal)
	}
}

// TestKitchenStageReport_ExcludesUnservedItems — блюдо, не дошедшее до "served"
// в периоде (ещё готовится), не должно попадать в отчёт — иначе открытая
// (незавершённая) стадия искажала бы среднее.
func TestKitchenStageReport_ExcludesUnservedItems(t *testing.T) {
	f := setupE2E(t)
	gdb, _ := db.Open(testDSN())
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})

	hot := "hot_kitchen"
	dish := "Лагман"
	miID := uuid.NewString()
	if err := gdb.Create(&models.MenuItem{
		ID: miID, Name: &dish, Station: &hot, Price: decimal.MustFromString("30"), RestaurantID: &f.rid,
	}).Error; err != nil {
		t.Fatal(err)
	}

	tok := f.login(t)
	r, b := f.post(t, "/api/v1/orders", tok, uuid.NewString(), map[string]any{
		"items": []map[string]any{{"menu_item_id": miID, "qty": "1"}},
	})
	if r.StatusCode != 201 {
		t.Fatalf("create order: %d %s", r.StatusCode, b)
	}
	var created struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(b, &created)
	itemID := firstOrderItemID(t, f, tok, created.ID)

	// Только →cooking, до "served" не доводим.
	if code, body := postJSON(t, f.srv.URL+fmt.Sprintf("/api/v1/kds/items/%s/status", itemID), tok, map[string]string{"status": "cooking"}); code != 200 {
		t.Fatalf("set status cooking: %d %s", code, body)
	}

	from := time.Now().Add(-time.Hour).UTC().Format(time.RFC3339)
	to := time.Now().Add(time.Hour).UTC().Format(time.RFC3339)
	rr, bb := f.get(t, "/api/v1/analytics/kitchen-stage-report?from="+from+"&to="+to, tok)
	if rr.StatusCode != 200 {
		t.Fatalf("kitchen-stage-report: %d %s", rr.StatusCode, bb)
	}
	var out struct {
		Rows []map[string]any `json:"rows"`
	}
	_ = json.Unmarshal(bb, &out)
	if len(out.Rows) != 0 {
		t.Fatalf("rows = %+v, want empty (item never reached served)", out.Rows)
	}
}
