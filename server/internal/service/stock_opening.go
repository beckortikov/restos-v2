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
	IngredientID string  `json:"ingredient_id"`
	Qty          string  `json:"qty"`             // decimal as string (в единице склада)
	Price        *string `json:"price,omitempty"` // себестоимость за единицу; если задана — обновит ingredient.price_per_unit и пойдёт в стоимость
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
	if err := requirePermFor(ctx, s.r, "inventory.manage"); err != nil {
		return nil, err
	}
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
			// Н12: битую строку не пропускаем молча — это редкая ручная операция,
			// где применилось «7 из 10» без объяснения. Любая невалидная строка —
			// ошибка всей операции с указанием, что не так.
			target, e := decimal.FromString(l.Qty)
			if e != nil {
				return apperrors.Wrap("VALIDATION", "строка «"+l.IngredientID+"»: некорректное количество", e)
			}
			if decimal.IsNegative(target) {
				return apperrors.Wrap("VALIDATION", "строка «"+l.IngredientID+"»: количество не может быть отрицательным", nil)
			}
			var ing models.Ingredient
			if err := tx.Where("id = ? AND restaurant_id = ?", l.IngredientID, rid).First(&ing).Error; err != nil {
				return apperrors.Wrap("VALIDATION", "ingredient not found: "+l.IngredientID, err)
			}
			// Себестоимость: берём введённую (закуп мог быть по другой цене) и
			// обновляем ingredient.price_per_unit, иначе — текущую цену ингредиента.
			price := ing.PricePerUnit
			if l.Price != nil && *l.Price != "" {
				p, e := decimal.FromString(*l.Price)
				if e != nil || decimal.IsNegative(p) {
					// Н12: битую цену не проглатываем (иначе тихо взяли бы старую).
					return apperrors.Wrap("VALIDATION", "строка «"+l.IngredientID+"»: некорректная цена", e)
				}
				price = p
				if !p.Equal(ing.PricePerUnit) {
					if err := tx.Model(&models.Ingredient{}).Where("id = ?", l.IngredientID).
						Update("price_per_unit", p).Error; err != nil {
						return err
					}
					// qty синкнётся отдельно, автоматически, через stockAfterCreate
					// (audit/stock_hook.go) когда ниже создастся StockMovement —
					// здесь синкаем ТОЛЬКО цену, если она реально изменилась.
					if err := recordIngredientSync(tx, []string{l.IngredientID}); err != nil {
						return err
					}
				}
			}
			// Начальный остаток — это УСТАНОВКА остатка в target, а не добавление
			// сверху. Движение на дельту (target − current); повторный ввод тех же
			// значений → дельта 0 → ничего не меняется (идемпотентно).
			delta := decimal.Sub(target, ing.Qty)
			if delta.IsZero() {
				continue
			}
			mvType := "opening_balance"
			desc := "Начальный остаток (установка)"
			mv := &models.StockMovement{
				ID: uuid.NewString(), Type: &mvType, IngredientID: &l.IngredientID,
				IngredientName: ing.Name, Description: &desc, Qty: delta, Unit: ing.Unit,
				RestaurantID: &rid, CreatedAt: now,
			}
			if err := tx.Create(mv).Error; err != nil {
				return err
			}
			total = decimal.Add(total, decimal.Mul(delta, price))
			applied++
		}
		res.Applied = applied
		res.InventoryValue = decimal.Normalize(total)

		// Автопроводка: взнос собственника на стоимость ДЕЛЬТЫ остатка. При
		// повторном вводе тех же значений дельта (и проводка) = 0 — Баланс не
		// раздувается. При корректировке вниз дельта (и проводка) отрицательна.
		if !total.IsZero() {
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
