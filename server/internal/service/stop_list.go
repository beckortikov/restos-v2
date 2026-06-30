package service

import (
	"context"
	"errors"
	"time"

	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
	apperrors "github.com/restos/restos-v4/server/internal/pkg/errors"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
	"github.com/restos/restos-v4/server/internal/repo"
)

// StopListService — compute-on-read стоп-листа.
// Логика: блюдо в стопе если:
//  1. menu_items.stop_list_override = true, ИЛИ
//  2. его tech_card_line ссылается на ингредиент с qty <= min_qty.
type StopListService struct{ r *repo.Repo }

func NewStopListService(r *repo.Repo) *StopListService { return &StopListService{r: r} }

// StopListIngredient — недостающий ингредиент в строке стоп-листа.
type StopListIngredient struct {
	Name   string          `json:"name"`
	Qty    decimal.Decimal `json:"qty"`
	MinQty decimal.Decimal `json:"min_qty"`
	Unit   string          `json:"unit"`
}

// StopListItem — позиция стоп-листа (для одного menu_item).
type StopListItem struct {
	MenuItemID   string               `json:"menu_item_id"`
	MenuItemName string               `json:"menu_item_name"`
	Emoji        string               `json:"emoji"`
	Category     string               `json:"category"`
	Ingredients  []StopListIngredient `json:"ingredients"`
	Manual       bool                 `json:"manual"`
	// Unavailable — блюдо помечено «СТОП» вручную в меню (is_available=false).
	// Снять стоп = вернуть доступность (is_available=true).
	Unavailable bool `json:"unavailable"`
}

// List — GET /api/v1/stop-list.
func (s *StopListService) List(ctx context.Context) ([]StopListItem, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}

	// Авто-стоп (по остаткам сырья и по готовым порциям) применяется ТОЛЬКО в
	// строгом режиме: учёт по техкартам + контроль остатков (enforce_stock_check).
	// Если контроль выключен (lenient) — склад может уходить в минус и позиции
	// продаются свободно, поэтому авто-стопа нет: в стопе остаются лишь ручные
	// override'ы. Согласовано с проверкой заказа (stockcheck, v3.9.108).
	var rest models.Restaurant
	if err := s.r.Raw().WithContext(ctx).Select("tech_cards_enabled, enforce_stock_check").
		Where("id = ?", rid).First(&rest).Error; err != nil {
		return nil, err
	}
	techEnabled := rest.TechCardsEnabled == nil || *rest.TechCardsEnabled
	enforce := rest.EnforceStockCheck != nil && *rest.EnforceStockCheck
	autoStop := techEnabled && enforce

	// 1–2. Меню-позиции, чьи tech-card-lines ссылаются на low-stock ингредиенты.
	affected := make(map[string][]StopListIngredient)
	if autoStop {
		var lowIngs []models.Ingredient
		if err := s.r.Raw().WithContext(ctx).
			Where("restaurant_id = ? AND qty <= min_qty", rid).
			Find(&lowIngs).Error; err != nil {
			return nil, err
		}
		lowByID := make(map[string]StopListIngredient, len(lowIngs))
		lowIDs := make([]string, 0, len(lowIngs))
		for _, i := range lowIngs {
			name := ""
			if i.Name != nil {
				name = *i.Name
			}
			unit := ""
			if i.Unit != nil {
				unit = *i.Unit
			}
			lowByID[i.ID] = StopListIngredient{Name: name, Qty: i.Qty, MinQty: i.MinQty, Unit: unit}
			lowIDs = append(lowIDs, i.ID)
		}
		if len(lowIDs) > 0 {
			var lines []models.TechCardLine
			if err := s.r.Raw().WithContext(ctx).
				Where("restaurant_id = ? AND ingredient_id IN ?", rid, lowIDs).
				Find(&lines).Error; err != nil {
				return nil, err
			}
			for _, l := range lines {
				if l.MenuItemID == nil || l.IngredientID == nil {
					continue
				}
				ing, ok := lowByID[*l.IngredientID]
				if !ok {
					continue
				}
				affected[*l.MenuItemID] = append(affected[*l.MenuItemID], ing)
			}
		}
	}

	// 3. Manual overrides — menu_items.stop_list_override = true (без удалённых).
	var manualItems []models.MenuItem
	if err := s.r.Raw().WithContext(ctx).
		Where("restaurant_id = ? AND stop_list_override = ? AND is_deleted = ?", rid, true, false).
		Find(&manualItems).Error; err != nil {
		return nil, err
	}
	manualIDs := make(map[string]bool, len(manualItems))
	for _, m := range manualItems {
		manualIDs[m.ID] = true
	}

	// 3a. Ручной СТОП через доступность — menu_items.is_available = false.
	// Это и есть «галочка СТОП» в управлении меню: блюдо должно попасть в
	// стоп-лист и уйти из ПОС. Применяется во ВСЕХ режимах (не только strict).
	var unavailItems []models.MenuItem
	if err := s.r.Raw().WithContext(ctx).
		Where("restaurant_id = ? AND is_available = ? AND is_deleted = ?", rid, false, false).
		Find(&unavailItems).Error; err != nil {
		return nil, err
	}
	unavailIDs := make(map[string]bool, len(unavailItems))
	for _, m := range unavailItems {
		unavailIDs[m.ID] = true
	}

	// 3b. Заготовочные блюда без готовых порций (prepared_qty <= 0). Их
	// доступность определяется prepared_qty, а НЕ остатком сырья: блюдо с
	// готовыми порциями продаётся даже при нулевом сырье и в стоп НЕ идёт.
	batchZeroIDs := make(map[string]bool)
	if autoStop {
		var batchZero []models.MenuItem
		if err := s.r.Raw().WithContext(ctx).
			Where("restaurant_id = ? AND is_deleted = ? AND is_batch_cooking = ? AND (prepared_qty <= 0 OR prepared_qty IS NULL)", rid, false, true).
			Find(&batchZero).Error; err != nil {
			return nil, err
		}
		for _, m := range batchZero {
			batchZeroIDs[m.ID] = true
		}
	}

	// 4. Объединяем set и грузим menu_items одним запросом.
	allIDs := make(map[string]bool)
	for id := range affected {
		allIDs[id] = true
	}
	for id := range manualIDs {
		allIDs[id] = true
	}
	for id := range unavailIDs {
		allIDs[id] = true
	}
	for id := range batchZeroIDs {
		allIDs[id] = true
	}
	if len(allIDs) == 0 {
		return []StopListItem{}, nil
	}
	ids := make([]string, 0, len(allIDs))
	for id := range allIDs {
		ids = append(ids, id)
	}
	var items []models.MenuItem
	if err := s.r.Raw().WithContext(ctx).
		Where("restaurant_id = ? AND id IN ? AND is_deleted = ?", rid, ids, false).
		Find(&items).Error; err != nil {
		return nil, err
	}

	out := make([]StopListItem, 0, len(items))
	for _, m := range items {
		name := ""
		if m.Name != nil {
			name = *m.Name
		}
		emoji := ""
		if m.Emoji != nil {
			emoji = *m.Emoji
		}
		category := ""
		if m.Category != nil {
			category = *m.Category
		}
		manual := manualIDs[m.ID]
		unavailable := unavailIDs[m.ID]
		isBatch := m.IsBatchCooking != nil && *m.IsBatchCooking

		var ings []StopListIngredient
		inStop := manual || unavailable
		if isBatch {
			// Заготовка: стоп только если нет готовых порций (или ручной override).
			// Остаток сырья (affected) для заготовок НЕ учитываем.
			if batchZeroIDs[m.ID] {
				inStop = true
				prep := 0
				if m.PreparedQty != nil {
					prep = *m.PreparedQty
				}
				ings = []StopListIngredient{{
					Name:   "Готовые порции",
					Qty:    decimal.FromInt(int64(prep)),
					MinQty: decimal.Zero,
					Unit:   "порц.",
				}}
			}
		} else {
			// Обычное блюдо: стоп по нехватке сырья из техкарты.
			ings = affected[m.ID]
			if len(ings) > 0 {
				inStop = true
			}
		}
		if !inStop {
			// batch с готовыми порциями, попавший в allIDs только из-за low-сырья.
			continue
		}

		out = append(out, StopListItem{
			MenuItemID:   m.ID,
			MenuItemName: name,
			Emoji:        emoji,
			Category:     category,
			Ingredients:  ings,
			Manual:       manual,
			Unavailable:  unavailable,
		})
	}
	return out, nil
}

// StopListOverrideInput — body POST /api/v1/stop-list/{menu_item_id}/override.
type StopListOverrideInput struct {
	Override bool `json:"override"`
}

// SetOverride — POST /api/v1/stop-list/{menu_item_id}/override.
func (s *StopListService) SetOverride(ctx context.Context, menuItemID string, in StopListOverrideInput) (*models.MenuItem, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	var item models.MenuItem
	if err := scoped.Where("id = ?", menuItemID).First(&item).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apperrors.ErrNotFound
		}
		return nil, err
	}
	scoped2, _ := s.r.ForTenant(ctx)
	if err := scoped2.Model(&item).
		Updates(map[string]any{
			"stop_list_override": in.Override,
			"updated_at":         time.Now().UTC(),
		}).Error; err != nil {
		return nil, err
	}
	scoped3, _ := s.r.ForTenant(ctx)
	var out models.MenuItem
	if err := scoped3.Where("id = ?", menuItemID).First(&out).Error; err != nil {
		return nil, err
	}
	return &out, nil
}

// Recompute — POST /api/v1/stop-list/recompute. No-op для FE-совместимости.
func (s *StopListService) Recompute(ctx context.Context) (map[string]any, error) {
	if _, err := tenant.MustRestaurantID(ctx); err != nil {
		return nil, err
	}
	return map[string]any{"ok": true}, nil
}
