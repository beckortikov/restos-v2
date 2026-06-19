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

// TestDashboardVsShiftRevenue — регрессионный тест согласованности выручки
// между дашбордом и сменой.
//
//   - «Выручка смены» / «Средний чек» (endpoint /shifts/{id}/revenue) берутся
//     из денормализованных агрегатов cash_shifts.
//     База = order.total_with_service = (total - discount) + service + tip.
//     Эта же сумма идёт в financial_operations(revenue) и на баланс кассы
//     (см. close_order: orders_close.go:404,420) — это реально полученные деньги.
//
//   - «Выручка сегодня» / «Средний чек» на дашборде считаются на фронте из
//     списка /orders по закрытым заказам за сегодня. Раньше база была
//     order.total (БЕЗ service) → дашборд занижал выручку на сумму сервиса.
//     Исправлено: дашборд использует total_with_service (часы/официанты тоже,
//     т.к. сервис на чек целиком). См. app/(app)/dashboard/page.tsx.
//
// Тест проверяет:
//  1. дашбордная база total_with_service СОВПАДАЕТ с выручкой смены (фикс);
//  2. старая база order.total занижала ровно на сумму сервиса (документирует
//     причину прежнего расхождения и ловит регресс в обратную сторону).
//
// Сценарий: 1 заказ 5×Плов (price 50) = total 250, service 10% →
// total_with_service 275. Оплата cash в открытой смене.
func TestDashboardVsShiftRevenue(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)

	// Касса для оплаты.
	cashAccID := uuid.NewString()
	cashName := "Касса"
	cashType := "cash"
	gdb, err := db.Open(testDSN())
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})
	if err := gdb.Create(&models.FinancialAccount{
		ID: cashAccID, Name: &cashName, Type: &cashType,
		RestaurantID: &f.rid, Balance: decimal.MustFromString("1000"),
	}).Error; err != nil {
		t.Fatal(err)
	}

	// Собственная позиция с детерминированной ценой 50 (setupE2E создаёт
	// "Plov" 25 — не используем его, чтобы числа были ровные).
	plovName := "ПловТест"
	plov := models.MenuItem{
		ID: uuid.NewString(), Name: &plovName,
		Price: decimal.MustFromString("50"), RestaurantID: &f.rid,
	}
	if err := gdb.Create(&plov).Error; err != nil {
		t.Fatal(err)
	}

	// ─── Открыть смену ───────────────────────────────────────────────────
	r, b := f.post(t, "/api/v1/shifts", tok, uuid.NewString(),
		map[string]any{"opening_balance": "100", "account_id": cashAccID})
	if r.StatusCode != 201 {
		t.Fatalf("open shift %d: %s", r.StatusCode, b)
	}
	var shift models.CashShift
	_ = json.Unmarshal(b, &shift)
	shiftID := shift.ID

	// ─── Создать и закрыть заказ: total 250, service 10% → 275 ───────────
	r, b = f.post(t, "/api/v1/orders", tok, uuid.NewString(),
		map[string]any{"items": []map[string]any{{"menu_item_id": plov.ID, "qty": "5"}}})
	if r.StatusCode != 201 {
		t.Fatalf("create order %d: %s", r.StatusCode, b)
	}
	var ord models.Order
	_ = json.Unmarshal(b, &ord)
	if !ord.Total.Equal(decimal.MustFromString("250")) {
		t.Fatalf("setup: order.total = %s, want 250", ord.Total.String())
	}

	r, b = f.post(t, fmt.Sprintf("/api/v1/orders/%s/close", ord.ID), tok, uuid.NewString(),
		map[string]any{
			"payment_method":  "cash",
			"account_id":      cashAccID,
			"shift_id":        shiftID,
			"service_percent": "10",
		})
	if r.StatusCode != 200 {
		t.Fatalf("close order %d: %s", r.StatusCode, b)
	}
	var closed models.Order
	_ = json.Unmarshal(b, &closed)
	if !closed.TotalWithService.Equal(decimal.MustFromString("275")) {
		t.Fatalf("setup: total_with_service = %s, want 275", closed.TotalWithService.String())
	}

	// ─── Метрика 1: выручка смены (endpoint, как на экране смены) ─────────
	rr, rb := f.get(t, fmt.Sprintf("/api/v1/shifts/%s/revenue", shiftID), tok)
	if rr.StatusCode != 200 {
		t.Fatalf("shift revenue %d: %s", rr.StatusCode, rb)
	}
	var shiftRev struct {
		CashRevenue decimal.Decimal `json:"cash_revenue"`
		CardRevenue decimal.Decimal `json:"card_revenue"`
		OrdersCount int             `json:"orders_count"`
		AvgCheck    decimal.Decimal `json:"avg_check"`
	}
	if err := json.Unmarshal(rb, &shiftRev); err != nil {
		t.Fatal(err)
	}
	shiftRevenue := decimal.Add(shiftRev.CashRevenue, shiftRev.CardRevenue)

	// ─── Метрика 2: выручка дашборда (как считает фронт из /orders) ──────
	// Реплицируем app/(app)/dashboard/page.tsx:
	//   todayOrders = orders.filter(status==='done' && closedAt startsWith today)
	//   todayRevenue = sum(o.totalWithService ?? o.total)   ← после фикса
	//   avgCheck     = todayRevenue / todayOrders.length
	// Параллельно считаем старую базу sum(o.total) — для проверки, что прежнее
	// расхождение было ровно на сумму сервиса.
	or, ob := f.get(t, "/api/v1/orders?limit=1000&include=items", tok)
	if or.StatusCode != 200 {
		t.Fatalf("orders list %d: %s", or.StatusCode, ob)
	}
	var ordersEnv struct {
		Data []struct {
			Status           *string         `json:"status"`
			Total            decimal.Decimal `json:"total"`
			TotalWithService decimal.Decimal `json:"total_with_service"`
			ClosedAt         *time.Time      `json:"closed_at"`
		} `json:"data"`
	}
	if err := json.Unmarshal(ob, &ordersEnv); err != nil {
		t.Fatal(err)
	}
	todayUTC := time.Now().UTC().Format("2006-01-02")
	dashRevenue := decimal.Zero    // новая база: total_with_service
	dashRevenueOld := decimal.Zero // старая база: total (без service)
	dashCount := 0
	for _, o := range ordersEnv.Data {
		// status==='done' на фронте = "closed" на бэке (маппинг в _mapV4Order).
		if o.Status == nil || *o.Status != "closed" {
			continue
		}
		if o.ClosedAt == nil || o.ClosedAt.UTC().Format("2006-01-02") != todayUTC {
			continue
		}
		dashRevenue = decimal.Add(dashRevenue, o.TotalWithService)
		dashRevenueOld = decimal.Add(dashRevenueOld, o.Total)
		dashCount++
	}
	dashAvg := decimal.Zero
	if dashCount > 0 {
		dashAvg = decimal.Normalize(decimal.DivRound(dashRevenue, decimal.FromInt(int64(dashCount))))
	}

	// ─── Сверка выручки: дашборд (новая база) == смена ───────────────────
	t.Logf("выручка смены = %s ; выручка дашборда = %s ; старая база дашборда = %s",
		shiftRevenue.String(), dashRevenue.String(), dashRevenueOld.String())
	if !shiftRevenue.Equal(decimal.MustFromString("275")) {
		t.Errorf("выручка смены = %s, want 275 (total_with_service)", shiftRevenue.String())
	}
	if !dashRevenue.Equal(shiftRevenue) {
		t.Errorf("выручка дашборда (%s) != выручка смены (%s) — фикс должен их выравнивать",
			dashRevenue.String(), shiftRevenue.String())
	}
	// Старая база занижала ровно на сумму сервиса (25 = 10% от 250).
	if !dashRevenueOld.Equal(decimal.MustFromString("250")) {
		t.Errorf("старая база дашборда = %s, want 250 (order.total)", dashRevenueOld.String())
	}
	if diff := decimal.Sub(shiftRevenue, dashRevenueOld); !diff.Equal(decimal.MustFromString("25")) {
		t.Errorf("занижение старой базы = %s, want 25 (= service 10%% от 250)", diff.String())
	}

	// ─── Сверка среднего чека: дашборд == смена ──────────────────────────
	t.Logf("средний чек смены = %s ; средний чек дашборда = %s", shiftRev.AvgCheck.String(), dashAvg.String())
	if shiftRev.OrdersCount != 1 || dashCount != 1 {
		t.Errorf("кол-во заказов: смена=%d дашборд=%d, want 1/1", shiftRev.OrdersCount, dashCount)
	}
	if !shiftRev.AvgCheck.Equal(decimal.MustFromString("275")) {
		t.Errorf("средний чек смены = %s, want 275", shiftRev.AvgCheck.String())
	}
	if !dashAvg.Equal(shiftRev.AvgCheck) {
		t.Errorf("средний чек дашборда (%s) != средний чек смены (%s)", dashAvg.String(), shiftRev.AvgCheck.String())
	}
}
