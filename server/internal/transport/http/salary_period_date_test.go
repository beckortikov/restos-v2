//go:build integration

package http_test

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"gorm.io/datatypes"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// TestSalary_PastMonthPayout_LandsInPeriod_NoShiftMirror — ЗП, вариант А
// (баг: раньше выплата за прошлый месяц date=сегодня → падала в ТЕКУЩИЙ месяц в
// ДДС/ОПиУ). Теперь дата операции = период начисления. Зеркала кассовой смены
// при этом НЕТ: зарплата из раздела Финансы платится из общих наличных
// (бэк-офис), ящик кассира двигают только операции со сменным контекстом
// (shift_id — сервисная выплата со смены; см. service_payout_test). Раньше
// зеркало создавалось по совпадению счёта, и ЗП ложно уменьшала ожидаемую
// кассу открытой смены.
func TestSalary_PastMonthPayout_LandsInPeriod_NoShiftMirror(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb := openTestDB(t)

	gdb.Model(&models.User{}).Where("restaurant_id = ?", f.rid).
		Update("permissions", datatypes.JSON([]byte(`{"actions":{"payroll.manage":true,"finance.manage":true}}`)))

	accID, accName := uuid.NewString(), "Касса"
	if err := gdb.Create(&models.FinancialAccount{
		ID: accID, Name: &accName, Balance: decimal.MustFromString("10000"), RestaurantID: &f.rid,
	}).Error; err != nil {
		t.Fatal(err)
	}

	// Открытая смена на этом счёте — чтобы зеркало могло сработать.
	shiftID, openStatus := uuid.NewString(), "open"
	if err := gdb.Create(&models.CashShift{
		ID: shiftID, RestaurantID: &f.rid, AccountID: &accID, Status: &openStatus,
		OpeningBalance: decimal.Zero, OpenedAt: time.Now().UTC(),
	}).Error; err != nil {
		t.Fatal(err)
	}

	// Сотрудник-оклад 4000 (monthly-начисление не зависит от периода).
	empName, role, payType := "Оклад-сотрудник", "waiter", "monthly"
	empID := uuid.NewString()
	if err := gdb.Create(&models.User{
		ID: empID, Name: &empName, Role: &role, PayType: &payType,
		Salary: decimal.MustFromString("4000"), RestaurantID: &f.rid,
	}).Error; err != nil {
		t.Fatal(err)
	}

	// Платим зарплату за ДАВНО прошедший месяц 2020-06.
	const pastPeriod = "2020-06"
	r, b := f.post(t, "/api/v1/finance/salary/pay", tok, uuid.NewString(), map[string]any{
		"user_id": empID, "amount": "4000", "account_id": accID,
		"employee_name": empName, "period": pastPeriod, "kind": "salary",
	})
	if r.StatusCode != http.StatusOK && r.StatusCode != http.StatusCreated {
		t.Fatalf("pay salary: %d %s", r.StatusCode, b)
	}

	// ─── Дата ОПЕРАЦИИ = период (2020-06-30), а НЕ сегодня ───────────────────
	var fo models.FinancialOperation
	if err := gdb.Where("restaurant_id = ? AND source_ref = ? AND category = ?", f.rid, empID, "Зарплата").
		Order("created_at DESC").First(&fo).Error; err != nil {
		t.Fatalf("финоп зарплаты не найден: %v", err)
	}
	if fo.Date == nil || *fo.Date != "2020-06-30" {
		t.Errorf("date операции = %v, want 2020-06-30 (последний день периода) — выплата за прошлый месяц должна лечь в тот месяц", fo.Date)
	}
	today := time.Now().UTC().Format("2006-01-02")
	if fo.Date != nil && *fo.Date == today {
		t.Errorf("date операции = сегодня (%s) — баг не исправлен, выплата упала в текущий месяц", today)
	}

	// ─── Зеркала в смене НЕТ: ЗП из Финансов не трогает ящик кассира ─────────
	var mirrors int64
	if err := gdb.Model(&models.CashShiftOperation{}).
		Where("shift_id = ? AND category = ? AND amount = ?", shiftID, "__auto_mirror__", decimal.MustFromString("4000")).
		Count(&mirrors).Error; err != nil {
		t.Fatal(err)
	}
	if mirrors != 0 {
		t.Errorf("зеркал в открытой смене = %d, want 0 — зарплата без shift_id платится из общих наличных и не должна уменьшать expected_cash смены", mirrors)
	}

	// Счёт списан.
	var acc models.FinancialAccount
	gdb.First(&acc, "id = ?", accID)
	if !acc.Balance.Equal(decimal.MustFromString("6000")) {
		t.Errorf("баланс счёта = %s, want 6000 (10000 − 4000)", decimal.Normalize(acc.Balance).String())
	}

	// ─── Свободная выплата (сотрудник без оклада) с периодом — тоже в период ─
	freeName := "Без-оклада"
	freeID := uuid.NewString()
	if err := gdb.Create(&models.User{
		ID: freeID, Name: &freeName, Role: &role, RestaurantID: &f.rid,
	}).Error; err != nil {
		t.Fatal(err)
	}
	r, b = f.post(t, "/api/v1/finance/salary/pay", tok, uuid.NewString(), map[string]any{
		"user_id": freeID, "amount": "500", "account_id": accID,
		"employee_name": freeName, "period": "2020-05", "kind": "salary",
	})
	if r.StatusCode != http.StatusOK && r.StatusCode != http.StatusCreated {
		t.Fatalf("free payout: %d %s", r.StatusCode, b)
	}
	var freeFo models.FinancialOperation
	if err := gdb.Where("restaurant_id = ? AND source_ref = ?", f.rid, freeID).
		Order("created_at DESC").First(&freeFo).Error; err != nil {
		t.Fatalf("финоп свободной выплаты не найден: %v", err)
	}
	if freeFo.Date == nil || !strings.HasPrefix(*freeFo.Date, "2020-05") {
		t.Errorf("свободная выплата: date = %v, want 2020-05-* — период не учтён", freeFo.Date)
	}
}
