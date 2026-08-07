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

// TestSalary_PastMonthAdvance_DoesNotReduceCurrentPayable — баг владельца:
// аванс, выданный за ПРОШЛЫЙ месяц, срезал остаток «К выплате» ТЕКУЩЕГО.
// Причина — остаток считался по глобальному счётчику users.advance
// (period-agnostic). Теперь аванс/удержания берутся из period-tagged строк:
// аванс за июнь влияет ТОЛЬКО на июнь.
func TestSalary_PastMonthAdvance_DoesNotReduceCurrentPayable(t *testing.T) {
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

	empName, role, payType := "Оклад-5000", "waiter", "monthly"
	empID := uuid.NewString()
	if err := gdb.Create(&models.User{
		ID: empID, Name: &empName, Role: &role, PayType: &payType,
		Salary: decimal.MustFromString("5000"), RestaurantID: &f.rid,
	}).Error; err != nil {
		t.Fatal(err)
	}

	const pastPeriod = "2020-06"
	now := time.Now().UTC()
	curPeriod := now.Format("2006-01")
	curMonthStart := curPeriod + "-01"
	today := now.Format("2006-01-02")
	if curPeriod == pastPeriod {
		t.Skip("маловероятно: текущий месяц совпал с прошлым тестовым")
	}

	// Аванс 2000 за ПРОШЛЫЙ месяц (2020-06).
	r, b := f.post(t, "/api/v1/finance/salary/advance", tok, uuid.NewString(), map[string]any{
		"user_id": empID, "amount": "2000", "account_id": accID, "period": pastPeriod,
	})
	if r.StatusCode != http.StatusOK && r.StatusCode != http.StatusCreated {
		t.Fatalf("аванс за прошлый месяц: %d %s", r.StatusCode, b)
	}

	accrualOf := func(from, to string) (accrued, advance decimal.Decimal) {
		q := url.Values{}
		q.Set("from", from)
		q.Set("to", to)
		rr, bb := f.get(t, "/api/v1/finance/salary/accrual?"+q.Encode(), tok)
		if rr.StatusCode != http.StatusOK {
			t.Fatalf("accrual: %d %s", rr.StatusCode, bb)
		}
		var resp struct {
			Data []struct {
				UserID  string          `json:"user_id"`
				Accrued decimal.Decimal `json:"accrued"`
				Advance decimal.Decimal `json:"advance"`
			} `json:"data"`
		}
		_ = json.Unmarshal(bb, &resp)
		for _, row := range resp.Data {
			if row.UserID == empID {
				return row.Accrued, row.Advance
			}
		}
		return decimal.Zero, decimal.Zero
	}

	// ─── Текущий месяц: аванс за июнь НЕ виден, остаток полный ───────────────
	if acc, adv := accrualOf(curMonthStart, today); !acc.Equal(decimal.MustFromString("5000")) || !adv.Equal(decimal.Zero) {
		t.Errorf("текущий месяц: accrued=%s advance=%s, want 5000 / 0 (аванс за июнь не должен попасть в текущий)", acc, adv)
	}

	// ─── Июнь 2020: аванс за июнь ВИДЕН в своём месяце ───────────────────────
	if _, adv := accrualOf("2020-06-01", "2020-06-30"); !adv.Equal(decimal.MustFromString("2000")) {
		t.Errorf("июнь: advance=%s, want 2000 (аванс должен считаться в своём месяце)", adv)
	}

	// ─── Выплата полного оклада за ТЕКУЩИЙ месяц проходит (остаток 5000) ─────
	// До фикса кап считал 5000 − 2000 (глоб. счётчик) = 3000 → выплата 5000 → 400.
	rp, bp := f.post(t, "/api/v1/finance/salary/pay", tok, uuid.NewString(), map[string]any{
		"user_id": empID, "amount": "5000", "account_id": accID, "period": curPeriod, "kind": "salary",
	})
	if rp.StatusCode != http.StatusOK && rp.StatusCode != http.StatusCreated {
		t.Fatalf("выплата за текущий месяц 5000: %d %s — аванс за прошлый месяц не должен резать остаток", rp.StatusCode, bp)
	}

	// ─── А за ИЮНЬ полный оклад НЕ проходит: там аванс 2000 срезал до 3000 ───
	// Доказывает, что period-scoping работает В ОБЕ стороны (не просто «всегда 0»).
	rj, _ := f.post(t, "/api/v1/finance/salary/pay", tok, uuid.NewString(), map[string]any{
		"user_id": empID, "amount": "5000", "account_id": accID, "period": pastPeriod, "kind": "salary",
	})
	if rj.StatusCode != http.StatusBadRequest {
		t.Fatalf("выплата за июнь 5000: %d, want 400 (аванс 2000 за июнь режет июньский остаток до 3000)", rj.StatusCode)
	}
}
