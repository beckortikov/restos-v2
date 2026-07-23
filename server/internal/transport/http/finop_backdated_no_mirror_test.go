//go:build integration

package http_test

import (
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// TestFinop_Backdated_DoesNotMirrorIntoOpenShift — ручная финоперация (ДДС
// «Добавить операцию»), заведённая ЗАДНИМ ЧИСЛОМ на кассовый счёт, НЕ должна
// зеркалиться в expected_cash ТЕКУЩЕЙ открытой смены (иначе фантомная
// недостача/излишек в сегодняшнем Z-отчёте — забыли внести расход за вчера,
// внесли сегодня с датой "вчера", а оно тихо подвинуло сегодняшнюю кассу).
// Инцидент 23.07.2026. Операция с сегодняшней датой (или без даты — дефолт)
// по-прежнему обязана зеркалиться, иначе баг просто переехал в другую сторону.
func TestFinop_Backdated_DoesNotMirrorIntoOpenShift(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, shiftID, accountID := seedForWrite(t, f)

	// Привязываем смену к кассовому счёту — иначе зеркало не создаётся вообще
	// (recordShiftCashOutIfActive ищет открытую смену по account_id).
	if err := gdb.Model(&models.CashShift{}).Where("id = ?", shiftID).
		Update("account_id", accountID).Error; err != nil {
		t.Fatal(err)
	}
	// Баланс с запасом — операции списывают деньги со счёта.
	if err := gdb.Model(&models.FinancialAccount{}).Where("id = ?", accountID).
		Update("balance", decimal.MustFromString("10000")).Error; err != nil {
		t.Fatal(err)
	}

	yesterday := time.Now().UTC().AddDate(0, 0, -1).Format("2006-01-02")
	today := time.Now().UTC().Format("2006-01-02")

	// ─── Задним числом (вчера) — зеркала в СЕГОДНЯШНЕЙ смене быть не должно ───
	r, b := f.post(t, "/api/v1/finance/operations", tok, uuid.NewString(), map[string]any{
		"type": "out", "amount": "165", "category": "Закупка продуктов",
		"account_id": accountID, "date": yesterday, "description": "Шашлик",
	})
	if r.StatusCode != http.StatusCreated && r.StatusCode != http.StatusOK {
		t.Fatalf("create backdated op: %d %s", r.StatusCode, b)
	}
	var mirrors int64
	if err := gdb.Model(&models.CashShiftOperation{}).
		Where("shift_id = ? AND category = ? AND amount = ?", shiftID, "__auto_mirror__", decimal.MustFromString("165")).
		Count(&mirrors).Error; err != nil {
		t.Fatal(err)
	}
	if mirrors != 0 {
		t.Errorf("backdated (вчера) операция создала %d зеркал в текущей открытой смене, want 0 — expected_cash сегодняшней смены не должен двигаться чужой датой", mirrors)
	}

	// ─── Сегодняшней датой — зеркало ОБЯЗАНО создаться (regression guard) ─────
	r, b = f.post(t, "/api/v1/finance/operations", tok, uuid.NewString(), map[string]any{
		"type": "out", "amount": "200", "category": "Закупка продуктов",
		"account_id": accountID, "date": today, "description": "Лаваш",
	})
	if r.StatusCode != http.StatusCreated && r.StatusCode != http.StatusOK {
		t.Fatalf("create today op: %d %s", r.StatusCode, b)
	}
	var todayMirrors int64
	if err := gdb.Model(&models.CashShiftOperation{}).
		Where("shift_id = ? AND category = ? AND amount = ?", shiftID, "__auto_mirror__", decimal.MustFromString("200")).
		Count(&todayMirrors).Error; err != nil {
		t.Fatal(err)
	}
	if todayMirrors != 1 {
		t.Errorf("сегодняшняя операция создала %d зеркал, want 1 — иначе expected_cash разойдётся с реальным оттоком денег со счёта", todayMirrors)
	}
}
