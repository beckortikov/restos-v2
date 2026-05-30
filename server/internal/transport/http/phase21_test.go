//go:build integration

package http_test

import (
	"encoding/json"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/db"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// ═════════════════════════════════════════════════════════════════════════════
// Phase 21 — coverage для критичных fix'ов v2.0.17/19/21:
//   • Close: service_percent корректно включается в total_with_service.
//   • Close: financial_accounts.balance растёт на TotalWithService.
//   • Create: order_number начинается с 1 per restaurant per day, инкрементится.
//   • Create: 50 параллельных создaний → номера 1..50 без дыр и дубликатов.
// ═════════════════════════════════════════════════════════════════════════════

// TestClose_WithServicePercent — закрытие заказа со service_percent=10 даёт
// total_with_service = total + 10% + tip. До v2.0.17 backend игнорировал
// сервис и возвращал total + tip, FE падал с «sum(payments) != total_with_service».
func TestClose_WithServicePercent(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	_, menuItemID, shiftID, accountID := seedForWrite(t, f)

	// Create: 2 × 25 = 50.
	resp, body := f.post(t, "/api/v1/orders", tok, uuid.NewString(), map[string]any{
		"items": []map[string]any{
			{"menu_item_id": menuItemID, "qty": "1"},
			{"menu_item_id": menuItemID, "qty": "1"},
		},
	})
	if resp.StatusCode != 201 {
		t.Fatalf("create %d: %s", resp.StatusCode, body)
	}
	var created models.Order
	_ = json.Unmarshal(body, &created)

	// Close с service_percent=10 и tip=5 → total_with_service = 50 + 5 + 5 = 60.
	closePath := fmt.Sprintf("/api/v1/orders/%s/close", created.ID)
	resp, body = f.post(t, closePath, tok, uuid.NewString(), map[string]any{
		"payment_method":  "cash",
		"account_id":      accountID,
		"shift_id":        shiftID,
		"tip_amount":      "5",
		"service_percent": "10",
	})
	if resp.StatusCode != 200 {
		t.Fatalf("close %d: %s", resp.StatusCode, body)
	}
	var closed models.Order
	_ = json.Unmarshal(body, &closed)
	if !closed.ServiceAmount.Equal(decimal.MustFromString("5")) {
		t.Errorf("service_amount = %s, want 5 (10%% of 50)", closed.ServiceAmount.String())
	}
	if !closed.TotalWithService.Equal(decimal.MustFromString("60")) {
		t.Errorf("total_with_service = %s, want 60 (50 + service 5 + tip 5)", closed.TotalWithService.String())
	}
}

// TestClose_MultiPayment_SumValidation — payments[].amount должен совпадать
// с backend total_with_service (с учётом service). Если cashier шлёт сумму
// без сервиса, backend отвергает с VALIDATION.
func TestClose_MultiPayment_SumValidation(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	_, menuItemID, shiftID, accountID := seedForWrite(t, f)

	resp, body := f.post(t, "/api/v1/orders", tok, uuid.NewString(), map[string]any{
		"items": []map[string]any{
			{"menu_item_id": menuItemID, "qty": "1"}, // 25
		},
	})
	var created models.Order
	_ = json.Unmarshal(body, &created)
	if resp.StatusCode != 201 {
		t.Fatalf("create %d: %s", resp.StatusCode, body)
	}

	// service=10% → service_amount=2.5 → expected total_with_service=27.5.
	// Шлём split с суммой 25 (без сервиса) — должно упасть.
	closePath := fmt.Sprintf("/api/v1/orders/%s/close", created.ID)
	resp, _ = f.post(t, closePath, tok, uuid.NewString(), map[string]any{
		"shift_id":        shiftID,
		"service_percent": "10",
		"payments": []map[string]any{
			{"method": "cash", "amount": "25", "account_id": accountID},
		},
	})
	if resp.StatusCode != 400 {
		t.Fatalf("want 400 sum mismatch, got %d", resp.StatusCode)
	}

	// Тот же сценарий с amount=27.5 (с сервисом) — должен пройти.
	resp, body = f.post(t, closePath, tok, uuid.NewString(), map[string]any{
		"shift_id":        shiftID,
		"service_percent": "10",
		"payments": []map[string]any{
			{"method": "cash", "amount": "27.5", "account_id": accountID},
		},
	})
	if resp.StatusCode != 200 {
		t.Fatalf("close with matching sum %d: %s", resp.StatusCode, body)
	}
}

// TestClose_CreditsAccountBalance — после close баланс financial_account
// должен вырасти на TotalWithService. До v2.0.19 backend создавал
// financial_operation, но account.balance оставался 0.
func TestClose_CreditsAccountBalance(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, menuItemID, shiftID, accountID := seedForWrite(t, f)

	// Открывающий баланс = 100.
	if err := gdb.Model(&models.FinancialAccount{}).
		Where("id = ?", accountID).
		Update("balance", decimal.MustFromString("100")).Error; err != nil {
		t.Fatal(err)
	}

	resp, body := f.post(t, "/api/v1/orders", tok, uuid.NewString(), map[string]any{
		"items": []map[string]any{{"menu_item_id": menuItemID, "qty": "2"}}, // 50
	})
	var created models.Order
	_ = json.Unmarshal(body, &created)

	closePath := fmt.Sprintf("/api/v1/orders/%s/close", created.ID)
	resp, body = f.post(t, closePath, tok, uuid.NewString(), map[string]any{
		"payment_method": "cash",
		"account_id":     accountID,
		"shift_id":       shiftID,
	})
	if resp.StatusCode != 200 {
		t.Fatalf("close %d: %s", resp.StatusCode, body)
	}

	var acc models.FinancialAccount
	if err := gdb.First(&acc, "id = ?", accountID).Error; err != nil {
		t.Fatal(err)
	}
	if !acc.Balance.Equal(decimal.MustFromString("150")) {
		t.Errorf("account.balance = %s, want 150 (opening 100 + sale 50)", acc.Balance.String())
	}
}

// TestClose_CreditsAccountBalance_MultiPayment — split-payment кредитит
// КАЖДЫЙ соответствующий счёт на свою долю.
func TestClose_CreditsAccountBalance_MultiPayment(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, menuItemID, shiftID, cashAccID := seedForWrite(t, f)

	// Второй счёт — карта.
	cardAccID := uuid.NewString()
	cardName := "Bank"
	cardType := "bank"
	if err := gdb.Create(&models.FinancialAccount{
		ID: cardAccID, Name: &cardName, Type: &cardType, RestaurantID: &f.rid,
	}).Error; err != nil {
		t.Fatal(err)
	}

	resp, body := f.post(t, "/api/v1/orders", tok, uuid.NewString(), map[string]any{
		"items": []map[string]any{{"menu_item_id": menuItemID, "qty": "4"}}, // 100
	})
	var created models.Order
	_ = json.Unmarshal(body, &created)
	if resp.StatusCode != 201 {
		t.Fatalf("create %d: %s", resp.StatusCode, body)
	}

	closePath := fmt.Sprintf("/api/v1/orders/%s/close", created.ID)
	resp, body = f.post(t, closePath, tok, uuid.NewString(), map[string]any{
		"shift_id": shiftID,
		"payments": []map[string]any{
			{"method": "cash", "amount": "60", "account_id": cashAccID},
			{"method": "card", "amount": "40", "account_id": cardAccID},
		},
	})
	if resp.StatusCode != 200 {
		t.Fatalf("close %d: %s", resp.StatusCode, body)
	}

	var cash, card models.FinancialAccount
	_ = gdb.First(&cash, "id = ?", cashAccID).Error
	_ = gdb.First(&card, "id = ?", cardAccID).Error
	if !cash.Balance.Equal(decimal.MustFromString("60")) {
		t.Errorf("cash balance = %s, want 60", cash.Balance.String())
	}
	if !card.Balance.Equal(decimal.MustFromString("40")) {
		t.Errorf("card balance = %s, want 40", card.Balance.String())
	}
}

// TestCreate_OrderNumberPerDay — order_number начинается с 1 per restaurant,
// инкрементится 1,2,3. До v2.0.21 все заказы получали 0 (SERIAL не работал).
func TestCreate_OrderNumberPerDay(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	_, menuItemID, _, _ := seedForWrite(t, f)

	for want := 1; want <= 3; want++ {
		resp, body := f.post(t, "/api/v1/orders", tok, uuid.NewString(), map[string]any{
			"items": []map[string]any{{"menu_item_id": menuItemID, "qty": "1"}},
		})
		if resp.StatusCode != 201 {
			t.Fatalf("create #%d: %d: %s", want, resp.StatusCode, body)
		}
		var o models.Order
		_ = json.Unmarshal(body, &o)
		if o.OrderNumber != want {
			t.Errorf("order #%d → OrderNumber=%d, want %d", want, o.OrderNumber, want)
		}
	}
}

// TestCreate_OrderNumberResetsNextDay — если счётчик в order_counters стоит
// на вчерашней дате, новый заказ сегодня получает номер 1.
func TestCreate_OrderNumberResetsNextDay(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, menuItemID, _, _ := seedForWrite(t, f)

	// Заранее записываем «вчерашний» счётчик с last_number=42.
	yesterday := time.Now().AddDate(0, 0, -1).Format("2006-01-02")
	if err := gdb.Exec(`
		INSERT INTO order_counters (restaurant_id, date, last_number, updated_at)
		VALUES (?, ?::date, 42, now())
	`, f.rid, yesterday).Error; err != nil {
		t.Fatal(err)
	}

	resp, body := f.post(t, "/api/v1/orders", tok, uuid.NewString(), map[string]any{
		"items": []map[string]any{{"menu_item_id": menuItemID, "qty": "1"}},
	})
	if resp.StatusCode != 201 {
		t.Fatalf("create %d: %s", resp.StatusCode, body)
	}
	var o models.Order
	_ = json.Unmarshal(body, &o)
	if o.OrderNumber != 1 {
		t.Errorf("new day OrderNumber = %d, want 1 (yesterday's 42 must not leak)", o.OrderNumber)
	}
}

// TestCreate_OrderNumberConcurrent — 20 параллельных создaний дают набор
// {1..20} без дыр и дубликатов (race-safety UPSERT'а).
func TestCreate_OrderNumberConcurrent(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	_, menuItemID, _, _ := seedForWrite(t, f)

	const N = 20
	var wg sync.WaitGroup
	nums := make(chan int, N)
	for i := 0; i < N; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			resp, body := f.post(t, "/api/v1/orders", tok, uuid.NewString(), map[string]any{
				"items": []map[string]any{{"menu_item_id": menuItemID, "qty": "1"}},
			})
			if resp.StatusCode != 201 {
				return
			}
			var o models.Order
			_ = json.Unmarshal(body, &o)
			nums <- o.OrderNumber
		}()
	}
	wg.Wait()
	close(nums)

	seen := make(map[int]bool)
	for n := range nums {
		if seen[n] {
			t.Errorf("duplicate OrderNumber %d", n)
		}
		seen[n] = true
	}
	if len(seen) != N {
		t.Errorf("got %d distinct numbers, want %d", len(seen), N)
	}
	for i := 1; i <= N; i++ {
		if !seen[i] {
			t.Errorf("missing OrderNumber %d in [1..%d]", i, N)
		}
	}
}

// Sanity: миграция 008 действительно создала order_counters.
func TestMigration008_OrderCountersTable(t *testing.T) {
	f := setupE2E(t)
	_ = f
	gdb, err := db.Open(testDSN())
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	}()
	var exists bool
	if err := gdb.Raw(`SELECT EXISTS (
		SELECT FROM information_schema.tables WHERE table_name = 'order_counters'
	)`).Scan(&exists).Error; err != nil {
		t.Fatal(err)
	}
	if !exists {
		t.Fatal("order_counters table not created by migration 008")
	}
}
