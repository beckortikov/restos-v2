package service

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
	apperrors "github.com/restos/restos-v4/server/internal/pkg/errors"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
)

// MenuItemInput — body POST/PATCH /api/v1/menu/items.
//
// На POST все поля кроме name+price опциональны (defaults в БД).
// На PATCH передаются только меняемые поля — остальные не трогаем.
//
// Pointer-семантика: поле = nil → не менять; поле = &"" → выставить пустое.
type MenuItemInput struct {
	Name              *string `json:"name,omitempty"`
	Category          *string `json:"category,omitempty"`
	Price             *string `json:"price,omitempty"` // decimal as string
	Emoji             *string `json:"emoji,omitempty"`
	ImageURL          *string `json:"image_url,omitempty"`
	IsAvailable       *bool   `json:"is_available,omitempty"`
	StopListOverride  *bool   `json:"stop_list_override,omitempty"`
	COGS              *string `json:"cogs,omitempty"`
	CookTimeMin       *int    `json:"cook_time_min,omitempty"`
	Station           *string `json:"station,omitempty"`
	IsBatchCooking    *bool   `json:"is_batch_cooking,omitempty"`
	Unit              *string `json:"unit,omitempty"`
	UnitSize          *string `json:"unit_size,omitempty"`
	SaleStep          *string `json:"sale_step,omitempty"`
	LowStockThreshold *int    `json:"low_stock_threshold,omitempty"`
}

// MenuCategoryInput — body POST/PATCH /api/v1/menu/categories.
type MenuCategoryInput struct {
	Name      *string `json:"name,omitempty"`
	SortOrder *int    `json:"sort_order,omitempty"`
}

// CreateItem создаёт menu_item. name и price обязательны.
func (s *MenuService) CreateItem(ctx context.Context, in MenuItemInput) (*models.MenuItem, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	if in.Name == nil || *in.Name == "" {
		return nil, apperrors.Wrap("VALIDATION", "name is required", nil)
	}
	if in.Price == nil {
		return nil, apperrors.Wrap("VALIDATION", "price is required", nil)
	}
	price, err := decimal.FromString(*in.Price)
	if err != nil {
		return nil, apperrors.Wrap("VALIDATION", "bad price", err)
	}
	if decimal.IsNegative(price) {
		return nil, apperrors.Wrap("VALIDATION", "price must be >= 0", nil)
	}

	now := time.Now().UTC()
	mi := &models.MenuItem{
		ID:           uuid.NewString(),
		Name:         in.Name,
		Category:     in.Category,
		Price:        price,
		Emoji:        in.Emoji,
		ImageURL:     in.ImageURL,
		IsAvailable:  in.IsAvailable,
		COGS:         decimal.Zero,
		CookTimeMin:  in.CookTimeMin,
		Station:      in.Station,
		Unit:         in.Unit,
		UnitSize:     decimal.MustFromString("1"),
		RestaurantID: &rid,
		CreatedAt:    now,
		UpdatedAt:    now,
	}
	if in.COGS != nil {
		c, err := decimal.FromString(*in.COGS)
		if err != nil {
			return nil, apperrors.Wrap("VALIDATION", "bad cogs", err)
		}
		mi.COGS = c
	}
	if in.UnitSize != nil {
		u, err := decimal.FromString(*in.UnitSize)
		if err != nil {
			return nil, apperrors.Wrap("VALIDATION", "bad unit_size", err)
		}
		mi.UnitSize = u
	}
	if in.SaleStep != nil {
		ss, err := decimal.FromString(*in.SaleStep)
		if err != nil {
			return nil, apperrors.Wrap("VALIDATION", "bad sale_step", err)
		}
		mi.SaleStep = ss
	}
	if in.LowStockThreshold != nil {
		mi.LowStockThreshold = *in.LowStockThreshold
	}
	if in.IsBatchCooking != nil {
		mi.IsBatchCooking = in.IsBatchCooking
	}
	if in.StopListOverride != nil {
		mi.StopListOverride = in.StopListOverride
	}

	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	if err := scoped.Create(mi).Error; err != nil {
		return nil, err
	}
	return mi, nil
}

// PatchItem применяет частичные изменения.
func (s *MenuService) PatchItem(ctx context.Context, id string, in MenuItemInput) (*models.MenuItem, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	var mi models.MenuItem
	if err := scoped.Where("id = ?", id).First(&mi).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apperrors.ErrNotFound
		}
		return nil, err
	}
	_ = rid

	updates := map[string]any{}
	if in.Name != nil {
		updates["name"] = *in.Name
	}
	if in.Category != nil {
		updates["category"] = *in.Category
	}
	if in.Price != nil {
		p, err := decimal.FromString(*in.Price)
		if err != nil {
			return nil, apperrors.Wrap("VALIDATION", "bad price", err)
		}
		updates["price"] = p
	}
	if in.Emoji != nil {
		updates["emoji"] = *in.Emoji
	}
	if in.ImageURL != nil {
		updates["image_url"] = *in.ImageURL
	}
	if in.IsAvailable != nil {
		updates["is_available"] = *in.IsAvailable
	}
	if in.StopListOverride != nil {
		updates["stop_list_override"] = *in.StopListOverride
	}
	if in.COGS != nil {
		c, err := decimal.FromString(*in.COGS)
		if err != nil {
			return nil, apperrors.Wrap("VALIDATION", "bad cogs", err)
		}
		updates["cogs"] = c
	}
	if in.CookTimeMin != nil {
		updates["cook_time_min"] = *in.CookTimeMin
	}
	if in.Station != nil {
		updates["station"] = *in.Station
	}
	if in.IsBatchCooking != nil {
		updates["is_batch_cooking"] = *in.IsBatchCooking
	}
	if in.Unit != nil {
		updates["unit"] = *in.Unit
	}
	if in.UnitSize != nil {
		u, err := decimal.FromString(*in.UnitSize)
		if err != nil {
			return nil, apperrors.Wrap("VALIDATION", "bad unit_size", err)
		}
		updates["unit_size"] = u
	}
	if in.SaleStep != nil {
		ss, err := decimal.FromString(*in.SaleStep)
		if err != nil {
			return nil, apperrors.Wrap("VALIDATION", "bad sale_step", err)
		}
		updates["sale_step"] = ss
	}
	if in.LowStockThreshold != nil {
		updates["low_stock_threshold"] = *in.LowStockThreshold
	}
	updates["updated_at"] = time.Now().UTC()

	if len(updates) == 1 { // только updated_at — нечего обновлять
		return &mi, nil
	}

	scoped2, _ := s.r.ForTenant(ctx)
	if err := scoped2.Model(&mi).Updates(updates).Error; err != nil {
		return nil, err
	}
	// Перечитываем (через свежий scope) чтобы получить актуальные default-fields.
	scoped3, _ := s.r.ForTenant(ctx)
	var updated models.MenuItem
	if err := scoped3.Where("id = ?", id).First(&updated).Error; err != nil {
		return nil, err
	}
	return &updated, nil
}

// SoftDeleteItem ставит is_deleted=true. Hard delete недопустим:
// у order_items стоит FK с RESTRICT (см. PRD 06).
func (s *MenuService) SoftDeleteItem(ctx context.Context, id string) error {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return err
	}
	res := scoped.Model(&models.MenuItem{}).
		Where("id = ?", id).
		Updates(map[string]any{
			"is_deleted": true,
			"updated_at": time.Now().UTC(),
		})
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return apperrors.ErrNotFound
	}
	return nil
}

// ─── Categories ─────────────────────────────────────────────────────────────

// CreateCategory — POST /api/v1/menu/categories.
func (s *MenuService) CreateCategory(ctx context.Context, in MenuCategoryInput) (*models.MenuCategory, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	if in.Name == nil || *in.Name == "" {
		return nil, apperrors.Wrap("VALIDATION", "name is required", nil)
	}
	now := time.Now().UTC()
	cat := &models.MenuCategory{
		ID:           uuid.NewString(),
		Name:         *in.Name,
		SortOrder:    in.SortOrder,
		RestaurantID: &rid,
		CreatedAt:    now,
		UpdatedAt:    now,
	}
	scoped, _ := s.r.ForTenant(ctx)
	if err := scoped.Create(cat).Error; err != nil {
		return nil, err
	}
	return cat, nil
}

// PatchCategory.
func (s *MenuService) PatchCategory(ctx context.Context, id string, in MenuCategoryInput) (*models.MenuCategory, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	var cat models.MenuCategory
	if err := scoped.Where("id = ?", id).First(&cat).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apperrors.ErrNotFound
		}
		return nil, err
	}
	updates := map[string]any{"updated_at": time.Now().UTC()}
	if in.Name != nil {
		updates["name"] = *in.Name
	}
	if in.SortOrder != nil {
		updates["sort_order"] = *in.SortOrder
	}
	scoped2, _ := s.r.ForTenant(ctx)
	if err := scoped2.Model(&cat).Updates(updates).Error; err != nil {
		return nil, err
	}
	scoped3, _ := s.r.ForTenant(ctx)
	var updated models.MenuCategory
	if err := scoped3.Where("id = ?", id).First(&updated).Error; err != nil {
		return nil, err
	}
	return &updated, nil
}

// DeleteCategory — hard delete (категории не связаны FK-RESTRICT с заказами).
func (s *MenuService) DeleteCategory(ctx context.Context, id string) error {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return err
	}
	res := scoped.Where("id = ?", id).Delete(&models.MenuCategory{})
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return apperrors.ErrNotFound
	}
	return nil
}
