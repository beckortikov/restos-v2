package service

import (
	"context"
	"errors"
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

// SemiPrepareInput — body POST /api/v1/semi/prepare.
type SemiPrepareInput struct {
	SemiTypeID string  `json:"semi_type_id"`
	Qty        string  `json:"qty"`
	PreparedBy *string `json:"prepared_by,omitempty"`
}

// SemiConsumeInput — body POST /api/v1/semi/consume.
type SemiConsumeInput struct {
	SemiTypeID string  `json:"semi_type_id"`
	Qty        string  `json:"qty"`
	OrderID    *string `json:"order_id,omitempty"`
}

// Prepare — POST /api/v1/semi/prepare.
// Производит N единиц полуфабриката из рецепта:
//   - для каждой строки рецепта пишет StockMovement type='semi_out' (списание
//     ингредиента; хук stock_denorm обновит ingredients.qty);
//   - инкрементит SemiFinishedStock.qty для этого semi_type_id (создаёт row
//     если не существует);
//   - возвращает обновлённый stock row.
func (s *SemiFinishedService) Prepare(ctx context.Context, in SemiPrepareInput) (*models.SemiFinishedStock, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	if in.SemiTypeID == "" {
		return nil, apperrors.Wrap("VALIDATION", "semi_type_id is required", nil)
	}
	qty, err := decimal.FromString(in.Qty)
	if err != nil {
		return nil, apperrors.Wrap("VALIDATION", "bad qty", err)
	}
	if !decimal.IsPositive(qty) {
		return nil, apperrors.Wrap("VALIDATION", "qty must be > 0", nil)
	}

	var out *models.SemiFinishedStock
	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)

		// 1. Полуфабрикат принадлежит ресторану.
		var st models.SemiFinishedType
		if err := tx.Where("restaurant_id = ? AND id = ?", rid, in.SemiTypeID).
			First(&st).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return apperrors.ErrNotFound
			}
			return err
		}

		// 2. Рецепт (recipe lines).
		var lines []models.SemiRecipeLine
		if err := tx.Where("semi_type_id = ?", in.SemiTypeID).
			Find(&lines).Error; err != nil {
			return err
		}

		now := time.Now().UTC()
		desc := "semi_prepare:" + in.SemiTypeID

		// 3. Списываем ингредиенты по рецепту: каждая строка × qty.
		mvType := "semi_out"
		for _, l := range lines {
			if l.IngredientID == nil {
				continue
			}
			deduct := decimal.Normalize(decimal.Mul(l.QtyPerUnit, qty)).Neg()
			ingID := *l.IngredientID
			unit := l.Unit
			mv := &models.StockMovement{
				ID:             uuid.NewString(),
				Type:           &mvType,
				IngredientID:   &ingID,
				IngredientName: l.Name,
				Description:    &desc,
				Qty:            deduct,
				Unit:           unit,
				RestaurantID:   &rid,
				CreatedAt:      now,
			}
			if err := tx.Create(mv).Error; err != nil {
				return err
			}
		}

		// 4. Инкремент SemiFinishedStock — берём с lock или создаём.
		var stock models.SemiFinishedStock
		err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("restaurant_id = ? AND semi_type_id = ?", rid, in.SemiTypeID).
			First(&stock).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			tid := in.SemiTypeID
			stock = models.SemiFinishedStock{
				ID:             uuid.NewString(),
				SemiTypeID:     &tid,
				Name:           st.Name,
				Qty:            decimal.Normalize(qty),
				Unit:           st.OutputUnit,
				LastProducedAt: &now,
				RestaurantID:   &rid,
				CreatedAt:      now,
				UpdatedAt:      now,
			}
			if err := tx.Create(&stock).Error; err != nil {
				return err
			}
		} else if err != nil {
			return err
		} else {
			stock.Qty = decimal.Normalize(decimal.Add(stock.Qty, qty))
			stock.LastProducedAt = &now
			stock.UpdatedAt = now
			if err := tx.Save(&stock).Error; err != nil {
				return err
			}
		}
		out = &stock
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// Consume — POST /api/v1/semi/consume.
// Декрементит SemiFinishedStock.qty. Записывает StockMovement type='semi_out'
// (без ингредиента — это маркер расхода полуфабриката).
func (s *SemiFinishedService) Consume(ctx context.Context, in SemiConsumeInput) (*models.SemiFinishedStock, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	if in.SemiTypeID == "" {
		return nil, apperrors.Wrap("VALIDATION", "semi_type_id is required", nil)
	}
	qty, err := decimal.FromString(in.Qty)
	if err != nil {
		return nil, apperrors.Wrap("VALIDATION", "bad qty", err)
	}
	if !decimal.IsPositive(qty) {
		return nil, apperrors.Wrap("VALIDATION", "qty must be > 0", nil)
	}

	var out *models.SemiFinishedStock
	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)
		var stock models.SemiFinishedStock
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("restaurant_id = ? AND semi_type_id = ?", rid, in.SemiTypeID).
			First(&stock).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return apperrors.ErrNotFound
			}
			return err
		}
		now := time.Now().UTC()
		stock.Qty = decimal.Normalize(decimal.Sub(stock.Qty, qty))
		stock.UpdatedAt = now
		if err := tx.Save(&stock).Error; err != nil {
			return err
		}
		out = &stock
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}
