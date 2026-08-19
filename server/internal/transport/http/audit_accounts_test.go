//go:build integration

package http_test

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// Тесты аудита счетов / зарплаты / обязательств / сверки смены.

func accBalance(t *testing.T, gdb *gorm.DB, id string) decimal.Decimal {
	t.Helper()
	var a models.FinancialAccount
	if err := gdb.First(&a, "id = ?", id).Error; err != nil {
		t.Fatal(err)
	}
	return a.Balance
}

// БАГ #7: одну и ту же зарплату за период можно выплатить многократно.
func TestAudit_SalaryDoublePay(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, _, accountID := seedForWrite(t, f)
	topUp(t, gdb, accountID)

	uid, uname, salary := uuid.NewString(), "Повар", decimal.MustFromString("1000")
	if err := gdb.Create(&models.User{
		ID: uid, Name: &uname, Salary: salary, RestaurantID: &f.rid,
	}).Error; err != nil {
		t.Fatal(err)
	}
	// Аванс — период-тегированной строкой salary_advances, а не глобальным
	// счётчиком users.advance: кап читает остаток только из неё (см.
	// комментарий в salaryCapForPeriod про баг «аванс за прошлый месяц срезал
	// остаток текущего»). users.advance тут больше ни на что не влияет.
	if err := gdb.Create(&models.SalaryAdvance{
		ID: uuid.NewString(), UserID: uid, Amount: decimal.MustFromString("300"),
		Period: "2026-07", AccountID: accountID, RestaurantID: &f.rid,
	}).Error; err != nil {
		t.Fatal(err)
	}

	// Остаток к выплате = 1000 оклад − 300 аванс = 700.
	pay := func(amt string) int {
		r, _ := f.post(t, "/api/v1/finance/salary/pay", tok, uuid.NewString(), map[string]any{
			"user_id": uid, "amount": amt, "account_id": accountID,
			"employee_name": uname, "period": "2026-07",
		})
		return r.StatusCode
	}
	// Выплата полного оклада 1000 при авансе 300 — отбита (переплата).
	if c := pay("1000"); c != http.StatusBadRequest {
		t.Errorf("выплата 1000 при остатке 700: %d, want 400 (аванс не вычтен)", c)
	}
	// Нетто 700 — проходит.
	if c := pay("700"); c != http.StatusCreated && c != http.StatusOK {
		t.Errorf("выплата 700: %d, want 2xx", c)
	}
	// Повторная выплата за тот же период — отбита.
	if c := pay("700"); c != http.StatusBadRequest {
		t.Errorf("повторная выплата за период: %d, want 400 (двойная выплата)", c)
	}

	var paid decimal.Decimal
	var ops []models.FinancialOperation
	gdb.Where("source_ref = ?", uid).Find(&ops)
	for _, op := range ops {
		if op.Category != nil && *op.Category == "Зарплата" {
			paid = decimal.Add(paid, op.Amount)
		}
	}
	if !paid.Equal(decimal.MustFromString("700")) {
		t.Errorf("выплачено всего %s за период, want 700 (одна нетто-выплата)", paid)
	}
	_ = salary
}

// БАГ #8: создание счёта с балансом «минтит» деньги без встречной проводки.
func TestAudit_AccountCreate_BalanceHasBacking(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, _, _ := seedForWrite(t, f)

	r, b := f.post(t, "/api/v1/finance/accounts", tok, uuid.NewString(), map[string]any{
		"name": "Левый счёт", "type": "cash", "balance": "5000",
	})
	if r.StatusCode != http.StatusCreated && r.StatusCode != http.StatusOK {
		t.Fatalf("create account: %d %s", r.StatusCode, b)
	}
	var acc models.FinancialAccount
	_ = json.Unmarshal(b, &acc)

	if !accBalance(t, gdb, acc.ID).Equal(decimal.MustFromString("5000")) {
		t.Skipf("баланс не 5000 — сценарий не тот")
	}
	// 5000 обязаны быть уравновешены встречной записью капитала «Взнос
	// собственника» (equity_entries) — иначе это деньги из ниоткуда в Балансе.
	var eqSum decimal.Decimal
	gdb.Model(&models.EquityEntry{}).Where("restaurant_id = ? AND category = ?", f.rid, "opening_account").
		Select("COALESCE(SUM(amount), 0)").Scan(&eqSum)
	if !eqSum.Equal(decimal.MustFromString("5000")) {
		t.Errorf("взнос капитала за открытие счёта = %s, want 5000 — баланс не подкреплён", eqSum)
	}
}

// БАГ #8 (PATCH): баланс счёта можно переписать напрямую.
func TestAudit_AccountPatch_BalanceNotOverwritable(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, _, accountID := seedForWrite(t, f)

	before := accBalance(t, gdb, accountID)
	r, b := f.patch(t, "/api/v1/finance/accounts/"+accountID, tok, uuid.NewString(), map[string]any{"balance": "9999"})
	if r.StatusCode == http.StatusNotFound {
		t.Skipf("PATCH счёта не поддержан")
	}
	after := accBalance(t, gdb, accountID)
	// Прямая перезапись баланса на произвольное значение недопустима без проводки.
	if after.Equal(decimal.MustFromString("9999")) && !before.Equal(decimal.MustFromString("9999")) {
		t.Errorf("баланс переписан %s → 9999 напрямую (resp %d %s) — мимо аудита сумм", before, r.StatusCode, b)
	}
}

// БАГ #9: «оплата» обязательства (PATCH paid_amount) не двигает счёт.
func TestAudit_LiabilityPayment_DebitsAccount(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, _, accountID := seedForWrite(t, f)
	topUp(t, gdb, accountID)

	r, b := f.post(t, "/api/v1/liabilities", tok, uuid.NewString(), map[string]any{
		"name": "Кредит", "category": "loan", "total_amount": "1000", "paid_amount": "0",
	})
	if r.StatusCode != http.StatusCreated && r.StatusCode != http.StatusOK {
		t.Fatalf("create liability: %d %s", r.StatusCode, b)
	}
	var lia models.Liability
	_ = json.Unmarshal(b, &lia)

	before := accBalance(t, gdb, accountID)
	// Погашаем 400 через /pay — должно списать со счёта.
	if r, b := f.post(t, "/api/v1/liabilities/"+lia.ID+"/pay", tok, uuid.NewString(),
		map[string]any{"amount": "400", "account_id": accountID}); r.StatusCode != http.StatusOK {
		t.Fatalf("pay liability: %d %s", r.StatusCode, b)
	}
	after := accBalance(t, gdb, accountID)
	if !decimal.Sub(before, after).Equal(decimal.MustFromString("400")) {
		t.Errorf("со счёта ушло %s при погашении 400 — обязательство и касса должны двигаться вместе", decimal.Sub(before, after))
	}
	// PATCH paid_amount напрямую запрещён.
	if r, _ := f.patch(t, "/api/v1/liabilities/"+lia.ID, tok, uuid.NewString(),
		map[string]any{"paid_amount": "1000"}); r.StatusCode == http.StatusOK {
		t.Errorf("PATCH paid_amount прошёл (%d) — прямое погашение мимо счёта не должно работать", r.StatusCode)
	}
}

// БАГ #27: смена и счёт — независимые реестры. Ручной кассовый расход двигает
// счёт, но не expected_cash смены → фантомная недостача/излишек в Z.
func TestAudit_ManualCashOut_ReflectedInShift(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, shiftID, accountID := seedForWrite(t, f)

	// Привязываем смену к кассовому счёту, стартовые 500 в обоих реестрах.
	if err := gdb.Model(&models.CashShift{}).Where("id = ?", shiftID).
		Updates(map[string]any{"account_id": accountID, "opening_balance": decimal.MustFromString("500")}).Error; err != nil {
		t.Fatal(err)
	}
	if err := gdb.Model(&models.FinancialAccount{}).Where("id = ?", accountID).
		Update("balance", decimal.MustFromString("500")).Error; err != nil {
		t.Fatal(err)
	}

	// Кассир платит 200 наличными как ручную финоперацию на кассовый счёт.
	if r, b := f.post(t, "/api/v1/finance/operations", tok, uuid.NewString(), map[string]any{
		"type": "out", "amount": "200", "account_id": accountID, "category": "хозрасход", "activity": "operational",
	}); r.StatusCode != http.StatusCreated && r.StatusCode != http.StatusOK {
		t.Fatalf("manual out: %d %s", r.StatusCode, b)
	}

	// Закрываем смену — expected_cash обязан учесть 200 (реально из кассы ушло).
	r, b := f.post(t, "/api/v1/shifts/"+shiftID+"/close", tok, uuid.NewString(), map[string]any{
		"closing_balance": "300",
	})
	if r.StatusCode != http.StatusOK {
		t.Skipf("close shift: %d %s", r.StatusCode, b)
	}
	var shift models.CashShift
	gdb.First(&shift, "id = ?", shiftID)
	acc := accBalance(t, gdb, accountID)
	// Ожидаемая касса обязана совпасть с балансом счёта (оба = 300).
	if shift.ExpectedCash != nil && !shift.ExpectedCash.Equal(acc) {
		t.Errorf("expected_cash = %s, баланс счёта = %s — ручной кассовый расход не отражён в смене (фантомный излишек)",
			*shift.ExpectedCash, acc)
	}
}

// affects_shift=false — расход реально списывается со счёта (деньги правда
// ушли), но НЕ зеркалится в открытую смену: пользователь явно сказал, что это
// не было движением наличных в сегодняшнем ящике (бухгалтерская проводка).
func TestAudit_ManualCashOut_AffectsShiftFalse_NotMirroredIntoShift(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, shiftID, accountID := seedForWrite(t, f)

	if err := gdb.Model(&models.CashShift{}).Where("id = ?", shiftID).
		Updates(map[string]any{"account_id": accountID, "opening_balance": decimal.MustFromString("500")}).Error; err != nil {
		t.Fatal(err)
	}
	if err := gdb.Model(&models.FinancialAccount{}).Where("id = ?", accountID).
		Update("balance", decimal.MustFromString("500")).Error; err != nil {
		t.Fatal(err)
	}

	if r, b := f.post(t, "/api/v1/finance/operations", tok, uuid.NewString(), map[string]any{
		"type": "out", "amount": "200", "account_id": accountID, "category": "прочие расходы",
		"activity": "operational", "affects_shift": false,
	}); r.StatusCode != http.StatusCreated && r.StatusCode != http.StatusOK {
		t.Fatalf("manual out: %d %s", r.StatusCode, b)
	}

	// Счёт реально дебетован — деньги ушли независимо от affects_shift.
	if acc := accBalance(t, gdb, accountID); !acc.Equal(decimal.MustFromString("300")) {
		t.Errorf("account balance = %s, want 300 — affects_shift не должен влиять на сам факт списания со счёта", acc)
	}

	// Но зеркала в смену НЕ должно быть.
	var cnt int64
	if err := gdb.Model(&models.CashShiftOperation{}).
		Where("shift_id = ? AND type = ?", shiftID, "cash_out").Count(&cnt).Error; err != nil {
		t.Fatal(err)
	}
	if cnt != 0 {
		t.Errorf("cash_shift_operations cash_out count = %d, want 0 — affects_shift=false не должен зеркалить расход в смену", cnt)
	}

	// Закрываем смену: раз зеркала нет, expected_cash остаётся 500 (как будто
	// этого расхода смена не видела вовсе) — ровно то поведение, которое просили.
	r, b := f.post(t, "/api/v1/shifts/"+shiftID+"/close", tok, uuid.NewString(), map[string]any{
		"closing_balance": "500",
	})
	if r.StatusCode != http.StatusOK {
		t.Fatalf("close shift: %d %s", r.StatusCode, b)
	}
	var shift models.CashShift
	gdb.First(&shift, "id = ?", shiftID)
	if shift.ExpectedCash == nil || !shift.ExpectedCash.Equal(decimal.MustFromString("500")) {
		t.Errorf("expected_cash = %v, want 500 — расход с affects_shift=false не должен был войти в расчёт", shift.ExpectedCash)
	}
}

// БАГ #28 (регресс, 069): авто-зеркало cash_out (наличная выплата) раньше
// можно было удалить как обычную операцию смены → expected_cash поднимался,
// хотя деньги реально ушли со счёта. Зеркало реальной, ещё действующей
// выплаты теперь несёт source_ref на её financial_operations — удаление
// такого зеркала блокируется (нужно отменять исходную выплату, не зеркало).
// Фантомные зеркала (без source_ref, или чья исходная операция уже удалена)
// по-прежнему удаляются как раньше — см. delete_phantom_mirror*_test.go.
func TestAudit_DeleteAutoMirror_KeepsShiftConsistent(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, shiftID, accountID := seedForWrite(t, f)

	if err := gdb.Model(&models.CashShift{}).Where("id = ?", shiftID).
		Updates(map[string]any{"account_id": accountID, "opening_balance": decimal.MustFromString("500")}).Error; err != nil {
		t.Fatal(err)
	}
	if err := gdb.Model(&models.FinancialAccount{}).Where("id = ?", accountID).
		Update("balance", decimal.MustFromString("500")).Error; err != nil {
		t.Fatal(err)
	}

	uid, uname := uuid.NewString(), "Официант-ЗП"
	if err := gdb.Create(&models.User{ID: uid, Name: &uname, RestaurantID: &f.rid}).Error; err != nil {
		t.Fatal(err)
	}
	// Наличная выплата 200 с кассового счёта → account 300 + зеркало cash_out 200
	// с source_ref на саму эту выплату.
	if r, b := f.post(t, "/api/v1/finance/salary/pay", tok, uuid.NewString(), map[string]any{
		"user_id": uid, "amount": "200", "account_id": accountID, "employee_name": uname, "period": "2026-07",
	}); r.StatusCode != http.StatusCreated && r.StatusCode != http.StatusOK {
		t.Fatalf("salary pay: %d %s", r.StatusCode, b)
	}
	var mirror models.CashShiftOperation
	if err := gdb.Where("shift_id = ? AND type = ?", shiftID, "cash_out").First(&mirror).Error; err != nil {
		t.Fatalf("зеркало cash_out не создано: %v", err)
	}
	if mirror.SourceRef == nil || *mirror.SourceRef == "" {
		t.Fatalf("зеркало без source_ref — санити-чек сетапа сломан")
	}

	// Удалить зеркало напрямую — заблокировано: выплата ещё действует.
	r, b := f.del(t, "/api/v1/cash-shift-operations/"+mirror.ID, tok, uuid.NewString())
	if r.StatusCode != http.StatusConflict {
		t.Fatalf("delete живого зеркала: %d %s, want 409 — выплата ещё существует", r.StatusCode, b)
	}
	var stillExists int64
	gdb.Model(&models.CashShiftOperation{}).Where("id = ?", mirror.ID).Count(&stillExists)
	if stillExists == 0 {
		t.Fatalf("зеркало удалено, несмотря на 409 — запись должна остаться на месте")
	}

	// Закрываем смену — expected_cash обязан остаться согласован со счётом (300).
	if r, b := f.post(t, "/api/v1/shifts/"+shiftID+"/close", tok, uuid.NewString(), map[string]any{
		"closing_balance": "300",
	}); r.StatusCode != http.StatusOK {
		t.Fatalf("close shift: %d %s", r.StatusCode, b)
	}
	var shift models.CashShift
	gdb.First(&shift, "id = ?", shiftID)
	acc := accBalance(t, gdb, accountID)
	if shift.ExpectedCash == nil || !shift.ExpectedCash.Equal(acc) {
		t.Errorf("expected_cash = %v, баланс счёта = %s — должны совпасть", shift.ExpectedCash, acc)
	}

	// Исходная выплата удалена (сторнирована) отдельно от зеркала — ТЕПЕРЬ
	// зеркало фантомное (source_ref есть, но записи по нему больше нет) и
	// удаление разрешено — штатный путь очистки после отмены операции.
	if err := gdb.Where("id = ?", *mirror.SourceRef).Delete(&models.FinancialOperation{}).Error; err != nil {
		t.Fatal(err)
	}
	r2, b2 := f.del(t, "/api/v1/cash-shift-operations/"+mirror.ID, tok, uuid.NewString())
	if r2.StatusCode != http.StatusOK && r2.StatusCode != http.StatusNoContent {
		t.Errorf("delete зеркала после удаления исходной операции: %d %s, want 200/204", r2.StatusCode, b2)
	}
}
