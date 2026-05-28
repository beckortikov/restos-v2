package service

import (
	"context"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/cursor"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
	"github.com/restos/restos-v4/server/internal/repo"
)

// MenuService — чтение меню (Phase 2 read-only).
type MenuService struct {
	r *repo.Repo
}

func NewMenuService(r *repo.Repo) *MenuService {
	return &MenuService{r: r}
}

// MenuItemsFilter — фильтры для GET /menu/items.
type MenuItemsFilter struct {
	Category                string // точное совпадение (если задано)
	Query                   string // ILIKE %q% по name (использует GIN trgm)
	OnlyAvailable           bool
	IncludeTechCards        bool // подгрузить tech_card_lines для каждого блюда (batch-query)
	IncludeIngredientPrices bool // подгрузить ingredients{price, unit, waste} из tech card lines
	Page                    cursor.Page
}

// MenuItemWithExtras — расширенный DTO с tech_card_lines.
// `tech_card_lines` всегда присутствует (пустой массив, если не запрошены),
// чтобы фронту не нужно было ветвить тип ответа.
type MenuItemWithExtras struct {
	models.MenuItem
	TechCardLines []models.TechCardLine `json:"tech_card_lines"`
}

// IngredientPrice — компактный DTO для top-level карты ingredient_prices.
type IngredientPrice struct {
	Price        decimal.Decimal `json:"price"`
	Unit         string          `json:"unit"`
	WastePercent decimal.Decimal `json:"waste_percent"`
}

// MenuItemsResult — результат ListItems. Всегда включает Items и пустые
// extras-поля; фронт читает их безусловно.
type MenuItemsResult struct {
	Items            []MenuItemWithExtras
	IngredientPrices map[string]IngredientPrice
	NextCursor       string
}

// ListItems возвращает блюда ресторана из контекста.
// is_deleted=true автоматически отфильтровывается (фронт не должен их видеть).
//
// Когда f.IncludeTechCards=true — батч-запросом подгружаются tech_card_lines
// (одним SELECT WHERE menu_item_id IN (...)) и группируются по menu_item_id.
// Когда дополнительно f.IncludeIngredientPrices=true — подтягиваются цены
// ингредиентов одним SELECT WHERE id IN (...) и возвращаются как top-level map.
func (s *MenuService) ListItems(ctx context.Context, f MenuItemsFilter) (MenuItemsResult, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return MenuItemsResult{}, err
	}
	q := scoped.Where("is_deleted = ?", false)
	if f.Category != "" {
		q = q.Where("category = ?", f.Category)
	}
	if f.Query != "" {
		q = q.Where("name ILIKE ?", "%"+f.Query+"%")
	}
	if f.OnlyAvailable {
		q = q.Where("is_available = ?", true)
	}
	q = cursor.Apply(q, "menu_items", f.Page)
	var rows []models.MenuItem
	if err := q.Find(&rows).Error; err != nil {
		return MenuItemsResult{}, err
	}
	limit := cursor.NormalizeLimit(f.Page.Limit)
	trimmed, next := cursor.Next(rows, limit, func(m models.MenuItem) cursor.Token {
		return cursor.Token{Time: m.CreatedAt, ID: m.ID}
	})

	out := MenuItemsResult{
		Items:            make([]MenuItemWithExtras, 0, len(trimmed)),
		IngredientPrices: map[string]IngredientPrice{},
		NextCursor:       next,
	}

	// Batch tech card lines (1 запрос).
	linesByItem := map[string][]models.TechCardLine{}
	if f.IncludeTechCards && len(trimmed) > 0 {
		ids := make([]string, 0, len(trimmed))
		for _, m := range trimmed {
			ids = append(ids, m.ID)
		}
		scopedTC, err := s.r.ForTenant(ctx)
		if err != nil {
			return MenuItemsResult{}, err
		}
		var lines []models.TechCardLine
		if err := scopedTC.Where("menu_item_id IN ?", ids).Find(&lines).Error; err != nil {
			return MenuItemsResult{}, err
		}
		for _, l := range lines {
			if l.MenuItemID == nil {
				continue
			}
			linesByItem[*l.MenuItemID] = append(linesByItem[*l.MenuItemID], l)
		}

		// Batch ingredient prices (1 запрос) — собираем ingredient_id из tech card lines.
		if f.IncludeIngredientPrices && len(lines) > 0 {
			ingIDsSet := map[string]struct{}{}
			for _, l := range lines {
				if l.IngredientID != nil && *l.IngredientID != "" {
					ingIDsSet[*l.IngredientID] = struct{}{}
				}
			}
			if len(ingIDsSet) > 0 {
				ingIDs := make([]string, 0, len(ingIDsSet))
				for id := range ingIDsSet {
					ingIDs = append(ingIDs, id)
				}
				scopedIng, err := s.r.ForTenant(ctx)
				if err != nil {
					return MenuItemsResult{}, err
				}
				var ings []models.Ingredient
				if err := scopedIng.Where("id IN ?", ingIDs).Find(&ings).Error; err != nil {
					return MenuItemsResult{}, err
				}
				for _, i := range ings {
					unit := ""
					if i.Unit != nil {
						unit = *i.Unit
					}
					out.IngredientPrices[i.ID] = IngredientPrice{
						Price:        i.PricePerUnit,
						Unit:         unit,
						WastePercent: i.WastePercent,
					}
				}
			}
		}
	}

	for _, m := range trimmed {
		lines := linesByItem[m.ID]
		if lines == nil {
			lines = []models.TechCardLine{}
		}
		out.Items = append(out.Items, MenuItemWithExtras{MenuItem: m, TechCardLines: lines})
	}
	return out, nil
}

// ListCategories — простой список без пагинации (категорий обычно < 50).
func (s *MenuService) ListCategories(ctx context.Context) ([]models.MenuCategory, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	var rows []models.MenuCategory
	if err := scoped.Order("sort_order ASC, name ASC").Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}
