// restaurants — глобальный CRUD ресторанов (Phase 10).
// Используется only Owner/superadmin level — в v4 локальный сервер, поэтому
// фильтрации по tenant нет (Raw()). Domain-операции (clear-operations / clear-menu /
// stats) выполняются строго по rid из path.
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
	"github.com/restos/restos-v4/server/internal/repo"
)

//nolint:repolint
type RestaurantsService struct{ r *repo.Repo }

func NewRestaurantsService(r *repo.Repo) *RestaurantsService { return &RestaurantsService{r: r} }

type RestaurantCreateInput struct {
	Name               *string `json:"name,omitempty"`
	Slug               *string `json:"slug,omitempty"`
	LogoURL            *string `json:"logo_url,omitempty"`
	Address            *string `json:"address,omitempty"`
	Phone              *string `json:"phone,omitempty"`
	Currency           *string `json:"currency,omitempty"`
	ServicePercent     *string `json:"service_percent,omitempty"`
	Timezone           *string `json:"timezone,omitempty"`
	EnforceStockCheck  *bool   `json:"enforce_stock_check,omitempty"`
	TechCardsEnabled   *bool   `json:"tech_cards_enabled,omitempty"`
	AutoReadyMode      *bool   `json:"auto_ready_mode,omitempty"`
	AutoReadyBufferMin *int    `json:"auto_ready_buffer_min,omitempty"`
	PinLockEnabled     *bool   `json:"pin_lock_enabled,omitempty"`
	PinLockTimeoutMin  *int    `json:"pin_lock_timeout_min,omitempty"`
	SupplyAllowNeg     *bool   `json:"supply_allow_negative,omitempty"`
}

func (s *RestaurantsService) List(ctx context.Context) ([]models.Restaurant, error) {
	var rows []models.Restaurant
	if err := s.r.Raw().WithContext(ctx).Order("created_at ASC").Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}

func (s *RestaurantsService) Get(ctx context.Context, id string) (*models.Restaurant, error) {
	var r models.Restaurant
	if err := s.r.Raw().WithContext(ctx).Where("id = ?", id).First(&r).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apperrors.ErrNotFound
		}
		return nil, err
	}
	return &r, nil
}

func (s *RestaurantsService) Create(ctx context.Context, in RestaurantCreateInput) (*models.Restaurant, error) {
	if in.Name == nil || *in.Name == "" {
		return nil, apperrors.Wrap("VALIDATION", "name is required", nil)
	}
	now := time.Now().UTC()
	currency := "UZS"
	if in.Currency != nil && *in.Currency != "" {
		currency = *in.Currency
	}
	tz := "Asia/Tashkent"
	if in.Timezone != nil && *in.Timezone != "" {
		tz = *in.Timezone
	}
	r := &models.Restaurant{
		ID:                 uuid.NewString(),
		Name:               *in.Name,
		Slug:               in.Slug,
		LogoURL:            in.LogoURL,
		Address:            in.Address,
		Phone:              in.Phone,
		Currency:           &currency,
		Timezone:           &tz,
		EnforceStockCheck:  in.EnforceStockCheck,
		TechCardsEnabled:   in.TechCardsEnabled,
		AutoReadyMode:      in.AutoReadyMode,
		AutoReadyBufferMin: in.AutoReadyBufferMin,
		PinLockEnabled:     in.PinLockEnabled,
		PinLockTimeoutMin:  in.PinLockTimeoutMin,
		CreatedAt:          now,
		UpdatedAt:          now,
	}
	if in.SupplyAllowNeg != nil {
		r.SupplyAllowNeg = *in.SupplyAllowNeg
	} else {
		r.SupplyAllowNeg = true
	}
	if in.ServicePercent != nil {
		d, err := decimal.FromString(*in.ServicePercent)
		if err != nil {
			return nil, apperrors.Wrap("VALIDATION", "bad service_percent", err)
		}
		r.ServicePercent = d
	}
	if err := s.r.Raw().WithContext(ctx).Create(r).Error; err != nil {
		return nil, err
	}
	return r, nil
}

func (s *RestaurantsService) Patch(ctx context.Context, id string, in RestaurantCreateInput) (*models.Restaurant, error) {
	var existing models.Restaurant
	if err := s.r.Raw().WithContext(ctx).Where("id = ?", id).First(&existing).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apperrors.ErrNotFound
		}
		return nil, err
	}
	updates := map[string]any{"updated_at": time.Now().UTC()}
	if in.Name != nil {
		updates["name"] = *in.Name
	}
	if in.Slug != nil {
		updates["slug"] = *in.Slug
	}
	if in.LogoURL != nil {
		updates["logo_url"] = *in.LogoURL
	}
	if in.Address != nil {
		updates["address"] = *in.Address
	}
	if in.Phone != nil {
		updates["phone"] = *in.Phone
	}
	if in.Currency != nil {
		updates["currency"] = *in.Currency
	}
	if in.Timezone != nil {
		updates["timezone"] = *in.Timezone
	}
	if in.ServicePercent != nil {
		d, err := decimal.FromString(*in.ServicePercent)
		if err != nil {
			return nil, apperrors.Wrap("VALIDATION", "bad service_percent", err)
		}
		updates["service_percent"] = d
	}
	if in.EnforceStockCheck != nil {
		updates["enforce_stock_check"] = *in.EnforceStockCheck
	}
	if in.TechCardsEnabled != nil {
		updates["tech_cards_enabled"] = *in.TechCardsEnabled
	}
	if in.AutoReadyMode != nil {
		updates["auto_ready_mode"] = *in.AutoReadyMode
	}
	if in.AutoReadyBufferMin != nil {
		updates["auto_ready_buffer_min"] = *in.AutoReadyBufferMin
	}
	if in.PinLockEnabled != nil {
		updates["pin_lock_enabled"] = *in.PinLockEnabled
	}
	if in.PinLockTimeoutMin != nil {
		updates["pin_lock_timeout_min"] = *in.PinLockTimeoutMin
	}
	if in.SupplyAllowNeg != nil {
		updates["supply_allow_negative"] = *in.SupplyAllowNeg
	}
	if err := s.r.Raw().WithContext(ctx).Model(&models.Restaurant{}).
		Where("id = ?", id).Updates(updates).Error; err != nil {
		return nil, err
	}
	return s.Get(ctx, id)
}

func (s *RestaurantsService) Delete(ctx context.Context, id string) error {
	// Не разрешаем удалять, если есть orders или users.
	db := s.r.Raw().WithContext(ctx)
	var existing models.Restaurant
	if err := db.Where("id = ?", id).First(&existing).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return apperrors.ErrNotFound
		}
		return err
	}
	var cnt int64
	if err := db.Model(&models.Order{}).Where("restaurant_id = ?", id).Count(&cnt).Error; err != nil {
		return err
	}
	if cnt > 0 {
		return apperrors.Wrap("CONFLICT", "restaurant has orders", nil)
	}
	if err := db.Model(&models.User{}).Where("restaurant_id = ?", id).Count(&cnt).Error; err != nil {
		return err
	}
	if cnt > 0 {
		return apperrors.Wrap("CONFLICT", "restaurant has users", nil)
	}
	res := db.Where("id = ?", id).Delete(&models.Restaurant{})
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return apperrors.ErrNotFound
	}
	return nil
}

// ClearOperations — удалить все операционные данные ресторана: orders, order_items,
// order_item_modifiers, financial_operations, cash_shifts + ops, time_entries.
type ClearCounts struct {
	Orders              int64 `json:"orders"`
	OrderItems          int64 `json:"order_items"`
	OrderItemModifiers  int64 `json:"order_item_modifiers"`
	FinancialOperations int64 `json:"financial_operations"`
	CashShifts          int64 `json:"cash_shifts"`
	CashShiftOperations int64 `json:"cash_shift_operations"`
	TimeEntries         int64 `json:"time_entries"`
}

type ClearOperationsResult struct {
	Counts ClearCounts `json:"counts"`
}

func (s *RestaurantsService) ClearOperations(ctx context.Context, id string) (*ClearOperationsResult, error) {
	var existing models.Restaurant
	if err := s.r.Raw().WithContext(ctx).Where("id = ?", id).First(&existing).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apperrors.ErrNotFound
		}
		return nil, err
	}
	out := &ClearOperationsResult{}
	err := s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)
		// order_item_modifiers — удаляем по order_items.order_id IN orders ресторана.
		// Сначала считаем.
		if err := tx.Model(&models.OrderItemModifier{}).
			Where("order_item_id IN (?)",
				tx.Model(&models.OrderItem{}).Select("id").
					Where("order_id IN (?)", tx.Model(&models.Order{}).Select("id").Where("restaurant_id = ?", id)),
			).Count(&out.Counts.OrderItemModifiers).Error; err != nil {
			return err
		}
		if err := tx.Where("order_item_id IN (?)",
			tx.Model(&models.OrderItem{}).Select("id").
				Where("order_id IN (?)", tx.Model(&models.Order{}).Select("id").Where("restaurant_id = ?", id)),
		).Delete(&models.OrderItemModifier{}).Error; err != nil {
			return err
		}

		// order_items.
		if err := tx.Model(&models.OrderItem{}).
			Where("order_id IN (?)", tx.Model(&models.Order{}).Select("id").Where("restaurant_id = ?", id)).
			Count(&out.Counts.OrderItems).Error; err != nil {
			return err
		}
		if err := tx.Where("order_id IN (?)", tx.Model(&models.Order{}).Select("id").Where("restaurant_id = ?", id)).
			Delete(&models.OrderItem{}).Error; err != nil {
			return err
		}

		// orders.
		res := tx.Where("restaurant_id = ?", id).Delete(&models.Order{})
		if res.Error != nil {
			return res.Error
		}
		out.Counts.Orders = res.RowsAffected

		// financial_operations.
		res = tx.Where("restaurant_id = ?", id).Delete(&models.FinancialOperation{})
		if res.Error != nil {
			return res.Error
		}
		out.Counts.FinancialOperations = res.RowsAffected

		// cash_shift_operations (по shift_id IN shifts ресторана).
		if err := tx.Model(&models.CashShiftOperation{}).
			Where("shift_id IN (?)", tx.Model(&models.CashShift{}).Select("id").Where("restaurant_id = ?", id)).
			Count(&out.Counts.CashShiftOperations).Error; err != nil {
			return err
		}
		if err := tx.Where("shift_id IN (?)", tx.Model(&models.CashShift{}).Select("id").Where("restaurant_id = ?", id)).
			Delete(&models.CashShiftOperation{}).Error; err != nil {
			return err
		}

		// cash_shifts.
		res = tx.Where("restaurant_id = ?", id).Delete(&models.CashShift{})
		if res.Error != nil {
			return res.Error
		}
		out.Counts.CashShifts = res.RowsAffected

		// time_entries.
		res = tx.Where("restaurant_id = ?", id).Delete(&models.TimeEntry{})
		if res.Error != nil {
			return res.Error
		}
		out.Counts.TimeEntries = res.RowsAffected
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// ClearMenu — удалить меню ресторана: menu_items, menu_categories, tech_card_lines,
// modifier_groups, modifiers (через group_id).
type ClearMenuCounts struct {
	MenuItems      int64 `json:"menu_items"`
	MenuCategories int64 `json:"menu_categories"`
	TechCardLines  int64 `json:"tech_card_lines"`
	ModifierGroups int64 `json:"modifier_groups"`
	Modifiers      int64 `json:"modifiers"`
}

type ClearMenuResult struct {
	Counts ClearMenuCounts `json:"counts"`
}

func (s *RestaurantsService) ClearMenu(ctx context.Context, id string) (*ClearMenuResult, error) {
	var existing models.Restaurant
	if err := s.r.Raw().WithContext(ctx).Where("id = ?", id).First(&existing).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apperrors.ErrNotFound
		}
		return nil, err
	}
	out := &ClearMenuResult{}
	err := s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)
		// modifiers через group_id IN modifier_groups ресторана.
		if err := tx.Model(&models.Modifier{}).
			Where("group_id IN (?)", tx.Model(&models.ModifierGroup{}).Select("id").Where("restaurant_id = ?", id)).
			Count(&out.Counts.Modifiers).Error; err != nil {
			return err
		}
		if err := tx.Where("group_id IN (?)", tx.Model(&models.ModifierGroup{}).Select("id").Where("restaurant_id = ?", id)).
			Delete(&models.Modifier{}).Error; err != nil {
			return err
		}

		// modifier_groups.
		res := tx.Where("restaurant_id = ?", id).Delete(&models.ModifierGroup{})
		if res.Error != nil {
			return res.Error
		}
		out.Counts.ModifierGroups = res.RowsAffected

		// tech_card_lines.
		res = tx.Where("restaurant_id = ?", id).Delete(&models.TechCardLine{})
		if res.Error != nil {
			return res.Error
		}
		out.Counts.TechCardLines = res.RowsAffected

		// menu_items.
		res = tx.Where("restaurant_id = ?", id).Delete(&models.MenuItem{})
		if res.Error != nil {
			return res.Error
		}
		out.Counts.MenuItems = res.RowsAffected

		// menu_categories.
		res = tx.Where("restaurant_id = ?", id).Delete(&models.MenuCategory{})
		if res.Error != nil {
			return res.Error
		}
		out.Counts.MenuCategories = res.RowsAffected
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// Stats — агрегатные счётчики для ресторана.
type RestaurantStats struct {
	OrdersCount      int64           `json:"orders_count"`
	MenuItemsCount   int64           `json:"menu_items_count"`
	UsersCount       int64           `json:"users_count"`
	IngredientsCount int64           `json:"ingredients_count"`
	TotalRevenue     decimal.Decimal `json:"total_revenue"`
	LastOrderAt      *time.Time      `json:"last_order_at"`
}

func (s *RestaurantsService) Stats(ctx context.Context, id string) (*RestaurantStats, error) {
	var existing models.Restaurant
	if err := s.r.Raw().WithContext(ctx).Where("id = ?", id).First(&existing).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apperrors.ErrNotFound
		}
		return nil, err
	}
	out := &RestaurantStats{}
	db := s.r.Raw().WithContext(ctx)
	if err := db.Model(&models.Order{}).Where("restaurant_id = ?", id).Count(&out.OrdersCount).Error; err != nil {
		return nil, err
	}
	if err := db.Model(&models.MenuItem{}).Where("restaurant_id = ?", id).Count(&out.MenuItemsCount).Error; err != nil {
		return nil, err
	}
	if err := db.Model(&models.User{}).Where("restaurant_id = ?", id).Count(&out.UsersCount).Error; err != nil {
		return nil, err
	}
	if err := db.Model(&models.Ingredient{}).Where("restaurant_id = ?", id).Count(&out.IngredientsCount).Error; err != nil {
		return nil, err
	}
	// total_revenue — SUM(total_with_service) для закрытых заказов.
	var revAgg struct {
		Total decimal.Decimal `gorm:"column:total"`
	}
	if err := db.Model(&models.Order{}).
		Select("COALESCE(SUM(total_with_service), 0) AS total").
		Where("restaurant_id = ? AND status = ?", id, "closed").
		Scan(&revAgg).Error; err != nil {
		return nil, err
	}
	out.TotalRevenue = decimal.Normalize(revAgg.Total)
	// last_order_at.
	var last models.Order
	if err := db.Where("restaurant_id = ?", id).Order("created_at DESC").Limit(1).Find(&last).Error; err != nil {
		return nil, err
	}
	if last.ID != "" {
		t := last.CreatedAt
		out.LastOrderAt = &t
	}
	return out, nil
}
