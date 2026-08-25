//go:build integration

package http_test

import (
	"net/http"
	"testing"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// TestRestaurant_ClearOperations_WipesOpsZeroesBalancesKeepsRefs — сброс
// операций ресторана: удаляет операционные данные (склад/брони/журнал/плановые
// платежи/ЗП-историю), ОБНУЛЯЕТ денормализованные балансы (остаток qty, деньги
// на счёте, долг поставщика), но СОХРАНЯЕТ справочники (номенклатура,
// поставщики, счета, меню). Раньше сброс трогал только 7 таблиц: деньги на
// счетах и весь склад оставались (баг владельца).
func TestRestaurant_ClearOperations_WipesOpsZeroesBalancesKeepsRefs(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb := openTestDB(t)
	rid := f.rid
	sp := func(s string) *string { return &s }
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}

	// ── СОХРАНИТЬ: номенклатура/поставщик/счёт/меню с ненулевыми балансами ──
	ingID := uuid.NewString()
	must(gdb.Create(&models.Ingredient{ID: ingID, Name: sp("Мука"), Unit: sp("kg"), Qty: decimal.MustFromString("50"), RestaurantID: &rid}).Error)
	supID := uuid.NewString()
	must(gdb.Create(&models.Supplier{ID: supID, Name: sp("Поставщик"), CurrentDebt: decimal.MustFromString("200"), RestaurantID: &rid}).Error)
	accID := uuid.NewString()
	must(gdb.Create(&models.FinancialAccount{ID: accID, Name: sp("Касса"), Balance: decimal.MustFromString("5000"), RestaurantID: &rid}).Error)
	menuID := uuid.NewString()
	must(gdb.Create(&models.MenuItem{ID: menuID, Name: sp("Пицца"), RestaurantID: &rid}).Error)

	// ── СТЕРЕТЬ: операции ──
	must(gdb.Create(&models.StockMovement{ID: uuid.NewString(), Type: sp("in"), IngredientID: &ingID, Qty: decimal.MustFromString("50"), RestaurantID: &rid}).Error)
	must(gdb.Create(&models.Reservation{ID: uuid.NewString(), Status: sp("pending"), RestaurantID: &rid}).Error)
	must(gdb.Create(&models.AuditLog{ID: uuid.NewString(), Action: sp("test"), RestaurantID: &rid}).Error)
	must(gdb.Create(&models.RecurringPayment{ID: uuid.NewString(), Name: sp("Аренда"), Amount: decimal.MustFromString("1000"), RestaurantID: &rid}).Error)
	must(gdb.Create(&models.SalaryAdvance{ID: uuid.NewString(), UserID: uuid.NewString(), Amount: decimal.MustFromString("100"), Period: "2026-08", AccountID: &accID, RestaurantID: &rid}).Error)
	// Капитал начального остатка — должен уйти в ноль, иначе Баланс после сброса
	// висит без актива и повторный ввод начального остатка задваивает капитал.
	must(gdb.Create(&models.EquityEntry{ID: uuid.NewString(), Name: sp("Взнос собственника — начальный остаток склада"), Amount: decimal.MustFromString("500"), RestaurantID: &rid}).Error)

	// ── Гвард: кассир (не владелец) не может сбросить — 403 ──
	rDenied, _ := f.post(t, "/api/v1/restaurants/"+rid+"/clear-operations", tok, uuid.NewString(), map[string]any{})
	if rDenied.StatusCode != http.StatusForbidden {
		t.Fatalf("сброс не-владельцем: %d, want 403 (только владелец)", rDenied.StatusCode)
	}
	// Повышаем актора до владельца (гвард перечитывает роль из БД) — теперь можно.
	must(gdb.Model(&models.User{}).Where("restaurant_id = ?", rid).Update("role", "owner").Error)

	// ── Сброс ──
	r, b := f.post(t, "/api/v1/restaurants/"+rid+"/clear-operations", tok, uuid.NewString(), map[string]any{})
	if r.StatusCode != http.StatusOK {
		t.Fatalf("clear-operations: %d %s", r.StatusCode, b)
	}

	// ── Справочники остались, но балансы обнулены ──
	var ing models.Ingredient
	if err := gdb.First(&ing, "id = ?", ingID).Error; err != nil {
		t.Fatalf("номенклатура удалена (не должна): %v", err)
	}
	if !ing.Qty.Equal(decimal.Zero) {
		t.Errorf("ingredients.qty = %s, want 0 (остаток обнуляется)", decimal.Normalize(ing.Qty).String())
	}
	var sup models.Supplier
	if err := gdb.First(&sup, "id = ?", supID).Error; err != nil {
		t.Fatalf("поставщик удалён (не должен): %v", err)
	}
	if !sup.CurrentDebt.Equal(decimal.Zero) {
		t.Errorf("supplier.current_debt = %s, want 0", decimal.Normalize(sup.CurrentDebt).String())
	}
	var acc models.FinancialAccount
	if err := gdb.First(&acc, "id = ?", accID).Error; err != nil {
		t.Fatalf("счёт удалён (не должен): %v", err)
	}
	if !acc.Balance.Equal(decimal.Zero) {
		t.Errorf("account.balance = %s, want 0 (деньги обнуляются — баг владельца)", decimal.Normalize(acc.Balance).String())
	}
	var menuCnt int64
	gdb.Model(&models.MenuItem{}).Where("id = ?", menuID).Count(&menuCnt)
	if menuCnt != 1 {
		t.Errorf("меню удалено (не должно): count=%d", menuCnt)
	}

	// ── Операций не осталось ──
	assertEmpty := func(name string, model any) {
		var c int64
		gdb.Model(model).Where("restaurant_id = ?", rid).Count(&c)
		if c != 0 {
			t.Errorf("%s: осталось %d записей, want 0", name, c)
		}
	}
	assertEmpty("stock_movements", &models.StockMovement{})
	assertEmpty("reservations", &models.Reservation{})
	assertEmpty("audit_log", &models.AuditLog{})
	assertEmpty("recurring_payments", &models.RecurringPayment{})
	assertEmpty("salary_advances", &models.SalaryAdvance{})
	assertEmpty("equity_entries", &models.EquityEntry{})
}
