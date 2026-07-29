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

// ЗП-1/ЗП-2: дневная оплата с РУЧНОЙ отметкой дней + серверный кап и свободная
// выплата. Владелец ставит ставку 60/день, отмечает дни руками (без табеля),
// начисление = ставка × дни, выплатить нельзя больше начисленного, а без
// оклада/ставки — свободная выплата любой суммы (отражается в финансах).
func TestSalary_WorkedDays_AccrualCapAndFreePayout(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb := openTestDB(t)

	// Права: отметка дней и выплата.
	gdb.Model(&models.User{}).Where("restaurant_id = ?", f.rid).
		Update("permissions", datatypes.JSON([]byte(`{"actions":{"payroll.manage":true,"finance.manage":true}}`)))

	// Счёт с балансом для выплат.
	accID, accName := uuid.NewString(), "Касса"
	gdb.Create(&models.FinancialAccount{ID: accID, Name: &accName, Balance: decimal.MustFromString("100000"), RestaurantID: &f.rid})

	daily, waiter := "daily", "waiter"
	dName := "Дневник"
	dUser := uuid.NewString()
	gdb.Create(&models.User{
		ID: dUser, Name: &dName, Role: &waiter, PayType: &daily,
		DailyRate: decimal.MustFromString("60"), RestaurantID: &f.rid,
	})

	from, to := "2026-07-01", "2026-07-31"
	setDays := func(dates []string) {
		r, b := f.put(t, "/api/v1/finance/salary/worked-days", tok, uuid.NewString(), map[string]any{
			"user_id": dUser, "from": from, "to": to, "dates": dates,
		})
		if r.StatusCode != http.StatusOK {
			t.Fatalf("set worked-days: %d %s", r.StatusCode, b)
		}
	}
	accruedOf := func(userID string) (days int, accrued decimal.Decimal) {
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
				Accrued    decimal.Decimal `json:"accrued"`
			} `json:"data"`
		}
		_ = json.Unmarshal(b, &resp)
		for _, row := range resp.Data {
			if row.UserID == userID {
				return row.DaysWorked, row.Accrued
			}
		}
		return 0, decimal.Zero
	}

	// Отмечаем 3 дня → начислено 3 × 60 = 180.
	setDays([]string{"2026-07-01", "2026-07-02", "2026-07-05"})
	if days, acc := accruedOf(dUser); days != 3 || !acc.Equal(decimal.MustFromString("180")) {
		t.Fatalf("после 3 дней: days=%d accrued=%s, want 3 / 180", days, acc)
	}

	// Замена набора на 2 дня (идемпотентная перезапись) → 2 × 60 = 120.
	setDays([]string{"2026-07-01", "2026-07-02"})
	if days, acc := accruedOf(dUser); days != 2 || !acc.Equal(decimal.MustFromString("120")) {
		t.Fatalf("после замены на 2 дня: days=%d accrued=%s, want 2 / 120", days, acc)
	}

	// Выплата в пределах начисленного (120) — ОК.
	r, b := f.post(t, "/api/v1/finance/salary/pay", tok, uuid.NewString(), map[string]any{
		"user_id": dUser, "amount": "120", "account_id": accID, "period": "2026-07", "kind": "salary",
	})
	if r.StatusCode != http.StatusCreated && r.StatusCode != http.StatusOK {
		t.Fatalf("выплата 120: %d %s", r.StatusCode, b)
	}
	// Повторная выплата сверх начисленного — кап (уже выплачено 120 из 120).
	r2, _ := f.post(t, "/api/v1/finance/salary/pay", tok, uuid.NewString(), map[string]any{
		"user_id": dUser, "amount": "50", "account_id": accID, "period": "2026-07", "kind": "salary",
	})
	if r2.StatusCode != http.StatusBadRequest {
		t.Fatalf("перевыплата дневнику: %d, want 400 (кап начисленного)", r2.StatusCode)
	}

	// Свободная выплата сотруднику БЕЗ оклада/ставки — любая сумма, отражается
	// в финансах (финоп type=out категория Зарплата).
	freeName := "Разнорабочий"
	freeUser := uuid.NewString()
	gdb.Create(&models.User{ID: freeUser, Name: &freeName, Role: &waiter, RestaurantID: &f.rid})
	rf, bf := f.post(t, "/api/v1/finance/salary/pay", tok, uuid.NewString(), map[string]any{
		"user_id": freeUser, "amount": "500", "account_id": accID, "period": "2026-07", "kind": "salary",
	})
	if rf.StatusCode != http.StatusCreated && rf.StatusCode != http.StatusOK {
		t.Fatalf("свободная выплата без оклада: %d %s", rf.StatusCode, bf)
	}
	var cnt int64
	gdb.Model(&models.FinancialOperation{}).
		Where("restaurant_id = ? AND source_ref = ? AND category = ? AND type = ?", f.rid, freeUser, "Зарплата", "out").
		Count(&cnt)
	if cnt != 1 {
		t.Fatalf("свободная выплата не попала в финансы: финопов %d, want 1", cnt)
	}
}
