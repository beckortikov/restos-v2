package service

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
	apperrors "github.com/restos/restos-v4/server/internal/pkg/errors"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
	"github.com/restos/restos-v4/server/internal/repo"
)

// ── Зарплата филиала из кассы центра (ADR-003, Фаза Р) ──────────────────────
//
// Владелец сети выдаёт зарплату сотрудникам филиалов сам, из своей кассы —
// филиал в выплате не участвует. Раньше это было невозможно провести честно:
// PaySalary работает строго в своём tenant, а провести её «за филиал» вручную
// значило бы разъехаться в отчётах и, главное, обойти зарплатный кап филиала
// (он ищет проводки в СВОЕЙ базе) — то есть открыть дорогу двойной выплате.
//
// Здесь выплата проводится ДВУМЯ проводками, см. миграцию 079:
//   • на центре — реальная, со списанием его счёта, помечена target_restaurant_id
//     (исключается из ОПиУ центра: затрата не его);
//   • зеркало филиала — без счёта и без движения баланса, помечено
//     paid_by_restaurant_id (исключается из ДДС филиала и сетевого ДДС: касса
//     филиала не пустела), но с той же категорией, source_ref и тегом периода —
//     благодаря чему кап филиала видит выплату и второй раз её не разрешит.
//
// Зеркало уезжает вниз обычным down-sync (PullFor + курсор mirror_since).

// PayBranchSalaryInput — body POST /api/v1/network/payroll/pay.
type PayBranchSalaryInput struct {
	BranchID  string  `json:"branch_id"`
	UserID    string  `json:"user_id"`
	Amount    string  `json:"amount"`
	AccountID string  `json:"account_id"` // счёт ЦЕНТРА, с которого платим
	Period    string  `json:"period"`     // YYYY-MM
	Kind      *string `json:"kind,omitempty"`
	// Override/OverrideReason — как в обычной PaySalary: превышение остатка не
	// глухая стена, а осознанный выбор с указанной причиной.
	Override       *bool   `json:"override,omitempty"`
	OverrideReason *string `json:"override_reason,omitempty"`
	Description    *string `json:"description,omitempty"`
}

// PayBranchSalary проводит выплату сотруднику филиала со счёта центра.
func (s *NetworkService) PayBranchSalary(ctx context.Context, in PayBranchSalaryInput) (*models.FinancialOperation, error) {
	me, account, err := s.requireCentralOwner(ctx)
	if err != nil {
		return nil, err
	}
	if err := requirePermFor(ctx, s.r, "payroll.manage"); err != nil {
		return nil, err
	}
	if in.BranchID == "" || in.UserID == "" || in.AccountID == "" {
		return nil, apperrors.Wrap("VALIDATION", "branch_id, user_id и account_id обязательны", nil)
	}
	if in.BranchID == me {
		return nil, apperrors.Wrap("VALIDATION", "для своих сотрудников используйте обычную выплату зарплаты", nil)
	}
	if in.Period == "" {
		return nil, apperrors.Wrap("VALIDATION", "period обязателен (YYYY-MM)", nil)
	}
	amount, err := decimal.FromString(in.Amount)
	if err != nil || !decimal.IsPositive(amount) {
		return nil, apperrors.Wrap("VALIDATION", "amount must be positive", err)
	}
	amount = decimal.Normalize(amount)

	// Филиал — в моей сети.
	var branch models.Restaurant
	if err := s.r.Raw().WithContext(ctx).Where("id = ?", in.BranchID).First(&branch).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apperrors.Wrap("VALIDATION", "филиал не найден", nil)
		}
		return nil, err
	}
	if branch.AccountID == nil || *branch.AccountID != account {
		return nil, apperrors.Wrap("VALIDATION", "филиал не входит в эту сеть", nil)
	}

	// Сотрудник — этого филиала. Учётки реплицированы (Ф1), поэтому проверка
	// выполняется на центре без обращения к филиалу.
	var user models.User
	if err := s.r.Raw().WithContext(ctx).
		Where("id = ? AND restaurant_id = ?", in.UserID, in.BranchID).First(&user).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apperrors.Wrap("VALIDATION", "сотрудник не найден в этом филиале", nil)
		}
		return nil, err
	}

	// ── Кап: считаем остаток к выплате ГЛАЗАМИ ФИЛИАЛА ──────────────────
	// Тот же salaryCapForPeriod, что и в обычной выплате, но с подменённым
	// tenant: все нужные ему таблицы (users, табель, salary_*, прошлые
	// проводки) реплицированы на центр, поэтому расчёт здесь даёт ровно тот
	// же ответ, что дал бы сам филиал. Иначе кап пришлось бы дублировать
	// второй реализацией — и две формулы разошлись бы при первой же правке.
	branchCtx := tenant.WithRestaurant(ctx, in.BranchID)
	salarySvc := NewSalaryService(s.r)
	isOverride := false
	desc := in.Description
	_, accrued, basis, paid, advance, deductions, err := salarySvc.salaryCapForPeriod(branchCtx, in.UserID, in.Period)
	if err != nil {
		return nil, err
	}
	if accrued.IsPositive() {
		payable := decimal.Sub(decimal.Sub(decimal.Sub(accrued, advance), deductions), paid)
		if decimal.IsNegative(payable) {
			payable = decimal.Zero
		}
		if decimal.Sub(amount, payable).GreaterThan(decimal.MustFromString("0.01")) {
			if in.Override == nil || !*in.Override {
				return nil, apperrors.Wrap("VALIDATION",
					fmt.Sprintf("сумма %s превышает остаток к выплате %s (%s − аванс %s − удержания %s − выплачено %s)",
						amount, payable, basis, advance, deductions, paid), nil)
			}
			reason := derefOr(in.OverrideReason, "")
			if reason == "" {
				return nil, apperrors.Wrap("VALIDATION", "укажите причину свободной выплаты", nil)
			}
			isOverride = true
			merged := mergeOverrideReason(in.Description, reason)
			desc = &merged
		}
	}

	category := salaryCategory(in.Kind)
	now := time.Now().UTC()
	// Учётная дата = период начисления, как в обычной выплате: зарплата за
	// июль обязана лечь в июль, даже если выдана в августе.
	date := now.Format("2006-01-02")
	if d := periodToOperationDate(in.Period, now); d != "" {
		date = d
	}
	// Тег периода — то, по чему кап филиала опознает выплату. Без него
	// зеркало для капа невидимо, и вся схема теряет смысл.
	tag := fmt.Sprintf("%s:%s", category, in.Period)
	if desc == nil || *desc == "" {
		desc = &tag
	} else if !containsStr(*desc, tag) {
		merged := *desc + " " + tag
		desc = &merged
	}

	outType, activity, isAuto := "out", "operational", false
	srcRef := in.UserID
	var created *models.FinancialOperation

	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)

		// Счёт центра — под замком, как во всех денежных путях.
		var acc models.FinancialAccount
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("restaurant_id = ? AND id = ?", me, in.AccountID).First(&acc).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return apperrors.Wrap("VALIDATION", "счёт не найден", nil)
			}
			return err
		}
		if !acc.IsEnabled {
			return apperrors.Wrap("CONFLICT", "счёт отключён", nil)
		}
		if decimal.IsNegative(decimal.Sub(acc.Balance, amount)) {
			return apperrors.Wrap("CONFLICT", "insufficient funds", nil)
		}
		if err := tx.Model(&acc).Updates(map[string]any{
			"balance":    decimal.Normalize(decimal.Sub(acc.Balance, amount)),
			"updated_at": now,
		}).Error; err != nil {
			return err
		}

		branchID, meID := in.BranchID, me
		counterparty := derefOr(user.Name, "")
		op := &models.FinancialOperation{
			ID: uuid.NewString(), Type: &outType, Amount: amount,
			Category: &category, AccountID: &acc.ID, AccountName: acc.Name,
			Activity: &activity, Date: &date, Description: desc,
			Counterparty: &counterparty, IsAuto: &isAuto, SourceRef: &srcRef,
			IsOverride: isOverride, RestaurantID: &meID,
			TargetRestaurantID: &branchID,
			CreatedAt:          now, UpdatedAt: now,
		}
		if err := tx.Create(op).Error; err != nil {
			return err
		}

		// Зеркальной строки НА ЦЕНТРЕ не создаём: id у платежа один, а
		// financial_operations.id — первичный ключ, вторая строка с ним просто
		// не вставится. Да она здесь и не нужна — собственные отчёты центра
		// скоуплены по нему самому, а сетевой ДДС считает проводку плательщика.
		// Зеркало живёт только у филиала: PullFor синтезирует его из этой же
		// строки при выдаче вниз (см. там же, «Зеркала расходов»).
		created = op
		return nil
	})
	if err != nil {
		return nil, err
	}
	return created, nil
}

func containsStr(s, sub string) bool {
	return len(sub) > 0 && len(s) >= len(sub) && indexOfStr(s, sub) >= 0
}

func indexOfStr(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
