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

		// Сумма shift-операций (внос/изъятие) — для expected_cash.
		var opSum decimal.Decimal
		var ops []models.CashShiftOperation
		if err := tx.Where("shift_id = ?", shiftID).Find(&ops).Error; err != nil {
			return err
		}
		opSum = decimal.Zero
		for _, op := range ops {
			if op.Type == nil {
				continue
			}
			switch *op.Type {
			case "cash_in":
				opSum = decimal.Add(opSum, op.Amount)
			case "cash_out":
				opSum = decimal.Sub(opSum, op.Amount)
			}
		}
		expected := decimal.Normalize(
			decimal.Add(decimal.Add(shift.OpeningBalance, shift.CashRevenue), opSum),
		)

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
		newOp := &models.CashShiftOperation{
			ID:          uuid.NewString(),
			ShiftID:     &sid,
			Type:        &typ,
			Amount:      amt,
			Description: &desc,
			Category:    category,
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
		// account_id — best-effort (для трассировки); баланс счёта НЕ трогаем:
		// opening_balance смены никогда не постился на счёт, поэтому списание
		// с баланса создало бы ложное «недостаточно средств» на свежих сменах.
		if typ == "cash_out" && category != nil {
			var accountName *string
			if shift.AccountID != nil && *shift.AccountID != "" {
				var acc models.FinancialAccount
				if err := tx.Where("id = ?", *shift.AccountID).First(&acc).Error; err == nil {
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
				AccountID:    shift.AccountID,
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
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return op, nil
}
