//go:build integration

package http_test

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// TestDeleteExpense_ClosedShift_AutoMirrorAllowed_RealExpenseBlocked —
// v3.16.164: фантомное __auto_mirror__, обнаруженное ПОСЛЕ закрытия смены
// (типичный случай — владелец заметил искажение на следующий день), теперь
// можно убрать. Обычный (не-авто) расход в закрытой смене по-прежнему
// защищён — иначе кассир мог бы задним числом переписывать уже утверждённый
// Z-отчёт.
func TestDeleteExpense_ClosedShift_AutoMirrorAllowed_RealExpenseBlocked(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, shiftID, accountID := seedForWrite(t, f)

	if err := gdb.Model(&models.CashShift{}).Where("id = ?", shiftID).
		Update("account_id", accountID).Error; err != nil {
		t.Fatal(err)
	}
	if err := gdb.Model(&models.FinancialAccount{}).Where("id = ?", accountID).
		Update("balance", decimal.MustFromString("5000")).Error; err != nil {
		t.Fatal(err)
	}

	// Фантомное зеркало (как оно реально выглядело до фикса v3.16.162).
	mirrorID := uuid.NewString()
	outType, mirrorCat, mirrorDesc := "cash_out", "__auto_mirror__", "шахди хучанд"
	now := time.Now().UTC()
	if err := gdb.Create(&models.CashShiftOperation{
		ID: mirrorID, ShiftID: &shiftID, Type: &outType, Amount: decimal.MustFromString("510"),
		Description: &mirrorDesc, Category: &mirrorCat, CreatedAt: now, UpdatedAt: now,
	}).Error; err != nil {
		t.Fatal(err)
	}

	// Обычный, легитимный расход из смены (санкционированный — через AddOperation
	// в реальности, здесь создаём напрямую для простоты — модель та же).
	realOpID := uuid.NewString()
	realCat, realDesc := "Ремонт и обслуживание", "сантехника"
	if err := gdb.Create(&models.CashShiftOperation{
		ID: realOpID, ShiftID: &shiftID, Type: &outType, Amount: decimal.MustFromString("30"),
		Description: &realDesc, Category: &realCat, CreatedAt: now, UpdatedAt: now,
	}).Error; err != nil {
		t.Fatal(err)
	}

	// ─── Закрываем смену ──────────────────────────────────────────────────────
	r, b := f.post(t, "/api/v1/shifts/"+shiftID+"/close", tok, uuid.NewString(), map[string]any{
		"closing_balance": "5000",
	})
	if r.StatusCode != http.StatusOK {
		t.Fatalf("close shift: %d %s", r.StatusCode, b)
	}
	var closedShift struct {
		ExpectedCash string `json:"expected_cash"`
	}
	if err := json.Unmarshal(b, &closedShift); err != nil {
		t.Fatal(err)
	}
	expectedBeforeCleanup := decimal.MustFromString(closedShift.ExpectedCash)
	// opening(0) + cash_revenue(0) − 510 − 30 = −540.
	if !expectedBeforeCleanup.Equal(decimal.MustFromString("-540")) {
		t.Fatalf("expected_cash сразу после close = %s, want -540 (санити-чек сетапа)", expectedBeforeCleanup.String())
	}

	// ─── Обычный расход в ЗАКРЫТОЙ смене — по-прежнему запрещён ──────────────
	r, b = f.del(t, "/api/v1/shifts/"+shiftID+"/expenses/"+realOpID, tok, uuid.NewString())
	if r.StatusCode == http.StatusOK || r.StatusCode == http.StatusNoContent {
		t.Fatalf("удаление ОБЫЧНОГО расхода из закрытой смены прошло (%d) — дыра для переписывания Z-отчёта задним числом: %s", r.StatusCode, b)
	}

	// ─── Фантомное зеркало из ЗАКРЫТОЙ смены — теперь можно убрать ──────────
	r, b = f.del(t, "/api/v1/shifts/"+shiftID+"/expenses/"+mirrorID, tok, uuid.NewString())
	if r.StatusCode != http.StatusOK && r.StatusCode != http.StatusNoContent {
		t.Fatalf("DELETE auto_mirror из закрытой смены: %d %s", r.StatusCode, b)
	}

	var stillExists int64
	gdb.Model(&models.CashShiftOperation{}).Where("id = ?", mirrorID).Count(&stillExists)
	if stillExists != 0 {
		t.Errorf("зеркало %s не удалено из закрытой смены", mirrorID)
	}

	// Баланс счёта не тронут (деньги реально потрачены по исходной ДДС-операции).
	var acc models.FinancialAccount
	gdb.First(&acc, "id = ?", accountID)
	if !acc.Balance.Equal(decimal.MustFromString("5000")) {
		t.Errorf("баланс счёта изменился: %s, want 5000", decimal.Normalize(acc.Balance).String())
	}

	// expected_cash ПЕРЕСЧИТАН и сохранён: −540 + 510 = −30 (осталась только
	// реальная «сантехника»). Если бы не пересчитали — Z-отчёт продолжал бы
	// показывать -540, разойдясь со списком операций.
	var shiftAfter models.CashShift
	gdb.First(&shiftAfter, "id = ?", shiftID)
	if shiftAfter.ExpectedCash == nil || !shiftAfter.ExpectedCash.Equal(decimal.MustFromString("-30")) {
		got := "nil"
		if shiftAfter.ExpectedCash != nil {
			got = decimal.Normalize(*shiftAfter.ExpectedCash).String()
		}
		t.Errorf("expected_cash после удаления зеркала = %s, want -30 (список операций и зафиксированная цифра разошлись)", got)
	}
}
