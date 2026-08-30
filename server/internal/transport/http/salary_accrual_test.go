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
)

type accrualRow struct {
	UserID     string          `json:"user_id"`
	PayType    string          `json:"pay_type"`
	DaysWorked int             `json:"days_worked"`
	Accrued    json.RawMessage `json:"accrued"`
	DailyRate  json.RawMessage `json:"daily_rate"`
}

func fetchAccrual(t *testing.T, f *e2eFixture, tok, from, to string) []accrualRow {
	t.Helper()
	r, b := f.get(t, "/api/v1/finance/salary/accrual?from="+from+"&to="+to, tok)
	if r.StatusCode != http.StatusOK {
		t.Fatalf("accrual: %d %s", r.StatusCode, b)
	}
	var env struct {
		Data []accrualRow `json:"data"`
	}
	if err := json.Unmarshal(b, &env); err != nil {
		t.Fatalf("unmarshal: %v — %s", err, b)
	}
	return env.Data
}

// TestSalaryAccrual_DailyPay — начисление дневника = ставка × отмеченные дни.
//
// Ключевое: два прихода в ОДИН день должны дать один рабочий день, иначе
// сотрудник, отметившийся после перерыва, получил бы двойную оплату.
func TestSalaryAccrual_DailyPay(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	seedForWrite(t, f)
	// Create теперь требует users.manage — грант поверх фикстуры.
	openTestDB(t).Model(&models.User{}).Where("restaurant_id = ?", f.rid).
		Update("permissions", datatypes.JSON([]byte(`{"actions":{"users.manage":true}}`)))

	// Заводим сотрудника на дневной оплате: 120 за день.
	r, b := f.post(t, "/api/v1/users", tok, uuid.NewString(), map[string]any{
		"name": "Дневник Тестовый", "role": "cook", "pin": "4321",
		"pay_type": "daily", "daily_rate": "120",
	})
	if r.StatusCode != http.StatusCreated && r.StatusCode != http.StatusOK {
		t.Fatalf("create user: %d %s", r.StatusCode, b)
	}
	var created struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(b, &created); err != nil || created.ID == "" {
		t.Fatalf("user id: %v — %s", err, b)
	}

	today := time.Now().UTC()
	d1 := today.AddDate(0, 0, -2)
	d2 := today.AddDate(0, 0, -1)
	from := d1.Format("2006-01-02")
	to := today.Format("2006-01-02")

	// Три отметки на два РАЗНЫХ дня (в d1 — дважды, после перерыва).
	for _, at := range []time.Time{
		d1.Truncate(time.Hour), d1.Truncate(time.Hour).Add(6 * time.Hour), d2.Truncate(time.Hour),
	} {
		if r, b := f.post(t, "/api/v1/time-entries", tok, uuid.NewString(), map[string]any{
			"user_id": created.ID, "clock_in": at.Format(time.RFC3339),
		}); r.StatusCode != http.StatusCreated && r.StatusCode != http.StatusOK {
			t.Fatalf("clock-in: %d %s", r.StatusCode, b)
		}
	}

	for _, row := range fetchAccrual(t, f, tok, from, to) {
		if row.UserID != created.ID {
			continue
		}
		if row.PayType != "daily" {
			t.Fatalf("pay_type = %q, want daily", row.PayType)
		}
		if row.DaysWorked != 2 {
			t.Fatalf("days_worked = %d, want 2 (две отметки в один день — один рабочий день)", row.DaysWorked)
		}
		if got := mustFloat(t, row.Accrued); got != 240 {
			t.Fatalf("accrued = %v, want 240 (120 × 2)", got)
		}
		return
	}
	t.Fatalf("сотрудник %s не найден в начислениях", created.ID)
}

// TestSalaryAccrual_MonthlyUnchanged — окладник считается как раньше: сумма из
// карточки, от табеля не зависит.
func TestSalaryAccrual_MonthlyUnchanged(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	seedForWrite(t, f)
	// Create теперь требует users.manage — грант поверх фикстуры.
	openTestDB(t).Model(&models.User{}).Where("restaurant_id = ?", f.rid).
		Update("permissions", datatypes.JSON([]byte(`{"actions":{"users.manage":true}}`)))

	r, b := f.post(t, "/api/v1/users", tok, uuid.NewString(), map[string]any{
		"name": "Окладник Тестовый", "role": "cook", "pin": "4322", "salary": "3000",
	})
	if r.StatusCode != http.StatusCreated && r.StatusCode != http.StatusOK {
		t.Fatalf("create user: %d %s", r.StatusCode, b)
	}
	var created struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(b, &created); err != nil {
		t.Fatalf("user id: %v — %s", err, b)
	}

	to := time.Now().UTC().Format("2006-01-02")
	from := time.Now().UTC().AddDate(0, 0, -7).Format("2006-01-02")
	for _, row := range fetchAccrual(t, f, tok, from, to) {
		if row.UserID != created.ID {
			continue
		}
		if row.PayType != "monthly" {
			t.Fatalf("pay_type = %q, want monthly (дефолт)", row.PayType)
		}
		if row.DaysWorked != 0 {
			t.Fatalf("days_worked = %d, want 0 — отметок не делали", row.DaysWorked)
		}
		if got := mustFloat(t, row.Accrued); got != 3000 {
			t.Fatalf("accrued = %v, want 3000 — оклад не зависит от табеля", got)
		}
		return
	}
	t.Fatalf("сотрудник %s не найден в начислениях", created.ID)
}
