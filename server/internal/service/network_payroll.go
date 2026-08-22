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

// ── Прочие расходы за филиал (Фаза Р: Р2/Р3/Р4) ─────────────────────────────

// BranchPayable — то, что филиалу предстоит заплатить и что центр может взять
// на себя: непогашенная накладная поставщика либо регулярный платёж.
// Единый тип на оба вида — экран у них один, а различает их Kind.
type BranchPayable struct {
	Kind         string          `json:"kind"` // receipt | recurring
	ID           string          `json:"id"`
	Title        string          `json:"title"`
	Counterparty *string         `json:"counterparty,omitempty"`
	Amount       decimal.Decimal `json:"amount"`
	DueDate      *string         `json:"due_date,omitempty"`
	Category     *string         `json:"category,omitempty"`
}

// BranchPayables — что филиал должен: долги по накладным + регулярные платежи.
// Обе таблицы реплицированы (Ф4/Ф5), поэтому список считается на центре без
// обращения к филиалу.
func (s *NetworkService) BranchPayables(ctx context.Context, branchID string) ([]BranchPayable, error) {
	_, account, err := s.requireCentralOwner(ctx)
	if err != nil {
		return nil, err
	}
	if err := requirePermFor(ctx, s.r, "finance.manage"); err != nil {
		return nil, err
	}
	var branch models.Restaurant
	if err := s.r.Raw().WithContext(ctx).Where("id = ?", branchID).First(&branch).Error; err != nil {
		return nil, apperrors.Wrap("VALIDATION", "филиал не найден", nil)
	}
	if branch.AccountID == nil || *branch.AccountID != account {
		return nil, apperrors.Wrap("VALIDATION", "филиал не входит в эту сеть", nil)
	}

	out := []BranchPayable{}

	var receipts []models.StockReceipt
	if err := s.r.Raw().WithContext(ctx).
		Where("restaurant_id = ? AND debt_amount > 0", branchID).
		Order("created_at ASC").Find(&receipts).Error; err != nil {
		return nil, err
	}
	for i := range receipts {
		r := receipts[i]
		// «Долг поставщику» без накладной (067, is_opening_debt) и обычная
		// приёмка выглядят по-разному, но платятся одинаково.
		title := "Приёмка"
		if r.IsOpeningDebt {
			title = "Долг поставщику"
		}
		if r.Date != nil && *r.Date != "" {
			title += " от " + *r.Date
		}
		out = append(out, BranchPayable{
			Kind: "receipt", ID: r.ID, Title: title,
			Counterparty: r.SupplierName, Amount: r.DebtAmount, DueDate: r.DueDate,
		})
	}

	var rps []models.RecurringPayment
	if err := s.r.Raw().WithContext(ctx).
		Where("restaurant_id = ?", branchID).Order("next_due ASC").Find(&rps).Error; err != nil {
		return nil, err
	}
	for i := range rps {
		rp := rps[i]
		if !rp.Active {
			continue
		}
		out = append(out, BranchPayable{
			Kind: "recurring", ID: rp.ID, Title: derefOr(rp.Name, "Регулярный платёж"),
			Counterparty: rp.Counterparty, Amount: rp.Amount,
			DueDate: rp.NextDue, Category: rp.Category,
		})
	}
	return out, nil
}

// PayBranchExpenseInput — body POST /api/v1/network/expenses/pay.
type PayBranchExpenseInput struct {
	BranchID    string  `json:"branch_id"`
	AccountID   string  `json:"account_id"` // счёт ЦЕНТРА
	Amount      string  `json:"amount"`
	Category    string  `json:"category"`
	Description *string `json:"description,omitempty"`
	// PayableKind/PayableID — необязательная привязка к документу филиала
	// (receipt | recurring). С ней филиал не просто увидит расход, но и
	// доведёт своё состояние: погасит долг накладной либо сдвинет срок
	// платежа (см. applyMirrorSideEffect).
	PayableKind string `json:"payable_kind,omitempty"`
	PayableID   string `json:"payable_id,omitempty"`
}

// PayBranchExpense — центр оплачивает расход филиала (Фаза Р, Р2/Р3/Р4).
//
// Тот же механизм двух проводок, что и у зарплаты: реальная у центра с
// target_restaurant_id, зеркальная у филиала с paid_by_restaurant_id. Разница
// одна — необязательная привязка к документу через source_ref, по которой
// филиал доводит долг накладной или срок регулярного платежа.
func (s *NetworkService) PayBranchExpense(ctx context.Context, in PayBranchExpenseInput) (*models.FinancialOperation, error) {
	me, account, err := s.requireCentralOwner(ctx)
	if err != nil {
		return nil, err
	}
	if err := requirePermFor(ctx, s.r, "finance.manage"); err != nil {
		return nil, err
	}
	if in.BranchID == "" || in.AccountID == "" {
		return nil, apperrors.Wrap("VALIDATION", "branch_id и account_id обязательны", nil)
	}
	if in.BranchID == me {
		return nil, apperrors.Wrap("VALIDATION", "для своих расходов используйте обычные операции", nil)
	}
	amount, err := decimal.FromString(in.Amount)
	if err != nil || !decimal.IsPositive(amount) {
		return nil, apperrors.Wrap("VALIDATION", "amount must be positive", err)
	}
	amount = decimal.Normalize(amount)

	var branch models.Restaurant
	if err := s.r.Raw().WithContext(ctx).Where("id = ?", in.BranchID).First(&branch).Error; err != nil {
		return nil, apperrors.Wrap("VALIDATION", "филиал не найден", nil)
	}
	if branch.AccountID == nil || *branch.AccountID != account {
		return nil, apperrors.Wrap("VALIDATION", "филиал не входит в эту сеть", nil)
	}

	category := in.Category
	var sourceRef *string
	counterparty := branch.Name

	// Привязка к документу: проверяем, что он действительно принадлежит этому
	// филиалу — иначе source_ref увёл бы доменный эффект в чужие данные.
	switch in.PayableKind {
	case "receipt":
		var r models.StockReceipt
		if err := s.r.Raw().WithContext(ctx).
			Where("id = ? AND restaurant_id = ?", in.PayableID, in.BranchID).First(&r).Error; err != nil {
			return nil, apperrors.Wrap("VALIDATION", "накладная не найдена у этого филиала", nil)
		}
		if !decimal.IsPositive(r.DebtAmount) {
			return nil, apperrors.Wrap("CONFLICT", "по этой накладной нет долга", nil)
		}
		if amount.GreaterThan(r.DebtAmount) {
			return nil, apperrors.Wrap("VALIDATION", "сумма больше долга по накладной", nil)
		}
		category = "supplier_payment"
		sourceRef = &r.ID
	case "recurring":
		var rp models.RecurringPayment
		if err := s.r.Raw().WithContext(ctx).
			Where("id = ? AND restaurant_id = ?", in.PayableID, in.BranchID).First(&rp).Error; err != nil {
			return nil, apperrors.Wrap("VALIDATION", "платёж не найден у этого филиала", nil)
		}
		if rp.Category != nil && *rp.Category != "" {
			category = *rp.Category
		}
		if rp.Counterparty != nil && *rp.Counterparty != "" {
			counterparty = *rp.Counterparty
		}
		sourceRef = &rp.ID
	case "":
		if category == "" {
			return nil, apperrors.Wrap("VALIDATION", "category обязательна", nil)
		}
	default:
		return nil, apperrors.Wrap("VALIDATION", "payable_kind must be receipt or recurring", nil)
	}

	now := time.Now().UTC()
	date := now.Format("2006-01-02")
	outType, activity, isAuto := "out", "operational", false
	branchID, meID := in.BranchID, me
	var created *models.FinancialOperation

	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)
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
		op := &models.FinancialOperation{
			ID: uuid.NewString(), Type: &outType, Amount: amount,
			Category: &category, AccountID: &acc.ID, AccountName: acc.Name,
			Activity: &activity, Date: &date, Description: in.Description,
			Counterparty: &counterparty, IsAuto: &isAuto, SourceRef: sourceRef,
			RestaurantID: &meID, TargetRestaurantID: &branchID,
			CreatedAt: now, UpdatedAt: now,
		}
		if err := tx.Create(op).Error; err != nil {
			return err
		}
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
