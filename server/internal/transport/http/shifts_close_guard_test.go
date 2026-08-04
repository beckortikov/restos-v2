//go:build integration

package http_test

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/google/uuid"
	"gorm.io/datatypes"

	"github.com/restos/restos-v4/server/internal/db"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// TestShiftClose_BlockedByOpenOrders — смену нельзя закрыть, пока есть
// незакрытые заказы (открытые столы / «с собой»). После их закрытия — можно.
func TestShiftClose_BlockedByOpenOrders(t *testing.T) {
	f := setupE2E(t)
	gdb, _ := db.Open(testDSN())
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})

	// Касса для оплаты/смены.
	cashAccID := uuid.NewString()
	cashName, cashType := "Касса", "cash"
	if err := gdb.Create(&models.FinancialAccount{
		ID: cashAccID, Name: &cashName, Type: &cashType, RestaurantID: &f.rid, Balance: decimal.Zero,
	}).Error; err != nil {
		t.Fatal(err)
	}
	// Меню-позиция.
	plovName := "Плов"
	plov := models.MenuItem{ID: uuid.NewString(), Name: &plovName, Price: decimal.MustFromString("50"), RestaurantID: &f.rid}
	if err := gdb.Create(&plov).Error; err != nil {
		t.Fatal(err)
	}

	tok := f.login(t)

	// Открыть смену.
	r, b := f.post(t, "/api/v1/shifts", tok, uuid.NewString(), map[string]any{"opening_balance": "0", "account_id": cashAccID})
	if r.StatusCode != 201 {
		t.Fatalf("open shift %d: %s", r.StatusCode, b)
	}
	var shift models.CashShift
	_ = json.Unmarshal(b, &shift)

	// Создать заказ (не закрывать) — status 'new', type hall.
	r, b = f.post(t, "/api/v1/orders", tok, uuid.NewString(), map[string]any{
		"items": []map[string]any{{"menu_item_id": plov.ID, "qty": "1"}},
	})
	if r.StatusCode != 201 {
		t.Fatalf("create order %d: %s", r.StatusCode, b)
	}
	var ord models.Order
	_ = json.Unmarshal(b, &ord)

	// ─── Закрытие смены заблокировано ────────────────────────────────────
	cr, cb := f.post(t, fmt.Sprintf("/api/v1/shifts/%s/close", shift.ID), tok, uuid.NewString(), map[string]any{"closing_balance": "0"})
	if cr.StatusCode != 409 {
		t.Fatalf("close shift with open order: got %d, want 409. body=%s", cr.StatusCode, cb)
	}
	if !strings.Contains(string(cb), "Сначала закройте") {
		t.Errorf("message should tell to close orders first, got: %s", cb)
	}
	// details.order_ids/order_numbers — machine-readable, чтобы фронт мог
	// найти и закрыть/отменить именно эти заказы, даже если они выпали из
	// «Активные заказы» (тот таб скоупится на текущую смену/дату и не видит
	// заказы-«хвосты» из прошлых смен — известный класс бага).
	var env struct {
		Details struct {
			OrderIDs     []string `json:"order_ids"`
			OrderNumbers []int    `json:"order_numbers"`
		} `json:"details"`
	}
	if err := json.Unmarshal(cb, &env); err != nil {
		t.Fatalf("decode error envelope: %v", err)
	}
	if len(env.Details.OrderIDs) != 1 || env.Details.OrderIDs[0] != ord.ID {
		t.Errorf("details.order_ids = %v, want [%s]", env.Details.OrderIDs, ord.ID)
	}
	if len(env.Details.OrderNumbers) != 1 || env.Details.OrderNumbers[0] != ord.OrderNumber {
		t.Errorf("details.order_numbers = %v, want [%d]", env.Details.OrderNumbers, ord.OrderNumber)
	}

	// ─── Закрываем заказ ─────────────────────────────────────────────────
	or, ob := f.post(t, fmt.Sprintf("/api/v1/orders/%s/close", ord.ID), tok, uuid.NewString(), map[string]any{
		"payment_method": "cash", "account_id": cashAccID, "shift_id": shift.ID,
	})
	if or.StatusCode != 200 {
		t.Fatalf("close order %d: %s", or.StatusCode, ob)
	}

	// ─── Теперь смена закрывается ────────────────────────────────────────
	cr2, cb2 := f.post(t, fmt.Sprintf("/api/v1/shifts/%s/close", shift.ID), tok, uuid.NewString(), map[string]any{"closing_balance": "50"})
	if cr2.StatusCode != 200 {
		t.Fatalf("close shift after closing order: %d %s", cr2.StatusCode, cb2)
	}
}

// TestShiftClose_ForceWithOpenOrders — 068: право shifts.close_with_open_orders
// (кассир имеет его по умолчанию) позволяет закрыть смену с висящими столами,
// но ТОЛЬКО с явным confirm_open_orders — первый запрос блокирует всё равно
// (details.can_force=true подсказывает фронту показать кнопку «Закрыть всё
// равно», а не тихо считает согласие). closed_open_orders_count фиксирует,
// сколько заказов было открыто в момент закрытия — для истории смен.
func TestShiftClose_ForceWithOpenOrders(t *testing.T) {
	f := setupE2E(t)
	gdb, _ := db.Open(testDSN())
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})

	cashAccID := uuid.NewString()
	cashName, cashType := "Касса", "cash"
	if err := gdb.Create(&models.FinancialAccount{
		ID: cashAccID, Name: &cashName, Type: &cashType, RestaurantID: &f.rid, Balance: decimal.Zero,
	}).Error; err != nil {
		t.Fatal(err)
	}
	plovName := "Плов"
	plov := models.MenuItem{ID: uuid.NewString(), Name: &plovName, Price: decimal.MustFromString("50"), RestaurantID: &f.rid}
	if err := gdb.Create(&plov).Error; err != nil {
		t.Fatal(err)
	}

	// Фикстура — кассир, у роли теперь shifts.close_with_open_orders=true по
	// умолчанию (не в personal actions, значит берётся из roleDefaults).
	tok := f.login(t)

	r, b := f.post(t, "/api/v1/shifts", tok, uuid.NewString(), map[string]any{"opening_balance": "0", "account_id": cashAccID})
	if r.StatusCode != 201 {
		t.Fatalf("open shift %d: %s", r.StatusCode, b)
	}
	var shift models.CashShift
	_ = json.Unmarshal(b, &shift)

	r, b = f.post(t, "/api/v1/orders", tok, uuid.NewString(), map[string]any{
		"items": []map[string]any{{"menu_item_id": plov.ID, "qty": "1"}},
	})
	if r.StatusCode != 201 {
		t.Fatalf("create order %d: %s", r.StatusCode, b)
	}

	// Первая попытка без confirm — блокирует, даже с правом. can_force=true
	// подтверждает, что право есть и кнопку «закрыть всё равно» показывать можно.
	cr, cb := f.post(t, "/api/v1/shifts/"+shift.ID+"/close", tok, uuid.NewString(), map[string]any{"closing_balance": "0"})
	if cr.StatusCode != 409 {
		t.Fatalf("close without confirm: got %d, want 409. body=%s", cr.StatusCode, cb)
	}
	var env struct {
		Details struct {
			CanForce bool `json:"can_force"`
		} `json:"details"`
	}
	if err := json.Unmarshal(cb, &env); err != nil {
		t.Fatalf("decode error envelope: %v", err)
	}
	if !env.Details.CanForce {
		t.Fatalf("can_force = false, want true — у кассира по умолчанию есть shifts.close_with_open_orders")
	}

	// С confirm_open_orders=true — закрывается, столы остаются висеть где были,
	// но смена закрыта и помечена closed_open_orders_count=1.
	cr2, cb2 := f.post(t, "/api/v1/shifts/"+shift.ID+"/close", tok, uuid.NewString(), map[string]any{
		"closing_balance": "0", "confirm_open_orders": true,
	})
	if cr2.StatusCode != 200 {
		t.Fatalf("close with confirm: %d %s", cr2.StatusCode, cb2)
	}
	var closed models.CashShift
	if err := json.Unmarshal(cb2, &closed); err != nil {
		t.Fatalf("decode closed shift: %v", err)
	}
	if closed.ClosedOpenOrdersCount != 1 {
		t.Errorf("closed_open_orders_count = %d, want 1", closed.ClosedOpenOrdersCount)
	}
	if closed.Status == nil || *closed.Status != "closed" {
		t.Errorf("status = %v, want closed", closed.Status)
	}
}

// TestShiftClose_ForceWithOpenOrders_DeniedWithoutPermission — без права
// shifts.close_with_open_orders confirm_open_orders=true НЕ помогает: бэк —
// источник правды, фронт-флаг сам по себе доступа не даёт.
func TestShiftClose_ForceWithOpenOrders_DeniedWithoutPermission(t *testing.T) {
	f := setupE2E(t)
	gdb, _ := db.Open(testDSN())
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})

	cashAccID := uuid.NewString()
	cashName, cashType := "Касса", "cash"
	if err := gdb.Create(&models.FinancialAccount{
		ID: cashAccID, Name: &cashName, Type: &cashType, RestaurantID: &f.rid, Balance: decimal.Zero,
	}).Error; err != nil {
		t.Fatal(err)
	}
	plovName := "Плов"
	plov := models.MenuItem{ID: uuid.NewString(), Name: &plovName, Price: decimal.MustFromString("50"), RestaurantID: &f.rid}
	if err := gdb.Create(&plov).Error; err != nil {
		t.Fatal(err)
	}
	tok := f.login(t)

	// Явный оверрайд роли — снимаем право у ЭТОГО конкретного кассира
	// (например, стажёр, которому владелец решил пересменку без старшего не давать).
	if err := gdb.Model(&models.User{}).Where("restaurant_id = ?", f.rid).
		Update("permissions", datatypes.JSON([]byte(`{"actions":{"shifts.close_with_open_orders":false}}`))).Error; err != nil {
		t.Fatal(err)
	}

	r, b := f.post(t, "/api/v1/shifts", tok, uuid.NewString(), map[string]any{"opening_balance": "0", "account_id": cashAccID})
	if r.StatusCode != 201 {
		t.Fatalf("open shift %d: %s", r.StatusCode, b)
	}
	var shift models.CashShift
	_ = json.Unmarshal(b, &shift)

	r, b = f.post(t, "/api/v1/orders", tok, uuid.NewString(), map[string]any{
		"items": []map[string]any{{"menu_item_id": plov.ID, "qty": "1"}},
	})
	if r.StatusCode != 201 {
		t.Fatalf("create order %d: %s", r.StatusCode, b)
	}

	cr, cb := f.post(t, "/api/v1/shifts/"+shift.ID+"/close", tok, uuid.NewString(), map[string]any{
		"closing_balance": "0", "confirm_open_orders": true,
	})
	if cr.StatusCode != 409 {
		t.Fatalf("close with confirm but no permission: got %d, want 409. body=%s", cr.StatusCode, cb)
	}
	var env struct {
		Details struct {
			CanForce bool `json:"can_force"`
		} `json:"details"`
	}
	_ = json.Unmarshal(cb, &env)
	if env.Details.CanForce {
		t.Errorf("can_force = true, want false — право явно снято у этого пользователя")
	}
}

// TestShiftClose_BlockedByOrphanOrderFromPreviousShift — репродукция реального
// репорта: кассир закрыл все видимые столы/заказы ТЕКУЩЕЙ смены, но закрытие
// падает с «Сначала закройте: «С собой» №N» на заказ, которого нет ни в
// «Активные заказы» (скоуп по shift_id текущей смены), ни в «Закрытые»
// (скоуп по статусу done/cancelled). Guard в Close() специально ищет заказы
// по ВСЕМУ ресторану (restaurant_id), а не по shift_id — иначе выручка
// заказа-«хвоста» никогда не попала бы ни в одну смену. Тест фиксирует, что
// такой заказ (из УЖЕ ЗАКРЫТОЙ прошлой смены) всё равно блокирует закрытие
// НОВОЙ смены и корректно называется в details.
func TestShiftClose_BlockedByOrphanOrderFromPreviousShift(t *testing.T) {
	f := setupE2E(t)
	gdb, _ := db.Open(testDSN())
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})

	cashAccID := uuid.NewString()
	cashName, cashType := "Касса", "cash"
	if err := gdb.Create(&models.FinancialAccount{
		ID: cashAccID, Name: &cashName, Type: &cashType, RestaurantID: &f.rid, Balance: decimal.Zero,
	}).Error; err != nil {
		t.Fatal(err)
	}
	tok := f.login(t)

	// Смена A: открыть, создать заказ «с собой», НЕ закрывать заказ, но смену
	// пометить закрытой напрямую в БД — так исторически мог получиться «хвост»
	// (до того, как guard стал это блокировать, либо ручное вмешательство).
	shiftAID := uuid.NewString()
	openStatus, closedStatus := "open", "closed"
	if err := gdb.Create(&models.CashShift{
		ID: shiftAID, RestaurantID: &f.rid, Status: &openStatus, AccountID: &cashAccID,
		OpeningBalance: decimal.Zero,
	}).Error; err != nil {
		t.Fatal(err)
	}

	takeawayType := "takeaway"
	orphan := models.Order{
		ID: uuid.NewString(), Status: &openStatus, Type: &takeawayType,
		ShiftID: &shiftAID, RestaurantID: &f.rid, Total: decimal.MustFromString("30"),
	}
	if err := gdb.Create(&orphan).Error; err != nil {
		t.Fatal(err)
	}
	if err := gdb.Model(&models.CashShift{}).Where("id = ?", shiftAID).
		Update("status", closedStatus).Error; err != nil {
		t.Fatal(err)
	}

	// Смена B: новая, «сегодняшняя» — у кассира все её заказы закрыты.
	rb, bb := f.post(t, "/api/v1/shifts", tok, uuid.NewString(), map[string]any{"opening_balance": "0", "account_id": cashAccID})
	if rb.StatusCode != 201 {
		t.Fatalf("open shift B %d: %s", rb.StatusCode, bb)
	}
	var shiftB models.CashShift
	_ = json.Unmarshal(bb, &shiftB)

	// Закрытие смены B блокируется заказом из УЖЕ ЗАКРЫТОЙ смены A.
	cr, cb := f.post(t, fmt.Sprintf("/api/v1/shifts/%s/close", shiftB.ID), tok, uuid.NewString(), map[string]any{"closing_balance": "0"})
	if cr.StatusCode != 409 {
		t.Fatalf("close shift B with orphan order from shift A: got %d, want 409. body=%s", cr.StatusCode, cb)
	}
	var env struct {
		Details struct {
			OrderIDs []string `json:"order_ids"`
		} `json:"details"`
	}
	if err := json.Unmarshal(cb, &env); err != nil {
		t.Fatalf("decode error envelope: %v", err)
	}
	found := false
	for _, id := range env.Details.OrderIDs {
		if id == orphan.ID {
			found = true
		}
	}
	if !found {
		t.Fatalf("details.order_ids должен содержать заказ-«хвост» %s из смены A, получили %v", orphan.ID, env.Details.OrderIDs)
	}
}
