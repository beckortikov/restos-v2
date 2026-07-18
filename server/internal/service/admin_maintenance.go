package service

import (
	"context"
	"errors"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
	apperrors "github.com/restos/restos-v4/server/internal/pkg/errors"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
	"github.com/restos/restos-v4/server/internal/repo"
)

// MaintenanceService — разовые обслуживающие операции (Н13-ретро и т.п.).
type MaintenanceService struct{ r *repo.Repo }

func NewMaintenanceService(r *repo.Repo) *MaintenanceService { return &MaintenanceService{r: r} }

// ShiftBalanceFixLine — сколько будет/было списано с одного счёта.
type ShiftBalanceFixLine struct {
	AccountID    string          `json:"account_id"`
	AccountName  string          `json:"account_name"`
	BalanceNow   decimal.Decimal `json:"balance_now"`
	Correction   decimal.Decimal `json:"correction"`
	BalanceAfter decimal.Decimal `json:"balance_after"`
	OpsCount     int             `json:"ops_count"`
}

// ShiftBalanceFixResult — превью или итог коррекции.
type ShiftBalanceFixResult struct {
	AlreadyApplied  bool                  `json:"already_applied"`
	AppliedAt       *time.Time            `json:"applied_at,omitempty"`
	Cutoff          string                `json:"cutoff"`
	Lines           []ShiftBalanceFixLine `json:"lines"`
	TotalCorrection decimal.Decimal       `json:"total_correction"`
}

// computeShiftBalanceFix — читает per-account суммы shift_expense-финопов до
// cutoff (те, что до фикса v3.16.94 НЕ дебетовали счёт). Только чтение.
func (s *MaintenanceService) computeShiftBalanceFix(ctx context.Context, cutoff time.Time) ([]ShiftBalanceFixLine, error) {
	scoped, err := s.r.ForTenantQualified(ctx, "fo")
	if err != nil {
		return nil, err
	}
	var rows []ShiftBalanceFixLine
	if err := scoped.Table("financial_operations AS fo").
		Select(`fo.account_id AS account_id,
		        MAX(fa.name) AS account_name,
		        MAX(fa.balance) AS balance_now,
		        COALESCE(SUM(fo.amount), 0) AS correction,
		        COUNT(*) AS ops_count`).
		Joins("JOIN financial_accounts fa ON fa.id::text = fo.account_id::text").
		Where("fo.type = ? AND fo.source_ref LIKE ? AND fo.created_at < ? AND fo.account_id IS NOT NULL",
			"out", "shift_expense:%", cutoff).
		Group("fo.account_id").
		Order("correction DESC").
		Scan(&rows).Error; err != nil {
		return nil, err
	}
	for i := range rows {
		rows[i].Correction = decimal.Normalize(rows[i].Correction)
		rows[i].BalanceAfter = decimal.Normalize(decimal.Sub(rows[i].BalanceNow, rows[i].Correction))
	}
	return rows, nil
}

func sumCorrection(lines []ShiftBalanceFixLine) decimal.Decimal {
	total := decimal.Zero
	for _, l := range lines {
		total = decimal.Add(total, l.Correction)
	}
	return decimal.Normalize(total)
}

// PreviewShiftBalanceFix — что будет скорректировано (без изменений). Показывает
// маркер already_applied, если коррекция уже выполнялась.
func (s *MaintenanceService) PreviewShiftBalanceFix(ctx context.Context, cutoff time.Time) (*ShiftBalanceFixResult, error) {
	if err := requirePermFor(ctx, s.r, "finance.manage"); err != nil {
		return nil, err
	}
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	out := &ShiftBalanceFixResult{Cutoff: cutoff.UTC().Format(time.RFC3339), Lines: []ShiftBalanceFixLine{}}

	var rest models.Restaurant
	if err := s.r.DB().WithContext(ctx).Select("shift_balance_corrected_at").Where("id = ?", rid).First(&rest).Error; err == nil {
		if rest.ShiftBalanceCorrectedAt != nil {
			out.AlreadyApplied = true
			out.AppliedAt = rest.ShiftBalanceCorrectedAt
		}
	}
	lines, err := s.computeShiftBalanceFix(ctx, cutoff)
	if err != nil {
		return nil, err
	}
	out.Lines = lines
	out.TotalCorrection = sumCorrection(lines)
	return out, nil
}

// ApplyShiftBalanceFix — применяет коррекцию РОВНО ОДИН РАЗ. Маркер
// restaurants.shift_balance_corrected_at защищает от повторного списания.
func (s *MaintenanceService) ApplyShiftBalanceFix(ctx context.Context, cutoff time.Time) (*ShiftBalanceFixResult, error) {
	if err := requirePermFor(ctx, s.r, "finance.manage"); err != nil {
		return nil, err
	}
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	out := &ShiftBalanceFixResult{Cutoff: cutoff.UTC().Format(time.RFC3339), Lines: []ShiftBalanceFixLine{}}

	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)
		// Ресторан под замком — маркер проверяем и ставим атомарно.
		var rest models.Restaurant
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("id = ?", rid).First(&rest).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return apperrors.ErrNotFound
			}
			return err
		}
		if rest.ShiftBalanceCorrectedAt != nil {
			return apperrors.Wrap("CONFLICT", "коррекция балансов уже выполнена — повтор запрещён (иначе списание задвоится)", nil)
		}

		lines, err := s.computeShiftBalanceFix(ctx, cutoff)
		if err != nil {
			return err
		}
		now := time.Now().UTC()
		for _, l := range lines {
			if !decimal.IsPositive(l.Correction) {
				continue
			}
			if err := tx.Model(&models.FinancialAccount{}).
				Where("restaurant_id = ? AND id = ?", rid, l.AccountID).
				Updates(map[string]any{
					"balance":    gorm.Expr("balance - ?", l.Correction),
					"updated_at": now,
				}).Error; err != nil {
				return err
			}
		}
		// Ставим маркер — второй запуск отобьётся.
		if err := tx.Model(&models.Restaurant{}).Where("id = ?", rid).
			Update("shift_balance_corrected_at", now).Error; err != nil {
			return err
		}
		out.Lines = lines
		out.TotalCorrection = sumCorrection(lines)
		out.AlreadyApplied = true
		out.AppliedAt = &now
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}
