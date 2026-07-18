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

// InventoryService — инвентаризация: draft → applied.
//
// Flow:
//  1. POST /stock/inventory  с lines (ingredient_id, actual_qty)
//     → создаём inventory_check (status=draft) + inventory_check_lines с
//     system_qty (текущее) и actual_qty (введённое); diff = actual - system.
//  2. POST /stock/inventory/{id}/apply
//     → берём строки draft'а, для каждой с diff != 0 создаём StockMovement
//     с type="inventory_correction" и qty = diff. Меняем status на "applied"
//     + applied_at. Денорм qty случится автоматически (хук на StockMovement).
type InventoryService struct {
	r *repo.Repo
}

func NewInventoryService(r *repo.Repo) *InventoryService { return &InventoryService{r: r} }

// InventoryCheckInput — body POST /api/v1/stock/inventory.
type InventoryCheckInput struct {
	Note  *string              `json:"note,omitempty"`
	Lines []InventoryLineInput `json:"lines"`
}

// InventoryLineInput — позиция: для какой сущности сколько фактически.
// Kind: ingredient (по умолчанию) | semi (полуфабрикат) | batch (готовая
// заготовка блюда). ingredient_id несёт id соответствующей сущности.
type InventoryLineInput struct {
	IngredientID string `json:"ingredient_id"`
	Kind         string `json:"kind,omitempty"`
	ActualQty    string `json:"actual_qty"`
}

// Create — создаёт draft инвентаризации со снапшотом system_qty.
func (s *InventoryService) Create(ctx context.Context, in InventoryCheckInput) (*models.InventoryCheck, error) {
	if err := requirePermFor(ctx, s.r, "inventory.manage"); err != nil {
		return nil, err
	}
	ridStr, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	if len(in.Lines) == 0 {
		return nil, apperrors.Wrap("VALIDATION", "at least one line required", nil)
	}
	actor, _ := audit.ActorFromContext(ctx)

	// Pre-parse lines + достать system_qty для каждой сущности (по kind).
	parsed := make([]struct {
		ID     string
		Kind   string
		Actual decimal.Decimal
	}, len(in.Lines))
	for i, l := range in.Lines {
		kind := l.Kind
		if kind == "" {
			kind = "ingredient"
		}
		if kind != "ingredient" && kind != "semi" && kind != "batch" {
			return nil, apperrors.Wrap("VALIDATION", "kind must be ingredient, semi or batch", nil)
		}
		actual, err := decimal.FromString(l.ActualQty)
		if err != nil {
			return nil, apperrors.Wrap("VALIDATION", "bad actual_qty", err)
		}
		// Н2: фактический остаток не может быть отрицательным.
		if decimal.IsNegative(actual) {
			return nil, apperrors.Wrap("VALIDATION", "фактический остаток не может быть отрицательным", nil)
		}
		parsed[i] = struct {
			ID     string
			Kind   string
			Actual decimal.Decimal
		}{l.IngredientID, kind, actual}
	}

	var created *models.InventoryCheck
	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)

		// 1. Снапшот system_qty/name/unit по каждому типу (Н1: +semi, +batch).
		var ingIDs, semiIDs, batchIDs []string
		for _, p := range parsed {
			switch p.Kind {
			case "semi":
				semiIDs = append(semiIDs, p.ID)
			case "batch":
				batchIDs = append(batchIDs, p.ID)
			default:
				ingIDs = append(ingIDs, p.ID)
			}
		}
		type invEntity struct {
			name string
			unit string
			qty  decimal.Decimal
		}
		snap := make(map[string]invEntity)
		if len(ingIDs) > 0 {
			var rows []models.Ingredient
			if err := tx.Where("restaurant_id = ? AND id IN ?", ridStr, ingIDs).Find(&rows).Error; err != nil {
				return err
			}
			for _, r := range rows {
				snap["ingredient:"+r.ID] = invEntity{name: deref(r.Name), unit: deref(r.Unit), qty: r.Qty}
			}
		}
		if len(semiIDs) > 0 {
			var rows []models.SemiFinishedStock
			if err := tx.Where("restaurant_id = ? AND id IN ?", ridStr, semiIDs).Find(&rows).Error; err != nil {
				return err
			}
			for _, r := range rows {
				snap["semi:"+r.ID] = invEntity{name: deref(r.Name), unit: deref(r.Unit), qty: r.Qty}
			}
		}
		if len(batchIDs) > 0 {
			var rows []models.MenuItem
			if err := tx.Where("restaurant_id = ? AND id IN ?", ridStr, batchIDs).Find(&rows).Error; err != nil {
				return err
			}
			for _, r := range rows {
				pq := decimal.Zero
				if r.PreparedQty != nil {
					pq = decimal.FromInt(int64(*r.PreparedQty))
				}
				unit := "порц."
				if r.Unit != nil && *r.Unit != "" {
					unit = *r.Unit
				}
				snap["batch:"+r.ID] = invEntity{name: deref(r.Name), unit: unit, qty: pq}
			}
		}

		// 2. Header.
		now := time.Now().UTC()
		checkID := uuid.NewString()
		conducted := actor.UserName
		if conducted == "" {
			conducted = "unknown"
		}
		conductedByID := actor.UserID
		check := &models.InventoryCheck{
			ID:            checkID,
			RestaurantID:  ridStr,
			ConductedBy:   conducted,
			ConductedByID: &conductedByID,
			Status:        "draft",
			Note:          in.Note,
			CreatedAt:     now,
		}

		totalItems := 0
		itemsWithDiff := 0
		lines := make([]*models.InventoryCheckLine, 0, len(parsed))
		for _, p := range parsed {
			e, ok := snap[p.Kind+":"+p.ID]
			if !ok {
				return apperrors.Wrap("VALIDATION", p.Kind+" not found: "+p.ID, nil)
			}
			diff := decimal.Normalize(decimal.Sub(p.Actual, e.qty))
			lines = append(lines, &models.InventoryCheckLine{
				ID:             uuid.NewString(),
				CheckID:        checkID,
				Kind:           p.Kind,
				IngredientID:   p.ID,
				IngredientName: e.name,
				Unit:           e.unit,
				SystemQty:      e.qty,
				ActualQty:      p.Actual,
				Diff:           diff,
				RestaurantID:   ridStr,
			})
			totalItems++
			if !diff.IsZero() {
				itemsWithDiff++
			}
		}
		check.TotalItems = &totalItems
		check.ItemsWithDiff = &itemsWithDiff
		if err := tx.Create(check).Error; err != nil {
			return err
		}
		for _, l := range lines {
			if err := tx.Create(l).Error; err != nil {
				return err
			}
		}
		created = check
		return nil
	})
	if err != nil {
		return nil, err
	}
	return created, nil
}

// Apply применяет draft: проходит по линиям с diff != 0, пишет StockMovement
// для каждой. Хук stock_denorm обновит ingredients.qty автоматически.
//
// Status переходит draft → applied (нельзя дважды).
func (s *InventoryService) Apply(ctx context.Context, checkID string) (*models.InventoryCheck, error) {
	if err := requirePermFor(ctx, s.r, "inventory.manage"); err != nil {
		return nil, err
	}
	ridStr, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}

	var applied *models.InventoryCheck
	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)
		var check models.InventoryCheck
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("restaurant_id = ? AND id = ?", ridStr, checkID).
			First(&check).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return apperrors.ErrNotFound
			}
			return err
		}
		if check.Status != "draft" {
			return apperrors.Wrap("CONFLICT", "inventory check is not in draft", nil)
		}
		var lines []models.InventoryCheckLine
		if err := tx.Where("check_id = ?", checkID).Find(&lines).Error; err != nil {
			return err
		}

		now := time.Now().UTC()
		desc := "inventory:" + checkID
		mvType := "inventory_correction"
		// #22/Н1: цены сущностей для стоимостной проводки недостачи/излишка.
		// ingredient/semi → price_per_unit, batch → cogs (себестоимость порции).
		priceKey := map[string]decimal.Decimal{}
		{
			var ingIDs, semiIDs, batchIDs []string
			for _, l := range lines {
				if l.Diff.IsZero() {
					continue
				}
				switch l.Kind {
				case "semi":
					semiIDs = append(semiIDs, l.IngredientID)
				case "batch":
					batchIDs = append(batchIDs, l.IngredientID)
				default:
					ingIDs = append(ingIDs, l.IngredientID)
				}
			}
			// Н3: tenant-фильтр явно — не читать чужие цены.
			if len(ingIDs) > 0 {
				var rows []models.Ingredient
				if err := tx.Select("id, price_per_unit").Where("restaurant_id = ? AND id IN ?", ridStr, ingIDs).Find(&rows).Error; err != nil {
					return err
				}
				for _, r := range rows {
					priceKey["ingredient:"+r.ID] = r.PricePerUnit
				}
			}
			if len(semiIDs) > 0 {
				var rows []models.SemiFinishedStock
				if err := tx.Select("id, price_per_unit").Where("restaurant_id = ? AND id IN ?", ridStr, semiIDs).Find(&rows).Error; err != nil {
					return err
				}
				for _, r := range rows {
					priceKey["semi:"+r.ID] = r.PricePerUnit
				}
			}
			if len(batchIDs) > 0 {
				var rows []models.MenuItem
				if err := tx.Select("id, cogs").Where("restaurant_id = ? AND id IN ?", ridStr, batchIDs).Find(&rows).Error; err != nil {
					return err
				}
				for _, r := range rows {
					priceKey["batch:"+r.ID] = r.COGS
				}
			}
		}
		shortfallValue := decimal.Zero // стоимость недостачи (diff<0)
		overageValue := decimal.Zero   // стоимость излишка (diff>0)
		// Н4: строки акта недостачи — что именно и на сколько не хватило.
		type shortLine struct {
			ingID, name, unit string
			qty, cost         decimal.Decimal
		}
		var shortLines []shortLine
		for _, l := range lines {
			if l.Diff.IsZero() {
				continue
			}
			ingID := l.IngredientID
			ingName := l.IngredientName
			unit := l.Unit
			// Применяем разницу по типу сущности (Н1).
			switch l.Kind {
			case "semi":
				if err := tx.Model(&models.SemiFinishedStock{}).
					Where("restaurant_id = ? AND id = ?", ridStr, ingID).
					Updates(map[string]any{"qty": gorm.Expr("qty + ?", l.Diff), "updated_at": now}).Error; err != nil {
					return err
				}
			case "batch":
				if err := tx.Model(&models.MenuItem{}).
					Where("restaurant_id = ? AND id = ?", ridStr, ingID).
					Updates(map[string]any{"prepared_qty": gorm.Expr("prepared_qty + ?", int(l.Diff.IntPart())), "updated_at": now}).Error; err != nil {
					return err
				}
			default:
				// Ингредиент: stock_movement inventory_correction → хук денорм qty.
				mv := &models.StockMovement{
					ID:             uuid.NewString(),
					Type:           &mvType,
					IngredientID:   &ingID,
					IngredientName: &ingName,
					Description:    &desc,
					Qty:            l.Diff,
					Unit:           &unit,
					RestaurantID:   &ridStr,
					CreatedAt:      now,
				}
				if err := tx.Create(mv).Error; err != nil {
					return err
				}
			}
			val := decimal.Mul(l.Diff, priceKey[l.Kind+":"+ingID])
			if decimal.IsNegative(l.Diff) {
				shortfallValue = decimal.Add(shortfallValue, val.Neg())
				shortLines = append(shortLines, shortLine{
					ingID: ingID, name: ingName, unit: unit,
					qty:  decimal.Normalize(l.Diff.Neg()),
					cost: decimal.Normalize(val.Neg()),
				})
			} else {
				overageValue = decimal.Add(overageValue, val)
			}
		}
		// #22: недостача — убыток (stock_writeoff, попадает в ОПиУ строкой
		// «Списания»); излишек — прочий доход (взнос капитала). Раньше стоимость
		// расхождения нигде не фиксировалась — убыток тихо испарялся, виден был
		// только как падение оценки склада между снимками.
		if decimal.IsPositive(shortfallValue) {
			woID := uuid.NewString()
			reason := "inventory_shortage"
			note := "Недостача по инвентаризации " + checkID
			if err := tx.Create(&models.StockWriteoff{
				ID: woID, Reason: &reason, Description: &note,
				TotalCost: decimal.Normalize(shortfallValue), RestaurantID: &ridStr, CreatedAt: now, UpdatedAt: now,
			}).Error; err != nil {
				return err
			}
			// Н4: детализация — раньше акт был «пустой» (только сумма), в списке
			// списаний нельзя было понять, чего не хватило.
			for _, sl := range shortLines {
				ingID, name, unit := sl.ingID, sl.name, sl.unit
				if err := tx.Create(&models.StockWriteoffLine{
					ID: uuid.NewString(), WriteoffID: &woID,
					IngredientID: &ingID, Name: &name, Qty: sl.qty,
					Unit: &unit, Cost: sl.cost, UpdatedAt: now,
				}).Error; err != nil {
					return err
				}
			}
		}
		if decimal.IsPositive(overageValue) {
			name := "Излишек по инвентаризации"
			cat := "inventory_overage"
			if err := tx.Create(&models.EquityEntry{
				ID: uuid.NewString(), Name: &name, Category: &cat, Amount: decimal.Normalize(overageValue),
				RestaurantID: &ridStr, CreatedAt: now, UpdatedAt: now,
			}).Error; err != nil {
				return err
			}
		}
		check.Status = "applied"
		check.AppliedAt = &now
		if err := tx.Save(&check).Error; err != nil {
			return err
		}
		applied = &check
		return nil
	})
	if err != nil {
		return nil, err
	}
	return applied, nil
}
