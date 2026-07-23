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

// TestDeleteOperation_RemovesPhantomAutoMirror_WithoutTouchingAccountBalance —
// эмпирическая проверка штатного способа убрать УЖЕ СОЗДАННОЕ (до фикса
// v3.16.162) фантомное зеркало __auto_mirror__ из ТЕКУЩЕЙ открытой смены:
// DELETE /api/v1/cash-shift-operations/{id} — ЭТО и есть реальный путь,
// которым пользуется фронт (кнопка «Удалить расход», см.
// lib/queries/shifts.ts deleteShiftExpense). Отдельный DeleteExpense
// (/shifts/{id}/expenses/{op_id}) существует в бэке, но фронтом НЕ
// вызывается — v3.16.164 по ошибке чинил только его, кнопка на реальной
// кассе продолжала падать «нельзя удалить авто-операцию смены». Тест
// нацелен на реально используемый эндпоинт.
//
// Ожидание: запись удаляется из cash_shift_operations БЕЗ ошибки и БЕЗ
// восстановления баланса счёта (деньги по исходной ДДС-операции реально
// потрачены — счёт трогать нельзя, иначе баланс задвоится). Эффект — только
// снятие искажения с expected_cash ЭТОЙ смены.
func TestDeleteOperation_RemovesPhantomAutoMirror_WithoutTouchingAccountBalance(t *testing.T) {
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

	// Эмулируем фантомное зеркало, каким оно было ДО фикса (создано напрямую,
	// как старый код это делал — вручную вставляем cash_shift_operation, минуя
	// recordShiftCashOutIfActive). Описание/сумма — как на скриншоте инцидента.
	mirrorID := uuid.NewString()
	outType, cat, desc := "cash_out", "__auto_mirror__", "шахди хучанд"
	now := time.Now().UTC()
	if err := gdb.Create(&models.CashShiftOperation{
		ID: mirrorID, ShiftID: &shiftID, Type: &outType, Amount: decimal.MustFromString("510"),
		Description: &desc, Category: &cat, CreatedAt: now, UpdatedAt: now,
	}).Error; err != nil {
		t.Fatal(err)
	}

	balanceBefore := decimal.MustFromString("5000")

	// ─── Удаляем фантомное зеркало через РЕАЛЬНЫЙ путь кнопки ────────────────
	r, b := f.del(t, "/api/v1/cash-shift-operations/"+mirrorID, tok, uuid.NewString())
	if r.StatusCode != http.StatusOK && r.StatusCode != http.StatusNoContent {
		t.Fatalf("DELETE cash-shift-operations (auto_mirror): %d %s — кнопка «Удалить расход» упадёт с ошибкой на реальной кассе", r.StatusCode, b)
	}

	// Запись реально удалена.
	var stillExists int64
	if err := gdb.Model(&models.CashShiftOperation{}).Where("id = ?", mirrorID).Count(&stillExists).Error; err != nil {
		t.Fatal(err)
	}
	if stillExists != 0 {
		t.Errorf("cash_shift_operation %s всё ещё существует после DELETE", mirrorID)
	}

	// Баланс счёта НЕ восстановлен (деньги по исходной ДДС-операции реально
	// потрачены — если бы баланс вернулся, получилось бы задвоение денег).
	var acc models.FinancialAccount
	gdb.First(&acc, "id = ?", accountID)
	if !acc.Balance.Equal(balanceBefore) {
		t.Errorf("баланс счёта изменился при удалении auto_mirror: было %s, стало %s — деньги задвоились/пропали",
			balanceBefore.String(), decimal.Normalize(acc.Balance).String())
	}
}
