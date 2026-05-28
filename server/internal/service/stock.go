package service

import (
	"context"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/cursor"
	"github.com/restos/restos-v4/server/internal/repo"
)

type StockService struct {
	r   *repo.Repo
	pub *EventPublisher
}

func NewStockService(r *repo.Repo) *StockService {
	return &StockService{r: r}
}

// IngredientsFilter — фильтры для GET /stock/ingredients.
type IngredientsFilter struct {
	Category string
	Query    string
	LowOnly  bool // qty <= min_qty
	Page     cursor.Page
}

// ListIngredients — пагинированный список ингредиентов.
func (s *StockService) ListIngredients(ctx context.Context, f IngredientsFilter) ([]models.Ingredient, string, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, "", err
	}
	q := scoped
	if f.Category != "" {
		q = q.Where("category = ?", f.Category)
	}
	if f.Query != "" {
		q = q.Where("name ILIKE ?", "%"+f.Query+"%")
	}
	if f.LowOnly {
		q = q.Where("qty <= min_qty")
	}
	q = cursor.Apply(q, "ingredients", f.Page)
	var rows []models.Ingredient
	if err := q.Find(&rows).Error; err != nil {
		return nil, "", err
	}
	limit := cursor.NormalizeLimit(f.Page.Limit)
	trimmed, next := cursor.Next(rows, limit, func(m models.Ingredient) cursor.Token {
		return cursor.Token{Time: m.CreatedAt, ID: m.ID}
	})
	return trimmed, next, nil
}
