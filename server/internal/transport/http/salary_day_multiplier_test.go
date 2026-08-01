//go:build integration

package http_test

import (
	"encoding/json"
	"net/http"
	"net/url"
	"testing"

	"github.com/google/uuid"
	"gorm.io/datatypes"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// TestSalary_DayMultiplier_DoubleShift — «две смены в один день» (066):
// менеджер вручную отмечает конкретный отработанный день как ×2, начисление
// дневника учитывает это как ЛИШНЮЮ оплачиваемую единицу за тот день, а не
// как дополнительный «отработанный день» (days_worked не меняется).
func TestSalary_DayMultiplier_DoubleShift(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb := openTestDB(t)

	gdb.Model(&models.User{}).Where("restaurant_id = ?", f.rid).
		Update("permissions", datatypes.JSON([]byte(`{"actions":{"payroll.manage":true,"finance.manage":true}}`)))

	accID, accName := uuid.NewString(), "Касса"
	gdb.Create(&models.FinancialAccount{ID: accID, Name: &accName, Balance: decimal.MustFromString("100000"), RestaurantID: &f.rid})

	daily, cook := "daily", "cook"
	dName := "Двухсменный"
	dUser := uuid.NewString()
	gdb.Create(&models.User{
		ID: dUser, Name: &dName, Role: &cook, PayType: &daily,
		DailyRate: decimal.MustFromString("60"), RestaurantID: &f.rid,
	})

	from, to := "2026-07-01", "2026-07-31"

	// Отмечаем 2 дня руками.
	if r, b := f.put(t, "/api/v1/finance/salary/worked-days", tok, uuid.NewString(), map[string]any{
		"user_id": dUser, "from": from, "to": to, "dates": []string{"2026-07-01", "2026-07-02"},
	}); r.StatusCode != http.StatusOK {
		t.Fatalf("set worked-days: %d %s", r.StatusCode, b)
	}

	accrualOf := func() (days, paidUnits int, accrued decimal.Decimal) {
		q := url.Values{}
		q.Set("from", from)
		q.Set("to", to)
		r, b := f.get(t, "/api/v1/finance/salary/accrual?"+q.Encode(), tok)
		if r.StatusCode != http.StatusOK {
			t.Fatalf("accrual: %d %s", r.StatusCode, b)
		}
		var resp struct {
			Data []struct {
				UserID     string          `json:"user_id"`
				DaysWorked int             `json:"days_worked"`
				PaidUnits  int             `json:"paid_units"`
				Accrued    decimal.Decimal `json:"accrued"`
			} `json:"data"`
		}
		_ = json.Unmarshal(b, &resp)
		for _, row := range resp.Data {
			if row.UserID == dUser {
				return row.DaysWorked, row.PaidUnits, row.Accrued
			}
		}
		t.Fatalf("сотрудник %s не найден в начислениях", dUser)
		return 0, 0, decimal.Zero
	}

	// 2 дня × 60 = 120, без множителей days_worked == paid_units.
	if days, units, acc := accrualOf(); days != 2 || units != 2 || !acc.Equal(decimal.MustFromString("120")) {
		t.Fatalf("до множителя: days=%d units=%d accrued=%s, want 2/2/120", days, units, acc)
	}

	// Ставим ×2 на 2026-07-01 (переключатель).
	r, b := f.put(t, "/api/v1/finance/salary/day-multiplier", tok, uuid.NewString(), map[string]any{
		"user_id": dUser, "date": "2026-07-01", "from": from, "to": to,
	})
	if r.StatusCode != http.StatusOK {
		t.Fatalf("toggle multiplier on: %d %s", r.StatusCode, b)
	}
	var toggled struct {
		Multipliers map[string]int `json:"multipliers"`
		PaidUnits   int            `json:"paid_units"`
		Count       int            `json:"count"`
	}
	if err := json.Unmarshal(b, &toggled); err != nil {
		t.Fatalf("unmarshal toggle response: %v — %s", err, b)
	}
	if toggled.Multipliers["2026-07-01"] != 2 {
		t.Fatalf("multipliers[2026-07-01] = %v, want 2 — %s", toggled.Multipliers, b)
	}
	if toggled.Count != 2 {
		t.Fatalf("count после множителя = %d, want 2 (дней всё ещё 2, не 3)", toggled.Count)
	}
	if toggled.PaidUnits != 3 {
		t.Fatalf("paid_units после множителя = %d, want 3 (2 дня + 1 лишняя единица за ×2)", toggled.PaidUnits)
	}

	// Начисление теперь 3 опл.ед. × 60 = 180, days_worked остался 2.
	if days, units, acc := accrualOf(); days != 2 || units != 3 || !acc.Equal(decimal.MustFromString("180")) {
		t.Fatalf("после множителя: days=%d units=%d accrued=%s, want 2/3/180", days, units, acc)
	}

	// Выплата ровно начисленной (удвоенной) суммы проходит.
	rp, bp := f.post(t, "/api/v1/finance/salary/pay", tok, uuid.NewString(), map[string]any{
		"user_id": dUser, "amount": "180", "account_id": accID, "period": "2026-07", "kind": "salary",
	})
	if rp.StatusCode != http.StatusCreated && rp.StatusCode != http.StatusOK {
		t.Fatalf("выплата 180 (с учётом ×2): %d %s", rp.StatusCode, bp)
	}

	// Повторный тог — снимает множитель, возвращаемся к 2/2/120.
	r2, b2 := f.put(t, "/api/v1/finance/salary/day-multiplier", tok, uuid.NewString(), map[string]any{
		"user_id": dUser, "date": "2026-07-01", "from": from, "to": to,
	})
	if r2.StatusCode != http.StatusOK {
		t.Fatalf("toggle multiplier off: %d %s", r2.StatusCode, b2)
	}
	if days, units, _ := accrualOf(); days != 2 || units != 2 {
		t.Fatalf("после снятия множителя: days=%d units=%d, want 2/2", days, units)
	}
}
