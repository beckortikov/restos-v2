//go:build integration

package http_test

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// Политика «касса смены ≠ счёт Наличные»: ящик открытой смены двигают только
// операции с ЯВНЫМ сменным контекстом (affects_shift=true или shift_id).
// Бэк-офисные платежи — зарплата (salary_period_date_test), погашение
// обязательств, ручной расход без опт-ина — списывают счёт, но expected_cash
// смены не трогают. Здесь: обязательства + ручной расход + правка владельцем.

// TestLiabilityPay_NoShiftMirror — погашение обязательства с кассового счёта
// открытой смены: счёт дебетован, зеркала в смене НЕТ (бэк-офисный платёж).
// Раньше recordShiftCashOutIfActive зеркалил по совпадению счёта (#27).
func TestLiabilityPay_NoShiftMirror(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, shiftID, accID := seedForWrite(t, f)

	if err := gdb.Model(&models.CashShift{}).Where("id = ?", shiftID).
		Update("account_id", accID).Error; err != nil {
		t.Fatal(err)
	}
	if err := gdb.Model(&models.FinancialAccount{}).Where("id = ?", accID).
		Update("balance", decimal.MustFromString("5000")).Error; err != nil {
		t.Fatal(err)
	}

	liaName := "Кредит на оборудование"
	liaID := uuid.NewString()
	if err := gdb.Create(&models.Liability{
		ID: liaID, Name: &liaName,
		TotalAmount:     decimal.MustFromString("2000"),
		RemainingAmount: decimal.MustFromString("2000"),
		RestaurantID:    &f.rid,
		CreatedAt:       time.Now().UTC(), UpdatedAt: time.Now().UTC(),
	}).Error; err != nil {
		t.Fatal(err)
	}

	r, b := f.post(t, "/api/v1/liabilities/"+liaID+"/pay", tok, uuid.NewString(), map[string]any{
		"amount": "700", "account_id": accID,
	})
	if r.StatusCode != http.StatusOK && r.StatusCode != http.StatusCreated {
		t.Fatalf("pay liability: %d %s", r.StatusCode, b)
	}

	var acc models.FinancialAccount
	gdb.First(&acc, "id = ?", accID)
	if !acc.Balance.Equal(decimal.MustFromString("4300")) {
		t.Errorf("баланс = %s, want 4300 (5000 − 700) — счёт обязан быть дебетован", decimal.Normalize(acc.Balance).String())
	}

	var mirrors int64
	gdb.Model(&models.CashShiftOperation{}).
		Where("shift_id = ? AND category = ?", shiftID, "__auto_mirror__").Count(&mirrors)
	if mirrors != 0 {
		t.Errorf("зеркал в смене = %d, want 0 — погашение обязательства не двигает ящик кассира", mirrors)
	}
}

// TestFinanceOps_Create_NoMirrorByDefault — ручной расход из Финансов БЕЗ
// affects_shift на счёте открытой смены: счёт списан, зеркала нет. Правка
// владельцем (PATCH) такой операции зеркала НЕ приобретает — сменная природа
// записи сохраняется (пересоздание только если зеркало существовало).
func TestFinanceOps_Create_NoMirrorByDefault_UpdateKeepsNone(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, shiftID, accID := seedForWrite(t, f)
	makeOwner(t, f.rid)

	if err := gdb.Model(&models.CashShift{}).Where("id = ?", shiftID).
		Update("account_id", accID).Error; err != nil {
		t.Fatal(err)
	}
	if err := gdb.Model(&models.FinancialAccount{}).Where("id = ?", accID).
		Update("balance", decimal.MustFromString("3000")).Error; err != nil {
		t.Fatal(err)
	}

	r, b := f.post(t, "/api/v1/finance/operations", tok, uuid.NewString(), map[string]any{
		"type": "out", "amount": "400", "category": "Аренда",
		"account_id": accID, "description": "Аренда зала",
	})
	if r.StatusCode != http.StatusCreated && r.StatusCode != http.StatusOK {
		t.Fatalf("create op: %d %s", r.StatusCode, b)
	}
	var op models.FinancialOperation
	_ = json.Unmarshal(b, &op)

	var mirrors int64
	gdb.Model(&models.CashShiftOperation{}).
		Where("shift_id = ? AND category = ?", shiftID, "__auto_mirror__").Count(&mirrors)
	if mirrors != 0 {
		t.Fatalf("зеркал после создания = %d, want 0 — расход без affects_shift не двигает ящик", mirrors)
	}

	// Правка суммы владельцем — зеркало не должно появиться из ниоткуда.
	if r, b := f.patch(t, "/api/v1/finance/operations/"+op.ID, tok, uuid.NewString(),
		map[string]any{"amount": "600"}); r.StatusCode != http.StatusOK {
		t.Fatalf("update: %d %s", r.StatusCode, b)
	}
	gdb.Model(&models.CashShiftOperation{}).
		Where("shift_id = ? AND category = ?", shiftID, "__auto_mirror__").Count(&mirrors)
	if mirrors != 0 {
		t.Errorf("зеркал после правки = %d, want 0 — PATCH без affects_shift сохраняет сменную природу записи", mirrors)
	}

	var acc models.FinancialAccount
	gdb.First(&acc, "id = ?", accID)
	if !acc.Balance.Equal(decimal.MustFromString("2400")) {
		t.Errorf("баланс = %s, want 2400 (3000 − 600 после правки)", decimal.Normalize(acc.Balance).String())
	}
}
