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

		// Складские единицы + per-unit факторы ингредиентов рецепта — списание
		// пишем в единице склада (рецепт в г/мл → шт/кг), а не в единице тех-карты,
		// иначе денорм ingredients.qty (хук) исказит остаток.
		recipeIngIDs := make([]string, 0, len(lines))
		for _, l := range lines {
			if l.IngredientID != nil && *l.IngredientID != "" {
				recipeIngIDs = append(recipeIngIDs, *l.IngredientID)
			}
		}
		convByID, err := loadIngStockConv(tx, recipeIngIDs)
		if err != nil {
			return err
		}

		// 3. Списываем ингредиенты по рецепту: каждая строка × qty.
		// Параллельно копим стоимость произведённой партии (Σ расход×цена) — из неё
		// считаем себестоимость единицы п/ф (price_per_unit), которая нужна для
		// с/с блюд на п/ф, оценки склада и списаний п/ф. Раньше price_per_unit не
		// проставлялся вовсе → оставался 0, и всё это считалось с нулевой с/с п/ф.
		mvType := "semi_out"
		producedCost := decimal.Zero
		for _, l := range lines {
			if l.IngredientID == nil {
				continue
			}
			ingID := *l.IngredientID
			conv := convByID[ingID]
			stockQty := conv.toStock(decimal.Mul(l.QtyPerUnit, qty), deref(l.Unit))
			producedCost = decimal.Add(producedCost, decimal.Mul(stockQty, conv.pricePerUnit))
			deduct := decimal.Normalize(stockQty).Neg()
			unit := l.Unit
			if conv.unit != "" {
				u := conv.unit
				unit = &u
			}
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

		// Себестоимость единицы этой партии = стоимость партии / произведённое кол-во.
		batchUnitCost := decimal.Zero
		if decimal.IsPositive(qty) {
			batchUnitCost = decimal.DivRound(producedCost, qty)
		}

		// 4. Инкремент SemiFinishedStock — берём с lock или создаём.
		var stock models.SemiFinishedStock
		err = tx.Clauses(clause.Locking{Strength: "UPDATE"}).
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
				PricePerUnit:   decimal.Normalize(batchUnitCost),
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
			// Скользящая средняя себестоимость: (старый остаток×старая цена +
			// стоимость новой партии) / новый остаток. Так с/с п/ф отражает
			// смешение партий разной стоимости (как у ингредиентов на приёмке).
			newQty := decimal.Add(stock.Qty, qty)
			if decimal.IsPositive(newQty) {
				oldValue := decimal.Mul(stock.Qty, stock.PricePerUnit)
				stock.PricePerUnit = decimal.Normalize(decimal.DivRound(decimal.Add(oldValue, producedCost), newQty))
			}
			stock.Qty = decimal.Normalize(newQty)
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
