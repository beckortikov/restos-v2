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

// 070: аванс выдаётся ОДНОЙ атомарной транзакцией (счёт списывается + строка
// salary_advances создаётся + users.advance инкрементируется), и его можно
// отменить — деньги возвращаются на счёт, users.advance декрементируется.
// Раньше выдача аванса была ДВУМЯ независимыми запросами (PaySalary(kind=
// advance) + отдельный PATCH users.advance): падение второго теряло
// синхронизацию — деньги ушли, счётчик не обновился, и поправить было нечего
// (у "аванса" не было id).
func TestSalary_GiveAdvance_AtomicAndCancellable(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb := openTestDB(t)

	gdb.Model(&models.User{}).Where("restaurant_id = ?", f.rid).
		Update("permissions", datatypes.JSON([]byte(`{"actions":{"payroll.manage":true,"finance.manage":true}}`)))

	accID, accName := uuid.NewString(), "Касса"
	if err := gdb.Create(&models.FinancialAccount{
		ID: accID, Name: &accName, Balance: decimal.MustFromString("1000"), RestaurantID: &f.rid,
	}).Error; err != nil {
		t.Fatal(err)
	}

	empName, waiterRole := "Сотрудник", "waiter"
	empID := uuid.NewString()
	if err := gdb.Create(&models.User{
		ID: empID, Name: &empName, Role: &waiterRole, RestaurantID: &f.rid,
	}).Error; err != nil {
		t.Fatal(err)
	}

	// Выдаём аванс 300 за 2026-07.
	r, b := f.post(t, "/api/v1/finance/salary/advance", tok, uuid.NewString(), map[string]any{
		"user_id": empID, "amount": "300", "account_id": accID, "period": "2026-07",
	})
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("give advance: %d %s", r.StatusCode, b)
	}
	var adv struct {
		ID     string `json:"id"`
		Amount string `json:"amount"`
	}
	if err := json.Unmarshal(b, &adv); err != nil {
		t.Fatal(err)
	}
	if adv.ID == "" {
		t.Fatalf("advance id пуст, ожидали id (можно отменить/трассировать): %s", b)
	}

	// Счёт списан.
	var acc models.FinancialAccount
	if err := gdb.First(&acc, "id = ?", accID).Error; err != nil {
		t.Fatal(err)
	}
	if got := decimal.Normalize(acc.Balance).String(); got != "700" {
		t.Errorf("баланс счёта = %s, ожидали 700 (1000 − 300 аванс)", got)
	}

	// users.advance синхронен со строкой.
	var u models.User
	if err := gdb.First(&u, "id = ?", empID).Error; err != nil {
		t.Fatal(err)
	}
	if got := decimal.Normalize(u.Advance).String(); got != "300" {
		t.Errorf("users.advance = %s, ожидали 300", got)
	}

	// История видна через GET (для отражения на карточке сотрудника).
	rl, bl := f.get(t, "/api/v1/finance/salary/advances?user_id="+empID, tok)
	if rl.StatusCode != http.StatusOK {
		t.Fatalf("list advances: %d %s", rl.StatusCode, bl)
	}
	var listEnv struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	_ = json.Unmarshal(bl, &listEnv)
	if len(listEnv.Data) != 1 || listEnv.Data[0].ID != adv.ID {
		t.Fatalf("список авансов сотрудника = %+v, ожидали ровно 1 запись %s", listEnv.Data, adv.ID)
	}

	// Отмена аванса: деньги возвращаются, счётчик декрементируется.
	rc, bc := f.del(t, "/api/v1/finance/salary/advances/"+adv.ID, tok, uuid.NewString())
	if rc.StatusCode != http.StatusOK {
		t.Fatalf("cancel advance: %d %s", rc.StatusCode, bc)
	}

	if err := gdb.First(&acc, "id = ?", accID).Error; err != nil {
		t.Fatal(err)
	}
	if got := decimal.Normalize(acc.Balance).String(); got != "1000" {
		t.Errorf("после отмены баланс счёта = %s, ожидали 1000 (деньги вернулись)", got)
	}
	if err := gdb.First(&u, "id = ?", empID).Error; err != nil {
		t.Fatal(err)
	}
	if got := decimal.Normalize(u.Advance).String(); got != "0" {
		t.Errorf("после отмены users.advance = %s, ожидали 0", got)
	}

	// Повторная отмена — не должна пройти (аванс уже отменён).
	rc2, _ := f.del(t, "/api/v1/finance/salary/advances/"+adv.ID, tok, uuid.NewString())
	if rc2.StatusCode == http.StatusOK {
		t.Errorf("повторная отмена уже отменённого аванса не должна давать 200")
	}
}

// 070: GiveAdvance применяет ТОТ ЖЕ кап, что раньше применялся к
// PaySalary(kind=advance) — начислено − аванс − удержания − выплачено.
// Раньше вся эта проверка (и Override-выход) жила только в PaySalary; при
// переносе выдачи аванса на отдельный эндпоинт кап легко было забыть —
// тогда владелец мог бы выдать аванс сверх начисленного без предупреждения.
func TestSalary_GiveAdvance_RespectsAccrualCap(t *testing.T) {
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

	empName, waiterRole := "Окладник", "waiter"
	empID := uuid.NewString()
	if err := gdb.Create(&models.User{
		ID: empID, Name: &empName, Role: &waiterRole, RestaurantID: &f.rid,
		Salary: decimal.MustFromString("120"),
	}).Error; err != nil {
		t.Fatal(err)
	}

	// Начислено 120 за 2026-07 — аванс 880 должен быть отклонён без override.
	r, b := f.post(t, "/api/v1/finance/salary/advance", tok, uuid.NewString(), map[string]any{
		"user_id": empID, "amount": "880", "account_id": accID, "period": "2026-07",
	})
	if r.StatusCode == http.StatusCreated {
		t.Fatalf("аванс 880 при начислении 120 должен быть отклонён капом, а не создан: %s", b)
	}

	// С override + причиной — проходит (свободная выплата, ЗП-4).
	r2, b2 := f.post(t, "/api/v1/finance/salary/advance", tok, uuid.NewString(), map[string]any{
		"user_id": empID, "amount": "880", "account_id": accID, "period": "2026-07",
		"override": true, "override_reason": "бонус",
	})
	if r2.StatusCode != http.StatusCreated {
		t.Fatalf("аванс с override должен пройти: %d %s", r2.StatusCode, b2)
	}

	var u models.User
	if err := gdb.First(&u, "id = ?", empID).Error; err != nil {
		t.Fatal(err)
	}
	if got := decimal.Normalize(u.Advance).String(); got != "880" {
		t.Errorf("users.advance после override-аванса = %s, ожидали 880", got)
	}
}

// 070: удержание можно отменить — декремент users.deductions, без движения
// денег по счёту (удержание никогда не списывало счёт).
func TestSalary_CancelDeduction_DecrementsCounter(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb := openTestDB(t)

	gdb.Model(&models.User{}).Where("restaurant_id = ?", f.rid).
		Update("permissions", datatypes.JSON([]byte(`{"actions":{"payroll.manage":true}}`)))

	empName, waiterRole := "Сотрудник2", "waiter"
	empID := uuid.NewString()
	if err := gdb.Create(&models.User{
		ID: empID, Name: &empName, Role: &waiterRole, RestaurantID: &f.rid,
	}).Error; err != nil {
		t.Fatal(err)
	}

	r, b := f.post(t, "/api/v1/finance/salary/deductions", tok, uuid.NewString(), map[string]any{
		"user_id": empID, "amount": "150", "reason": "штраф", "period": "2026-07",
	})
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("add deduction: %d %s", r.StatusCode, b)
	}
	var ded struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(b, &ded)

	var u models.User
	if err := gdb.First(&u, "id = ?", empID).Error; err != nil {
		t.Fatal(err)
	}
	if got := decimal.Normalize(u.Deductions).String(); got != "150" {
		t.Fatalf("users.deductions = %s, ожидали 150", got)
	}

	rc, bc := f.del(t, "/api/v1/finance/salary/deductions/"+ded.ID, tok, uuid.NewString())
	if rc.StatusCode != http.StatusOK {
		t.Fatalf("cancel deduction: %d %s", rc.StatusCode, bc)
	}
	if err := gdb.First(&u, "id = ?", empID).Error; err != nil {
		t.Fatal(err)
	}
	if got := decimal.Normalize(u.Deductions).String(); got != "0" {
		t.Errorf("после отмены users.deductions = %s, ожидали 0", got)
	}
}
