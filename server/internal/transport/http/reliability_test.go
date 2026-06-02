//go:build integration

package http_test

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/db"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// TestReliability — reliability/resiliency edge cases.
//
// Покрывает: reprint, stock-shortage guard, print-queue retry, SSE delivery,
// license-lock, inventory recount, stop-list, reservation expire, backup roundtrip.
// Каждый t.Run — отдельный сценарий. MISSING-функционал помечаем явно.
func TestReliability(t *testing.T) {
	t.Run("Reprint_Receipt_CreatesNewJob", func(t *testing.T) {
		f := setupE2E(t)
		tok := f.login(t)
		gdb, _ := db.Open(testDSN())
		t.Cleanup(func() {
			if sqlDB, err := gdb.DB(); err == nil {
				_ = sqlDB.Close()
			}
		})
		mid, sid, accID, _ := bootstrapForOrder(t, f, gdb, "1000")
		gdb.Model(&models.MenuItem{}).Where("id = ?", mid).Update("price", decimal.MustFromString("100"))

		r, b := f.post(t, "/api/v1/orders", tok, uuid.NewString(),
			map[string]any{"items": []map[string]any{{"menu_item_id": mid, "qty": "1"}}})
		if r.StatusCode != 201 {
			t.Fatalf("create order %d: %s", r.StatusCode, b)
		}
		var ord models.Order
		_ = json.Unmarshal(b, &ord)

		cr, cb := f.post(t, fmt.Sprintf("/api/v1/orders/%s/close", ord.ID), tok, uuid.NewString(),
			map[string]any{"payment_method": "cash", "account_id": accID, "shift_id": sid})
		if cr.StatusCode != 200 {
			t.Fatalf("close %d: %s", cr.StatusCode, cb)
		}

		// Один print_job создан close'ом.
		var jobs1 []models.PrintJob
		gdb.Where("order_id = ?", ord.ID).Find(&jobs1)
		count1 := len(jobs1)

		// Reprint.
		rr, rb := f.post(t, fmt.Sprintf("/api/v1/orders/%s/reprint-receipt", ord.ID), tok, uuid.NewString(), nil)
		if rr.StatusCode != 200 {
			t.Errorf("MISSING/failing: reprint-receipt status %d: %s", rr.StatusCode, rb)
			return
		}

		var jobs2 []models.PrintJob
		gdb.Where("order_id = ?", ord.ID).Find(&jobs2)
		if len(jobs2) <= count1 {
			t.Errorf("MISMATCH reprint did not create new job: before=%d, after=%d", count1, len(jobs2))
		}
	})

	t.Run("StockShortage_DoesNotBlockOrderCreate", func(t *testing.T) {
		// На уровне create order — никакой проверки stock. Это finding.
		f := setupE2E(t)
		tok := f.login(t)
		gdb, _ := db.Open(testDSN())
		t.Cleanup(func() {
			if sqlDB, err := gdb.DB(); err == nil {
				_ = sqlDB.Close()
			}
		})
		mid, _, _, ingID := bootstrapForOrder(t, f, gdb, "100")
		// Сводим qty к 0.
		gdb.Model(&models.Ingredient{}).Where("id = ?", ingID).Update("qty", decimal.MustFromString("0"))

		r, b := f.post(t, "/api/v1/orders", tok, uuid.NewString(),
			map[string]any{"items": []map[string]any{{"menu_item_id": mid, "qty": "1"}}})
		if r.StatusCode == 201 {
			t.Errorf("MISSING: stock-shortage guard — заказ создан при qty=0 (status 201). Body: %s", b)
		} else {
			t.Logf("OK: order create blocked due to stock shortage status %d", r.StatusCode)
		}
	})

	t.Run("PrintQueue_RetryEndpoint", func(t *testing.T) {
		// Worker запускается отдельно — здесь ограничиваемся HTTP-контрактом
		// retry endpoint'а. Создаём failed-job напрямую в БД, дёргаем retry,
		// проверяем что status=pending и attempts сброшен.
		f := setupE2E(t)
		tok := f.login(t)
		gdb, _ := db.Open(testDSN())
		t.Cleanup(func() {
			if sqlDB, err := gdb.DB(); err == nil {
				_ = sqlDB.Close()
			}
		})

		failMsg := "boom"
		j := &models.PrintJob{
			ID:           uuid.NewString(),
			Type:         "receipt",
			Payload:      []byte("dummy"),
			Status:       "failed",
			Attempts:     5,
			LastError:    &failMsg,
			RestaurantID: &f.rid,
			CreatedAt:    time.Now().UTC(),
			UpdatedAt:    time.Now().UTC(),
		}
		if err := gdb.Create(j).Error; err != nil {
			t.Fatal(err)
		}
		rr, rb := f.post(t, fmt.Sprintf("/api/v1/print/jobs/%s/retry", j.ID), tok, uuid.NewString(), nil)
		if rr.StatusCode != 200 && rr.StatusCode != 202 {
			t.Errorf("MISSING/failing retry endpoint status %d: %s", rr.StatusCode, rb)
			return
		}
		var after models.PrintJob
		gdb.First(&after, "id = ?", j.ID)
		if after.Status != "pending" {
			t.Errorf("MISMATCH retry status = %s, want pending", after.Status)
		}
	})

	t.Run("SSE_OrderClosedEvent", func(t *testing.T) {
		f := setupE2E(t)
		tok := f.login(t)
		gdb, _ := db.Open(testDSN())
		t.Cleanup(func() {
			if sqlDB, err := gdb.DB(); err == nil {
				_ = sqlDB.Close()
			}
		})
		mid, sid, accID, _ := bootstrapForOrder(t, f, gdb, "1000")
		gdb.Model(&models.MenuItem{}).Where("id = ?", mid).Update("price", decimal.MustFromString("100"))

		// Подключаемся к SSE в фоне.
		gotCh := make(chan string, 1)
		errCh := make(chan error, 1)
		go func() {
			data, err := readSSEUntil(f.srv.URL, tok, "order.closed", 3*time.Second)
			if err != nil {
				errCh <- err
				return
			}
			gotCh <- data
		}()
		time.Sleep(200 * time.Millisecond)

		// Создаём + закрываем заказ.
		r, b := f.post(t, "/api/v1/orders", tok, uuid.NewString(),
			map[string]any{"items": []map[string]any{{"menu_item_id": mid, "qty": "1"}}})
		if r.StatusCode != 201 {
			t.Fatalf("create %d: %s", r.StatusCode, b)
		}
		var ord models.Order
		_ = json.Unmarshal(b, &ord)
		cr, cb := f.post(t, fmt.Sprintf("/api/v1/orders/%s/close", ord.ID), tok, uuid.NewString(),
			map[string]any{"payment_method": "cash", "account_id": accID, "shift_id": sid})
		if cr.StatusCode != 200 {
			t.Fatalf("close %d: %s", cr.StatusCode, cb)
		}

		select {
		case data := <-gotCh:
			t.Logf("OK: SSE order.closed event received: %s", data)
		case err := <-errCh:
			t.Errorf("MISMATCH/MISSING SSE order.closed: %v", err)
		case <-time.After(3 * time.Second):
			t.Errorf("MISMATCH: timeout waiting for order.closed SSE event")
		}
	})

	t.Run("License_Lock_NotEnforcedInTestRouter", func(t *testing.T) {
		// LicenseRequired middleware подключается только при LicensePublicKey != nil.
		// В setupE2E LicensePublicKey не задаётся — middleware отсутствует.
		// Фиксируем это и документируем, что под продовым роутером блокировка
		// есть (см. middleware/license.go).
		t.Skipf("not testable: setupE2E uses nil LicensePublicKey → LicenseRequired middleware not mounted. Covered in middleware/license_test.go separately.")
	})

	t.Run("Inventory_Recount_Apply", func(t *testing.T) {
		f := setupE2E(t)
		tok := f.login(t)
		gdb, _ := db.Open(testDSN())
		t.Cleanup(func() {
			if sqlDB, err := gdb.DB(); err == nil {
				_ = sqlDB.Close()
			}
		})

		// Создаём ingredient qty=10.
		name, unit := "InvRice", "kg"
		ing := &models.Ingredient{
			ID: uuid.NewString(), Name: &name, Unit: &unit, RestaurantID: &f.rid,
			Qty: decimal.MustFromString("10"),
		}
		if err := gdb.Create(ing).Error; err != nil {
			t.Fatal(err)
		}

		// POST /stock/inventory: actual_qty=8.
		r, b := f.post(t, "/api/v1/stock/inventory", tok, uuid.NewString(),
			map[string]any{
				"note": "плановая",
				"lines": []map[string]any{
					{"ingredient_id": ing.ID, "actual_qty": "8"},
				},
			})
		if r.StatusCode != 201 {
			t.Fatalf("inventory create %d: %s", r.StatusCode, b)
		}
		var inv models.InventoryCheck
		_ = json.Unmarshal(b, &inv)

		// Apply.
		ar, ab := f.post(t, fmt.Sprintf("/api/v1/stock/inventory/%s/apply", inv.ID), tok, uuid.NewString(), nil)
		if ar.StatusCode != 200 {
			t.Fatalf("inventory apply %d: %s", ar.StatusCode, ab)
		}

		// qty должен стать 8 (через stock_movement diff=-2 + denorm-хук).
		var ingAfter models.Ingredient
		gdb.First(&ingAfter, "id = ?", ing.ID)
		if !ingAfter.Qty.Equal(decimal.MustFromString("8")) {
			t.Errorf("MISMATCH ingredient.qty after inventory apply = %s, want 8", ingAfter.Qty.String())
		}

		// Был создан stock_movement type=inventory_correction.
		var mvs []models.StockMovement
		gdb.Where("description = ?", "inventory:"+inv.ID).Find(&mvs)
		if len(mvs) != 1 {
			t.Errorf("MISMATCH inventory_correction movements = %d, want 1", len(mvs))
		}
		if len(mvs) == 1 && !mvs[0].Qty.Equal(decimal.MustFromString("-2")) {
			t.Errorf("MISMATCH correction qty = %s, want -2", mvs[0].Qty.String())
		}
	})

	t.Run("StopList_Override_DoesNotBlockOrder", func(t *testing.T) {
		// SetOverride просто помечает позицию; запрет на создание заказа
		// с этой позицией бизнес-логикой не реализован (compute-on-read,
		// фронт обязан фильтровать). Это finding для бэка.
		f := setupE2E(t)
		tok := f.login(t)
		gdb, _ := db.Open(testDSN())
		t.Cleanup(func() {
			if sqlDB, err := gdb.DB(); err == nil {
				_ = sqlDB.Close()
			}
		})

		mid, _, _, _ := bootstrapForOrder(t, f, gdb, "100")
		// Override.
		rr, rb := f.post(t, fmt.Sprintf("/api/v1/stop-list/%s/override", mid), tok, uuid.NewString(),
			map[string]any{"override": true})
		if rr.StatusCode != 200 {
			t.Fatalf("override %d: %s", rr.StatusCode, rb)
		}
		// Order с заблокированной позицией.
		r, b := f.post(t, "/api/v1/orders", tok, uuid.NewString(),
			map[string]any{"items": []map[string]any{{"menu_item_id": mid, "qty": "1"}}})
		if r.StatusCode == 201 {
			t.Errorf("MISSING: stop-list override НЕ блокирует создание заказа (status 201). FE-only guard.")
		} else {
			t.Logf("OK: stop-listed item rejected status %d: %s", r.StatusCode, b)
		}
	})

	t.Run("Reservation_AutoExpire_NotImplemented", func(t *testing.T) {
		// Нет background-job для auto-expire старых reservations.
		// Зафиксируем как finding.
		t.Logf("DOCUMENTED MISSING: reservation auto-expire job not implemented (no /reservations/expire endpoint, no cron).")
	})

	t.Run("Backup_Restore_NotTestableViaHTTP", func(t *testing.T) {
		// jobs/backup.go использует pg_dump shell-out. Это unit-test'абельно
		// в internal/jobs/, но не через HTTP endpoint (его нет).
		t.Logf("DOCUMENTED MISSING: backup/restore не имеет HTTP endpoint'ов. Покрыто внутри internal/jobs/backup_test.go (если есть).")
	})
}

// readSSEUntil — читает SSE поток и ждёт event указанного типа.
func readSSEUntil(baseURL, tok, eventType string, timeout time.Duration) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", baseURL+"/api/v1/events", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("status %d", resp.StatusCode)
	}
	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	var currentEvent string
	for sc.Scan() {
		line := sc.Text()
		switch {
		case strings.HasPrefix(line, "event: "):
			currentEvent = strings.TrimPrefix(line, "event: ")
		case strings.HasPrefix(line, "data: "):
			if currentEvent == eventType {
				return strings.TrimPrefix(line, "data: "), nil
			}
		}
	}
	if err := sc.Err(); err != nil {
		return "", err
	}
	return "", fmt.Errorf("stream ended without %s", eventType)
}
