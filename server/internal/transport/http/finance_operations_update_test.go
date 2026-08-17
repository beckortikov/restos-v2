//go:build integration

package http_test

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// makeOwner повышает фикстуру-кассира до владельца в БД (гвард requireOwner
// перечитывает роль из БД на каждый вызов, токен остаётся тем же) — тот же
// паттерн, что уже используется в restaurant_clear_operations_test.go/phase10_test.go.
func makeOwner(t *testing.T, rid string) {
	t.Helper()
	gdb := openTestDB(t)
	if err := gdb.Model(&models.User{}).Where("restaurant_id = ?", rid).Update("role", "owner").Error; err != nil {
		t.Fatal(err)
	}
}

func TestFinanceOps_Update_HappyPath(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, shiftID, accID := seedForWrite(t, f)
	topUp(t, gdb, accID)
	makeOwner(t, f.rid)

	// Второй счёт — переносим операцию на него в рамках правки.
	acc2ID := uuid.NewString()
	name2, type2 := "Bank", "bank"
	if err := gdb.Create(&models.FinancialAccount{ID: acc2ID, Name: &name2, Type: &type2, RestaurantID: &f.rid}).Error; err != nil {
		t.Fatal(err)
	}
	topUp(t, gdb, acc2ID)

	cr, cb := f.post(t, "/api/v1/finance/operations", tok, uuid.NewString(), map[string]any{
		"type": "out", "amount": "1000", "category": "Аренда", "account_id": accID,
		"shift_id": shiftID, "description": "Первичная запись",
	})
	if cr.StatusCode != http.StatusCreated {
		t.Fatalf("create: %d %s", cr.StatusCode, cb)
	}
	var created models.FinancialOperation
	if err := json.Unmarshal(cb, &created); err != nil {
		t.Fatal(err)
	}

	accBalAfterCreate := accBalance(t, gdb, accID)
	if !accBalAfterCreate.Equal(decimal.MustFromString("9000")) {
		t.Fatalf("после создания баланс = %s, want 9000", accBalAfterCreate)
	}
	var mirrorAfterCreate int64
	gdb.Model(&models.CashShiftOperation{}).Where("source_ref = ?", created.ID).Count(&mirrorAfterCreate)
	if mirrorAfterCreate != 1 {
		t.Fatalf("зеркало смены после создания: %d строк, want 1", mirrorAfterCreate)
	}

	// Правка: сумма 1000→1500, счёт accID→acc2ID.
	ur, ub := f.patch(t, "/api/v1/finance/operations/"+created.ID, tok, uuid.NewString(), map[string]any{
		"amount": "1500", "account_id": acc2ID, "category": "Аренда",
	})
	if ur.StatusCode != http.StatusOK {
		t.Fatalf("update: %d %s", ur.StatusCode, ub)
	}
	var updated models.FinancialOperation
	if err := json.Unmarshal(ub, &updated); err != nil {
		t.Fatal(err)
	}
	if !updated.Amount.Equal(decimal.MustFromString("1500")) {
		t.Errorf("amount = %s, want 1500", updated.Amount)
	}
	if updated.Description == nil || !strings.Contains(*updated.Description, "испр. владельцем") {
		t.Errorf("description не помечен правкой: %v", updated.Description)
	}

	// Старый счёт — реверс 1000 (9000+1000=10000, назад к исходному).
	if bal := accBalance(t, gdb, accID); !bal.Equal(decimal.MustFromString("10000")) {
		t.Errorf("старый счёт после правки = %s, want 10000 (реверс)", bal)
	}
	// Новый счёт — списаны 1500 (10000-1500=8500).
	if bal := accBalance(t, gdb, acc2ID); !bal.Equal(decimal.MustFromString("8500")) {
		t.Errorf("новый счёт после правки = %s, want 8500", bal)
	}

	// Зеркало смены переехало на новую сумму/счёт (старое снесено, новое создано —
	// т.к. shift_id той же открытой смены передан не был явно, но op.ShiftID хранит
	// исходный shiftID, и recordShiftCashOutIfActive матчит по нему).
	var mirror models.CashShiftOperation
	if err := gdb.Where("source_ref = ?", created.ID).First(&mirror).Error; err != nil {
		t.Fatalf("зеркало смены после правки не найдено: %v", err)
	}
	if !mirror.Amount.Equal(decimal.MustFromString("1500")) {
		t.Errorf("зеркало смены amount = %s, want 1500", mirror.Amount)
	}
}

func TestFinanceOps_Update_Guards(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t) // дефолтная фикстура — кассир, НЕ владелец.
	gdb, _, _, accID := seedForWrite(t, f)
	topUp(t, gdb, accID)

	// Заводим обычный расход (создать можно и не-владельцем — Create без гварда).
	cr, cb := f.post(t, "/api/v1/finance/operations", tok, uuid.NewString(), map[string]any{
		"type": "out", "amount": "500", "category": "Аренда", "account_id": accID,
	})
	if cr.StatusCode != http.StatusCreated {
		t.Fatalf("create: %d %s", cr.StatusCode, cb)
	}
	var op models.FinancialOperation
	_ = json.Unmarshal(cb, &op)

	// Не-владелец → 403.
	if r, b := f.patch(t, "/api/v1/finance/operations/"+op.ID, tok, uuid.NewString(),
		map[string]any{"amount": "600"}); r.StatusCode != http.StatusForbidden {
		t.Errorf("не-владелец: %d %s, want 403", r.StatusCode, b)
	}

	makeOwner(t, f.rid)

	// Системная категория (симулируем auto-проводку накладной напрямую в БД).
	sysID := uuid.NewString()
	outType, cat, isAuto := "out", "stock_purchase", true
	if err := gdb.Create(&models.FinancialOperation{
		ID: sysID, Type: &outType, Amount: decimal.MustFromString("100"), Category: &cat,
		AccountID: &accID, IsAuto: &isAuto, RestaurantID: &f.rid,
	}).Error; err != nil {
		t.Fatal(err)
	}
	if r, b := f.patch(t, "/api/v1/finance/operations/"+sysID, tok, uuid.NewString(),
		map[string]any{"amount": "200"}); r.StatusCode != http.StatusBadRequest {
		t.Errorf("системная проводка: %d %s, want 400", r.StatusCode, b)
	}

	// Уже отменённая.
	if err := gdb.Model(&models.FinancialOperation{}).Where("id = ?", op.ID).
		Update("cancelled_at", time.Now().UTC()).Error; err != nil {
		t.Fatal(err)
	}
	if r, b := f.patch(t, "/api/v1/finance/operations/"+op.ID, tok, uuid.NewString(),
		map[string]any{"amount": "600"}); r.StatusCode != http.StatusBadRequest {
		t.Errorf("отменённая операция: %d %s, want 400", r.StatusCode, b)
	}
	// Развменяем отмену для следующей проверки.
	if err := gdb.Model(&models.FinancialOperation{}).Where("id = ?", op.ID).
		Update("cancelled_at", nil).Error; err != nil {
		t.Fatal(err)
	}

	// shift_expense: — зеркало со сменного экрана, первичное для другого пути.
	shiftExpID := uuid.NewString()
	shiftSrc := "shift_expense:" + uuid.NewString()
	if err := gdb.Create(&models.FinancialOperation{
		ID: shiftExpID, Type: &outType, Amount: decimal.MustFromString("50"), Category: &cat,
		AccountID: &accID, SourceRef: &shiftSrc, RestaurantID: &f.rid,
	}).Error; err != nil {
		t.Fatal(err)
	}
	if r, b := f.patch(t, "/api/v1/finance/operations/"+shiftExpID, tok, uuid.NewString(),
		map[string]any{"amount": "70"}); r.StatusCode != http.StatusBadRequest {
		t.Errorf("shift_expense: операция: %d %s, want 400", r.StatusCode, b)
	}
}

func TestFinanceOps_Update_InsufficientFunds(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, _, accID := seedForWrite(t, f)
	topUp(t, gdb, accID) // 10000
	makeOwner(t, f.rid)

	cr, cb := f.post(t, "/api/v1/finance/operations", tok, uuid.NewString(), map[string]any{
		"type": "out", "amount": "1000", "category": "Аренда", "account_id": accID,
	})
	if cr.StatusCode != http.StatusCreated {
		t.Fatalf("create: %d %s", cr.StatusCode, cb)
	}
	var op models.FinancialOperation
	_ = json.Unmarshal(cb, &op)

	// Баланс после создания — 9000. Увеличиваем расход до 20000 (> баланса + возврат 1000).
	if r, b := f.patch(t, "/api/v1/finance/operations/"+op.ID, tok, uuid.NewString(),
		map[string]any{"amount": "20000"}); r.StatusCode != http.StatusConflict {
		t.Errorf("insufficient funds: %d %s, want 409", r.StatusCode, b)
	}
	// Баланс не должен был измениться (транзакция откатилась).
	if bal := accBalance(t, gdb, accID); !bal.Equal(decimal.MustFromString("9000")) {
		t.Errorf("баланс после отклонённой правки = %s, want 9000 (не тронут)", bal)
	}
}

func TestFinanceOps_Update_ClosedShift_RecomputesExpectedCash(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, shiftID, accID := seedForWrite(t, f)
	topUp(t, gdb, accID)
	makeOwner(t, f.rid)
	// seedForWrite не привязывает счёт к смене — а opTouchesDrawer (computeExpectedCash)
	// считает операцию только если её account_id == shift.AccountID. Реальная
	// смена всегда открывается на конкретный счёт кассы — воспроизводим это.
	if err := gdb.Model(&models.CashShift{}).Where("id = ?", shiftID).
		Update("account_id", accID).Error; err != nil {
		t.Fatal(err)
	}

	cr, cb := f.post(t, "/api/v1/finance/operations", tok, uuid.NewString(), map[string]any{
		"type": "out", "amount": "300", "category": "Аренда", "account_id": accID, "shift_id": shiftID,
	})
	if cr.StatusCode != http.StatusCreated {
		t.Fatalf("create: %d %s", cr.StatusCode, cb)
	}
	var op models.FinancialOperation
	_ = json.Unmarshal(cb, &op)

	// Закрываем смену — expected_cash застывает как снэпшот (opening 0 + revenue 0 − 300 = -300).
	closedStatus := "closed"
	expectedAtClose := decimal.MustFromString("-300")
	if err := gdb.Model(&models.CashShift{}).Where("id = ?", shiftID).
		Updates(map[string]any{"status": closedStatus, "expected_cash": expectedAtClose}).Error; err != nil {
		t.Fatal(err)
	}

	// Правим сумму задним числом 300→500 — уже закрытая смена должна пересчитаться.
	if r, b := f.patch(t, "/api/v1/finance/operations/"+op.ID, tok, uuid.NewString(),
		map[string]any{"amount": "500"}); r.StatusCode != http.StatusOK {
		t.Fatalf("update: %d %s", r.StatusCode, b)
	}

	var shift models.CashShift
	if err := gdb.Where("id = ?", shiftID).First(&shift).Error; err != nil {
		t.Fatal(err)
	}
	if shift.ExpectedCash == nil || !shift.ExpectedCash.Equal(decimal.MustFromString("-500")) {
		got := "nil"
		if shift.ExpectedCash != nil {
			got = shift.ExpectedCash.String()
		}
		t.Errorf("expected_cash закрытой смены после правки = %s, want -500", got)
	}
}
