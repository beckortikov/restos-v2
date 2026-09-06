//go:build integration

package service

import (
	"testing"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/db"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// TestRecurringMirror_PartialPaymentKeepsCycleOpen — центр платит регулярный
// платёж филиала (Фаза Р, applyMirrorSideEffect) частями.
//
// Раньше этот путь суммой не интересовался вовсе и двигал срок безусловно:
// первый же перевод «закрывал» месяц, недоплата терялась, строка снова
// показывала полную сумму на следующий цикл — тот же баг, что чинили в
// локальной оплате (v3.16.314), только на мирроринге. Сумма всё это время
// была доступна (op.Amount, соседняя ветка передаёт её в payReceiptDebt).
//
// Проверяем полный цикл и точный откат в LIFO-порядке.
func TestRecurringMirror_PartialPaymentKeepsCycleOpen(t *testing.T) {
	gdb, err := db.Open(syncOrdersTestDSN())
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	if err := db.MigrateUp(t.Context(), gdb); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})
	cleanDocsTables(t, gdb, "recurring_payments")

	restID := uuid.NewString()
	rpID := uuid.NewString()
	name := "Аренда"
	due := "2026-03-10"
	now := time.Date(2026, 3, 10, 12, 0, 0, 0, time.UTC)

	reload := func() models.RecurringPayment {
		t.Helper()
		var out models.RecurringPayment
		if err := gdb.Where("id = ?", rpID).First(&out).Error; err != nil {
			t.Fatalf("reload: %v", err)
		}
		return out
	}
	apply := func(rp *models.RecurringPayment, amount string) {
		t.Helper()
		if err := gdb.Transaction(func(tx *gorm.DB) error {
			return applyRecurringDuePayment(tx, rp, decimal.MustFromString(amount), now)
		}); err != nil {
			t.Fatalf("apply %s: %v", amount, err)
		}
	}
	reverse := func(rp *models.RecurringPayment, amount string) {
		t.Helper()
		if err := gdb.Transaction(func(tx *gorm.DB) error {
			return reverseRecurringDuePayment(tx, rp, decimal.MustFromString(amount), now)
		}); err != nil {
			t.Fatalf("reverse %s: %v", amount, err)
		}
	}

	rp := models.RecurringPayment{
		ID: rpID, Name: &name, RestaurantID: &restID, NextDue: &due,
		Amount: decimal.MustFromString("1000"), DayOfMonth: 10, Active: true,
	}
	if err := gdb.Create(&rp).Error; err != nil {
		t.Fatalf("create: %v", err)
	}

	// ── Частичный платёж 400 из 1000: цикл остаётся открытым ────────────────
	cur := reload()
	apply(&cur, "400")
	got := reload()
	if got.RemainingAmount == nil || !got.RemainingAmount.Equal(decimal.MustFromString("600")) {
		t.Errorf("remaining_amount после 400 = %v, want 600", got.RemainingAmount)
	}
	if got.NextDue == nil || *got.NextDue != due {
		t.Errorf("next_due после частичного платежа = %v, want %s (срок не должен двигаться)", got.NextDue, due)
	}
	if got.LastPaidAmount == nil || !got.LastPaidAmount.Equal(decimal.MustFromString("400")) {
		t.Errorf("last_paid_amount = %v, want 400", got.LastPaidAmount)
	}

	// ── Доплата 600: цикл закрывается, срок на месяц вперёд ─────────────────
	cur = reload()
	apply(&cur, "600")
	got = reload()
	if got.RemainingAmount != nil {
		t.Errorf("remaining_amount после закрытия = %v, want nil", got.RemainingAmount)
	}
	if got.NextDue == nil || *got.NextDue != "2026-04-10" {
		t.Errorf("next_due после закрытия = %v, want 2026-04-10", got.NextDue)
	}

	// ── Откат LIFO: сначала отменяем доплату 600 ────────────────────────────
	cur = reload()
	reverse(&cur, "600")
	got = reload()
	if got.NextDue == nil || *got.NextDue != due {
		t.Errorf("next_due после отката доплаты = %v, want %s", got.NextDue, due)
	}
	if got.RemainingAmount == nil || !got.RemainingAmount.Equal(decimal.MustFromString("600")) {
		t.Errorf("remaining_amount после отката доплаты = %v, want 600 (состояние после первого платежа)", got.RemainingAmount)
	}
	if got.LastPaidAt != nil || got.LastPaidAmount != nil {
		t.Errorf("last_paid_* не обнулены: %v / %v", got.LastPaidAt, got.LastPaidAmount)
	}

	// ── Затем отменяем первый платёж 400: цикл снова нетронут ───────────────
	cur = reload()
	reverse(&cur, "400")
	got = reload()
	if got.RemainingAmount != nil {
		t.Errorf("remaining_amount после полного отката = %v, want nil (цикл нетронут)", got.RemainingAmount)
	}
	if got.NextDue == nil || *got.NextDue != due {
		t.Errorf("next_due после полного отката = %v, want %s", got.NextDue, due)
	}
}

// TestRecurringMirror_FullPaymentAdvancesAsBefore — платёж, покрывающий цикл
// целиком, ведёт себя как раньше: срок вперёд, остаток пуст. Переплата
// (больше Amount) тоже закрывает цикл, а не оставляет отрицательный остаток.
func TestRecurringMirror_FullPaymentAdvancesAsBefore(t *testing.T) {
	gdb, err := db.Open(syncOrdersTestDSN())
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	if err := db.MigrateUp(t.Context(), gdb); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})
	cleanDocsTables(t, gdb, "recurring_payments")

	restID := uuid.NewString()
	name := "Коммуналка"
	due := "2026-05-01"
	now := time.Date(2026, 5, 1, 9, 0, 0, 0, time.UTC)

	for _, tc := range []struct{ label, amount string }{
		{"ровно сумма", "1000"},
		{"переплата", "1500"},
	} {
		rpID := uuid.NewString()
		d := due
		rp := models.RecurringPayment{
			ID: rpID, Name: &name, RestaurantID: &restID, NextDue: &d,
			Amount: decimal.MustFromString("1000"), DayOfMonth: 1, Active: true,
		}
		if err := gdb.Create(&rp).Error; err != nil {
			t.Fatalf("[%s] create: %v", tc.label, err)
		}
		if err := gdb.Transaction(func(tx *gorm.DB) error {
			return applyRecurringDuePayment(tx, &rp, decimal.MustFromString(tc.amount), now)
		}); err != nil {
			t.Fatalf("[%s] apply: %v", tc.label, err)
		}
		var got models.RecurringPayment
		if err := gdb.Where("id = ?", rpID).First(&got).Error; err != nil {
			t.Fatal(err)
		}
		if got.RemainingAmount != nil {
			t.Errorf("[%s] remaining_amount = %v, want nil", tc.label, got.RemainingAmount)
		}
		if got.NextDue == nil || *got.NextDue != "2026-06-01" {
			t.Errorf("[%s] next_due = %v, want 2026-06-01", tc.label, got.NextDue)
		}
	}
}
