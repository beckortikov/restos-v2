//go:build integration

package http_test

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/google/uuid"
	"gorm.io/datatypes"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// TestSalaryAccrual_PaidAttributedToPeriodNotPaymentDate (082) — зарплата «за
// июль», выплаченная фактически в августе (обычное дело — платят в начале
// следующего месяца), обязана считаться выплаченной ЗА ИЮЛЬ, а не за август.
//
// До 082 у этого была двойная бухгалтерия: сервер (кап на повторную выплату,
// salaryCapForPeriod) матчил «выплачено» по тегу периода в description и
// корректно относил такую выплату к июлю; а список сотрудников/Ведомость на
// фронте считали «Выплачено (ЗП)» по ДАТЕ проводки в окне месяца — та же
// выплата попадала в август и там задваивалась, уводя «К выплате» в минус
// (владелец поймал живьём: v3.16.29x). 082 — структурная колонка
// salary_period, один источник истины для обоих потребителей.
func TestSalaryAccrual_PaidAttributedToPeriodNotPaymentDate(t *testing.T) {
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

	// Окладник 480 — начисление не зависит от периода (та же сумма и в июле, и в августе).
	empName, role := "Оклад ЮлАвг", "waiter"
	empID := uuid.NewString()
	if err := gdb.Create(&models.User{
		ID: empID, Name: &empName, Role: &role, Salary: decimal.MustFromString("480"), RestaurantID: &f.rid,
	}).Error; err != nil {
		t.Fatal(err)
	}

	// Платим «за июль» — физически СЕЙЧАС (тест идёт в августе), период явно
	// указан 2026-07. periodToOperationDate уже кладёт date=2026-07-31 (v3.16.245),
	// но CreatedAt — сегодняшний (август): именно это расхождение раньше путало
	// клиентский фильтр «дата проводки в окне месяца».
	r, b := f.post(t, "/api/v1/finance/salary/pay", tok, uuid.NewString(), map[string]any{
		"user_id": empID, "amount": "480", "account_id": accID,
		"employee_name": empName, "period": "2026-07", "kind": "salary",
	})
	if r.StatusCode != http.StatusOK && r.StatusCode != http.StatusCreated {
		t.Fatalf("pay salary for July: %d %s", r.StatusCode, b)
	}

	fetchRow := func(from, to string) (accrued, paidSalary, paidCombined float64) {
		rr, bb := f.get(t, "/api/v1/finance/salary/accrual?from="+from+"&to="+to, tok)
		if rr.StatusCode != http.StatusOK {
			t.Fatalf("accrual %s..%s: %d %s", from, to, rr.StatusCode, bb)
		}
		var env struct {
			Data []struct {
				UserID       string          `json:"user_id"`
				Accrued      json.RawMessage `json:"accrued"`
				PaidSalary   json.RawMessage `json:"paid_salary"`
				PaidCombined json.RawMessage `json:"paid_combined"`
			} `json:"data"`
		}
		if err := json.Unmarshal(bb, &env); err != nil {
			t.Fatalf("unmarshal accrual: %v — %s", err, bb)
		}
		for _, row := range env.Data {
			if row.UserID == empID {
				return mustFloat(t, row.Accrued), mustFloat(t, row.PaidSalary), mustFloat(t, row.PaidCombined)
			}
		}
		t.Fatalf("сотрудник %s не найден в начислениях за %s..%s", empID, from, to)
		return
	}

	// ─── Июль (период выплаты) — выплачено 480, остаток 0 ────────────────────
	julyAccrued, julyPaid, julyCombined := fetchRow("2026-07-01", "2026-07-31")
	if julyAccrued != 480 {
		t.Errorf("июль accrued = %v, want 480", julyAccrued)
	}
	if julyPaid != 480 {
		t.Errorf("июль paid_salary = %v, want 480 — выплата «за июль» обязана считаться выплаченной за июль", julyPaid)
	}
	if julyCombined != 480 {
		t.Errorf("июль paid_combined = %v, want 480", julyCombined)
	}
	if toPay := julyAccrued - julyPaid; toPay != 0 {
		t.Errorf("июль К выплате = %v, want 0 (начислено 480 − выплачено 480)", toPay)
	}

	// ─── Август (месяц физической оплаты) — выплата НЕ засчитывается сюда ────
	augAccrued, augPaid, augCombined := fetchRow("2026-08-01", "2026-08-31")
	if augPaid != 0 {
		t.Errorf("август paid_salary = %v, want 0 — июльская выплата не должна попадать в август (это и был баг владельца)", augPaid)
	}
	if augCombined != 0 {
		t.Errorf("август paid_combined = %v, want 0", augCombined)
	}
	if augAccrued != 480 {
		t.Errorf("август accrued = %v, want 480 (тот же оклад)", augAccrued)
	}
	if toPay := augAccrued - augPaid; toPay != 480 {
		t.Errorf("август К выплате = %v, want 480 (полный оклад августа ещё не выплачен) — МИНУСА БЫТЬ НЕ ДОЛЖНО", toPay)
	}
}
