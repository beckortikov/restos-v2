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
