package service

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"github.com/restos/restos-v4/server/internal/audit"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
	apperrors "github.com/restos/restos-v4/server/internal/pkg/errors"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
	"github.com/restos/restos-v4/server/internal/repo"
	"github.com/restos/restos-v4/server/internal/synclog"
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
			CreatedBy:          actorIDPtr(ctx),
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
	// Описание по умолчанию — название документа. Без него и в ленте центра, и
	// в ОПиУ филиала строка подписана одной лишь статьёй («Аренда»), и через
	// месяц уже не понять, за что именно платили.
	desc := in.Description

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
		if desc == nil || *desc == "" {
			d := "Оплата накладной"
			if r.SupplierName != nil && *r.SupplierName != "" {
				d += " · " + *r.SupplierName
			}
			if r.Date != nil && *r.Date != "" {
				d += " от " + *r.Date
			}
			desc = &d
		}
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
		if (desc == nil || *desc == "") && rp.Name != nil && *rp.Name != "" {
			desc = rp.Name
		}
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
			Activity: &activity, Date: &date, Description: desc,
			Counterparty: &counterparty, IsAuto: &isAuto, SourceRef: sourceRef,
			RestaurantID: &meID, TargetRestaurantID: &branchID,
			CreatedBy: actorIDPtr(ctx), CreatedAt: now, UpdatedAt: now,
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

// ── Списание со счёта филиала по запросу центра (Ф-Ц) ──────────────────────
//
// Владелец сети 2026-08-25: у филиала может не быть своего управляющего —
// всё управляется из центра, а забрать деньги с кассы филиала до сих пор было
// нечем (обычный «Перевести» — только вниз, а «Переводы в сети» требуют,
// чтобы КТО-ТО на филиале нажал «Отправить»). Центр физически не может
// списать чужой счёт напрямую: у него лежит РЕПЛИКА financial_accounts
// филиала (питается его же push-up синком), прямая правка была бы фантомной
// — филиал её не увидит, а на следующем своём чек-ине перезапишет обратно
// (и хуже: центр успел бы зачислить себе настоящие деньги из ниоткуда).
//
// Поэтому центр не списывает сам, а создаёт ЗАПРОС — money_transfer в статусе
// requested, без всякого движения по счетам. Документ едет вниз филиалу тем
// же PullFor, что и остальное (см. sync_ingest.go), и на филиале САМ СЕБЯ
// применяет при получении (applyRequestedTransfer) — без единого клика
// человека: авторизация уже произошла здесь, на центре, у владельца сети.
// Как только applyRequestedTransfer спишет счёт, статус requested→sent
// синкается обратно, и центр принимает его Receive() — точно тем же путём,
// что и обычный перевод, отправленный вручную филиалом.

// RequestMoneyTransferInput — body POST /api/v1/network/branches/{id}/request-transfer.
type RequestMoneyTransferInput struct {
	BranchID      string  `json:"branch_id"`
	FromAccountID string  `json:"from_account_id"`
	Amount        string  `json:"amount"`
	Note          *string `json:"note,omitempty"`
	// ToAccountID — СВОЙ (central) счёт-назначение, если известен заранее
	// (владелец, 2026-08-28: «мы заранее знаем куда перевести деньги...
	// отдельно списать не надо будет потом»). В отличие от Create()'овского
	// SuggestedToAccountID (для ДРУГОЙ стороны, только подсказка, приём всё
	// равно ручной) — здесь central сам себе и запросчик, и получатель,
	// поэтому счёт применяется АВТОМАТИЧЕСКИ, без отдельного «Принять»: см.
	// applyAutoReceiveTransfer в sync_ingest.go, срабатывает когда запрошенное
	// списание долетает обратно статусом sent. Пусто → как раньше, обычное
	// ручное «Принять» в «Переводах в сети».
	ToAccountID *string `json:"to_account_id,omitempty"`
}

// RequestMoneyTransfer заводит запрос на списание со счёта филиала. Ничего не
// списывает и не зачисляет — только документ; реальное движение денег
// произойдёт на филиале, см. applyRequestedTransfer.
func (s *NetworkService) RequestMoneyTransfer(ctx context.Context, in RequestMoneyTransferInput) (*models.MoneyTransfer, error) {
	me, account, err := s.requireCentralOwner(ctx)
	if err != nil {
		return nil, err
	}
	if err := requirePermFor(ctx, s.r, "finance.manage"); err != nil {
		return nil, err
	}
	if in.BranchID == "" || in.FromAccountID == "" {
		return nil, apperrors.Wrap("VALIDATION", "branch_id и from_account_id обязательны", nil)
	}
	if in.BranchID == me {
		return nil, apperrors.Wrap("VALIDATION", "нельзя запросить перевод у самого себя", nil)
	}
	amount, err := decimal.FromString(in.Amount)
	if err != nil || !decimal.IsPositive(amount) {
		return nil, apperrors.Wrap("VALIDATION", "amount must be positive", err)
	}
	amount = decimal.Normalize(amount)

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
	// Счёт обязан реально принадлежать филиалу — иначе applyRequestedTransfer
	// на его стороне просто не найдёт что списывать (гвард дублируется там же,
	// на пришедшем payload, эта проверка — только чтобы не заводить заведомо
	// нерабочий запрос).
	var acc models.FinancialAccount
	if err := s.r.Raw().WithContext(ctx).
		Where("id = ? AND restaurant_id = ?", in.FromAccountID, in.BranchID).
		First(&acc).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apperrors.Wrap("VALIDATION", "счёт не найден у этого филиала", nil)
		}
		return nil, err
	}

	// ToAccountID — СВОЙ счёт central, обязан реально принадлежать ЕМУ (me),
	// не филиалу: иначе applyAutoReceiveTransfer на возврате sent найдёт чужой
	// счёт и либо не сработает (др. restaurant_id), либо, того хуже, спутает
	// узлы, если бы id случайно совпал (uuid — не совпадёт, но проверка дешёвая).
	if in.ToAccountID != nil && *in.ToAccountID != "" {
		var toAcc models.FinancialAccount
		if err := s.r.Raw().WithContext(ctx).
			Where("id = ? AND restaurant_id = ?", *in.ToAccountID, me).
			First(&toAcc).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return nil, apperrors.Wrap("VALIDATION", "счёт-назначение не найден у central", nil)
			}
			return nil, err
		}
		if !toAcc.IsEnabled {
			return nil, apperrors.Wrap("VALIDATION", "счёт-назначение отключён", nil)
		}
	} else {
		in.ToAccountID = nil
	}

	actor, _ := audit.ActorFromContext(ctx)
	now := time.Now().UTC()
	transferID := uuid.NewString()
	branchID := in.BranchID
	var created *models.MoneyTransfer
	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)
		var cnt int64
		tx.Model(&models.MoneyTransfer{}).Where("account_id = ?", account).Count(&cnt)
		num := int(cnt) + 1

		t := &models.MoneyTransfer{
			ID:                   transferID,
			AccountID:            &account,
			FromRestaurantID:     &branchID,
			ToRestaurantID:       &me,
			TransferNumber:       &num,
			Amount:               amount,
			Status:               moneyTransferStatusRequested,
			Note:                 in.Note,
			FromAccountID:        &acc.ID,
			FromAccountName:      acc.Name,
			SuggestedToAccountID: in.ToAccountID,
			CreatedBy:            &actor.UserID,
			CreatedAt:            now,
			UpdatedAt:            now,
		}
		if err := tx.Create(t).Error; err != nil {
			return err
		}
		if err := synclog.Record(tx, synclog.Entry{
			Entity: "money_transfers", RowID: transferID, Op: "insert",
			RestaurantID: &me, AccountID: &account, Payload: t,
		}); err != nil {
			return err
		}
		created = t
		return nil
	})
	if err != nil {
		return nil, err
	}
	return created, nil
}

// CancelRequestedTransfer отменяет ещё НЕ применённый филиалом запрос на
// списание (Ф-Ц, status=requested) — например, случайно продублированный
// (тот же счёт и сумма отправлены дважды). Деньги при requested ещё нигде не
// двигались: спишутся САМИ на филиале только когда документ дойдёт туда
// down-sync'ом (applyRequestedTransfer) — до этого момента отмена ничего не
// возвращает и не компенсирует, просто помечает документ cancelled. PullFor
// отбирает money_transfers строго по status=requested (sync_ingest.go) —
// отменённый документ перестаёт туда попадать и филиал его больше не увидит.
// Если он уже успел уйти в sent/received (деньги реально тронулись) —
// отменять поздно: явная ошибка вместо тихого искажения истории.
func (s *NetworkService) CancelRequestedTransfer(ctx context.Context, transferID string) (*models.MoneyTransfer, error) {
	me, _, err := s.requireCentralOwner(ctx)
	if err != nil {
		return nil, err
	}
	if err := requirePermFor(ctx, s.r, "finance.manage"); err != nil {
		return nil, err
	}

	var t models.MoneyTransfer
	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("id = ? AND to_restaurant_id = ?", transferID, me).First(&t).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return apperrors.ErrNotFound
			}
			return err
		}
		if t.Status != moneyTransferStatusRequested {
			return apperrors.Wrap("CONFLICT", "заявка уже не «ждёт синхронизации» — деньги, вероятно, уже в движении, отменить нельзя", nil)
		}
		now := time.Now().UTC()
		t.Status = "cancelled"
		t.UpdatedAt = now
		return tx.Model(&models.MoneyTransfer{}).Where("id = ?", transferID).
			Updates(map[string]any{"status": "cancelled", "updated_at": now}).Error
	})
	if err != nil {
		return nil, err
	}
	return &t, nil
}

// CancelBranchExpense — отмена расхода/выплаты, проведённой центром за филиал
// (Фаза Р). Бухгалтер сидит в центре, ошибки и правки там — обычное дело, а
// без распространения отмены данные молча расходятся: деньги вернулись бы на
// счёт центра, а у филиала остались бы и проводка в ОПиУ, и погашенный долг.
//
// На ЦЕНТРЕ — как в обычной отмене выплаты (SalaryService.CancelSalary):
// деньги обратно на счёт, компенсирующий приход (ДДС остаётся сбалансированным)
// и пометка cancelled_at на исходной проводке.
//
// На ФИЛИАЛЕ зеркало помечается тем же cancelled_at — не удаляется. Строка
// нужна там как курсор: филиал тянет зеркала окном по updated_at, и снеси мы
// её, отметке «отменено» негде было бы храниться, а центр слал бы отмену на
// каждом тике вечно. Заодно у филиала отменённый расход виден, а не исчезает
// молча. Откат долга накладной и срока регулярного платежа делает приём на
// стороне филиала (reverseMirrorSideEffect), ровно один раз.
func (s *NetworkService) CancelBranchExpense(ctx context.Context, opID string) (*models.FinancialOperation, error) {
	me, _, err := s.requireCentralOwner(ctx)
	if err != nil {
		return nil, err
	}
	if err := requirePermFor(ctx, s.r, "finance.manage"); err != nil {
		return nil, err
	}
	actor, _ := audit.ActorFromContext(ctx)
	cancelledBy := actor.UserID

	var op models.FinancialOperation
	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("restaurant_id = ? AND id = ?", me, opID).First(&op).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return apperrors.Wrap("NOT_FOUND", "операция не найдена", nil)
			}
			return err
		}
		if op.TargetRestaurantID == nil || *op.TargetRestaurantID == "" {
			return apperrors.Wrap("VALIDATION", "это не расход за филиал — отменяйте обычным способом", nil)
		}
		if op.CancelledAt != nil {
			return apperrors.Wrap("VALIDATION", "расход уже отменён", nil)
		}
		now := time.Now().UTC()

		if op.AccountID != nil && *op.AccountID != "" {
			var acc models.FinancialAccount
			if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
				Where("restaurant_id = ? AND id = ?", me, *op.AccountID).First(&acc).Error; err != nil {
				if errors.Is(err, gorm.ErrRecordNotFound) {
					return apperrors.Wrap("VALIDATION", "счёт выплаты не найден", nil)
				}
				return err
			}
			if err := tx.Model(&acc).Updates(map[string]any{
				"balance":    decimal.Normalize(decimal.Add(acc.Balance, op.Amount)),
				"updated_at": now,
			}).Error; err != nil {
				return err
			}
		}

		// Компенсирующий приход — чтобы ДДС центра сошёлся. Activity берём ТУ
		// ЖЕ, что у отменяемого расхода: ДДС группирует по ней, и приход в
		// чужой корзине не погасил бы отток, а нарисовал бы центру и лишний
		// расход, и лишний доход. SourceRef НЕ копируем: он адресует документ
		// филиала и на компенсации выглядел бы как ещё одно к нему обращение.
		inType, isAuto := "in", false
		activity := "operational"
		if op.Activity != nil && *op.Activity != "" {
			activity = *op.Activity
		}
		desc := "Отмена расхода за филиал"
		meID := me
		reverse := models.FinancialOperation{
			ID: uuid.NewString(), Type: &inType, Amount: op.Amount,
			Category: op.Category, AccountID: op.AccountID, AccountName: op.AccountName,
			Activity: &activity, Date: op.Date, Description: &desc,
			Counterparty: op.Counterparty, IsAuto: &isAuto, RestaurantID: &meID,
			CreatedBy: actorIDPtr(ctx), CreatedAt: now, UpdatedAt: now,
		}
		if err := tx.Create(&reverse).Error; err != nil {
			return err
		}

		op.CancelledAt = &now
		op.CancelledBy = &cancelledBy
		return tx.Model(&models.FinancialOperation{}).Where("id = ?", opID).
			Updates(map[string]any{"cancelled_at": now, "cancelled_by": cancelledBy, "updated_at": now}).Error
	})
	if err != nil {
		return nil, err
	}
	return &op, nil
}

// BranchExpense — проведённый центром расход за филиал (для списка с отменой).
type BranchExpense struct {
	ID           string          `json:"id"`
	Date         *string         `json:"date"`
	Category     *string         `json:"category"`
	Counterparty *string         `json:"counterparty"`
	Description  *string         `json:"description"`
	Amount       decimal.Decimal `json:"amount"`
	AccountName  *string         `json:"account_name"`
	CancelledAt  *time.Time      `json:"cancelled_at"`
}

// BranchExpenses — что центр уже оплатил за этот филиал, новые сверху.
// Отменённые тоже показываем: иначе отменённая по ошибке проводка исчезала бы
// бесследно и владелец не понимал бы, куда делись деньги.
func (s *NetworkService) BranchExpenses(ctx context.Context, branchID string, limit int) ([]BranchExpense, error) {
	me, _, err := s.requireCentralOwner(ctx)
	if err != nil {
		return nil, err
	}
	if err := requirePermFor(ctx, s.r, "finance.manage"); err != nil {
		return nil, err
	}
	if limit <= 0 || limit > 100 {
		limit = 30
	}
	var rows []models.FinancialOperation
	if err := s.r.Raw().WithContext(ctx).
		Where("restaurant_id = ? AND target_restaurant_id = ?", me, branchID).
		Order("created_at DESC").Limit(limit).Find(&rows).Error; err != nil {
		return nil, err
	}
	out := make([]BranchExpense, 0, len(rows))
	for i := range rows {
		r := rows[i]
		out = append(out, BranchExpense{
			ID: r.ID, Date: r.Date, Category: r.Category, Counterparty: r.Counterparty,
			Description: r.Description, Amount: r.Amount, AccountName: r.AccountName,
			CancelledAt: r.CancelledAt,
		})
	}
	return out, nil
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
