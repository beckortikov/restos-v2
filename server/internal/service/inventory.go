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

// InventoryLineInput — позиция: для какого ингредиента сколько фактически.
type InventoryLineInput struct {
	IngredientID string `json:"ingredient_id"`
	ActualQty    string `json:"actual_qty"`
}

// Create — создаёт draft инвентаризации со снапшотом system_qty.
func (s *InventoryService) Create(ctx context.Context, in InventoryCheckInput) (*models.InventoryCheck, error) {
	ridStr, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	if len(in.Lines) == 0 {
		return nil, apperrors.Wrap("VALIDATION", "at least one line required", nil)
	}
	actor, _ := audit.ActorFromContext(ctx)

	// Pre-parse lines + достать system_qty для каждого ингредиента.
	parsed := make([]struct {
		IngredientID string
		Actual       decimal.Decimal
	}, len(in.Lines))
	for i, l := range in.Lines {
		actual, err := decimal.FromString(l.ActualQty)
		if err != nil {
			return nil, apperrors.Wrap("VALIDATION", "bad actual_qty", err)
		}
		parsed[i] = struct {
			IngredientID string
			Actual       decimal.Decimal
		}{l.IngredientID, actual}
	}

	var created *models.InventoryCheck
	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)

		// 1. Загружаем актуальные ingredients (system_qty + name + unit).
		ingIDs := make([]string, 0, len(parsed))
		for _, p := range parsed {
			ingIDs = append(ingIDs, p.IngredientID)
		}
		var ingredients []models.Ingredient
		if err := tx.Where("restaurant_id = ? AND id IN ?", ridStr, ingIDs).
			Find(&ingredients).Error; err != nil {
			return err
		}
		ingByID := make(map[string]models.Ingredient, len(ingredients))
		for _, ing := range ingredients {
			ingByID[ing.ID] = ing
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
			ing, ok := ingByID[p.IngredientID]
			if !ok {
				return apperrors.Wrap("VALIDATION", "ingredient not found: "+p.IngredientID, nil)
			}
			diff := decimal.Normalize(decimal.Sub(p.Actual, ing.Qty))
			unit := ""
			if ing.Unit != nil {
				unit = *ing.Unit
			}
			name := ""
			if ing.Name != nil {
				name = *ing.Name
			}
			lines = append(lines, &models.InventoryCheckLine{
				ID:             uuid.NewString(),
				CheckID:        checkID,
				IngredientID:   ing.ID,
				IngredientName: name,
				Unit:           unit,
				SystemQty:      ing.Qty,
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
		for _, l := range lines {
			if l.Diff.IsZero() {
				continue
			}
			// qty в movement = diff (положительный или отрицательный).
			ingID := l.IngredientID
			ingName := l.IngredientName
			unit := l.Unit
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
