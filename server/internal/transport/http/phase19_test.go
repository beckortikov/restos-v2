//go:build integration

package http_test

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// ═════════════════════════════════════════════════════════════════════════
// Phase 19 — stock + tech-card validation (порт v1 stock-check.ts)
// ═════════════════════════════════════════════════════════════════════════

// setRestaurantFlags — toggle tech_cards_enabled / enforce_stock_check у тестового ресторана.
func setRestaurantFlags(t *testing.T, gdb *gorm.DB, rid string, techCards, enforce bool) {
	t.Helper()
	if err := gdb.Model(&models.Restaurant{}).
		Where("id = ?", rid).
		Updates(map[string]any{
			"tech_cards_enabled":  techCards,
			"enforce_stock_check": enforce,
		}).Error; err != nil {
		t.Fatal(err)
	}
}

// createMenuItem — простой helper.
func createMenuItem(t *testing.T, gdb *gorm.DB, rid, name string, price string) string {
	t.Helper()
	id := uuid.NewString()
	if err := gdb.Create(&models.MenuItem{
		ID: id, Name: &name, Price: decimal.MustFromString(price), RestaurantID: &rid,
	}).Error; err != nil {
		t.Fatal(err)
	}
	return id
}

// TestPhase19_CreateOrder_MissingTechCard — order item без tech_card_lines
// при tech_cards_enabled=true должен быть отклонён.
func TestPhase19_CreateOrder_MissingTechCard(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, _, _ := seedForWrite(t, f)
	// Включаем tech_cards (без enforce → mode = tech-card-only).
	setRestaurantFlags(t, gdb, f.rid, true, false)

	// Создаём блюдо БЕЗ tech_card_lines.
	naked := createMenuItem(t, gdb, f.rid, "Без техкарты", "10")

	resp, body := f.post(t, "/api/v1/orders", tok, uuid.NewString(), map[string]any{
		"items": []map[string]any{{"menu_item_id": naked, "qty": "1"}},
	})
	if resp.StatusCode != 400 {
		t.Fatalf("want 400 VALIDATION, got %d: %s", resp.StatusCode, body)
	}
	var env struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	}
	_ = json.Unmarshal(body, &env)
	if env.Code != "VALIDATION" {
		t.Errorf("want code=VALIDATION, got %s (%s)", env.Code, env.Message)
	}
}

// TestPhase19_CreateOrder_StockOK — sufficient stock → 201.
func TestPhase19_CreateOrder_StockOK(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, menuItemID, _, _ := seedForWrite(t, f)
	// seedForWrite уже создал Rice qty=10 и tech card 0.2/portion.
	// strict mode: 10/0.2 = 50 portions max.
	setRestaurantFlags(t, gdb, f.rid, true, true)

	resp, body := f.post(t, "/api/v1/orders", tok, uuid.NewString(), map[string]any{
		"items": []map[string]any{{"menu_item_id": menuItemID, "qty": "1"}},
	})
	if resp.StatusCode != 201 {
		t.Fatalf("want 201, got %d: %s", resp.StatusCode, body)
	}
}

// TestPhase19_CreateOrder_StockShort — strict + недостаточно → 400.
func TestPhase19_CreateOrder_StockShort(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, menuItemID, _, _ := seedForWrite(t, f)
	setRestaurantFlags(t, gdb, f.rid, true, true)

	// 10 кг / 0.2 = 50 порций max. Заказываем 100 → shortage.
	resp, body := f.post(t, "/api/v1/orders", tok, uuid.NewString(), map[string]any{
		"items": []map[string]any{{"menu_item_id": menuItemID, "qty": "100"}},
	})
	if resp.StatusCode != 400 {
		t.Fatalf("want 400 VALIDATION, got %d: %s", resp.StatusCode, body)
	}
}

// TestPhase19_CreateOrder_StockShortButLax — недостаточно, но enforce=false
// и техкарта есть → 201 (allow, может уйти в минус).
func TestPhase19_CreateOrder_StockShortButLax(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, menuItemID, _, _ := seedForWrite(t, f)
	setRestaurantFlags(t, gdb, f.rid, true, false) // tech-card-only

	resp, body := f.post(t, "/api/v1/orders", tok, uuid.NewString(), map[string]any{
		"items": []map[string]any{{"menu_item_id": menuItemID, "qty": "100"}},
	})
	if resp.StatusCode != 201 {
		t.Fatalf("want 201 (lax mode allows over-sell with tech card), got %d: %s", resp.StatusCode, body)
	}
}

// TestPhase19_CreateOrder_RaceReservation — первый заказ резервирует 0.8 из 1.0;
// второй заказ просит 0.4 → 400 (по reserve).
func TestPhase19_CreateOrder_RaceReservation(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, menuItemID, _, _ := seedForWrite(t, f)

	// Уменьшим ingredient до 1 кг чтобы race-условие срабатывало быстро.
	if err := gdb.Model(&models.Ingredient{}).
		Where("restaurant_id = ?", f.rid).
		Update("qty", decimal.MustFromString("1")).Error; err != nil {
		t.Fatal(err)
	}
	setRestaurantFlags(t, gdb, f.rid, true, true)

	// 1й заказ: 4 порции × 0.2 = 0.8 кг → ок (резервирует 0.8 из 1.0).
	resp1, body1 := f.post(t, "/api/v1/orders", tok, uuid.NewString(), map[string]any{
		"items": []map[string]any{{"menu_item_id": menuItemID, "qty": "4"}},
	})
	if resp1.StatusCode != 201 {
		t.Fatalf("first order: want 201, got %d: %s", resp1.StatusCode, body1)
	}

	// 2й заказ: 2 порции × 0.2 = 0.4 кг → но осталось только 0.2 кг → 400.
	resp2, body2 := f.post(t, "/api/v1/orders", tok, uuid.NewString(), map[string]any{
		"items": []map[string]any{{"menu_item_id": menuItemID, "qty": "2"}},
	})
	if resp2.StatusCode != 400 {
		t.Fatalf("second order: want 400 due to reservation, got %d: %s", resp2.StatusCode, body2)
	}
}

// TestPhase19_DeductGuardStrict — close заказа который должен уйти в минус
// при strict mode → 409 conflict, rollback.
func TestPhase19_DeductGuardStrict(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, menuItemID, shiftID, accountID := seedForWrite(t, f)

	// Сначала включаем lax (tech-card-only), создаём заказ на 100 порций (= 20 кг), при stock 10 кг.
	// Затем переключаем на strict и пробуем закрыть. После create stock = 10 (не уменьшался).
	// На close стоковый deduct хук попытается -20 → newQty = -10 → strict guard сработает.
	setRestaurantFlags(t, gdb, f.rid, true, false)

	resp, body := f.post(t, "/api/v1/orders", tok, uuid.NewString(), map[string]any{
		"items": []map[string]any{{"menu_item_id": menuItemID, "qty": "100"}},
	})
	if resp.StatusCode != 201 {
		t.Fatalf("create order under lax: %d %s", resp.StatusCode, body)
	}
	var created models.Order
	_ = json.Unmarshal(body, &created)

	// Включаем strict перед закрытием.
	setRestaurantFlags(t, gdb, f.rid, true, true)

	closePath := fmt.Sprintf("/api/v1/orders/%s/close", created.ID)
	resp2, body2 := f.post(t, closePath, tok, uuid.NewString(), map[string]any{
		"payment_method": "cash",
		"account_id":     accountID,
		"shift_id":       shiftID,
	})
	// Guard должен откатить tx → 409 CONFLICT.
	if resp2.StatusCode != 409 && resp2.StatusCode != 500 {
		t.Fatalf("want 409/500 from stock guard, got %d: %s", resp2.StatusCode, body2)
	}

	// Verify rollback: ingredient qty не изменился.
	var ing models.Ingredient
	if err := gdb.Where("restaurant_id = ?", f.rid).First(&ing).Error; err != nil {
		t.Fatal(err)
	}
	if !ing.Qty.Equal(decimal.MustFromString("10")) {
		t.Errorf("ingredient qty changed despite rollback: %s (want 10)", ing.Qty.String())
	}
	// Order status НЕ должен быть closed.
	var ord models.Order
	if err := gdb.First(&ord, "id = ?", created.ID).Error; err != nil {
		t.Fatal(err)
	}
	if ord.Status != nil && *ord.Status == "closed" {
		t.Errorf("order should not be closed after guard rollback")
	}
	// Ranges of dead-letter prints — ничего из stock_movements не должно быть для этого заказа.
	var mvCount int64
	_ = gdb.Model(&models.StockMovement{}).Where("description = ?", "order:"+created.ID).Count(&mvCount).Error
	if mvCount != 0 {
		t.Errorf("stock_movements should be rolled back, got %d", mvCount)
	}
	_ = time.Now()
}

// TestPhase19_DeductGuardLax — close с уходом qty в минус под lax (enforce=false) → success.
func TestPhase19_DeductGuardLax(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, menuItemID, shiftID, accountID := seedForWrite(t, f)
	setRestaurantFlags(t, gdb, f.rid, true, false)

	resp, body := f.post(t, "/api/v1/orders", tok, uuid.NewString(), map[string]any{
		"items": []map[string]any{{"menu_item_id": menuItemID, "qty": "100"}}, // 20 кг при stock 10
	})
	if resp.StatusCode != 201 {
		t.Fatalf("create order lax: %d %s", resp.StatusCode, body)
	}
	var created models.Order
	_ = json.Unmarshal(body, &created)

	closePath := fmt.Sprintf("/api/v1/orders/%s/close", created.ID)
	resp2, body2 := f.post(t, closePath, tok, uuid.NewString(), map[string]any{
		"payment_method": "cash",
		"account_id":     accountID,
		"shift_id":       shiftID,
	})
	if resp2.StatusCode != 200 {
		t.Fatalf("want 200, got %d: %s", resp2.StatusCode, body2)
	}

	// Ingredient qty должен быть -10 (10 - 20). Не клампим.
	var ing models.Ingredient
	if err := gdb.Where("restaurant_id = ?", f.rid).First(&ing).Error; err != nil {
		t.Fatal(err)
	}
	if !ing.Qty.Equal(decimal.MustFromString("-10")) {
		t.Errorf("ingredient qty under lax: %s (want -10)", ing.Qty.String())
	}
}
