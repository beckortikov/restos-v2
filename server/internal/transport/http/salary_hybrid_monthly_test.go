//go:build integration

package http_test

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
	"gorm.io/datatypes"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// TestSalaryAccrual_HybridMonthlyExtraShifts — гибрид «оклад + доп. смены»:
// окладник с daily_rate>0 получает Salary ПЛЮС daily_rate за каждый день,
// отмеченный ЯВНО через календарь «Доп. смены» (salary_worked_days). Обычная
// явка через табель (time_entries) НЕ должна прибавлять к начислению — она
// уже покрыта окладом, иначе владелец платил бы дважды за каждый рабочий
// день окладника, у которого включён клок-ин.
func TestSalaryAccrual_HybridMonthlyExtraShifts(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb := openTestDB(t)

	gdb.Model(&models.User{}).Where("restaurant_id = ?", f.rid).
		Update("permissions", datatypes.JSON([]byte(`{"actions":{"payroll.manage":true,"finance.manage":true}}`)))

	accID, accName := uuid.NewString(), "Касса"
	if err := gdb.Create(&models.FinancialAccount{
		ID: accID, Name: &accName, Balance: decimal.MustFromString("100000"), RestaurantID: &f.rid,
	}).Error; err != nil {
		t.Fatal(err)
	}

	role, name := "cook", "Гибрид Тест"
	empID := uuid.NewString()
	if err := gdb.Create(&models.User{
		ID: empID, Name: &name, Role: &role,
		Salary: decimal.MustFromString("3000"), DailyRate: decimal.MustFromString("150"),
		RestaurantID: &f.rid,
	}).Error; err != nil {
		t.Fatal(err)
	}

	from, to := "2026-07-01", "2026-07-31"

	// Без отметок — начислено = чистый оклад, extra_shift_units = 0.
	fetchRow := func() (accrued float64, extraUnits int) {
		r, b := f.get(t, "/api/v1/finance/salary/accrual?from="+from+"&to="+to, tok)
		if r.StatusCode != http.StatusOK {
			t.Fatalf("accrual: %d %s", r.StatusCode, b)
		}
		var env struct {
			Data []struct {
				UserID          string          `json:"user_id"`
				Accrued         json.RawMessage `json:"accrued"`
				ExtraShiftUnits int             `json:"extra_shift_units"`
			} `json:"data"`
		}
		if err := json.Unmarshal(b, &env); err != nil {
			t.Fatalf("unmarshal: %v — %s", err, b)
		}
		for _, row := range env.Data {
			if row.UserID == empID {
				return mustFloat(t, row.Accrued), row.ExtraShiftUnits
			}
		}
		t.Fatalf("сотрудник %s не найден", empID)
		return
	}

	if accrued, extra := fetchRow(); accrued != 3000 || extra != 0 {
		t.Fatalf("без отметок: accrued=%v extra=%v, want 3000/0 (чистый оклад)", accrued, extra)
	}

	// Реальная явка через табель — НЕ должна прибавлять к начислению оклада.
	clockIn := time.Date(2026, 7, 10, 9, 0, 0, 0, time.UTC)
	if r, b := f.post(t, "/api/v1/time-entries", tok, uuid.NewString(), map[string]any{
		"user_id": empID, "clock_in": clockIn.Format(time.RFC3339),
	}); r.StatusCode != http.StatusCreated && r.StatusCode != http.StatusOK {
		t.Fatalf("clock-in: %d %s", r.StatusCode, b)
	}
	if accrued, extra := fetchRow(); accrued != 3000 || extra != 0 {
		t.Fatalf("после обычной явки в табеле: accrued=%v extra=%v, want 3000/0 — табель не должен прибавлять к окладу", accrued, extra)
	}

	// Явная отметка «доп. смена» — 2 дня через тот же календарь (059).
	if r, b := f.put(t, "/api/v1/finance/salary/worked-days", tok, uuid.NewString(), map[string]any{
		"user_id": empID, "from": from, "to": to, "dates": []string{"2026-07-05", "2026-07-15"},
	}); r.StatusCode != http.StatusOK {
		t.Fatalf("set worked-days: %d %s", r.StatusCode, b)
	}
	accrued, extra := fetchRow()
	if extra != 2 {
		t.Fatalf("extra_shift_units = %d, want 2 (две отметки доп.смены)", extra)
	}
	if accrued != 3300 {
		t.Fatalf("accrued = %v, want 3300 (3000 оклад + 2×150 доп.смены)", accrued)
	}

	// Кап: выплатить больше начисленного (3300) без override — отклонено.
	rOver, _ := f.post(t, "/api/v1/finance/salary/pay", tok, uuid.NewString(), map[string]any{
		"user_id": empID, "amount": "3500", "account_id": accID, "period": "2026-07", "kind": "salary",
	})
	if rOver.StatusCode != http.StatusBadRequest {
		t.Fatalf("перевыплата гибриду: %d, want 400 (кап учитывает доп.смены)", rOver.StatusCode)
	}
	// Ровно начисленное (3300, включая доп.смены) — проходит.
	rOK, bOK := f.post(t, "/api/v1/finance/salary/pay", tok, uuid.NewString(), map[string]any{
		"user_id": empID, "amount": "3300", "account_id": accID, "period": "2026-07", "kind": "salary",
	})
	if rOK.StatusCode != http.StatusCreated && rOK.StatusCode != http.StatusOK {
		t.Fatalf("выплата 3300 (оклад+доп.смены): %d %s", rOK.StatusCode, bOK)
	}
}
