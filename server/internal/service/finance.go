// finance — Phase 12 backend gap C: финансовые счета, операции, кастомные категории,
// JSON-отчёты (P&L, cashflow, balance, monthly revenue), выплаты ЗП и сервиса.
//
// Все мутации со связанными таблицами идут через repo.Transaction. Все запросы
// — через ForTenant(ctx). Decimal-поля принимаем как *string в DTO.
package service

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"github.com/restos/restos-v4/server/internal/audit"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/cursor"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
	apperrors "github.com/restos/restos-v4/server/internal/pkg/errors"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
	"github.com/restos/restos-v4/server/internal/pkg/timeutil"
	"github.com/restos/restos-v4/server/internal/repo"
)

// ═══════════════════════════════════════════════════════════════════════════
// FinancialAccount CRUD + transfer
// ═══════════════════════════════════════════════════════════════════════════

type FinancialAccountsService struct {
	r   *repo.Repo
	pub *EventPublisher
}

func NewFinancialAccountsService(r *repo.Repo) *FinancialAccountsService {
	return &FinancialAccountsService{r: r}
}

// WithPublisher (как в других сервисах).
func (s *FinancialAccountsService) WithPublisher(pub *EventPublisher) *FinancialAccountsService {
	s.pub = pub
	return s
}

type FinancialAccountInput struct {
	Name    *string `json:"name,omitempty"`
	Type    *string `json:"type,omitempty"`
	Balance *string `json:"balance,omitempty"`
}

type AccountTransferInput struct {
	FromID      *string `json:"from_id,omitempty"`
	ToID        *string `json:"to_id,omitempty"`
	Amount      *string `json:"amount,omitempty"`
	Description *string `json:"description,omitempty"`
}

type AccountTransferResult struct {
	From models.FinancialOperation `json:"from"`
	To   models.FinancialOperation `json:"to"`
}

func (s *FinancialAccountsService) List(ctx context.Context) ([]models.FinancialAccount, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	var rows []models.FinancialAccount
	if err := scoped.Order("name ASC").Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}

func (s *FinancialAccountsService) Create(ctx context.Context, in FinancialAccountInput) (*models.FinancialAccount, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	if in.Name == nil || *in.Name == "" {
		return nil, apperrors.Wrap("VALIDATION", "name is required", nil)
	}
	now := time.Now().UTC()
	a := &models.FinancialAccount{
		ID: uuid.NewString(), Name: in.Name, Type: in.Type,
		RestaurantID: &rid, IsEnabled: true, CreatedAt: now, UpdatedAt: now,
	}
	initial := decimal.Zero
	if in.Balance != nil {
		d, err := decimal.FromString(*in.Balance)
		if err != nil {
			return nil, apperrors.Wrap("VALIDATION", "bad balance", err)
		}
		if decimal.IsNegative(d) {
			return nil, apperrors.Wrap("VALIDATION", "начальный баланс не может быть отрицательным", nil)
		}
		initial = d
	}
	// #8: начальный остаток счёта — не «деньги из ниоткуда». Встречная запись —
	// «Взнос собственника» (equity_entries), ровно как у начального остатка
	// склада. Так актив (баланс счёта) уравновешен капиталом, Баланс сходится, и
	// это НЕ финоперация — не засоряет ДДС/список операций/ОПиУ.
	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)
		a.Balance = initial
		if err := tx.Create(a).Error; err != nil {
			return err
		}
		if decimal.IsPositive(initial) {
			name := "Взнос собственника — начальный остаток счёта"
			cat := "opening_account"
			ridStr := rid
			if err := tx.Create(&models.EquityEntry{
				ID: uuid.NewString(), Name: &name, Category: &cat, Amount: initial,
				RestaurantID: &ridStr, CreatedAt: now, UpdatedAt: now,
			}).Error; err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return a, nil
}

func (s *FinancialAccountsService) Patch(ctx context.Context, id string, in FinancialAccountInput) (*models.FinancialAccount, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	var existing models.FinancialAccount
	if err := scoped.Where("id = ?", id).First(&existing).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apperrors.ErrNotFound
		}
		return nil, err
	}
	updates := map[string]any{"updated_at": time.Now().UTC()}
	if in.Name != nil {
		updates["name"] = *in.Name
	}
	if in.Type != nil {
		updates["type"] = *in.Type
	}
	// #8: прямая перезапись баланса запрещена — это мимо всякого аудита сумм.
	// Баланс меняется только проводкой (ручная операция / корректировка). Правку
	// имени/типа при этом не блокируем.
	if in.Balance != nil {
		d, err := decimal.FromString(*in.Balance)
		if err != nil {
			return nil, apperrors.Wrap("VALIDATION", "bad balance", err)
		}
		if !d.Equal(existing.Balance) {
			return nil, apperrors.Wrap("VALIDATION", "баланс счёта нельзя изменить напрямую — оформите финансовую операцию", nil)
		}
	}
	scoped2, _ := s.r.ForTenant(ctx)
	if err := scoped2.Model(&existing).Updates(updates).Error; err != nil {
		return nil, err
	}
	scoped3, _ := s.r.ForTenant(ctx)
	var out models.FinancialAccount
	if err := scoped3.Where("id = ?", id).First(&out).Error; err != nil {
		return nil, err
	}
	return &out, nil
}

// SetEnabled — включить/отключить счёт. Отключение заменяет удаление: строка
// остаётся, вся история и остаток целы, но счёт перестаёт предлагаться при
// оплате, и MustBeEnabled ниже не даёт провести на него деньги.
//
// Баланс НЕ проверяем осознанно: это не удаление, деньги никуда не деваются и
// продолжают считаться в Балансе. Владельцу не нужно сначала обнулять счёт.
//
// Гварды — только там, где отключение реально ломает работу кассы.
func (s *FinancialAccountsService) SetEnabled(ctx context.Context, id string, enabled bool) (*models.FinancialAccount, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	var existing models.FinancialAccount
	if err := scoped.Where("id = ?", id).First(&existing).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apperrors.ErrNotFound
		}
		return nil, err
	}
	if existing.IsEnabled == enabled {
		return &existing, nil // идемпотентно
	}

	if !enabled {
		if err := s.checkCanDisable(ctx, existing); err != nil {
			return nil, err
		}
	}

	now := time.Now().UTC()
	updates := map[string]any{"is_enabled": enabled, "updated_at": now}
	if enabled {
		updates["disabled_at"] = nil
	} else {
		updates["disabled_at"] = now
	}
	scopedUpd, _ := s.r.ForTenant(ctx)
	if err := scopedUpd.Model(&models.FinancialAccount{}).Where("id = ?", id).Updates(updates).Error; err != nil {
		return nil, err
	}
	scopedOut, _ := s.r.ForTenant(ctx)
	var out models.FinancialAccount
	if err := scopedOut.Where("id = ?", id).First(&out).Error; err != nil {
		return nil, err
	}
	// Публикуем ПОСЛЕ успешного обновления — открытые POS-терминалы
	// перезапрашивают список счетов и перестают предлагать отключённый.
	if s.pub != nil {
		rid, err := tenant.MustRestaurantID(ctx)
		if err == nil {
			buf := NewBuffer()
			buf.Add(EventFinanceAccountUpdated, map[string]any{
				"id":         out.ID,
				"is_enabled": out.IsEnabled,
			})
			s.pub.Flush(ctx, rid, buf)
		}
	}
	return &out, nil
}

// checkCanDisable — три случая, когда отключение оставит кассу нерабочей.
func (s *FinancialAccountsService) checkCanDisable(ctx context.Context, acc models.FinancialAccount) error {
	// 1. Счёт открытой смены: смена уже пишет в него выручку, отключение
	//    посреди смены оставит кассира без счёта до её закрытия.
	scopedShift, err := s.r.ForTenant(ctx)
	if err != nil {
		return err
	}
	var openShifts int64
	if err := scopedShift.Model(&models.CashShift{}).
		Where("account_id = ? AND status = ?", acc.ID, "open").Count(&openShifts).Error; err != nil {
		return err
	}
	if openShifts > 0 {
		return apperrors.Wrap("CONFLICT", "счёт используется в открытой смене — закройте смену", nil)
	}

	// 2. Последний включённый наличный счёт: pos2 при открытии смены фильтрует
	//    строго по type='cash' без фолбэка — без единого наличного счёта смена
	//    просто не откроется.
	if acc.Type != nil && *acc.Type == "cash" {
		scopedCash, err := s.r.ForTenant(ctx)
		if err != nil {
			return err
		}
		var otherCash int64
		if err := scopedCash.Model(&models.FinancialAccount{}).
			Where("id <> ? AND type = ? AND is_enabled = true", acc.ID, "cash").
			Count(&otherCash).Error; err != nil {
			return err
		}
		if otherCash == 0 {
			return apperrors.Wrap("CONFLICT", "это единственный включённый наличный счёт — без него не открыть смену", nil)
		}
	}

	// 3. Активные регулярные платежи: шаблон продолжил бы списывать с
	//    отключённого счёта. Перечисляем их, чтобы владелец перепривязал.
	scopedRec, err := s.r.ForTenant(ctx)
	if err != nil {
		return err
	}
	var pays []models.RecurringPayment
	if err := scopedRec.Where("account_id = ? AND active = true", acc.ID).
		Order("name ASC").Limit(5).Find(&pays).Error; err != nil {
		return err
	}
	if len(pays) > 0 {
		names := make([]string, 0, len(pays))
		for _, p := range pays {
			if p.Name != nil && *p.Name != "" {
				names = append(names, *p.Name)
			}
		}
		msg := "на счёт настроены регулярные платежи — перепривяжите их к другому счёту"
		if len(names) > 0 {
			msg += ": " + strings.Join(names, ", ")
		}
		return apperrors.Wrap("CONFLICT", msg, nil)
	}
	return nil
}

// MustBeEnabled — гвард для любой проводки денег. Вызывается из сервисов,
// которые дебетуют/кредитуют счёт (операции, оплата заказа, приёмка, оплата
// долга, ЗП, перевод). Страховка на случай пропущенного пикера на фронте или
// старой сборки APK закупщика, которая ещё не знает про отключённые счета.
//
// Пустой id пропускаем — «счёт не указан» валидируется вызывающим кодом.
func MustBeEnabled(ctx context.Context, r *repo.Repo, accountID string) error {
	if accountID == "" {
		return nil
	}
	scoped, err := r.ForTenant(ctx)
	if err != nil {
		return err
	}
	var acc models.FinancialAccount
	if err := scoped.Where("id = ?", accountID).First(&acc).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return apperrors.Wrap("VALIDATION", "счёт не найден", nil)
		}
		return err
	}
	if !acc.IsEnabled {
		name := ""
		if acc.Name != nil {
			name = " «" + *acc.Name + "»"
		}
		return apperrors.Wrap("CONFLICT", "счёт"+name+" отключён — выберите другой счёт", nil)
	}
	return nil
}

// Delete — 409 если есть FinancialOperation на этот аккаунт.
func (s *FinancialAccountsService) Delete(ctx context.Context, id string) error {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return err
	}
	var existing models.FinancialAccount
	if err := scoped.Where("id = ?", id).First(&existing).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return apperrors.ErrNotFound
		}
		return err
	}
	// #8: счёт с ненулевым балансом удалять нельзя — иначе CashTotal в Балансе
	// упадёт на сумму остатка без единой проводки.
	if !existing.Balance.IsZero() {
		return apperrors.Wrap("CONFLICT", "нельзя удалить счёт с ненулевым балансом: "+existing.Balance.String(), nil)
	}
	scopedCheck, _ := s.r.ForTenant(ctx)
	var refs int64
	if err := scopedCheck.Model(&models.FinancialOperation{}).
		Where("account_id = ?", id).Count(&refs).Error; err != nil {
		return err
	}
	if refs > 0 {
		return apperrors.Wrap("CONFLICT", "account has financial operations", nil)
	}
	scopedDel, _ := s.r.ForTenant(ctx)
	res := scopedDel.Where("id = ?", id).Delete(&models.FinancialAccount{})
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return apperrors.ErrNotFound
	}
	return nil
}

// Transfer — атомарный перевод между двумя счетами. Создаёт две FinancialOperation,
// обновляет балансы обоих счетов в одной транзакции.
func (s *FinancialAccountsService) Transfer(ctx context.Context, in AccountTransferInput) (*AccountTransferResult, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	if in.FromID == nil || *in.FromID == "" || in.ToID == nil || *in.ToID == "" {
		return nil, apperrors.Wrap("VALIDATION", "from_id and to_id are required", nil)
	}
	if *in.FromID == *in.ToID {
		return nil, apperrors.Wrap("VALIDATION", "from_id and to_id must differ", nil)
	}
	if in.Amount == nil || *in.Amount == "" {
		return nil, apperrors.Wrap("VALIDATION", "amount is required", nil)
	}
	amount, err := decimal.FromString(*in.Amount)
	if err != nil || !decimal.IsPositive(amount) {
		return nil, apperrors.Wrap("VALIDATION", "amount must be positive decimal", err)
	}
	// Принимающий счёт должен быть включён — новые деньги на отключённый счёт
	// не заводим. Счёт-источник проверять НЕ надо осознанно: перевод — это
	// штатный способ забрать остаток с уже отключённого счёта.
	if err := MustBeEnabled(ctx, s.r, *in.ToID); err != nil {
		return nil, err
	}

	var result AccountTransferResult
	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)
		// Блокируем ОБА счёта одним запросом с ORDER BY id — это берёт
		// row-lock'и в детерминированном порядке и исключает deadlock при
		// встречных переводах A→B / B→A. Без FOR UPDATE два параллельных
		// перевода читали старый баланс и теряли один из них (порча денег).
		var locked []models.FinancialAccount
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("restaurant_id = ? AND id IN ?", rid, []string{*in.FromID, *in.ToID}).
			Order("id ASC").Find(&locked).Error; err != nil {
			return err
		}
		var from, to models.FinancialAccount
		for i := range locked {
			switch locked[i].ID {
			case *in.FromID:
				from = locked[i]
			case *in.ToID:
				to = locked[i]
			}
		}
		if from.ID == "" {
			return apperrors.Wrap("NOT_FOUND", "from account not found", nil)
		}
		if to.ID == "" {
			return apperrors.Wrap("NOT_FOUND", "to account not found", nil)
		}
		if decimal.IsNegative(decimal.Sub(from.Balance, amount)) {
			return apperrors.Wrap("CONFLICT", "insufficient funds on from account", nil)
		}
		newFrom := decimal.Normalize(decimal.Sub(from.Balance, amount))
		newTo := decimal.Normalize(decimal.Add(to.Balance, amount))
		now := time.Now().UTC()
		date := now.Format("2006-01-02")
		if err := tx.Model(&from).Updates(map[string]any{"balance": newFrom, "updated_at": now}).Error; err != nil {
			return err
		}
		if err := tx.Model(&to).Updates(map[string]any{"balance": newTo, "updated_at": now}).Error; err != nil {
			return err
		}
		category := "Перевод"
		activity := "financial"
		ridStr := rid
		isAuto := false
		desc := in.Description

		toName := ""
		if to.Name != nil {
			toName = *to.Name
		}
		fromName := ""
		if from.Name != nil {
			fromName = *from.Name
		}
		fromID := from.ID
		toID := to.ID

		outType := "out"
		opOut := &models.FinancialOperation{
			ID:           uuid.NewString(),
			Type:         &outType,
			Amount:       amount,
			Category:     &category,
			AccountID:    &fromID,
			AccountName:  from.Name,
			Activity:     &activity,
			Date:         &date,
			Description:  desc,
			Counterparty: &toName,
			IsAuto:       &isAuto,
			RestaurantID: &ridStr,
			CreatedAt:    now,
			UpdatedAt:    now,
		}
		if err := tx.Create(opOut).Error; err != nil {
			return err
		}
		inType := "in"
		opIn := &models.FinancialOperation{
			ID:           uuid.NewString(),
			Type:         &inType,
			Amount:       amount,
			Category:     &category,
			AccountID:    &toID,
			AccountName:  to.Name,
			Activity:     &activity,
			Date:         &date,
			Description:  desc,
			Counterparty: &fromName,
			IsAuto:       &isAuto,
			RestaurantID: &ridStr,
			CreatedAt:    now,
			UpdatedAt:    now,
		}
		if err := tx.Create(opIn).Error; err != nil {
			return err
		}
		result.From = *opOut
		result.To = *opIn
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &result, nil
}

// ═══════════════════════════════════════════════════════════════════════════
// FinancialOperations — paged list + manual create
// ═══════════════════════════════════════════════════════════════════════════

type FinancialOperationsService struct {
	r   *repo.Repo
	pub *EventPublisher
}

func NewFinancialOperationsService(r *repo.Repo) *FinancialOperationsService {
	return &FinancialOperationsService{r: r}
}

// WithPublisher (как в других сервисах).
func (s *FinancialOperationsService) WithPublisher(pub *EventPublisher) *FinancialOperationsService {
	s.pub = pub
	return s
}

type FinancialOperationsFilter struct {
	From, To  *time.Time
	Type      string
	AccountID string
	Category  string
	Activity  string
	ShiftID   string
	Page      cursor.Page
}

func (s *FinancialOperationsService) List(ctx context.Context, f FinancialOperationsFilter) ([]models.FinancialOperation, string, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, "", err
	}
	q := scoped
	if f.Type != "" {
		q = q.Where("type = ?", f.Type)
	}
	if f.AccountID != "" {
		q = q.Where("account_id = ?", f.AccountID)
	}
	if f.Category != "" {
		q = q.Where("category = ?", f.Category)
	}
	if f.Activity != "" {
		q = q.Where("activity = ?", f.Activity)
	}
	if f.ShiftID != "" {
		q = q.Where("shift_id = ?", f.ShiftID)
	}
	if f.From != nil {
		q = q.Where("created_at >= ?", *f.From)
	}
	if f.To != nil {
		q = q.Where("created_at < ?", *f.To)
	}
	q = cursor.Apply(q, "financial_operations", f.Page)
	var rows []models.FinancialOperation
	if err := q.Find(&rows).Error; err != nil {
		return nil, "", err
	}
	limit := cursor.NormalizeLimit(f.Page.Limit)
	trimmed, next := cursor.Next(rows, limit, func(m models.FinancialOperation) cursor.Token {
		return cursor.Token{Time: m.CreatedAt, ID: m.ID}
	})
	return trimmed, next, nil
}

type FinancialOperationInput struct {
	Type         *string `json:"type,omitempty"`
	Amount       *string `json:"amount,omitempty"`
	Category     *string `json:"category,omitempty"`
	AccountID    *string `json:"account_id,omitempty"`
	Activity     *string `json:"activity,omitempty"`
	Date         *string `json:"date,omitempty"`
	Description  *string `json:"description,omitempty"`
	Counterparty *string `json:"counterparty,omitempty"`
	ShiftID      *string `json:"shift_id,omitempty"`
	// AffectsShift — явный выбор «Касса» (счёт, ничего больше) vs «Смена»
	// (тот же счёт + уменьшить «Ожидается касса» текущей открытой смены).
	// nil/true — как раньше: recordShiftCashOutIfActive решает сам по
	// совпадению счёта (обратная совместимость со старыми клиентами и
	// существующими тестами). Явный false — расход НЕ зеркалится в смену,
	// даже если счёт совпадает: бухгалтерская проводка, которая не была
	// физическим движением наличных в ящике сегодня.
	AffectsShift *bool `json:"affects_shift,omitempty"`
}

// Create — ручная финансовая операция (Manager). Обновляет баланс счёта в той же tx.
// Тип transfer тут запрещён — используйте /accounts/transfer.
func (s *FinancialOperationsService) Create(ctx context.Context, in FinancialOperationInput) (*models.FinancialOperation, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	if in.Type == nil || (*in.Type != "in" && *in.Type != "out") {
		return nil, apperrors.Wrap("VALIDATION", "type must be 'in' or 'out'", nil)
	}
	if in.Amount == nil || *in.Amount == "" {
		return nil, apperrors.Wrap("VALIDATION", "amount is required", nil)
	}
	amount, err := decimal.FromString(*in.Amount)
	if err != nil || !decimal.IsPositive(amount) {
		return nil, apperrors.Wrap("VALIDATION", "amount must be positive", err)
	}
	if in.Category == nil || *in.Category == "" {
		return nil, apperrors.Wrap("VALIDATION", "category is required", nil)
	}
	// #29: зарезервированные категории и financial-активность создаются ТОЛЬКО
	// системой (приёмка, гашение долга, перевод, выручка, возврат). Ручная
	// операция с такой меткой уводила деньги со счёта, но исключалась из opex
	// ОПиУ — простой способ спрятать расход из прибыли. Запрещаем на входе.
	switch *in.Category {
	case "stock_purchase", "supplier_payment", "revenue", "refund", "Перевод":
		return nil, apperrors.Wrap("VALIDATION", "категория «"+*in.Category+"» зарезервирована системой", nil)
	}
	if in.Activity != nil && *in.Activity == "financial" {
		return nil, apperrors.Wrap("VALIDATION", "activity=financial зарезервирована (переводы между счетами)", nil)
	}
	if in.AccountID == nil || *in.AccountID == "" {
		return nil, apperrors.Wrap("VALIDATION", "account_id is required", nil)
	}
	// Отключённый счёт не участвует в операциях — ни приход, ни расход.
	// Забрать с него остаток можно переводом (см. Transfer ниже).
	if err := MustBeEnabled(ctx, s.r, *in.AccountID); err != nil {
		return nil, err
	}
	now := time.Now().UTC()
	date := now.Format("2006-01-02")
	if in.Date != nil && *in.Date != "" {
		date = *in.Date
	}
	activity := "operational"
	if in.Activity != nil && *in.Activity != "" {
		activity = *in.Activity
	}
	isAuto := false
	ridStr := rid

	var op models.FinancialOperation
	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)
		var acc models.FinancialAccount
		// FOR UPDATE: блокируем счёт на время read-modify-write баланса,
		// иначе параллельные операции теряют друг друга (порча денег).
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("restaurant_id = ? AND id = ?", rid, *in.AccountID).First(&acc).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return apperrors.Wrap("VALIDATION", "account not found", nil)
			}
			return err
		}
		var newBal decimal.Decimal
		if *in.Type == "in" {
			newBal = decimal.Normalize(decimal.Add(acc.Balance, amount))
		} else {
			if decimal.IsNegative(decimal.Sub(acc.Balance, amount)) {
				return apperrors.Wrap("CONFLICT", "insufficient funds on account", nil)
			}
			newBal = decimal.Normalize(decimal.Sub(acc.Balance, amount))
		}
		if err := tx.Model(&acc).Updates(map[string]any{"balance": newBal, "updated_at": now}).Error; err != nil {
			return err
		}
		op = models.FinancialOperation{
			ID:           uuid.NewString(),
			Type:         in.Type,
			Amount:       amount,
			Category:     in.Category,
			AccountID:    in.AccountID,
			AccountName:  acc.Name,
			Activity:     &activity,
			Date:         &date,
			Description:  in.Description,
			Counterparty: in.Counterparty,
			IsAuto:       &isAuto,
			ShiftID:      in.ShiftID,
			RestaurantID: &ridStr,
			CreatedAt:    now,
			UpdatedAt:    now,
		}
		if err := tx.Create(&op).Error; err != nil {
			return err
		}
		// #27: наличный расход, отбитый ручной операцией на кассовом счёте
		// открытой смены, обязан уменьшить и expected_cash — иначе смена и счёт
		// расходятся (фантомная недостача/излишек в Z). Зеркало создаётся только
		// если счёт принадлежит открытой смене (внутри recordShiftCashOutIfActive).
		//
		// AffectsShift=false — явный отказ от зеркала: пользователь говорит, что
		// эта проводка не была физическим движением денег в сегодняшнем ящике
		// (бухгалтерская операция на счёте «Касса», а не расход из смены).
		// nil/true — поведение как раньше (совместимость со старыми клиентами).
		if *in.Type == "out" && (in.AffectsShift == nil || *in.AffectsShift) {
			shiftRef := ""
			if in.ShiftID != nil {
				shiftRef = *in.ShiftID
			}
			d := "Расход"
			if in.Description != nil && *in.Description != "" {
				d = *in.Description
			}
			if err := recordShiftCashOutIfActive(tx, rid, shiftRef, *in.AccountID, d, date, op.ID, amount, now); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	// Публикуем ПОСЛЕ успешного коммита: подписчики (счета, ДДС, баланс)
	// перезапрашивают данные и должны увидеть уже зафиксированную операцию.
	if s.pub != nil {
		buf := NewBuffer()
		buf.Add(EventFinanceOperation, map[string]any{
			"id":         op.ID,
			"type":       in.Type,
			"account_id": in.AccountID,
		})
		s.pub.Flush(ctx, ridStr, buf)
	}
	return &op, nil
}

// ═══════════════════════════════════════════════════════════════════════════
// CustomCategories CRUD
// ═══════════════════════════════════════════════════════════════════════════

type CustomCategoriesService struct{ r *repo.Repo }

func NewCustomCategoriesService(r *repo.Repo) *CustomCategoriesService {
	return &CustomCategoriesService{r: r}
}

type CustomCategoryInput struct {
	Name *string `json:"name,omitempty"`
	Type *string `json:"type,omitempty"`
}

func (s *CustomCategoriesService) List(ctx context.Context, typeFilter string) ([]models.CustomCategory, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	q := scoped
	if typeFilter != "" {
		q = q.Where("type = ?", typeFilter)
	}
	var rows []models.CustomCategory
	if err := q.Order("name ASC").Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}

func (s *CustomCategoriesService) Create(ctx context.Context, in CustomCategoryInput) (*models.CustomCategory, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	if in.Name == nil || *in.Name == "" {
		return nil, apperrors.Wrap("VALIDATION", "name is required", nil)
	}
	t := "out"
	if in.Type != nil && *in.Type != "" {
		t = *in.Type
	}
	if t != "in" && t != "out" {
		return nil, apperrors.Wrap("VALIDATION", "type must be 'in' or 'out'", nil)
	}
	c := &models.CustomCategory{
		ID: uuid.NewString(), Name: *in.Name, Type: t,
		RestaurantID: &rid, CreatedAt: time.Now().UTC(),
	}
	scoped, _ := s.r.ForTenant(ctx)
	if err := scoped.Create(c).Error; err != nil {
		return nil, err
	}
	return c, nil
}

func (s *CustomCategoriesService) Delete(ctx context.Context, id string) error {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return err
	}
	res := scoped.Where("id = ?", id).Delete(&models.CustomCategory{})
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return apperrors.ErrNotFound
	}
	return nil
}

// ═══════════════════════════════════════════════════════════════════════════
// FinanceReportsService — JSON-отчёты P&L / Cashflow / Balance / MonthlyRevenue
// ═══════════════════════════════════════════════════════════════════════════

type FinanceReportsService struct{ r *repo.Repo }

func NewFinanceReportsService(r *repo.Repo) *FinanceReportsService {
	return &FinanceReportsService{r: r}
}

type PnLJSON struct {
	Period struct {
		From *time.Time `json:"from,omitempty"`
		To   *time.Time `json:"to,omitempty"`
	} `json:"period"`
	Revenue struct {
		Total    decimal.Decimal `json:"total"`
		ByMethod []ByMethodRow   `json:"by_method"`
	} `json:"revenue"`
	COGS struct {
		Total decimal.Decimal `json:"total"`
	} `json:"cogs"`
	Writeoffs decimal.Decimal `json:"writeoffs"`
	Opex      struct {
		Total      decimal.Decimal `json:"total"`
		ByCategory []ByCategoryRow `json:"by_category"`
	} `json:"opex"`
	GrossProfit   decimal.Decimal `json:"gross_profit"`
	NetProfit     decimal.Decimal `json:"net_profit"`
	MarginPercent decimal.Decimal `json:"margin_percent"`
}

type ByMethodRow struct {
	Method string          `json:"method"`
	Amount decimal.Decimal `json:"amount"`
}

type ByCategoryRow struct {
	Category string          `json:"category"`
	Amount   decimal.Decimal `json:"amount"`
}

// opexExcludedCategories — категории out-операций, которые НЕ являются
// операционным расходом ОПиУ: закупка склада (станет COGS при продаже), гашение
// долга поставщику и обязательства (движение по пассиву). Единый список для всех
// отчётов — иначе они дают разную прибыль (#10/#12/#17).
var opexExcludedCategories = []string{"stock_purchase", "supplier_payment", "liability_payment"}

// OpexByDay — операционный расход по дням (тот же opex-фильтр, что в ОПиУ).
// Нужен «Динамике» вместо валового ДДС-оттока (#12): раньше расходы графика
// раздувались переводами/инкассациями/закупками.
func (s *FinanceReportsService) OpexByDay(ctx context.Context, f PeriodFilter) (map[string]decimal.Decimal, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	type dayRow struct {
		Day   string          `gorm:"column:day"`
		Total decimal.Decimal `gorm:"column:total"`
	}
	q := applyFOPeriod(applyOpexFilter(scoped.Table("financial_operations").
		Select(foBizDay+" AS day, COALESCE(SUM(amount), 0) AS total")), f)
	var rows []dayRow
	if err := q.Group("day").Scan(&rows).Error; err != nil {
		return nil, err
	}
	out := make(map[string]decimal.Decimal, len(rows))
	for _, r := range rows {
		out[r.Day] = decimal.Normalize(r.Total)
	}
	return out, nil
}

// applyOpexFilter — операционный расход: type='out', не financial-активность
// (переводы/инкассации/взносы), не зарезервированные категории. Применяется во
// всех отчётах, где нужен opex, чтобы прибыль везде считалась одинаково.
func applyOpexFilter(q *gorm.DB) *gorm.DB {
	return q.Where("type = ?", "out").
		Where("COALESCE(activity, '') <> ?", "financial").
		Where("COALESCE(category, '') NOT IN ?", opexExcludedCategories)
}

// foBizDay — SQL деловой даты финоперации: date (введённая пользователем), а если
// пусто — дата создания. По ней фильтруем и группируем финотчёты. Иначе операция,
// заведённая задним числом (напр. «Аренда 01.07», внесена 05.07), попадала в
// период/день ВВОДА, а не в свой: в ДДС график по created_at не сходился с
// таблицей, которую клиент фильтрует по date.
const foBizDay = "COALESCE(NULLIF(date, ''), to_char(created_at, 'YYYY-MM-DD'))"

// applyFOPeriod фильтрует financial_operations по деловой дате (foBizDay) в
// полуинтервале [From, To). Сравнение текстовых 'YYYY-MM-DD' лексикографическое,
// что корректно для дат.
//
// To усечён до даты — эксклюзивность корректна, ТОЛЬКО когда To уже полночь
// (date-only «to» получает +1 день в parsePeriod специально для этого: делает
// диапазон включительным по последний день, оставаясь эксклюзивным как timestamp).
// Если To — момент СРЕДИ дня (обычный случай: «с текущего момента», отчёт за
// сегодня без явного date-only фильтра — ровно как шлёт TestFinancialFlow_Full),
// усечение до даты и строгое "<" вычёркивали ВЕСЬ сегодняшний день целиком: дата
// операции, заведённой прямо сейчас, равна today, а today < today — ложь. ОПиУ и
// ДДС за «сегодня» показывали 0 по расходам, хотя они только что созданы.
func applyFOPeriod(q *gorm.DB, f PeriodFilter) *gorm.DB {
	if f.From != nil {
		q = q.Where(foBizDay+" >= ?", f.From.Format("2006-01-02"))
	}
	if f.To != nil {
		toDate := f.To.Format("2006-01-02")
		if isMidnight(*f.To) {
			q = q.Where(foBizDay+" < ?", toDate)
		} else {
			q = q.Where(foBizDay+" <= ?", toDate)
		}
	}
	return q
}

func isMidnight(t time.Time) bool {
	return t.Hour() == 0 && t.Minute() == 0 && t.Second() == 0 && t.Nanosecond() == 0
}

func (s *FinanceReportsService) PnL(ctx context.Context, f PeriodFilter) (*PnLJSON, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	out := &PnLJSON{}
	out.Period.From = f.From
	out.Period.To = f.To

	scoped, _ := s.r.ForTenant(ctx)
	// Revenue total + разбивка по методам оплаты.
	// 'refunded' (полный возврат) включаем НАРАВНЕ с 'closed': валовая выручка и
	// COGS считаются, а возврат вычитается отдельной строкой opex (category=
	// 'refund'). Иначе полный возврат бил по прибыли дважды.
	//
	// ВАЖНО: 'split' — это РЕЖИМ оплаты (счёт разделён), а НЕ счёт. Реальные
	// деньги ушли в наличные/карту через order_splits. Поэтому псевдо-метод
	// «split» РАСКЛАДЫВАЕМ на фактические методы его сплитов пропорционально их
	// долям — в отчёте не должно быть «счёта split» (замечание владельца).
	type revRow struct {
		Method string          `gorm:"column:method"`
		Total  decimal.Decimal `gorm:"column:total"`
	}
	applyDates := func(q *gorm.DB) *gorm.DB {
		if f.From != nil {
			q = q.Where("closed_at >= ?", *f.From)
		}
		if f.To != nil {
			q = q.Where("closed_at < ?", *f.To)
		}
		return q
	}
	methodTotals := map[string]decimal.Decimal{}
	methodOrder := []string{}
	addMethod := func(method string, amt decimal.Decimal) {
		if _, ok := methodTotals[method]; !ok {
			methodOrder = append(methodOrder, method)
		}
		methodTotals[method] = decimal.Add(methodTotals[method], amt)
	}

	// 1. Обычные заказы (не split) — по orders.payment_method.
	var revRows []revRow
	if err := applyDates(scoped.Table("orders").
		Select("COALESCE(payment_method, '') AS method, COALESCE(SUM(total_with_service), 0) AS total").
		Where("status IN ? AND closed_at IS NOT NULL AND COALESCE(payment_method,'') <> 'split'", []string{"closed", "refunded"})).
		Group("payment_method").Scan(&revRows).Error; err != nil {
		return nil, err
	}
	for _, r := range revRows {
		addMethod(r.Method, r.Total)
	}

	// 2. Split-заказы — распределяем total_with_service по методам их сплитов.
	scopedSplitOrd, _ := s.r.ForTenant(ctx)
	type splitOrdRow struct {
		ID      string          `gorm:"column:id"`
		TotalWS decimal.Decimal `gorm:"column:total_with_service"`
	}
	var splitOrders []splitOrdRow
	if err := applyDates(scopedSplitOrd.Table("orders").
		Select("id, total_with_service").
		Where("status IN ? AND closed_at IS NOT NULL AND COALESCE(payment_method,'') = 'split'", []string{"closed", "refunded"})).
		Scan(&splitOrders).Error; err != nil {
		return nil, err
	}
	if len(splitOrders) > 0 {
		ids := make([]string, len(splitOrders))
		for i, o := range splitOrders {
			ids[i] = o.ID
		}
		scopedSplits, _ := s.r.ForTenant(ctx)
		type splPart struct {
			OrderID string          `gorm:"column:order_id"`
			Method  string          `gorm:"column:method"`
			Total   decimal.Decimal `gorm:"column:total"`
		}
		var parts []splPart
		if err := scopedSplits.Table("order_splits").
			Select("order_id, COALESCE(payment_method, '') AS method, COALESCE(total, 0) AS total").
			Where("order_id IN ?", ids).Scan(&parts).Error; err != nil {
			return nil, err
		}
		byOrder := map[string][]splPart{}
		baseByOrder := map[string]decimal.Decimal{}
		for _, pt := range parts {
			byOrder[pt.OrderID] = append(byOrder[pt.OrderID], pt)
			baseByOrder[pt.OrderID] = decimal.Add(baseByOrder[pt.OrderID], pt.Total)
		}
		for _, o := range splitOrders {
			ps := byOrder[o.ID]
			base := baseByOrder[o.ID]
			if len(ps) == 0 || !decimal.IsPositive(base) {
				// Нет сплитов/нулевая база — оставляем «split» (edge case).
				addMethod("split", o.TotalWS)
				continue
			}
			// Пропорция по долям сплитов; последнему — остаток (Σ === TotalWS,
			// без дрейфа округления).
			remaining := o.TotalWS
			for i, pt := range ps {
				var share decimal.Decimal
				if i == len(ps)-1 {
					share = remaining
				} else {
					share = decimal.Normalize(decimal.DivRound(decimal.Mul(o.TotalWS, pt.Total), base))
					remaining = decimal.Sub(remaining, share)
				}
				addMethod(pt.Method, share)
			}
		}
	}

	out.Revenue.Total = decimal.Zero
	out.Revenue.ByMethod = make([]ByMethodRow, 0, len(methodOrder))
	for _, m := range methodOrder {
		out.Revenue.Total = decimal.Add(out.Revenue.Total, methodTotals[m])
		out.Revenue.ByMethod = append(out.Revenue.ByMethod, ByMethodRow{Method: m, Amount: decimal.Normalize(methodTotals[m])})
	}
	out.Revenue.Total = decimal.Normalize(out.Revenue.Total)

	// COGS = sum(order_items.cogs * order_items.qty) for closed orders in period.
	scoped2, _ := s.r.ForTenant(ctx)
	type cogsRow struct {
		Total decimal.Decimal `gorm:"column:total"`
	}
	q2 := scoped2.Table("orders AS o").
		Select("COALESCE(SUM(CASE WHEN oi.unit IN ('g','kg') AND oi.unit_size > 0 THEN oi.cogs * oi.qty / oi.unit_size ELSE oi.cogs * oi.qty END), 0) AS total").
		Joins("JOIN order_items oi ON oi.order_id = o.id").
		// 'refunded' наравне с 'closed' — согласовано с revenue-запросом (см. выше):
		// себестоимость возвращённого заказа остаётся реальной потерей.
		Where("o.status IN ? AND o.closed_at IS NOT NULL AND oi.cancelled_at IS NULL", []string{"closed", "refunded"})
	if f.From != nil {
		q2 = q2.Where("o.closed_at >= ?", *f.From)
	}
	if f.To != nil {
		q2 = q2.Where("o.closed_at < ?", *f.To)
	}
	var cogsRows []cogsRow
	if err := q2.Scan(&cogsRows).Error; err != nil {
		return nil, err
	}
	if len(cogsRows) > 0 {
		out.COGS.Total = decimal.Normalize(cogsRows[0].Total)
	}

	// Writeoffs: SUM(stock_writeoffs.total_cost) created_at IN period.
	// Включаем в ОПиУ отдельной строкой между COGS и opex — на дашборде
	// владелец должен видеть брак не растворённым в operational expenses.
	scopedWo, _ := s.r.ForTenant(ctx)
	type woRow struct {
		Total decimal.Decimal `gorm:"column:total"`
	}
	qWo := scopedWo.Table("stock_writeoffs").
		Select("COALESCE(SUM(total_cost), 0) AS total")
	if f.From != nil {
		qWo = qWo.Where("created_at >= ?", *f.From)
	}
	if f.To != nil {
		qWo = qWo.Where("created_at < ?", *f.To)
	}
	var woRows []woRow
	if err := qWo.Scan(&woRows).Error; err != nil {
		return nil, err
	}
	if len(woRows) > 0 {
		out.Writeoffs = decimal.Normalize(woRows[0].Total)
	}

	// Opex from financial_operations type='out' grouped by category.
	//
	// Закупки склада (category='stock_purchase' — приход по накладной) в ОПиУ
	// НЕ включаем: это движение запасов (актив на складе), а не расход. Расходом
	// они становятся как COGS при продаже. Иначе двойной счёт себестоимости.
	// В ДДС (cashflow) закупка остаётся — это реальный отток денег.
	scoped3, _ := s.r.ForTenant(ctx)
	type opexRow struct {
		Category string          `gorm:"column:category"`
		Total    decimal.Decimal `gorm:"column:total"`
	}
	q3 := applyFOPeriod(applyOpexFilter(scoped3.Table("financial_operations").
		Select("COALESCE(category, '') AS category, COALESCE(SUM(amount), 0) AS total")), f)
	if f.OperationalOnly {
		// «Только операционные»: капвложения (investment — оборудование) и
		// финансовую активность в opex не считаем, чтобы разовая покупка не
		// проваливала операционную прибыль. По умолчанию (флаг off) — как было.
		q3 = q3.Where("COALESCE(activity, 'operational') = ?", "operational")
	}
	var opexRows []opexRow
	if err := q3.Group("category").Scan(&opexRows).Error; err != nil {
		return nil, err
	}
	out.Opex.Total = decimal.Zero
	out.Opex.ByCategory = make([]ByCategoryRow, 0, len(opexRows))
	for _, r := range opexRows {
		out.Opex.Total = decimal.Add(out.Opex.Total, r.Total)
		out.Opex.ByCategory = append(out.Opex.ByCategory, ByCategoryRow{Category: r.Category, Amount: decimal.Normalize(r.Total)})
	}
	out.Opex.Total = decimal.Normalize(out.Opex.Total)

	// GrossProfit = Revenue - COGS - Writeoffs. Списания — это потеря
	// валовой маржи (испорченный продукт, который не превратился в выручку),
	// поэтому они вычитаются ДО операционных расходов.
	out.GrossProfit = decimal.Normalize(decimal.Sub(decimal.Sub(out.Revenue.Total, out.COGS.Total), out.Writeoffs))
	out.NetProfit = decimal.Normalize(decimal.Sub(out.GrossProfit, out.Opex.Total))
	if decimal.IsPositive(out.Revenue.Total) {
		out.MarginPercent = decimal.Normalize(decimal.Mul(decimal.DivRound(out.NetProfit, out.Revenue.Total), decimal.FromInt(100)))
	} else {
		out.MarginPercent = decimal.Zero
	}
	_ = rid
	return out, nil
}

type CashflowJSON struct {
	Period struct {
		From *time.Time `json:"from,omitempty"`
		To   *time.Time `json:"to,omitempty"`
	} `json:"period"`
	ByActivity map[string]ActivityRow `json:"by_activity"`
	NetTotal   decimal.Decimal        `json:"net_total"`
	ByDay      []DayRow               `json:"by_day"`
	// v3.5.0: расход по конкретным статьям (financial_operations.category).
	// Только type='out'. Сортировано в Go сверху вниз по amount.
	OutByCategory []CategoryAmount `json:"out_by_category"`
}

type CategoryAmount struct {
	Category string          `json:"category"`
	Amount   decimal.Decimal `json:"amount"`
}

type ActivityRow struct {
	In  decimal.Decimal `json:"in"`
	Out decimal.Decimal `json:"out"`
	Net decimal.Decimal `json:"net"`
}

type DayRow struct {
	Date string          `json:"date"`
	In   decimal.Decimal `json:"in"`
	Out  decimal.Decimal `json:"out"`
}

func (s *FinanceReportsService) Cashflow(ctx context.Context, f PeriodFilter) (*CashflowJSON, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	out := &CashflowJSON{ByActivity: map[string]ActivityRow{}}
	out.Period.From = f.From
	out.Period.To = f.To

	type actRow struct {
		Activity string          `gorm:"column:activity"`
		Type     string          `gorm:"column:type"`
		Total    decimal.Decimal `gorm:"column:total"`
	}
	q := applyFOPeriod(scoped.Table("financial_operations").
		Select("COALESCE(activity, 'operational') AS activity, COALESCE(type, '') AS type, COALESCE(SUM(amount), 0) AS total"), f)
	var rows []actRow
	if err := q.Group("activity, type").Scan(&rows).Error; err != nil {
		return nil, err
	}
	net := decimal.Zero
	for _, r := range rows {
		ar := out.ByActivity[r.Activity]
		if r.Type == "in" {
			ar.In = decimal.Normalize(decimal.Add(ar.In, r.Total))
			net = decimal.Add(net, r.Total)
		} else if r.Type == "out" {
			ar.Out = decimal.Normalize(decimal.Add(ar.Out, r.Total))
			net = decimal.Sub(net, r.Total)
		}
		ar.Net = decimal.Normalize(decimal.Sub(ar.In, ar.Out))
		out.ByActivity[r.Activity] = ar
	}
	out.NetTotal = decimal.Normalize(net)

	// By day.
	scoped2, _ := s.r.ForTenant(ctx)
	type dayRow struct {
		Day   string          `gorm:"column:day"`
		Type  string          `gorm:"column:type"`
		Total decimal.Decimal `gorm:"column:total"`
	}
	q2 := applyFOPeriod(scoped2.Table("financial_operations").
		Select(foBizDay+" AS day, COALESCE(type, '') AS type, COALESCE(SUM(amount), 0) AS total"), f)
	var drows []dayRow
	if err := q2.Group("day, type").Order("day ASC").Scan(&drows).Error; err != nil {
		return nil, err
	}
	dayMap := map[string]*DayRow{}
	keys := []string{}
	for _, r := range drows {
		d, ok := dayMap[r.Day]
		if !ok {
			d = &DayRow{Date: r.Day, In: decimal.Zero, Out: decimal.Zero}
			dayMap[r.Day] = d
			keys = append(keys, r.Day)
		}
		if r.Type == "in" {
			d.In = decimal.Normalize(decimal.Add(d.In, r.Total))
		} else if r.Type == "out" {
			d.Out = decimal.Normalize(decimal.Add(d.Out, r.Total))
		}
	}
	out.ByDay = make([]DayRow, 0, len(keys))
	for _, k := range keys {
		out.ByDay = append(out.ByDay, *dayMap[k])
	}

	// By category — только type='out', сортировка desc по amount в Go.
	scoped3, _ := s.r.ForTenant(ctx)
	type catRow struct {
		Category string          `gorm:"column:category"`
		Total    decimal.Decimal `gorm:"column:total"`
	}
	q3 := applyFOPeriod(applyOpexFilter(scoped3.Table("financial_operations").
		Select(`COALESCE(NULLIF(category, ''), 'Без категории') AS category,
		        COALESCE(SUM(amount), 0) AS total`)), f)
	var crows []catRow
	_ = q3.Group("category").Scan(&crows).Error
	out.OutByCategory = make([]CategoryAmount, 0, len(crows))
	for _, r := range crows {
		out.OutByCategory = append(out.OutByCategory, CategoryAmount{
			Category: r.Category,
			Amount:   decimal.Normalize(r.Total),
		})
	}
	sort.Slice(out.OutByCategory, func(i, j int) bool {
		return out.OutByCategory[i].Amount.GreaterThan(out.OutByCategory[j].Amount)
	})
	return out, nil
}

type BalanceJSON struct {
	// Авто-оборотные активы (считаются на бэке, фронт только показывает):
	Accounts       []BalanceLine   `json:"accounts"`        // счета, amount = баланс
	CashTotal      decimal.Decimal `json:"cash_total"`      // Σ балансов счетов
	InventoryValue decimal.Decimal `json:"inventory_value"` // Σ остаток × цена (ингредиенты + полуфабрикаты)
	// Внеоборотные (ручные) активы:
	Assets      []BalanceLine   `json:"assets"`
	TotalAssets decimal.Decimal `json:"total_assets"` // только ручные активы
	// Долг поставщикам (авто-обязательство, Σ suppliers.current_debt):
	SupplierDebt     decimal.Decimal `json:"supplier_debt"`
	Liabilities      []LiabilityLine `json:"liabilities"`
	TotalLiabilities decimal.Decimal `json:"total_liabilities"`
	Equity           []BalanceLine   `json:"equity"`
	TotalEquity      decimal.Decimal `json:"total_equity"`
	ComputedEquity   decimal.Decimal `json:"computed_equity"`
	// Грандтоталы (всё посчитано на сервере, для API/Excel без UI-математики):
	GrandTotalAssets      decimal.Decimal `json:"grand_total_assets"`      // деньги + склад + ручные активы
	GrandTotalLiabilities decimal.Decimal `json:"grand_total_liabilities"` // долг поставщикам + ручные обязательства
}

type BalanceLine struct {
	ID     string          `json:"id"`
	Name   string          `json:"name"`
	Amount decimal.Decimal `json:"amount"`
}

type LiabilityLine struct {
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Total     decimal.Decimal `json:"total"`
	Paid      decimal.Decimal `json:"paid"`
	Remaining decimal.Decimal `json:"remaining"`
}

func (s *FinanceReportsService) Balance(ctx context.Context) (*BalanceJSON, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	out := &BalanceJSON{
		Accounts: []BalanceLine{}, Assets: []BalanceLine{}, Liabilities: []LiabilityLine{}, Equity: []BalanceLine{},
	}

	// Денежные средства — балансы счетов (авто-актив). Отдельный scoped, чтобы
	// не загрязнять statement для последующих запросов (assets/liabilities).
	scopedAcc, _ := s.r.ForTenant(ctx)
	var accs []models.FinancialAccount
	if err := scopedAcc.Order("name ASC").Find(&accs).Error; err != nil {
		return nil, err
	}
	out.CashTotal = decimal.Zero
	for _, a := range accs {
		name := ""
		if a.Name != nil {
			name = *a.Name
		}
		out.Accounts = append(out.Accounts, BalanceLine{ID: a.ID, Name: name, Amount: a.Balance})
		out.CashTotal = decimal.Add(out.CashTotal, a.Balance)
	}
	out.CashTotal = decimal.Normalize(out.CashTotal)

	// Стоимость склада — Σ(остаток × цена за единицу) по ингредиентам (авто-актив).
	var invRow struct {
		Total decimal.Decimal `gorm:"column:total"`
	}
	scopedInv, _ := s.r.ForTenant(ctx)
	if err := scopedInv.Model(&models.Ingredient{}).
		Select("COALESCE(SUM(GREATEST(qty, 0) * price_per_unit), 0) AS total").
		Scan(&invRow).Error; err != nil {
		return nil, err
	}
	// + полуфабрикаты (semi_finished_stock).
	var semiRow struct {
		Total decimal.Decimal `gorm:"column:total"`
	}
	scopedSemi, _ := s.r.ForTenant(ctx)
	if err := scopedSemi.Model(&models.SemiFinishedStock{}).
		Select("COALESCE(SUM(GREATEST(qty, 0) * price_per_unit), 0) AS total").
		Scan(&semiRow).Error; err != nil {
		return nil, err
	}
	out.InventoryValue = decimal.Normalize(decimal.Add(invRow.Total, semiRow.Total))

	// Долг поставщикам — авто-обязательство (Σ положительных current_debt).
	var debtRow struct {
		Total decimal.Decimal `gorm:"column:total"`
	}
	scopedDebt, _ := s.r.ForTenant(ctx)
	if err := scopedDebt.Model(&models.Supplier{}).
		Select("COALESCE(SUM(current_debt), 0) AS total").
		Where("current_debt > 0").
		Scan(&debtRow).Error; err != nil {
		return nil, err
	}
	out.SupplierDebt = decimal.Normalize(debtRow.Total)

	var assets []models.Asset
	if err := scoped.Order("name ASC").Find(&assets).Error; err != nil {
		return nil, err
	}
	out.TotalAssets = decimal.Zero
	for _, a := range assets {
		name := ""
		if a.Name != nil {
			name = *a.Name
		}
		out.Assets = append(out.Assets, BalanceLine{ID: a.ID, Name: name, Amount: a.Amount})
		out.TotalAssets = decimal.Add(out.TotalAssets, a.Amount)
	}
	out.TotalAssets = decimal.Normalize(out.TotalAssets)

	scoped2, _ := s.r.ForTenant(ctx)
	var liabs []models.Liability
	if err := scoped2.Order("name ASC").Find(&liabs).Error; err != nil {
		return nil, err
	}
	out.TotalLiabilities = decimal.Zero
	for _, l := range liabs {
		name := ""
		if l.Name != nil {
			name = *l.Name
		}
		out.Liabilities = append(out.Liabilities, LiabilityLine{
			ID: l.ID, Name: name, Total: l.TotalAmount, Paid: l.PaidAmount, Remaining: l.RemainingAmount,
		})
		out.TotalLiabilities = decimal.Add(out.TotalLiabilities, l.RemainingAmount)
	}
	out.TotalLiabilities = decimal.Normalize(out.TotalLiabilities)

	scoped3, _ := s.r.ForTenant(ctx)
	var equity []models.EquityEntry
	if err := scoped3.Order("name ASC").Find(&equity).Error; err != nil {
		return nil, err
	}
	out.TotalEquity = decimal.Zero
	for _, e := range equity {
		name := ""
		if e.Name != nil {
			name = *e.Name
		}
		out.Equity = append(out.Equity, BalanceLine{ID: e.ID, Name: name, Amount: e.Amount})
		out.TotalEquity = decimal.Add(out.TotalEquity, e.Amount)
	}
	out.TotalEquity = decimal.Normalize(out.TotalEquity)
	// Грандтоталы: активы = деньги + склад + ручные; обязательства = долг
	// поставщикам + ручные. ComputedEquity = чистые активы (assets − liabilities).
	out.GrandTotalAssets = decimal.Normalize(decimal.Add(decimal.Add(out.CashTotal, out.InventoryValue), out.TotalAssets))
	out.GrandTotalLiabilities = decimal.Normalize(decimal.Add(out.SupplierDebt, out.TotalLiabilities))
	out.ComputedEquity = decimal.Normalize(decimal.Sub(out.GrandTotalAssets, out.GrandTotalLiabilities))
	return out, nil
}

type MonthlyRevenueRow struct {
	Month       string          `json:"month"`
	Revenue     decimal.Decimal `json:"revenue"`
	OrdersCount int             `json:"orders_count"`
	AvgCheck    decimal.Decimal `json:"avg_check"`
	Expenses    decimal.Decimal `json:"expenses"`
	Profit      decimal.Decimal `json:"profit"`
}

// MonthlyRevenue — последние N месяцев от now (или указанного года).
func (s *FinanceReportsService) MonthlyRevenue(ctx context.Context, months int) ([]MonthlyRevenueRow, error) {
	if months <= 0 {
		months = 12
	}
	if months > 60 {
		months = 60
	}
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	// Граница "от" — начало месяца now-(months-1).
	now := time.Now().UTC()
	startMonth := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC).AddDate(0, -(months - 1), 0)

	type row struct {
		Month string          `gorm:"column:month"`
		Total decimal.Decimal `gorm:"column:total"`
		Cnt   int             `gorm:"column:cnt"`
	}
	var rows []row
	if err := scoped.Table("orders").
		Select("to_char(closed_at, 'YYYY-MM') AS month, COALESCE(SUM(total_with_service), 0) AS total, COUNT(*) AS cnt").
		Where("status IN ? AND closed_at IS NOT NULL AND closed_at >= ?", []string{"closed", "refunded"}, startMonth).
		Group("month").
		Order("month ASC").
		Scan(&rows).Error; err != nil {
		return nil, err
	}
	byMonth := map[string]row{}
	for _, r := range rows {
		byMonth[r.Month] = r
	}

	// expenses: SUM(financial_operations.amount) WHERE type='out' AND activity='operational',
	// сгруппировано по месяцу date (или created_at если date NULL).
	type expRow struct {
		Month string          `gorm:"column:month"`
		Total decimal.Decimal `gorm:"column:total"`
	}
	scopedE, _ := s.r.ForTenant(ctx)
	var expRows []expRow
	if err := applyOpexFilter(scopedE.Table("financial_operations").
		Select("left("+foBizDay+", 7) AS month, COALESCE(SUM(amount), 0) AS total")).
		Where(foBizDay+" >= ?", startMonth.Format("2006-01-02")).
		Group("month").
		Scan(&expRows).Error; err != nil {
		return nil, err
	}
	byMonthExp := map[string]decimal.Decimal{}
	for _, r := range expRows {
		byMonthExp[r.Month] = r.Total
	}

	out := make([]MonthlyRevenueRow, 0, months)
	for i := 0; i < months; i++ {
		t := startMonth.AddDate(0, i, 0)
		key := t.Format("2006-01")
		r, ok := byMonth[key]
		var avg decimal.Decimal
		if ok && r.Cnt > 0 {
			avg = decimal.Normalize(decimal.DivRound(r.Total, decimal.FromInt(int64(r.Cnt))))
		} else {
			avg = decimal.Zero
		}
		total := decimal.Zero
		cnt := 0
		if ok {
			total = decimal.Normalize(r.Total)
			cnt = r.Cnt
		}
		exp := decimal.Normalize(byMonthExp[key])
		profit := decimal.Normalize(decimal.Sub(total, exp))
		out = append(out, MonthlyRevenueRow{
			Month: key, Revenue: total, OrdersCount: cnt, AvgCheck: avg,
			Expenses: exp, Profit: profit,
		})
	}
	return out, nil
}

// ═══════════════════════════════════════════════════════════════════════════
// SalaryService — выплата ЗП и сервис-чарджа сотрудникам.
// ═══════════════════════════════════════════════════════════════════════════

type SalaryService struct{ r *repo.Repo }

func NewSalaryService(r *repo.Repo) *SalaryService { return &SalaryService{r: r} }

type SalaryPayInput struct {
	UserID       *string `json:"user_id,omitempty"`
	Amount       *string `json:"amount,omitempty"`
	AccountID    *string `json:"account_id,omitempty"`
	EmployeeName *string `json:"employee_name,omitempty"`
	Period       *string `json:"period,omitempty"`
	Description  *string `json:"description,omitempty"`
	// Kind — «salary» (окончательный расчёт) или «advance» (аванс). До этого
	// оба писались одной категорией «Зарплата» и различались только текстом
	// «(аванс)» в имени контрагента, из-за чего отчёт не мог их разделить.
	// Пусто → salary (совместимость со старыми клиентами).
	Kind *string `json:"kind,omitempty"`
	// Override — выплатить сумму выше расчётного остатка осознанно (бонус,
	// доплата, ручная коррекция), а не быть заблокированным сервером. Требует
	// непустой OverrideReason. Без Override превышение — 409, как раньше (ЗП-4).
	Override *bool `json:"override,omitempty"`
	// OverrideReason — обязательна при Override=true и реальном превышении
	// кап-суммы. Уходит в описание проводки (см. mergeOverrideReason) — отчёт
	// отличит осознанную "свободную" выплату от обычного расчёта по формуле.
	OverrideReason *string `json:"override_reason,omitempty"`
}

// mergeOverrideReason — причина "свободной" выплаты в текст проводки.
// Отдельного поля под причину в financial_operations нет (и не нужно — это
// разовое пояснение, не структурный признак), is_override уже даёт признак
// для фильтрации, а текст — для человека, читающего ленту операций.
func mergeOverrideReason(base *string, reason string) string {
	if base != nil && *base != "" {
		return *base + " — свободная выплата: " + reason
	}
	return "Свободная выплата: " + reason
}

// Категории зарплатных проводок в financial_operations.
const (
	CategorySalary  = "Зарплата"
	CategoryAdvance = "Аванс"
)

// salaryCategory — маппинг kind → категория проводки.
func salaryCategory(kind *string) string {
	if kind != nil && *kind == "advance" {
		return CategoryAdvance
	}
	return CategorySalary
}

// salaryCapForPeriod — начислено/выплачено за период для честного кап-чека
// (#7): вынесено из PaySalary, чтобы GiveAdvance (070) применял ТОТ ЖЕ кап,
// что и раньше применялся к kind=advance внутри PaySalary — иначе выдача
// аванса новым эндпоинтом стала бы неограниченной там, где раньше требовала
// осознанного Override.
func (s *SalaryService) salaryCapForPeriod(ctx context.Context, userID, period string) (u models.User, accrued decimal.Decimal, basis string, paid, advance, deductions decimal.Decimal, err error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return
	}
	if err = scoped.Where("id = ?", userID).First(&u).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			err = apperrors.Wrap("VALIDATION", "user not found", nil)
		}
		return
	}
	// Уже выплачено за период = Σ зарплатных проводок этого сотрудника ЗА
	// ЭТОТ ПЕРИОД — матчим по тегу периода в description ("Зарплата:2026-07",
	// см. payoutTx()), НЕ по фактической дате проводки: зарплату за июль часто
	// платят в начале августа, и "date LIKE период%" эту прошлую выплату
	// никогда не найдёт — кап молча переставал работать (ЗП-баг, нашли по
	// TestSalary_WorkedDays_AccrualCapAndFreePayout).
	// Только категория «Зарплата»: авансы теперь пишутся отдельной
	// категорией и вычитаются из остатка через u.Advance — считать их
	// здесь второй раз означало бы вычесть аванс дважды.
	scopedP, _ := s.r.ForTenant(ctx)
	periodTag := "%" + CategorySalary + ":" + period + "%"
	if err = scopedP.Table("financial_operations").
		Select("COALESCE(SUM(amount), 0)").
		Where("category = ? AND source_ref = ? AND description LIKE ?", CategorySalary, userID, periodTag).
		Scan(&paid).Error; err != nil {
		return
	}
	// Начислено за период. Для оклада — сумма из карточки, для дневной
	// оплаты (054) — ставка × отработанные дни из табеля: капить дневника
	// по u.Salary было бы неверно, у него оклад равен нулю.
	accrued = u.Salary
	basis = fmt.Sprintf("оклад %s", u.Salary)
	if payTypeOf(u) == PayTypeDaily {
		days, units, derr := s.daysWorkedInPeriod(ctx, userID, period)
		if derr != nil {
			err = derr
			return
		}
		accrued = accruedFor(u, units)
		if units != days {
			basis = fmt.Sprintf("ставка %s × %d опл.ед. (%d дн., есть дни ×2) = %s", u.DailyRate, units, days, accrued)
		} else {
			basis = fmt.Sprintf("ставка %s × %d дн. = %s", u.DailyRate, days, accrued)
		}
	}
	// Аванс/удержания за ЭТОТ период — из period-tagged строк salary_advances/
	// salary_deductions (не отменённых), а НЕ из глобальных счётчиков
	// users.advance/deductions: счётчик period-agnostic, поэтому аванс за
	// прошлый месяц раньше срезал остаток текущего (реальный баг владельца).
	advance, deductions, err = s.advDedForPeriod(ctx, userID, period)
	return
}

// advDedForPeriod — Σ НЕотменённых авансов и удержаний сотрудника за месяц
// period (YYYY-MM). Источник истины для остатка «К выплате» вместо глобальных
// счётчиков users.advance/deductions (см. комментарий в salaryCapForPeriod).
// salary_deductions.period NULL у записей до 070 — "period = ?" их не берёт,
// легаси-удержания без месяца в остаток периода не попадают (осознанно).
func (s *SalaryService) advDedForPeriod(ctx context.Context, userID, period string) (adv, ded decimal.Decimal, err error) {
	sa, err := s.r.ForTenant(ctx)
	if err != nil {
		return
	}
	if err = sa.Table("salary_advances").
		Select("COALESCE(SUM(amount), 0)").
		Where("user_id::text = ? AND period = ? AND cancelled_at IS NULL", userID, period).
		Scan(&adv).Error; err != nil {
		return
	}
	sd, err := s.r.ForTenant(ctx)
	if err != nil {
		return
	}
	if err = sd.Table("salary_deductions").
		Select("COALESCE(SUM(amount), 0)").
		Where("user_id::text = ? AND period = ? AND cancelled_at IS NULL", userID, period).
		Scan(&ded).Error; err != nil {
		return
	}
	return decimal.Normalize(adv), decimal.Normalize(ded), nil
}

func (s *SalaryService) PaySalary(ctx context.Context, in SalaryPayInput) (*models.FinancialOperation, error) {
	// #7: сервер сам считает остаток к выплате и не даёт переплатить/выплатить
	// дважды за период. Раньше amount брался от клиента без проверки: зарплату за
	// период можно было выплатить сколько угодно раз, а аванс/удержания
	// (User.Advance/Deductions) не вычитались вовсе.
	//
	// ЗП-4: превышение остатка теперь не глухая стена, а осознанный выбор —
	// Override+OverrideReason проводит "свободную выплату" (бонус, доплата,
	// коррекция), помечает is_override=true и кладёт причину в описание.
	isOverride := false
	overrideDesc := in.Description
	if in.UserID != nil && *in.UserID != "" && in.Amount != nil && *in.Amount != "" && in.Period != nil && *in.Period != "" {
		amount, perr := decimal.FromString(*in.Amount)
		if perr != nil || !decimal.IsPositive(amount) {
			return nil, apperrors.Wrap("VALIDATION", "amount must be positive", perr)
		}
		_, accrued, basis, paid, advance, deductions, err := s.salaryCapForPeriod(ctx, *in.UserID, *in.Period)
		if err != nil {
			return nil, err
		}
		// Кап действует только если начислено что-то положительное. Ноль
		// (не сконфигурирован оклад/ставка или нет отметок) — выплата ручная,
		// без ограничения: иначе включение дневной оплаты заблокировало бы
		// выплаты до заполнения табеля.
		if !accrued.IsPositive() {
			return s.payout(ctx, payoutInput{
				UserID: in.UserID, Amount: in.Amount, AccountID: in.AccountID,
				Counterparty: in.EmployeeName, Category: salaryCategory(in.Kind),
				Period: in.Period, Description: in.Description,
			})
		}
		// Начислено − аванс − удержания − уже выплачено.
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
			reason := strings.TrimSpace(derefOr(in.OverrideReason, ""))
			if reason == "" {
				return nil, apperrors.Wrap("VALIDATION", "укажите причину свободной выплаты", nil)
			}
			isOverride = true
			merged := mergeOverrideReason(in.Description, reason)
			overrideDesc = &merged
		}
	}
	sp := in
	return s.payout(ctx, payoutInput{
		UserID:       sp.UserID,
		Amount:       sp.Amount,
		AccountID:    sp.AccountID,
		Counterparty: sp.EmployeeName,
		Category:     salaryCategory(sp.Kind),
		Period:       sp.Period,
		Description:  overrideDesc,
		IsOverride:   isOverride,
	})
}

type ServiceChargePayInput struct {
	WaiterID    *string `json:"waiter_id,omitempty"`
	Amount      *string `json:"amount,omitempty"`
	AccountID   *string `json:"account_id,omitempty"`
	PeriodFrom  *string `json:"period_from,omitempty"`
	PeriodTo    *string `json:"period_to,omitempty"`
	Description *string `json:"description,omitempty"`
	// ShiftID — без него выплата не привязывается к смене и не видна в
	// отчёте по смене (service-payout/by-shift).
	ShiftID *string `json:"shift_id,omitempty"`
	// Override/OverrideReason — см. SalaryPayInput. Тот же принцип: превышение
	// расчётного остатка не блокируется намертво, а требует осознанного флага
	// и причины (ЗП-4).
	Override       *bool   `json:"override,omitempty"`
	OverrideReason *string `json:"override_reason,omitempty"`
}

func (s *SalaryService) PayServiceCharge(ctx context.Context, in ServiceChargePayInput) (*models.FinancialOperation, error) {
	period := ""
	if in.PeriodFrom != nil && in.PeriodTo != nil {
		period = *in.PeriodFrom + "..." + *in.PeriodTo
	}
	// Counterparty = имя официанта (lookup by waiter_id).
	var counterparty string
	if in.WaiterID != nil && *in.WaiterID != "" {
		scoped, err := s.r.ForTenant(ctx)
		if err != nil {
			return nil, err
		}
		var u models.User
		if err := scoped.Where("id = ?", *in.WaiterID).First(&u).Error; err == nil {
			if u.Name != nil {
				counterparty = *u.Name
			}
		}
	}
	// Кап суммы: выплатить нельзя больше, чем НАЧИСЛЕНО официанту минус уже
	// ВЫПЛАЧЕНО. Прежде единственным гейтом было «хватает денег на счёте» —
	// можно было вывести сверх заработанного. Допуск 0.01 на округление.
	//
	// ЗП-4: раньше кап срабатывал ТОЛЬКО по ShiftID — а страница «Зарплата»
	// шлёт period_from/period_to без shift_id, и кап там был фантомным (UI
	// показывал «остаток», сервер его не проверял вообще). Теперь при
	// отсутствии смены считаем тот же остаток за произвольный период —
	// ровно то, что показано в интерфейсе, наконец действительно проверяется.
	isOverride := false
	overrideDesc := in.Description
	if in.WaiterID != nil && *in.WaiterID != "" && in.Amount != nil {
		if payAmt, perr := decimal.FromString(*in.Amount); perr == nil {
			var accrual []ServiceAccrualRow
			var payouts []ServicePayoutRow
			var aerr, perr2 error
			haveCapData := false
			switch {
			case in.ShiftID != nil && *in.ShiftID != "":
				accrual, aerr = s.AccrualByWaiter(ctx, nil, nil, *in.ShiftID)
				payouts, perr2 = s.PayoutByWaiter(ctx, nil, nil, *in.ShiftID)
				haveCapData = aerr == nil && perr2 == nil
			case in.PeriodFrom != nil && *in.PeriodFrom != "" && in.PeriodTo != nil && *in.PeriodTo != "":
				from, ferr := timeutil.ParseLooseRFC3339(*in.PeriodFrom)
				to, terr := timeutil.ParseLooseRFC3339(*in.PeriodTo)
				if ferr == nil && terr == nil {
					// Date-only `to` (без времени) — включительно весь день,
					// как в parsePeriod (xlsx.go) для остальных отчётов.
					if !strings.Contains(*in.PeriodTo, "T") {
						to = to.AddDate(0, 0, 1)
					}
					accrual, aerr = s.AccrualByWaiter(ctx, &from, &to, "")
					payouts, perr2 = s.PayoutByWaiter(ctx, &from, &to, "")
					haveCapData = aerr == nil && perr2 == nil
				}
			}
			if haveCapData {
				accrued := decimal.Zero
				for _, r := range accrual {
					if r.WaiterID == *in.WaiterID {
						accrued = r.AccruedAmount
						break
					}
				}
				paid := decimal.Zero
				for _, r := range payouts {
					if r.WaiterID == *in.WaiterID {
						paid = r.PaidAmount
						break
					}
				}
				remaining := decimal.Sub(accrued, paid)
				if decimal.Sub(payAmt, remaining).GreaterThan(decimal.MustFromString("0.01")) {
					if in.Override == nil || !*in.Override {
						return nil, apperrors.Wrap("VALIDATION",
							fmt.Sprintf("сумма выплаты %s превышает остаток к выплате %s (начислено %s − выплачено %s)",
								payAmt.String(), remaining.String(), accrued.String(), paid.String()), nil)
					}
					reason := strings.TrimSpace(derefOr(in.OverrideReason, ""))
					if reason == "" {
						return nil, apperrors.Wrap("VALIDATION", "укажите причину свободной выплаты", nil)
					}
					isOverride = true
					merged := mergeOverrideReason(in.Description, reason)
					overrideDesc = &merged
				}
			}
		}
	}

	cp := counterparty
	return s.payout(ctx, payoutInput{
		UserID:       in.WaiterID,
		Amount:       in.Amount,
		AccountID:    in.AccountID,
		Counterparty: &cp,
		Category:     "Сервис",
		Period:       &period,
		Description:  overrideDesc,
		ShiftID:      in.ShiftID,
		IsOverride:   isOverride,
	})
}

type payoutInput struct {
	UserID       *string
	Amount       *string
	AccountID    *string
	Counterparty *string
	Category     string
	Period       *string
	Description  *string
	ShiftID      *string
	// IsOverride — выплата выше расчётного остатка, проведённая осознанно
	// (ЗП-4). false во всех путях, что не прошли через override-ветку.
	IsOverride bool
}

func (s *SalaryService) payout(ctx context.Context, in payoutInput) (*models.FinancialOperation, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	if in.AccountID == nil || *in.AccountID == "" {
		return nil, apperrors.Wrap("VALIDATION", "account_id is required", nil)
	}
	// Общая точка обеих выплат — PaySalary и PayServiceCharge.
	if err := MustBeEnabled(ctx, s.r, *in.AccountID); err != nil {
		return nil, err
	}
	var op *models.FinancialOperation
	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		created, err := payoutTx(ctx, tr, rid, in)
		if err != nil {
			return err
		}
		op = created
		return nil
	})
	if err != nil {
		return nil, err
	}
	return op, nil
}

// periodToOperationDate — бизнес-дата выплаты по периоду начисления (ЗП, вариант
// А). period в формате YYYY-MM (зарплата/аванс) → операция ложится в ЭТОТ месяц,
// а не в месяц фактической проводки: зарплату за июнь платят в июле, но в
// ДДС/ОПиУ она обязана быть июньским расходом (баг: раньше date=сегодня всегда,
// и всё падало в текущий месяц). Берём min(последний день месяца, сегодня): для
// прошлого месяца — его последний день, для текущего — сегодня (без будущих дат).
//
// Не-YYYY-MM period (обслуживание передаёт диапазон "from...to", свободная
// выплата без периода) → "" → вызывающий оставляет сегодняшнюю дату.
func periodToOperationDate(period string, now time.Time) string {
	t, err := time.Parse("2006-01", period)
	if err != nil {
		return ""
	}
	lastDay := t.AddDate(0, 1, -1).Format("2006-01-02") // первый день + месяц − день
	today := now.UTC().Format("2006-01-02")
	if lastDay < today {
		return lastDay
	}
	return today
}

// payoutTx — тело выплаты (списание счёта + FinancialOperation + зеркало в
// кассовую смену), выполняемое ВНУТРИ уже открытой транзакции tr. Вынесено из
// payout(), чтобы GiveAdvance мог провести выплату аванса и создать
// сопутствующую SalaryAdvance-запись + инкремент users.advance в ОДНОЙ
// транзакции (070) — раньше это были два независимых запроса подряд, и
// падение второго теряло синхронизацию счётчика с реально списанными деньгами.
func payoutTx(ctx context.Context, tr *repo.Repo, rid string, in payoutInput) (*models.FinancialOperation, error) {
	if in.UserID == nil || *in.UserID == "" {
		return nil, apperrors.Wrap("VALIDATION", "user_id/waiter_id is required", nil)
	}
	if in.Amount == nil || *in.Amount == "" {
		return nil, apperrors.Wrap("VALIDATION", "amount is required", nil)
	}
	amount, err := decimal.FromString(*in.Amount)
	if err != nil || !decimal.IsPositive(amount) {
		return nil, apperrors.Wrap("VALIDATION", "amount must be positive", err)
	}
	if in.AccountID == nil || *in.AccountID == "" {
		return nil, apperrors.Wrap("VALIDATION", "account_id is required", nil)
	}
	now := time.Now().UTC()
	today := now.Format("2006-01-02")
	// Дата ОПЕРАЦИИ = период начисления (ЗП, вариант А): зарплата/аванс за
	// прошлый месяц ложится в тот месяц в ДДС/ОПиУ, а не в дату проводки.
	// Свободная/override-выплата с периодом сюда попадает так же (тот же
	// payoutInput.Period). Обслуживание (диапазон) и выплата без периода →
	// periodToOperationDate вернёт "" → остаётся сегодня.
	//
	// ВАЖНО: это учётная дата, а НЕ момент движения денег. Наличные из ящика
	// уходят СЕГОДНЯ независимо от периода, поэтому зеркало кассовой смены
	// (recordShiftCashOutIfActive ниже) получает today, не date — иначе для
	// зарплаты за прошлый месяц зеркало пропустилось бы (v3.16.162 отбивает
	// не-сегодняшние даты) и expected_cash показал бы фантомный излишек.
	date := today
	if d := periodToOperationDate(derefOr(in.Period, ""), now); d != "" {
		date = d
	}
	outType := "out"
	activity := "operational"
	category := in.Category
	isAuto := false
	srcRef := *in.UserID
	ridStr := rid

	// Тег периода в описании ("Зарплата:2026-07") — не просто человекочитаемая
	// подпись: PaySalary матчит по нему уже выплаченное за период (ниже,
	// "paid"-запрос), потому что financial_operations.date — это дата САМОЙ
	// проводки (когда деньги реально ушли), а не период, за который платят.
	// Зарплату за июль часто платят в начале августа — "date LIKE период%"
	// в этом случае никогда не совпадает, и кап молча не видит предыдущую
	// выплату. Тег ставим ВСЕГДА, даже если вызывающий передал свой
	// description — иначе для платежа с произвольным текстом период
	// потерялся бы и кап снова ослеп именно на этой проводке.
	desc := in.Description
	if in.Period != nil && *in.Period != "" {
		tag := fmt.Sprintf("%s:%s", category, *in.Period)
		switch {
		case desc == nil || *desc == "":
			desc = &tag
		case !strings.Contains(*desc, tag):
			merged := *desc + " " + tag
			desc = &merged
		}
	}

	tx := tr.Raw().WithContext(ctx)
	var acc models.FinancialAccount
	// FOR UPDATE: блокируем счёт на время read-modify-write баланса,
	// иначе параллельные операции теряют друг друга (порча денег).
	if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
		Where("restaurant_id = ? AND id = ?", rid, *in.AccountID).First(&acc).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apperrors.Wrap("VALIDATION", "account not found", nil)
		}
		return nil, err
	}
	if decimal.IsNegative(decimal.Sub(acc.Balance, amount)) {
		return nil, apperrors.Wrap("CONFLICT", "insufficient funds", nil)
	}
	newBal := decimal.Normalize(decimal.Sub(acc.Balance, amount))
	if err := tx.Model(&acc).Updates(map[string]any{"balance": newBal, "updated_at": now}).Error; err != nil {
		return nil, err
	}
	// Наличная выплата (зарплата/обслуживание) со счёта открытой смены →
	// зеркалим отток в кассовую смену (cash_out), иначе expected_cash в
	// Z-отчёте покажет ложную недостачу. No-op для безнала/закрытой смены.
	// foID — генерируем ЗАРАНЕЕ (а не в поле ниже), чтобы зеркало несло
	// source_ref на саму эту выплату (069, регресс БАГ #28).
	foID := uuid.NewString()
	if err := recordShiftCashOutIfActive(tx, rid, derefOr(in.ShiftID, ""), *in.AccountID, derefOr(desc, category), today, foID, amount, now); err != nil {
		return nil, err
	}
	op := models.FinancialOperation{
		ID:           foID,
		Type:         &outType,
		Amount:       amount,
		Category:     &category,
		AccountID:    in.AccountID,
		AccountName:  acc.Name,
		Activity:     &activity,
		Date:         &date,
		Description:  desc,
		Counterparty: in.Counterparty,
		IsAuto:       &isAuto,
		SourceRef:    &srcRef,
		ShiftID:      in.ShiftID,
		IsOverride:   in.IsOverride,
		RestaurantID: &ridStr,
		CreatedAt:    now,
		UpdatedAt:    now,
	}
	if err := tx.Create(&op).Error; err != nil {
		return nil, err
	}
	return &op, nil
}

// AdvanceInput — выдача аванса (070). См. SalaryService.GiveAdvance.
type AdvanceInput struct {
	UserID    *string `json:"user_id,omitempty"`
	Amount    *string `json:"amount,omitempty"`
	AccountID *string `json:"account_id,omitempty"`
	Period    *string `json:"period,omitempty"`
	Note      *string `json:"note,omitempty"`
	// Override/OverrideReason — тот же кап и тот же принцип, что и в
	// PaySalary (ЗП-4): раньше аванс шёл через PaySalary(kind=advance) и
	// капался ТОЙ ЖЕ формулой (начислено − аванс − удержания − выплачено).
	// GiveAdvance обязан применять этот кап, иначе выдача аванса стала бы
	// неограниченной именно там, где раньше требовала осознанного Override.
	Override       *bool   `json:"override,omitempty"`
	OverrideReason *string `json:"override_reason,omitempty"`
}

// GiveAdvance — выдача аванса ОДНОЙ транзакцией: списание счёта +
// FinancialOperation (категория «Аванс») + строка salary_advances +
// инкремент users.advance. До 070 это были два независимых запроса подряд
// (payout + отдельный PATCH users.advance) — если второй не проходил, деньги
// уходили без обновления счётчика, а без id у "аванса" нечего было
// редактировать/отменять.
func (s *SalaryService) GiveAdvance(ctx context.Context, in AdvanceInput) (*models.SalaryAdvance, error) {
	if err := requirePermFor(ctx, s.r, "payroll.manage"); err != nil {
		return nil, err
	}
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	if in.UserID == nil || *in.UserID == "" {
		return nil, apperrors.Wrap("VALIDATION", "user_id is required", nil)
	}
	if in.Period == nil || *in.Period == "" {
		return nil, apperrors.Wrap("VALIDATION", "period is required", nil)
	}
	if in.AccountID == nil || *in.AccountID == "" {
		return nil, apperrors.Wrap("VALIDATION", "account_id is required", nil)
	}
	if err := MustBeEnabled(ctx, s.r, *in.AccountID); err != nil {
		return nil, err
	}
	amount, perr := decimal.FromString(derefOr(in.Amount, ""))
	if perr != nil || !decimal.IsPositive(amount) {
		return nil, apperrors.Wrap("VALIDATION", "amount must be positive", perr)
	}

	u, accrued, basis, paid, advance, deductions, err := s.salaryCapForPeriod(ctx, *in.UserID, *in.Period)
	if err != nil {
		return nil, err
	}
	isOverride := false
	note := in.Note
	// Тот же принцип, что и в PaySalary: кап действует только если начислено
	// что-то положительное — иначе включение дневной оплаты заблокировало бы
	// авансы до заполнения табеля.
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
			reason := strings.TrimSpace(derefOr(in.OverrideReason, ""))
			if reason == "" {
				return nil, apperrors.Wrap("VALIDATION", "укажите причину свободной выплаты", nil)
			}
			isOverride = true
			merged := mergeOverrideReason(in.Note, reason)
			note = &merged
		}
	}

	actor, _ := audit.ActorFromContext(ctx)
	createdBy := actor.UserID

	var advRow models.SalaryAdvance
	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		op, err := payoutTx(ctx, tr, rid, payoutInput{
			UserID:       in.UserID,
			Amount:       in.Amount,
			AccountID:    in.AccountID,
			Counterparty: u.Name,
			Category:     CategoryAdvance,
			Period:       in.Period,
			Description:  note,
			IsOverride:   isOverride,
		})
		if err != nil {
			return err
		}
		tx := tr.Raw().WithContext(ctx)
		now := time.Now().UTC()
		ridStr := rid
		advRow = models.SalaryAdvance{
			ID:           uuid.NewString(),
			RestaurantID: &ridStr,
			UserID:       *in.UserID,
			Amount:       amount,
			Period:       *in.Period,
			AccountID:    *in.AccountID,
			Note:         in.Note,
			SourceOpID:   &op.ID,
			CreatedBy:    &createdBy,
			CreatedAt:    now,
		}
		if err := tx.Create(&advRow).Error; err != nil {
			return err
		}
		newAdvance := decimal.Normalize(decimal.Add(u.Advance, amount))
		return tx.Model(&models.User{}).Where("restaurant_id = ? AND id = ?", rid, u.ID).
			Updates(map[string]any{"advance": newAdvance, "updated_at": now}).Error
	})
	if err != nil {
		return nil, err
	}
	return &advRow, nil
}

// CancelAdvance — отмена ранее выданного аванса: реверс денег обратно на
// счёт, с которого выдавали (AccountID на строке), декремент users.advance,
// пометка cancelled_at/by. Реверс — отдельная FinancialOperation (тип "in",
// та же категория «Аванс»), а не удаление проводки: следуем тому же
// принципу, что и reverseCloseFinancials — история не переписывается, а
// дополняется компенсирующей записью.
func (s *SalaryService) CancelAdvance(ctx context.Context, id string) (*models.SalaryAdvance, error) {
	if err := requirePermFor(ctx, s.r, "payroll.manage"); err != nil {
		return nil, err
	}
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	if id == "" {
		return nil, apperrors.Wrap("VALIDATION", "id is required", nil)
	}
	actor, _ := audit.ActorFromContext(ctx)
	cancelledBy := actor.UserID

	var row models.SalaryAdvance
	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)
		if err := tx.Where("restaurant_id = ? AND id = ?", rid, id).First(&row).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return apperrors.Wrap("NOT_FOUND", "advance not found", nil)
			}
			return err
		}
		if row.CancelledAt != nil {
			return apperrors.Wrap("VALIDATION", "аванс уже отменён", nil)
		}
		var u models.User
		if err := tx.Where("restaurant_id = ? AND id = ?", rid, row.UserID).First(&u).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return apperrors.Wrap("VALIDATION", "user not found", nil)
			}
			return err
		}
		var acc models.FinancialAccount
		// FOR UPDATE — тот же принцип, что и в payoutTx: блокируем счёт на
		// время read-modify-write баланса.
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("restaurant_id = ? AND id = ?", rid, row.AccountID).First(&acc).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return apperrors.Wrap("VALIDATION", "account not found", nil)
			}
			return err
		}
		now := time.Now().UTC()
		date := now.Format("2006-01-02")
		newBal := decimal.Normalize(decimal.Add(acc.Balance, row.Amount))
		if err := tx.Model(&acc).Updates(map[string]any{"balance": newBal, "updated_at": now}).Error; err != nil {
			return err
		}
		inType := "in"
		activity := "operational"
		category := CategoryAdvance
		isAuto := false
		desc := fmt.Sprintf("Отмена аванса (%s)", row.Period)
		srcRef := row.UserID
		ridStr := rid
		accountID := row.AccountID
		reverseOp := models.FinancialOperation{
			ID:           uuid.NewString(),
			Type:         &inType,
			Amount:       row.Amount,
			Category:     &category,
			AccountID:    &accountID,
			AccountName:  acc.Name,
			Activity:     &activity,
			Date:         &date,
			Description:  &desc,
			Counterparty: u.Name,
			IsAuto:       &isAuto,
			SourceRef:    &srcRef,
			RestaurantID: &ridStr,
			CreatedAt:    now,
			UpdatedAt:    now,
		}
		if err := tx.Create(&reverseOp).Error; err != nil {
			return err
		}
		newAdvance := decimal.Normalize(decimal.Sub(u.Advance, row.Amount))
		if decimal.IsNegative(newAdvance) {
			newAdvance = decimal.Zero
		}
		if err := tx.Model(&u).Updates(map[string]any{"advance": newAdvance, "updated_at": now}).Error; err != nil {
			return err
		}
		row.CancelledAt = &now
		row.CancelledBy = &cancelledBy
		return tx.Model(&models.SalaryAdvance{}).Where("id = ?", row.ID).
			Updates(map[string]any{"cancelled_at": now, "cancelled_by": cancelledBy}).Error
	})
	if err != nil {
		return nil, err
	}
	return &row, nil
}

// ListAdvances — история авансов одного сотрудника, новые сверху.
func (s *SalaryService) ListAdvances(ctx context.Context, userID string) ([]models.SalaryAdvance, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	var rows []models.SalaryAdvance
	if err := scoped.Where("user_id = ?", userID).Order("created_at DESC").Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}

// ServiceAccrualRow / ServicePayoutRow — для сводок по официанту.
type ServiceAccrualRow struct {
	WaiterID      string          `json:"waiter_id"`
	WaiterName    string          `json:"waiter_name"`
	TotalOrders   int             `json:"total_orders"`
	TotalRevenue  decimal.Decimal `json:"total_revenue"`
	AccruedAmount decimal.Decimal `json:"accrued_amount"`
}

type ServicePayoutRow struct {
	WaiterID   string          `json:"waiter_id"`
	WaiterName string          `json:"waiter_name"`
	PaidAmount decimal.Decimal `json:"paid_amount"`
}

// AccrualByWaiter — начисление service-charge за период, сгруппированное по официанту.
// Сумма = SUM(oi.qty * oi.price * o.service_percent / 100) for closed orders.
func (s *SalaryService) AccrualByWaiter(ctx context.Context, from, to *time.Time, shiftID string) ([]ServiceAccrualRow, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	type row struct {
		WaiterID   string          `gorm:"column:waiter_id"`
		WaiterName string          `gorm:"column:waiter_name"`
		Cnt        int             `gorm:"column:cnt"`
		Revenue    decimal.Decimal `gorm:"column:revenue"`
		Accrued    decimal.Decimal `gorm:"column:accrued"`
	}
	raw := s.r.DB().Session(&gormSessionNewDB).WithContext(ctx)
	// Источник правды по обслуживанию — ЗАФИКСИРОВАННОЕ при закрытии
	// o.service_amount (то, что реально начислено и отражено в смене), а НЕ
	// пересчёт из order_items: для весовых позиций пересчёт price×qty/unitSize
	// расходится с зафиксированным числом, и отчёты показывали разное.
	// Без JOIN на order_items — иначе SUM(total_with_service)/COUNT раздувались
	// на число позиций (заказ с 3 строками давал ×3 по выручке).
	q := raw.Table("orders AS o").
		Select(`COALESCE(o.waiter_id::text, '') AS waiter_id,
		        COALESCE(u.name, '') AS waiter_name,
		        COUNT(*) AS cnt,
		        COALESCE(SUM(o.total_with_service), 0) AS revenue,
		        COALESCE(SUM(o.service_amount), 0) AS accrued`).
		Joins("LEFT JOIN users u ON u.id::text = o.waiter_id::text").
		Where("o.restaurant_id = ? AND o.status = ? AND o.closed_at IS NOT NULL", rid, "closed").
		Where("o.waiter_id IS NOT NULL")
	if from != nil {
		q = q.Where("o.closed_at >= ?", *from)
	}
	if to != nil {
		q = q.Where("o.closed_at < ?", *to)
	}
	if shiftID != "" {
		q = q.Where("o.shift_id = ?", shiftID)
	}
	var rows []row
	if err := q.Group("o.waiter_id, u.name").Order("u.name ASC").Scan(&rows).Error; err != nil {
		return nil, err
	}
	out := make([]ServiceAccrualRow, 0, len(rows))
	for _, r := range rows {
		out = append(out, ServiceAccrualRow{
			WaiterID:      r.WaiterID,
			WaiterName:    r.WaiterName,
			TotalOrders:   r.Cnt,
			TotalRevenue:  decimal.Normalize(r.Revenue),
			AccruedAmount: decimal.Normalize(r.Accrued),
		})
	}
	return out, nil
}

// PayoutByWaiter — суммарные выплаты service-charge ('Сервис'%) за период.
func (s *SalaryService) PayoutByWaiter(ctx context.Context, from, to *time.Time, shiftID string) ([]ServicePayoutRow, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	type row struct {
		SourceRef string          `gorm:"column:source_ref"`
		Name      string          `gorm:"column:name"`
		Total     decimal.Decimal `gorm:"column:total"`
	}
	raw := s.r.DB().Session(&gormSessionNewDB).WithContext(ctx)
	q := raw.Table("financial_operations AS fo").
		Select(`COALESCE(fo.source_ref, '') AS source_ref,
		        COALESCE(u.name, COALESCE(fo.counterparty, '')) AS name,
		        COALESCE(SUM(fo.amount), 0) AS total`).
		Joins("LEFT JOIN users u ON u.id::text = fo.source_ref").
		Where("fo.restaurant_id = ? AND fo.type = ?", rid, "out").
		Where("fo.category ILIKE ?", "Сервис%")
	if from != nil {
		q = q.Where("fo.created_at >= ?", *from)
	}
	if to != nil {
		q = q.Where("fo.created_at < ?", *to)
	}
	if shiftID != "" {
		q = q.Where("fo.shift_id = ?", shiftID)
	}
	var rows []row
	if err := q.Group("fo.source_ref, u.name, fo.counterparty").Order("name ASC").Scan(&rows).Error; err != nil {
		return nil, err
	}
	out := make([]ServicePayoutRow, 0, len(rows))
	for _, r := range rows {
		out = append(out, ServicePayoutRow{
			WaiterID:   r.SourceRef,
			WaiterName: r.Name,
			PaidAmount: decimal.Normalize(r.Total),
		})
	}
	return out, nil
}
