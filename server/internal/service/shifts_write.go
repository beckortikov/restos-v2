package service

import (
	"context"
	"errors"
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
	return closed, nil
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
		newOp := &models.CashShiftOperation{
			ID:          uuid.NewString(),
			ShiftID:     &sid,
			Type:        &typ,
			Amount:      amt,
			Description: &desc,
			CreatedBy:   &creator,
			CreatedAt:   now,
			UpdatedAt:   now,
		}
		if err := tx.Create(newOp).Error; err != nil {
			return err
		}
		op = newOp
		return nil
	})
	if err != nil {
		return nil, err
	}
	return op, nil
}
