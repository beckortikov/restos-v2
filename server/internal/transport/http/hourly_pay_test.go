//go:build integration

package http_test

import (
	"encoding/json"
	"net/http"
	"net/url"
	"testing"
	"time"

	"github.com/google/uuid"
	"gorm.io/datatypes"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// Почасовая оплата (107): начисление = часы закрытых смен × ставка, с
// округлением смены по правилу ресторана.
func TestHourlyPay_AccrualAndRounding(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb := openTestDB(t)
	gdb.Model(&models.User{}).Where("restaurant_id = ?", f.rid).
		Update("permissions", datatypes.JSON([]byte(`{"actions":{"payroll.manage":true,"finance.manage":true}}`)))

	hourly, cook, name := "hourly", "cook", "Почасовик"
	userID := uuid.NewString()
	gdb.Create(&models.User{
		ID: userID, Name: &name, Role: &cook, RestaurantID: &f.rid,
		PayType: &hourly, HourlyRate: decimal.MustFromString("20"),
	})

	closed := "closed"
	// Две смены: ровно 8 ч и 7 ч 58 мин (7.9667).
	mk := func(day string, hours string) {
		in, _ := time.Parse(time.RFC3339, day+"T09:00:00Z")
		h := decimal.MustFromString(hours)
		out := in.Add(8 * time.Hour)
		gdb.Create(&models.TimeEntry{
			ID: uuid.NewString(), UserID: &userID, ClockIn: &in, ClockOut: &out,
			TotalHours: h, Status: &closed, RestaurantID: &f.rid,
		})
	}
	mk("2026-07-06", "8")
	mk("2026-07-07", "7.9667")

	accrual := func() (hours string, accrued string) {
		q := url.Values{}
		q.Set("from", "2026-07-01")
		q.Set("to", "2026-07-31")
		r, b := f.get(t, "/api/v1/finance/salary/accrual?"+q.Encode(), tok)
		if r.StatusCode != http.StatusOK {
			t.Fatalf("accrual: %d %s", r.StatusCode, b)
		}
		var resp struct {
			Data []struct {
				UserID      string `json:"user_id"`
				PayType     string `json:"pay_type"`
				HoursWorked string `json:"hours_worked"`
				Accrued     string `json:"accrued"`
			} `json:"data"`
		}
		_ = json.Unmarshal(b, &resp)
		for _, row := range resp.Data {
			if row.UserID == userID {
				if row.PayType != "hourly" {
					t.Fatalf("pay_type = %s, want hourly", row.PayType)
				}
				return row.HoursWorked, row.Accrued
			}
		}
		t.Fatalf("сотрудник не найден в начислении: %+v", resp.Data)
		return "", ""
	}

	// Без округления: 8 + 7.9667 = 15.9667 ч × 20 = 319.334
	hours, accrued := accrual()
	if hours != "15.9667" {
		t.Fatalf("часы без округления = %s, want 15.9667", hours)
	}
	if accrued != "319.334" {
		t.Fatalf("начислено без округления = %s, want 319.334", accrued)
	}

	// Округление до 15 минут: 8 ч остаётся 8, 7:58 → 8:00. Итого 16 ч × 20 = 320.
	gdb.Model(&models.Restaurant{}).Where("id = ?", f.rid).Update("shift_rounding_minutes", 15)
	hours, accrued = accrual()
	if hours != "16" {
		t.Fatalf("часы с округлением = %s, want 16", hours)
	}
	if accrued != "320" {
		t.Fatalf("начислено с округлением = %s, want 320", accrued)
	}

	// Кап на выплату считается по тем же часам: иначе выплату режет
	// непонятно почему.
	accID, accName := uuid.NewString(), "Касса"
	gdb.Create(&models.FinancialAccount{
		ID: accID, Name: &accName, Balance: decimal.MustFromString("10000"), RestaurantID: &f.rid,
	})
	r, b := f.post(t, "/api/v1/finance/salary/pay", tok, uuid.NewString(), map[string]any{
		"user_id": userID, "amount": "320", "account_id": accID, "period": "2026-07",
	})
	if r.StatusCode != http.StatusCreated && r.StatusCode != http.StatusOK {
		t.Fatalf("выплата в пределах начисления должна проходить: %d %s", r.StatusCode, b)
	}
	// Сверх начисленного — отказ.
	r, _ = f.post(t, "/api/v1/finance/salary/pay", tok, uuid.NewString(), map[string]any{
		"user_id": userID, "amount": "50", "account_id": accID, "period": "2026-07",
	})
	if r.StatusCode < 400 {
		t.Fatalf("выплата сверх начисленного должна отклоняться, получили %d", r.StatusCode)
	}

	// Открытая смена в сумму не входит: у неё нет ухода.
	open := time.Now().UTC()
	active := "active"
	gdb.Create(&models.TimeEntry{
		ID: uuid.NewString(), UserID: &userID, ClockIn: &open, Status: &active, RestaurantID: &f.rid,
	})
	if hours, _ = accrual(); hours != "16" {
		t.Fatalf("открытая смена попала в часы: %s", hours)
	}
}
