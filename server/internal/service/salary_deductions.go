// salary_deductions — удержания из зарплаты с сохранённой причиной (ЗП-4,
// миграция 064). Раньше удержание было чистым счётчиком на users.deductions:
// причина показывалась тостом и терялась, ни одной записи не оставалось.
//
// НЕ FinancialOperation: удержание не двигает баланс счёта — деньги не
// выданы, им неоткуда "выходить". Это только уменьшение будущей выплаты,
// проверяемого в PaySalary (accrued − advance − deductions − paid).
package service

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/audit"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
	apperrors "github.com/restos/restos-v4/server/internal/pkg/errors"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
	"github.com/restos/restos-v4/server/internal/repo"
)

type DeductionInput struct {
	UserID *string `json:"user_id,omitempty"`
	Amount *string `json:"amount,omitempty"`
	Reason *string `json:"reason,omitempty"`
	// Period — YYYY-MM, к какому месяцу относится удержание (070). Опционально
	// для обратной совместимости со старыми клиентами.
	Period *string `json:"period,omitempty"`
	// SourceRef — маркер происхождения (105). Ставит только сервер (штраф за
	// опоздание), из тела запроса не принимается: иначе клиент мог бы занять
	// чужой ключ и заблокировать штраф.
	SourceRef *string `json:"-"`
}

// AddDeduction — создаёт запись удержания и увеличивает users.deductions
// в одной транзакции. Причина обязательна — без неё запись бессмысленна:
// единственная цель этой сущности — не терять "за что удержали".
func (s *SalaryService) AddDeduction(ctx context.Context, in DeductionInput) (*models.SalaryDeduction, error) {
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
	if in.Amount == nil || *in.Amount == "" {
		return nil, apperrors.Wrap("VALIDATION", "amount is required", nil)
	}
	amount, perr := decimal.FromString(*in.Amount)
	if perr != nil || !decimal.IsPositive(amount) {
		return nil, apperrors.Wrap("VALIDATION", "amount must be positive", perr)
	}
	reason := strings.TrimSpace(derefOr(in.Reason, ""))
	if reason == "" {
		return nil, apperrors.Wrap("VALIDATION", "укажите причину удержания", nil)
	}

	actor, _ := audit.ActorFromContext(ctx)
	createdBy := actor.UserID
	now := time.Now().UTC()
	ridStr := rid
	dedID := *in.UserID
	row := &models.SalaryDeduction{
		ID:           uuid.NewString(),
		RestaurantID: &ridStr,
		UserID:       dedID,
		Amount:       amount,
		Reason:       reason,
		Period:       in.Period,
		SourceRef:    in.SourceRef,
		CreatedBy:    &createdBy,
		CreatedAt:    now,
	}

	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)
		var u models.User
		if err := tx.Where("restaurant_id = ? AND id = ?", rid, *in.UserID).First(&u).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return apperrors.Wrap("VALIDATION", "user not found", nil)
			}
			return err
		}
		if err := tx.Create(row).Error; err != nil {
			return err
		}
		if err := recordSalaryDeductionSync(tx, row); err != nil {
			return err
		}
		newDeductions := decimal.Normalize(decimal.Add(u.Deductions, amount))
		if err := tx.Model(&u).Updates(map[string]any{"deductions": newDeductions, "updated_at": now}).Error; err != nil {
			return err
		}
		// users.deductions — денормализованный счётчик, читаемый SalaryAccrual;
		// без ре-синка строки users central видит новую строку в
		// salary_deductions, но старую (нулевую) сумму в самой карточке
		// сотрудника (найдено вживую в Ф5б — central 500'ил на отсутствующей
		// salary_day_multipliers, а после её восстановления удержание всё
		// равно не отражалось в начислении).
		u.Deductions = newDeductions
		return recordUserSync(tx, &u, "update")
	})
	if err != nil {
		return nil, err
	}
	return row, nil
}

// CancelDeduction — отмена удержания (070): помечает cancelled_at/by и
// уменьшает users.deductions. Без движения денег по счёту — удержание и не
// двигало баланс (см. комментарий к SalaryDeduction), отменять там нечего.
func (s *SalaryService) CancelDeduction(ctx context.Context, id string) (*models.SalaryDeduction, error) {
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

	var row models.SalaryDeduction
	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)
		if err := tx.Where("restaurant_id = ? AND id = ?", rid, id).First(&row).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return apperrors.Wrap("NOT_FOUND", "deduction not found", nil)
			}
			return err
		}
		if row.CancelledAt != nil {
			return apperrors.Wrap("VALIDATION", "удержание уже отменено", nil)
		}
		var u models.User
		if err := tx.Where("restaurant_id = ? AND id = ?", rid, row.UserID).First(&u).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return apperrors.Wrap("VALIDATION", "user not found", nil)
			}
			return err
		}
		now := time.Now().UTC()
		newDeductions := decimal.Normalize(decimal.Sub(u.Deductions, row.Amount))
		if decimal.IsNegative(newDeductions) {
			newDeductions = decimal.Zero
		}
		if err := tx.Model(&u).Updates(map[string]any{"deductions": newDeductions, "updated_at": now}).Error; err != nil {
			return err
		}
		u.Deductions = newDeductions
		if err := recordUserSync(tx, &u, "update"); err != nil {
			return err
		}
		row.CancelledAt = &now
		row.CancelledBy = &cancelledBy
		if err := tx.Model(&models.SalaryDeduction{}).Where("id = ?", row.ID).
			Updates(map[string]any{"cancelled_at": now, "cancelled_by": cancelledBy}).Error; err != nil {
			return err
		}
		return recordSalaryDeductionSync(tx, &row)
	})
	if err != nil {
		return nil, err
	}
	return &row, nil
}

// ListDeductions — история удержаний одного сотрудника, новые сверху.
func (s *SalaryService) ListDeductions(ctx context.Context, userID string) ([]models.SalaryDeduction, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	var rows []models.SalaryDeduction
	if err := scoped.Where("user_id = ?", userID).Order("created_at DESC").Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}
