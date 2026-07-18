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

// Н13-UI: разовая коррекция балансов под фикс кассовых расходов. Превью считает
// сумму прошлых shift_expense-финопов, применение списывает её со счёта и ставит
// маркер; повтор отбивается (иначе списание задвоится).
func TestMaintenance_ShiftBalanceFix_PreviewApplyGuard(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb := openTestDB(t)

	// Грант finance.manage тестовому кассиру (действие финансовое).
	gdb.Model(&models.User{}).Where("restaurant_id = ?", f.rid).
		Update("permissions", datatypes.JSON([]byte(`{"actions":{"finance.manage":true}}`)))

	accID, accName := uuid.NewString(), "Касса"
	if err := gdb.Create(&models.FinancialAccount{
		ID: accID, Name: &accName, Balance: decimal.MustFromString("1000"), RestaurantID: &f.rid,
	}).Error; err != nil {
		t.Fatal(err)
	}
	// Два прошлых кассовых расхода (до фикса не дебетовали счёт): 120 + 180 = 300.
	past := time.Now().UTC().Add(-48 * time.Hour)
	mkExpense := func(amount, opID string) {
		out, cat, act := "out", "Закупка продуктов", "operational"
		src := "shift_expense:" + opID
		if err := gdb.Create(&models.FinancialOperation{
			ID: uuid.NewString(), Type: &out, Amount: decimal.MustFromString(amount),
			Category: &cat, AccountID: &accID, Activity: &act, SourceRef: &src,
			RestaurantID: &f.rid, CreatedAt: past,
		}).Error; err != nil {
			t.Fatal(err)
		}
	}
	mkExpense("120", uuid.NewString())
	mkExpense("180", uuid.NewString())

	// Превью: коррекция 300, баланс после 700, ещё не применено.
	r, b := f.get(t, "/api/v1/admin/maintenance/shift-balance-fix", tok)
	if r.StatusCode != http.StatusOK {
		t.Fatalf("preview: %d %s", r.StatusCode, b)
	}
	var prev struct {
		AlreadyApplied  bool            `json:"already_applied"`
		TotalCorrection decimal.Decimal `json:"total_correction"`
		Lines           []struct {
			BalanceAfter decimal.Decimal `json:"balance_after"`
		} `json:"lines"`
	}
	_ = json.Unmarshal(b, &prev)
	if prev.AlreadyApplied {
		t.Fatalf("превью: already_applied=true до применения")
	}
	if !prev.TotalCorrection.Equal(decimal.MustFromString("300")) {
		t.Fatalf("превью коррекция = %s, want 300", prev.TotalCorrection)
	}

	// Применение: баланс 1000 − 300 = 700.
	ar, ab := f.post(t, "/api/v1/admin/maintenance/shift-balance-fix", tok, uuid.NewString(), map[string]any{})
	if ar.StatusCode != http.StatusOK {
		t.Fatalf("apply: %d %s", ar.StatusCode, ab)
	}
	var acc models.FinancialAccount
	gdb.Where("id = ?", accID).First(&acc)
	if !decimal.Normalize(acc.Balance).Equal(decimal.MustFromString("700")) {
		t.Fatalf("баланс после коррекции = %s, want 700", decimal.Normalize(acc.Balance))
	}

	// Повтор — отбивается (409), баланс не меняется.
	ar2, _ := f.post(t, "/api/v1/admin/maintenance/shift-balance-fix", tok, uuid.NewString(), map[string]any{})
	if ar2.StatusCode != http.StatusConflict {
		t.Fatalf("повтор apply: %d, want 409 (защита от двойного списания)", ar2.StatusCode)
	}
	gdb.Where("id = ?", accID).First(&acc)
	if !decimal.Normalize(acc.Balance).Equal(decimal.MustFromString("700")) {
		t.Fatalf("баланс после повторного apply = %s, want 700 (не должен измениться)", decimal.Normalize(acc.Balance))
	}
}
