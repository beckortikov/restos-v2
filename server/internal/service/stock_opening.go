package service

// OpeningBalance — ввод НАЧАЛЬНОГО остатка склада (не инвентаризация, которая
// показала бы «излишек»). На каждую позицию создаётся stock_movement типа
// "opening_balance" (хук денормализует ingredients.qty), а на суммарную
// стоимость заведённого склада создаётся автопроводка в капитал —
// «Взнос собственника» (equity_entries). Тогда Баланс сходится: вырос актив
// «Склад» и встречно — собственный капитал.

import (
	"context"
	"time"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
	apperrors "github.com/restos/restos-v4/server/internal/pkg/errors"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
	"github.com/restos/restos-v4/server/internal/repo"
)

type OpeningBalanceLine struct {
	IngredientID string `json:"ingredient_id"`
	Qty          string `json:"qty"` // decimal as string (в единице склада)
}

type OpeningBalanceInput struct {
	Lines []OpeningBalanceLine `json:"lines"`
	Note  *string              `json:"note,omitempty"`
}

type OpeningBalanceResult struct {
	Applied        int             `json:"applied"`
	InventoryValue decimal.Decimal `json:"inventory_value"`
	EquityEntryID  *string         `json:"equity_entry_id,omitempty"`
}

func (s *StockService) OpeningBalance(ctx context.Context, in OpeningBalanceInput) (*OpeningBalanceResult, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	if len(in.Lines) == 0 {
		return nil, apperrors.Wrap("VALIDATION", "no lines", nil)
	}

	res := &OpeningBalanceResult{InventoryValue: decimal.Zero}
	now := time.Now().UTC()
	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)
		total := decimal.Zero
		applied := 0
		for _, l := range in.Lines {
			qty, e := decimal.FromString(l.Qty)
			if e != nil || qty.IsZero() {
				continue
			}
			var ing models.Ingredient
			if err := tx.Where("id = ? AND restaurant_id = ?", l.IngredientID, rid).First(&ing).Error; err != nil {
				return apperrors.Wrap("VALIDATION", "ingredient not found: "+l.IngredientID, err)
			}
			mvType := "opening_balance"
			desc := "Начальный остаток"
			mv := &models.StockMovement{
				ID: uuid.NewString(), Type: &mvType, IngredientID: &l.IngredientID,
				IngredientName: ing.Name, Description: &desc, Qty: qty, Unit: ing.Unit,
				RestaurantID: &rid, CreatedAt: now,
			}
			if err := tx.Create(mv).Error; err != nil {
				return err
			}
			total = decimal.Add(total, decimal.Mul(qty, ing.PricePerUnit))
			applied++
		}
		if applied == 0 {
			return apperrors.Wrap("VALIDATION", "нет позиций с ненулевым остатком", nil)
		}
		res.Applied = applied
		res.InventoryValue = decimal.Normalize(total)

		// Автопроводка: взнос собственника на стоимость заведённого склада.
		if total.IsPositive() {
			name := "Взнос собственника — начальный остаток склада"
			cat := "opening_inventory"
			eq := &models.EquityEntry{
				ID: uuid.NewString(), Name: &name, Category: &cat, Amount: decimal.Normalize(total),
				Note: in.Note, RestaurantID: &rid, CreatedAt: now, UpdatedAt: now,
			}
			if err := tx.Create(eq).Error; err != nil {
				return err
			}
			res.EquityEntryID = &eq.ID
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return res, nil
}
