//go:build integration

package http_test

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/db"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// Расход из смены (POST /shifts/{id}/expenses с категорией) должен создавать
// financial_operations (type=out) — иначе он виден только в самой смене
// (Сводка/X-Z) и пропадает из ОПиУ (opex) и ДДС (cashflow).
func TestShiftExpense_AppearsInPnLAndCashflow(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _ := db.Open(testDSN())
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})

	shiftID, openStatus, openedBy := uuid.NewString(), "open", "test"
	now := time.Now().UTC()
	if err := gdb.Create(&models.CashShift{
		ID: shiftID, RestaurantID: &f.rid, Status: &openStatus, OpenedBy: &openedBy,
		OpeningBalance: decimal.Zero, OpenedAt: now, UpdatedAt: now,
	}).Error; err != nil {
		t.Fatal(err)
	}

	r, b := f.post(t, "/api/v1/shifts/"+shiftID+"/expenses", tok, uuid.NewString(), map[string]any{
		"type": "expense", "amount": "40", "category": "Ремонт", "description": "лампочка",
	})
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("expense: %d %s", r.StatusCode, b)
	}
	var op models.CashShiftOperation
	if err := json.Unmarshal(b, &op); err != nil {
		t.Fatal(err)
	}

	today := now.Format("2006-01-02")

	// ОПиУ: расход должен попасть в opex категорией «Ремонт».
	rp, bp := f.get(t, "/api/v1/finance/pnl?from="+today+"&to="+today, tok)
	if rp.StatusCode != http.StatusOK {
		t.Fatalf("pnl: %d %s", rp.StatusCode, bp)
	}
	var pnl struct {
		Opex struct {
			Total      decimal.Decimal `json:"total"`
			ByCategory []struct {
				Category string          `json:"category"`
				Amount   decimal.Decimal `json:"amount"`
			} `json:"by_category"`
		} `json:"opex"`
	}
	if err := json.Unmarshal(bp, &pnl); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, c := range pnl.Opex.ByCategory {
		if c.Category == "Ремонт" && c.Amount.Equal(decimal.MustFromString("40")) {
			found = true
		}
	}
	if !found {
		t.Fatalf("расход смены не найден в opex ОПиУ: %+v", pnl.Opex.ByCategory)
	}

	// ДДС: та же операция должна быть в оттоке по категории.
	rc, bc := f.get(t, "/api/v1/finance/cashflow?from="+today+"&to="+today, tok)
	if rc.StatusCode != http.StatusOK {
		t.Fatalf("cashflow: %d %s", rc.StatusCode, bc)
	}
	var cf struct {
		OutByCategory []struct {
			Category string          `json:"category"`
			Amount   decimal.Decimal `json:"amount"`
		} `json:"out_by_category"`
	}
	if err := json.Unmarshal(bc, &cf); err != nil {
		t.Fatal(err)
	}
	foundCf := false
	for _, c := range cf.OutByCategory {
		if c.Category == "Ремонт" && c.Amount.Equal(decimal.MustFromString("40")) {
			foundCf = true
		}
	}
	if !foundCf {
		t.Fatalf("расход смены не найден в ДДС: %+v", cf.OutByCategory)
	}

	// Удаление расхода должно реверснуть financial_operation — иначе он
	// «застревает» в ОПиУ/ДДС уже после того, как кассир его удалил.
	rd, rdb := f.del(t, "/api/v1/shifts/"+shiftID+"/expenses/"+op.ID, tok, uuid.NewString())
	if rd.StatusCode != http.StatusNoContent {
		t.Fatalf("delete expense: %d %s", rd.StatusCode, rdb)
	}
	var cnt int64
	if err := gdb.Model(&models.FinancialOperation{}).
		Where("restaurant_id = ? AND source_ref = ?", f.rid, "shift_expense:"+op.ID).
		Count(&cnt).Error; err != nil {
		t.Fatal(err)
	}
	if cnt != 0 {
		t.Fatalf("financial_operation не удалена после удаления расхода смены (осталось %d)", cnt)
	}
}

// Н13: расход из смены с категорией ДЕБЕТУЕТ счёт смены, а удаление — возвращает.
// Раньше баланс счёта не трогали, тогда как выручка кредитует счёт полностью при
// закрытии заказа → «Денежные средства» в Балансе завышались на сумму всех
// кассовых расходов за всю историю.
func TestShiftExpense_DebitsAndRestoresAccount(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _ := db.Open(testDSN())
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})

	accID, accName := uuid.NewString(), "Касса"
	if err := gdb.Create(&models.FinancialAccount{
		ID: accID, Name: &accName, Balance: decimal.MustFromString("1000"), RestaurantID: &f.rid,
	}).Error; err != nil {
		t.Fatal(err)
	}
	shiftID, openStatus, openedBy := uuid.NewString(), "open", "test"
	now := time.Now().UTC()
	if err := gdb.Create(&models.CashShift{
		ID: shiftID, RestaurantID: &f.rid, AccountID: &accID, Status: &openStatus, OpenedBy: &openedBy,
		OpeningBalance: decimal.Zero, OpenedAt: now, UpdatedAt: now,
	}).Error; err != nil {
		t.Fatal(err)
	}

	balOf := func() decimal.Decimal {
		var a models.FinancialAccount
		gdb.Where("id = ?", accID).First(&a)
		return decimal.Normalize(a.Balance)
	}

	// Расход 40 с категорией → счёт 1000 − 40 = 960.
	r, b := f.post(t, "/api/v1/shifts/"+shiftID+"/expenses", tok, uuid.NewString(), map[string]any{
		"type": "expense", "amount": "40", "category": "Закупка продуктов", "description": "нон",
	})
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("expense: %d %s", r.StatusCode, b)
	}
	var op models.CashShiftOperation
	if err := json.Unmarshal(b, &op); err != nil {
		t.Fatal(err)
	}
	if got := balOf(); !got.Equal(decimal.MustFromString("960")) {
		t.Fatalf("после кассового расхода баланс счёта = %s, want 960 (1000−40)", got)
	}

	// Удаление расхода → счёт возвращается к 1000 (реверс дебета).
	rd, rdb := f.del(t, "/api/v1/shifts/"+shiftID+"/expenses/"+op.ID, tok, uuid.NewString())
	if rd.StatusCode != http.StatusNoContent {
		t.Fatalf("delete expense: %d %s", rd.StatusCode, rdb)
	}
	if got := balOf(); !got.Equal(decimal.MustFromString("1000")) {
		t.Fatalf("после удаления баланс счёта = %s, want 1000 (реверс)", got)
	}
}

// Внесение/изъятие (cash_in / cash_out БЕЗ категории) — это движение налички
// в кассе, а не расход бизнеса. Оно НЕ должно создавать financial_operations
// и попадать в ОПиУ.
func TestShiftCashOut_WithoutCategory_DoesNotHitPnL(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _ := db.Open(testDSN())
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})

	shiftID, openStatus, openedBy := uuid.NewString(), "open", "test"
	now := time.Now().UTC()
	if err := gdb.Create(&models.CashShift{
		ID: shiftID, RestaurantID: &f.rid, Status: &openStatus, OpenedBy: &openedBy,
		OpeningBalance: decimal.Zero, OpenedAt: now, UpdatedAt: now,
	}).Error; err != nil {
		t.Fatal(err)
	}

	r, b := f.post(t, "/api/v1/shifts/"+shiftID+"/operations", tok, uuid.NewString(), map[string]any{
		"type": "cash_out", "amount": "30", "description": "инкассация",
	})
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("operation: %d %s", r.StatusCode, b)
	}

	var cnt int64
	if err := gdb.Model(&models.FinancialOperation{}).
		Where("restaurant_id = ? AND shift_id = ?", f.rid, shiftID).
		Count(&cnt).Error; err != nil {
		t.Fatal(err)
	}
	if cnt != 0 {
		t.Fatalf("изъятие без категории не должно создавать financial_operations, найдено %d", cnt)
	}
}

// Безналичный расход из смены (account_id = банк-счёт) ДЕБЕТУЕТ банк-счёт, а не
// наличный ящик смены, и НЕ идёт в кассовый Z-отчёт (expected_cash). Наличный
// расход при этом ведёт себя как раньше — со счёта смены и в кассовый Z.
func TestShiftExpense_Cashless_DebitsBankNotDrawer(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _ := db.Open(testDSN())
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})

	cashID, cashName := uuid.NewString(), "Касса"
	bankID, bankName, bankType := uuid.NewString(), "Банк", "bank"
	if err := gdb.Create(&models.FinancialAccount{ID: cashID, Name: &cashName, Balance: decimal.MustFromString("1000"), RestaurantID: &f.rid}).Error; err != nil {
		t.Fatal(err)
	}
	if err := gdb.Create(&models.FinancialAccount{ID: bankID, Name: &bankName, Type: &bankType, Balance: decimal.MustFromString("500"), RestaurantID: &f.rid}).Error; err != nil {
		t.Fatal(err)
	}
	shiftID, openStatus, openedBy := uuid.NewString(), "open", "test"
	now := time.Now().UTC()
	if err := gdb.Create(&models.CashShift{
		ID: shiftID, RestaurantID: &f.rid, AccountID: &cashID, Status: &openStatus, OpenedBy: &openedBy,
		OpeningBalance: decimal.Zero, OpenedAt: now, UpdatedAt: now,
	}).Error; err != nil {
		t.Fatal(err)
	}

	balOf := func(id string) decimal.Decimal {
		var a models.FinancialAccount
		gdb.Where("id = ?", id).First(&a)
		return decimal.Normalize(a.Balance)
	}

	// 1) Наличный расход 40 (без account_id) → касса 960, банк 500.
	r, b := f.post(t, "/api/v1/shifts/"+shiftID+"/expenses", tok, uuid.NewString(), map[string]any{
		"type": "expense", "amount": "40", "category": "Закупка продуктов",
	})
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("cash expense: %d %s", r.StatusCode, b)
	}

	// 2) Безналичный расход 100 (account_id = банк) → касса 960 (не тронута), банк 400.
	r2, b2 := f.post(t, "/api/v1/shifts/"+shiftID+"/expenses", tok, uuid.NewString(), map[string]any{
		"type": "expense", "amount": "100", "category": "Ремонт", "account_id": bankID,
	})
	if r2.StatusCode != http.StatusCreated {
		t.Fatalf("cashless expense: %d %s", r2.StatusCode, b2)
	}
	var cashlessOp models.CashShiftOperation
	if err := json.Unmarshal(b2, &cashlessOp); err != nil {
		t.Fatal(err)
	}

	if got := balOf(cashID); !got.Equal(decimal.MustFromString("960")) {
		t.Errorf("касса = %s, want 960 (только наличный расход 40; безнал её не трогает)", got)
	}
	if got := balOf(bankID); !got.Equal(decimal.MustFromString("400")) {
		t.Errorf("банк = %s, want 400 (500 − безнал 100)", got)
	}

	// account_id сохранён на безналичной операции.
	var stored models.CashShiftOperation
	if err := gdb.Where("id = ?", cashlessOp.ID).First(&stored).Error; err != nil {
		t.Fatal(err)
	}
	if stored.AccountID == nil || *stored.AccountID != bankID {
		t.Errorf("account_id безналичного расхода = %v, want %s", stored.AccountID, bankID)
	}

	// Z-отчёт (наличный ящик): expenses_total = 40 (только наличный расход),
	// безналичные 100 в кассовый Z не идут.
	rz, bz := f.get(t, "/api/v1/shifts/"+shiftID+"/zreport", tok)
	if rz.StatusCode != http.StatusOK {
		t.Fatalf("zreport: %d %s", rz.StatusCode, bz)
	}
	var z struct {
		ExpensesTotal decimal.Decimal `json:"expenses_total"`
	}
	if err := json.Unmarshal(bz, &z); err != nil {
		t.Fatal(err)
	}
	if !z.ExpensesTotal.Equal(decimal.MustFromString("40")) {
		t.Errorf("Z-отчёт expenses_total = %s, want 40 (безналичный расход в наличный Z не идёт)", decimal.Normalize(z.ExpensesTotal))
	}
}
