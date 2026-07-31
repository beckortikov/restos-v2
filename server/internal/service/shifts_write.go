package service

import (
	"context"
	"errors"
	"fmt"
	"strings"
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
)

// OpenShiftInput — body POST /api/v1/shifts.
type OpenShiftInput struct {
	OpeningBalance string  `json:"opening_balance"`
	AccountID      *string `json:"account_id,omitempty"`
}

// CloseShiftInput — body POST /api/v1/shifts/{id}/close.
type CloseShiftInput struct {
	ClosingBalance string `json:"closing_balance"`
}

// ShiftOperationInput — body POST /api/v1/shifts/{id}/operations.
type ShiftOperationInput struct {
	Type        string `json:"type"` // cash_in | cash_out
	Amount      string `json:"amount"`
	Description string `json:"description"`
	// Category — заполнена только для расходов (cash_out с категорией). Для
	// внесения/изъятия пустая → хранится NULL, операция считается изъятием.
	Category string `json:"category,omitempty"`
	// AccountID — счёт операции. Пусто → счёт смены (наличный ящик). Для
	// безналичного расхода — id банк-счёта: дебетуется он, наличный ящик
	// (expected_cash) не трогается.
	AccountID string `json:"account_id,omitempty"`
}

// WithPublisher — fluent setter (как в OrdersService).
func (s *ShiftsService) WithPublisher(pub *EventPublisher) *ShiftsService {
	s.pub = pub
	return s
}

// Open открывает новую кассовую смену. Если уже есть открытая для ресторана —
// CONFLICT (только одна открытая смена на ресторан).
func (s *ShiftsService) Open(ctx context.Context, in OpenShiftInput) (*models.CashShift, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	open, err := decimal.FromString(in.OpeningBalance)
	if err != nil {
		return nil, apperrors.Wrap("VALIDATION", "bad opening_balance", err)
	}
	if decimal.IsNegative(open) {
		return nil, apperrors.Wrap("VALIDATION", "opening_balance must be >= 0", nil)
	}
	// Смену нельзя открыть на отключённый счёт — вся наличная выручка пошла бы
	// на счёт, который владелец вывел из оборота.
	if in.AccountID != nil {
		if err := MustBeEnabled(ctx, s.r, *in.AccountID); err != nil {
			return nil, err
		}
	}
	actor, _ := audit.ActorFromContext(ctx)

	var shift *models.CashShift
	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)
		// Уникальный invariant: не больше одной open-смены на ресторан.
		var existing int64
		if err := tx.Model(&models.CashShift{}).
			Where("restaurant_id = ? AND status = ?", rid, "open").
			Count(&existing).Error; err != nil {
			return err
		}
		if existing > 0 {
			return apperrors.Wrap("CONFLICT", "another shift is already open", nil)
		}

		now := time.Now().UTC()
		status := "open"
		opener := actor.UserID
		newShift := &models.CashShift{
			ID:             uuid.NewString(),
			RestaurantID:   &rid,
			AccountID:      in.AccountID,
			Status:         &status,
			OpenedBy:       &opener,
			OpeningBalance: open,
			CashRevenue:    decimal.Zero,
			CardRevenue:    decimal.Zero,
			OpenedAt:       now,
			UpdatedAt:      now,
		}
		if err := tx.Create(newShift).Error; err != nil {
			return err
		}
		if err := recordShiftSync(tx, newShift, "insert"); err != nil {
			return err
		}
		shift = newShift
		return nil
	})
	if err != nil {
		return nil, err
	}
	if s.pub != nil {
		buf := NewBuffer()
		buf.Add(EventShiftOpened, map[string]any{"id": shift.ID})
		s.pub.Flush(ctx, rid, buf)
	}
	return shift, nil
}

// Close закрывает смену. expected_cash = opening_balance + cash_revenue + cash_in - cash_out.
// closing_balance — введён кассиром (пересчёт). Расхождение = closing - expected.
func (s *ShiftsService) Close(ctx context.Context, shiftID string, in CloseShiftInput) (*models.CashShift, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	closing, err := decimal.FromString(in.ClosingBalance)
	if err != nil {
		return nil, apperrors.Wrap("VALIDATION", "bad closing_balance", err)
	}
	actor, _ := audit.ActorFromContext(ctx)

	var closed *models.CashShift
	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)
		var shift models.CashShift
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("restaurant_id = ? AND id = ?", rid, shiftID).
			First(&shift).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return apperrors.ErrNotFound
			}
			return err
		}
		if shift.Status == nil || *shift.Status != "open" {
			return apperrors.Wrap("CONFLICT", "shift is not open", nil)
		}

		// Guard: нельзя закрыть смену, пока есть незакрытые заказы (открытые
		// столы или «с собой»). Иначе выручка/остатки этих заказов не попадут
		// в смену. Сообщаем кассиру, что именно закрыть.
		var openOrders []models.Order
		if err := tx.
			Where("restaurant_id = ? AND status NOT IN ?", rid, []string{"closed", "cancelled"}).
			Order("order_number ASC").
			Find(&openOrders).Error; err != nil {
			return err
		}
		if len(openOrders) > 0 {
			// order_ids/order_numbers — machine-readable, чтобы фронт мог сразу
			// предложить открыть/отменить именно эти заказы (независимо от того,
			// к какой смене/дате они привязаны — «Активные заказы» скоупятся на
			// текущую смену и не находят заказы-«хвосты» из прошлых смен).
			ids := make([]string, len(openOrders))
			numbers := make([]int, len(openOrders))
			for i, o := range openOrders {
				ids[i] = o.ID
				numbers[i] = o.OrderNumber
			}
			return apperrors.WrapDetails("CONFLICT", openOrdersMessage(tx, rid, openOrders), map[string]any{
				"order_ids":     ids,
				"order_numbers": numbers,
			}, nil)
		}

		expected, err := computeExpectedCash(tx, shiftID, &shift)
		if err != nil {
			return err
		}

		now := time.Now().UTC()
		status := "closed"
		closedBy := actor.UserID
		shift.Status = &status
		shift.ClosingBalance = closing
		shift.ExpectedCash = &expected
		shift.ClosedAt = &now
		shift.ClosedBy = &closedBy
		shift.UpdatedAt = now
		if err := tx.Save(&shift).Error; err != nil {
			return err
		}
		if err := recordShiftSync(tx, &shift, "update"); err != nil {
			return err
		}
		closed = &shift
		return nil
	})
	if err != nil {
		return nil, err
	}
	if s.pub != nil {
		buf := NewBuffer()
		buf.Add(EventShiftClosed, map[string]any{"id": closed.ID})
		s.pub.Flush(ctx, rid, buf)
	}
	// v3.9.1: авто-бэкап при закрытии смены. Fire-and-forget — не блокирует
	// ответ кассиру. pg_dump за 2-15с в фоне. Касса работает 12-16ч/день,
	// закрытие смены = гарантированно работающая машина (не надеемся на
	// «комп включён ночью» как у 3:00-cron).
	if s.backup != nil {
		go func() {
			bctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
			defer cancel()
			if f, err := s.backup.CreateAuto(bctx); err != nil {
				// Не критично — ежедневный 3:00-cron подстрахует. Логируем.
				// (BackupService.CreateAuto уже логирует детали.)
				_ = err
			} else {
				_ = f
			}
		}()
	}
	return closed, nil
}

// openOrdersMessage строит сообщение кассиру о незакрытых заказах, мешающих
// закрыть смену: перечисляет столы и заказы «с собой»/доставку.
func openOrdersMessage(tx *gorm.DB, rid string, orders []models.Order) string {
	// Имена столов для hall-заказов.
	tableIDs := make([]string, 0, len(orders))
	for _, o := range orders {
		if o.TableID != nil && *o.TableID != "" {
			tableIDs = append(tableIDs, *o.TableID)
		}
	}
	tableLabel := make(map[string]string)
	if len(tableIDs) > 0 {
		var tables []models.Table
		tx.Where("restaurant_id = ? AND id IN ?", rid, tableIDs).Find(&tables)
		for _, t := range tables {
			switch {
			case t.Number != nil:
				tableLabel[t.ID] = fmt.Sprintf("Стол %d", *t.Number)
			case t.Name != nil && *t.Name != "":
				tableLabel[t.ID] = *t.Name
			default:
				tableLabel[t.ID] = "Стол"
			}
		}
	}

	labels := make([]string, 0, len(orders))
	seen := make(map[string]bool)
	for _, o := range orders {
		var label string
		switch {
		case o.Type != nil && *o.Type == "delivery":
			label = fmt.Sprintf("Доставка №%d", o.OrderNumber)
		case o.Type != nil && *o.Type == "takeaway":
			label = fmt.Sprintf("«С собой» №%d", o.OrderNumber)
		case o.TableID != nil && tableLabel[*o.TableID] != "":
			label = tableLabel[*o.TableID]
		default:
			label = fmt.Sprintf("Заказ №%d", o.OrderNumber)
		}
		if !seen[label] {
			seen[label] = true
			labels = append(labels, label)
		}
	}

	const maxShown = 10
	extra := 0
	if len(labels) > maxShown {
		extra = len(labels) - maxShown
		labels = labels[:maxShown]
	}
	msg := "Сначала закройте: " + strings.Join(labels, ", ")
	if extra > 0 {
		msg += fmt.Sprintf(" и ещё %d", extra)
	}
	return msg
}

// UpdateAccountInput — body PATCH /api/v1/shifts/{id}.
type UpdateAccountInput struct {
	AccountID string `json:"account_id"`
}

// UpdateAccount привязывает (или меняет) финансовый счёт к открытой смене.
// Нужно для recovery legacy-смен, открытых без accountId — без него
// createShiftExpense и payServiceCharge падают.
// Изменение запрещено для закрытых смен (фиксированный отчёт).
func (s *ShiftsService) UpdateAccount(ctx context.Context, shiftID string, in UpdateAccountInput) (*models.CashShift, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	if in.AccountID == "" {
		return nil, apperrors.Wrap("VALIDATION", "account_id is required", nil)
	}
	if err := MustBeEnabled(ctx, s.r, in.AccountID); err != nil {
		return nil, err
	}

	var updated *models.CashShift
	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)
		var shift models.CashShift
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("restaurant_id = ? AND id = ?", rid, shiftID).
			First(&shift).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return apperrors.ErrNotFound
			}
			return err
		}
		if shift.Status == nil || *shift.Status != "open" {
			return apperrors.Wrap("CONFLICT", "shift is not open", nil)
		}
		// Verify account exists in this tenant and is of type 'cash'.
		var acc models.FinancialAccount
		if err := tx.Where("restaurant_id = ? AND id = ?", rid, in.AccountID).
			First(&acc).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return apperrors.Wrap("VALIDATION", "account not found", nil)
			}
			return err
		}
		if acc.Type == nil || *acc.Type != "cash" {
			return apperrors.Wrap("VALIDATION", "account must be of type 'cash'", nil)
		}

		now := time.Now().UTC()
		shift.AccountID = &in.AccountID
		shift.UpdatedAt = now
		if err := tx.Save(&shift).Error; err != nil {
			return err
		}
		if err := recordShiftSync(tx, &shift, "update"); err != nil {
			return err
		}
		updated = &shift
		return nil
	})
	if err != nil {
		return nil, err
	}
	if s.pub != nil {
		buf := NewBuffer()
		buf.Add(EventShiftOpened, map[string]any{"id": updated.ID, "patched": true})
		s.pub.Flush(ctx, rid, buf)
	}
	return updated, nil
}

// opTouchesDrawer — трогает ли операция наличный ящик смены. Наличной считаем
// операцию без своего счёта (legacy/наличные) или на самом счёте смены.
// Операция на другом счёте (безналичный расход) ящик не трогает.
func opTouchesDrawer(opAccountID, shiftAccountID *string) bool {
	if opAccountID == nil || *opAccountID == "" {
		return true
	}
	if shiftAccountID == nil || *shiftAccountID == "" {
		return false
	}
	return *opAccountID == *shiftAccountID
}

// computeExpectedCash — expected_cash = opening_balance + cash_revenue +
// Σcash_in − Σcash_out (только операции, касающиеся наличного ящика — см.
// opTouchesDrawer). Общий расчёт для Close() и для пересчёта уже закрытой
// смены после удаления фантомного __auto_mirror__ (см. DeleteExpense в
// shifts_extras.go) — без него список операций и сохранённая цифра в Z-отчёте
// расходятся.
func computeExpectedCash(tx *gorm.DB, shiftID string, shift *models.CashShift) (decimal.Decimal, error) {
	var ops []models.CashShiftOperation
	if err := tx.Where("shift_id = ?", shiftID).Find(&ops).Error; err != nil {
		return decimal.Zero, err
	}
	opSum := decimal.Zero
	for _, op := range ops {
		if op.Type == nil {
			continue
		}
		if !opTouchesDrawer(op.AccountID, shift.AccountID) {
			continue
		}
		switch *op.Type {
		case "cash_in":
			opSum = decimal.Add(opSum, op.Amount)
		case "cash_out":
			opSum = decimal.Sub(opSum, op.Amount)
		}
	}
	return decimal.Normalize(
		decimal.Add(decimal.Add(shift.OpeningBalance, shift.CashRevenue), opSum),
	), nil
}

// AddOperation вносит cash_in / cash_out в смену.
func (s *ShiftsService) AddOperation(ctx context.Context, shiftID string, in ShiftOperationInput) (*models.CashShiftOperation, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	if in.Type != "cash_in" && in.Type != "cash_out" {
		return nil, apperrors.Wrap("VALIDATION", "type must be cash_in or cash_out", nil)
	}
	amt, err := decimal.FromString(in.Amount)
	if err != nil {
		return nil, apperrors.Wrap("VALIDATION", "bad amount", err)
	}
	if !decimal.IsPositive(amt) {
		return nil, apperrors.Wrap("VALIDATION", "amount must be > 0", nil)
	}
	// Безналичный расход из смены целится в конкретный банк-счёт — он должен
	// быть включён. Пустой account_id = наличный ящик (счёт смены), он уже
	// проверен при открытии смены.
	if a := strings.TrimSpace(in.AccountID); a != "" {
		if err := MustBeEnabled(ctx, s.r, a); err != nil {
			return nil, err
		}
	}
	actor, _ := audit.ActorFromContext(ctx)

	var op *models.CashShiftOperation
	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)
		// Убедимся, что смена принадлежит ресторану и открыта.
		var shift models.CashShift
		if err := tx.Where("restaurant_id = ? AND id = ?", rid, shiftID).
			First(&shift).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return apperrors.ErrNotFound
			}
			return err
		}
		if shift.Status == nil || *shift.Status != "open" {
			return apperrors.Wrap("CONFLICT", "shift is not open", nil)
		}

		now := time.Now().UTC()
		sid := shiftID
		typ := in.Type
		desc := in.Description
		creator := actor.UserID
		var category *string
		if c := strings.TrimSpace(in.Category); c != "" {
			category = &c
		}
		// Целевой счёт операции: явный account_id (безналичный расход с банк-счёта)
		// либо счёт смены (наличный ящик). Храним на операции только если он
		// отличается от счёта смены — тогда Close/ZReport понимают, что наличный
		// ящик эта операция не трогает.
		var opAccountID *string
		if a := strings.TrimSpace(in.AccountID); a != "" {
			opAccountID = &a
		}
		targetAccountID := shift.AccountID
		if opAccountID != nil {
			targetAccountID = opAccountID
		}
		newOp := &models.CashShiftOperation{
			ID:          uuid.NewString(),
			ShiftID:     &sid,
			Type:        &typ,
			Amount:      amt,
			Description: &desc,
			Category:    category,
			AccountID:   opAccountID,
			CreatedBy:   &creator,
			CreatedAt:   now,
			UpdatedAt:   now,
		}
		if err := tx.Create(newOp).Error; err != nil {
			return err
		}
		op = newOp

		// Расход из смены (cash_out С категорией) — это операционный расход
		// бизнеса, а не просто движение налички в ящике (в отличие от
		// внесения/изъятия без категории). ОПиУ и ДДС читают ТОЛЬКО
		// financial_operations, поэтому без этой записи расход был виден
		// лишь в самой смене (Сводка/X-Z) и пропадал из P&L и cashflow.
		if typ == "cash_out" && category != nil {
			var accountName *string
			if targetAccountID != nil && *targetAccountID != "" {
				var acc models.FinancialAccount
				if err := tx.Where("id = ?", *targetAccountID).First(&acc).Error; err == nil {
					accountName = acc.Name
				}
			}
			opType := "out"
			activity := "operational"
			date := now.Format("2006-01-02")
			isAuto := true
			srcRef := "shift_expense:" + newOp.ID
			fo := &models.FinancialOperation{
				ID:           uuid.NewString(),
				Type:         &opType,
				Amount:       amt,
				Category:     category,
				AccountID:    targetAccountID,
				AccountName:  accountName,
				Activity:     &activity,
				Date:         &date,
				Description:  &desc,
				IsAuto:       &isAuto,
				SourceRef:    &srcRef,
				ShiftID:      &sid,
				RestaurantID: &rid,
				CreatedAt:    now,
				UpdatedAt:    now,
			}
			if err := tx.Create(fo).Error; err != nil {
				return err
			}
			// Н13: дебетуем ЦЕЛЕВОЙ счёт на сумму расхода (наличный ящик смены или
			// банк-счёт при безналичном расходе). Раньше баланс НЕ трогали — но
			// выручка счёт кредитует полностью при закрытии заказа, а кассовые
			// расходы его не уменьшали → «Денежные средства» в Балансе
			// систематически завышались на сумму всех расходов за всю историю.
			// Гард «недостаточно средств» НЕ применяем: opening_balance смены на
			// счёт не постится, поэтому свежая смена может списать из физического
			// флоата больше, чем на балансе счёта — относительное движение всё
			// равно верное, а ложный отказ заблокировал бы реальную закупку.
			if targetAccountID != nil && *targetAccountID != "" {
				// Model(&FinancialAccount{ID: ...}), не голый литерал: ADR-003
				// Ф5 — generic trackedSave-хук достаёт RowID через reflection.
				if err := tx.Model(&models.FinancialAccount{ID: *targetAccountID}).
					Where("restaurant_id = ?", rid).
					Updates(map[string]any{
						"balance":    gorm.Expr("balance - ?", amt),
						"updated_at": now,
					}).Error; err != nil {
					return err
				}
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return op, nil
}

// recordShiftCashOutIfActive зеркалит отток наличных со счёта в кассовую смену.
// Если accountID — счёт открытой смены, создаёт cash_shift_operation type=cash_out,
// чтобы expected_cash в Z-отчёте (= opening + cash_revenue + cash_in − cash_out)
// совпал с фактической наличкой в ящике. Без этого возвраты и выплаты (зарплата/
// обслуживание) наличными списывали баланс счёта, но не уменьшали expected_cash →
// Z-отчёт показывал ложную недостачу. Вызывается ВНУТРИ транзакции операции.
// No-op, если открытой смены на этом счёте нет (напр. безнал-счёт или смена закрыта).
//
// opDate — бизнес-дата самой финоперации (то, что пользователь выбрал в форме;
// пусто = «не указана явно», всегда сегодня). Если операция ЗАДНИМ ЧИСЛОМ
// (opDate ≠ сегодня) — зеркало НЕ создаём: это исторический учётный факт (забыли
// внести расход за прошлую смену), а не движение в физическом ящике ТЕКУЩЕЙ
// открытой смены. Мы не знаем, ушли ли деньги из кассы именно сегодня — если
// зеркалить как обычно, ДДС-запись задним числом создаёт фантомную
// недостачу/излишек в СЕГОДНЯШНЕМ Z-отчёте, а сама операция и так корректно
// легла на свою дату в ДДС (foBizDay). Инцидент 23.07.2026.
func recordShiftCashOutIfActive(tx *gorm.DB, rid, shiftID, accountID, desc, opDate string, amount decimal.Decimal, now time.Time) error {
	if !decimal.IsPositive(amount) {
		return nil
	}
	if opDate != "" && opDate != now.Format("2006-01-02") {
		return nil
	}
	var shift models.CashShift
	var err error
	if shiftID != "" {
		// Операция явно привязана к смене (выплата/возврат «со смены» несёт
		// shift_id) — зеркалим ИМЕННО в неё, даже если у смены не задан или не
		// совпадает счёт. Раньше искали только по account_id: если смена без
		// счёта (или выплата с другого счёта), матчинг промахивался → баланс
		// счёта уменьшался, а expected_cash смены — нет (касса и смена
		// расходились). Одно зеркало на операцию — двойного оттока нет.
		err = tx.Where("restaurant_id = ? AND status = ? AND id = ?", rid, "open", shiftID).First(&shift).Error
	} else {
		// Вне контекста смены (shift_id не передан) — зеркалим, только если счёт
		// принадлежит открытой смене.
		if accountID == "" {
			return nil
		}
		err = tx.Where("restaurant_id = ? AND status = ? AND account_id = ?", rid, "open", accountID).First(&shift).Error
	}
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	t := "cash_out"
	d := desc
	// #28: помечаем авто-зеркало — его нельзя удалять из смены как обычное
	// изъятие (иначе expected_cash поднимется, а деньги со счёта уже ушли).
	autoCat := autoMirrorCategory
	op := &models.CashShiftOperation{
		ID:          uuid.NewString(),
		ShiftID:     &shift.ID,
		Type:        &t,
		Amount:      decimal.Normalize(amount),
		Description: &d,
		Category:    &autoCat,
		CreatedAt:   now,
		UpdatedAt:   now,
	}
	return tx.Create(op).Error
}

// autoMirrorCategory — метка авто-зеркал cash_out (зарплата/возврат/ручной
// расход наличными). Такие операции создаёт система как отражение оттока со
// счёта; удалять их вручную нельзя (см. DeleteOperation).
const autoMirrorCategory = "__auto_mirror__"
