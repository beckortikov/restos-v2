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
	"github.com/restos/restos-v4/server/internal/repo"
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
	// Покупной товар: бэк сам создаёт складской ингредиент (0 остаток) + 1:1
	// техкарту + станцию showcase. Поля закупки нужны только при is_purchased=true.
	IsPurchased    *bool   `json:"is_purchased,omitempty"`
	PurchasePrice  *string `json:"purchase_price,omitempty"`
	PurchaseUnit   *string `json:"purchase_unit,omitempty"`
	PurchaseMinQty *string `json:"purchase_min_qty,omitempty"`
	// Сет (bundle): слоты/опции настраиваются отдельными эндпоинтами
	// (POST /menu/bundle-slots, /menu/bundle-slot-options) после создания.
	IsBundle *bool `json:"is_bundle,omitempty"`
}

// parsePurchase валидирует поля покупного товара.
// purchasedStation нормализует станцию покупного товара. Разрешены «бар» и
// «витрина» (showcase); пустое/прочее → showcase по умолчанию. Раньше станция
// жёстко форсилась в showcase — из-за чего «Бар» сохранялся как «Витрина».
func purchasedStation(s *string) string {
	if s != nil && (*s == "bar" || *s == "showcase") {
		return *s
	}
	return "showcase"
}

func parsePurchase(in MenuItemInput) (price decimal.Decimal, unit string, minQty decimal.Decimal, err error) {
	if in.PurchasePrice == nil || in.PurchaseUnit == nil || *in.PurchaseUnit == "" {
		return decimal.Zero, "", decimal.Zero, apperrors.Wrap("VALIDATION", "purchase_price и purchase_unit обязательны для покупного товара", nil)
	}
	price, e := decimal.FromString(*in.PurchasePrice)
	if e != nil {
		return decimal.Zero, "", decimal.Zero, apperrors.Wrap("VALIDATION", "bad purchase_price", e)
	}
	if decimal.IsNegative(price) {
		return decimal.Zero, "", decimal.Zero, apperrors.Wrap("VALIDATION", "purchase_price must be >= 0", nil)
	}
	unit = *in.PurchaseUnit
	minQty = decimal.Zero
	if in.PurchaseMinQty != nil {
		if m, e := decimal.FromString(*in.PurchaseMinQty); e == nil {
			minQty = m
		}
	}
	return price, unit, minQty, nil
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
	mi.IsPurchased = in.IsPurchased != nil && *in.IsPurchased
	mi.IsBundle = in.IsBundle != nil && *in.IsBundle

	// Покупной товар: в одной транзакции создаём складской ингредиент с 0
	// остатком + 1:1 техкарту + станцию + cogs = цена закупки.
	if mi.IsPurchased {
		price, unit, minQty, perr := parsePurchase(in)
		if perr != nil {
			return nil, perr
		}
		// Станция покупного товара — витрина (по умолчанию) ИЛИ бар (напитки/
		// штучный товар). Уважаем выбор пользователя, не форсим showcase.
		station := purchasedStation(mi.Station)
		mi.Station = &station
		mi.COGS = price
		txErr := s.r.Transaction(ctx, func(tr *repo.Repo) error {
			tx := tr.Raw().WithContext(ctx)
			// Мультисклад: покупной товар сразу привязываем к складу «Покупные
			// товары» (не ждём self-heal на рестарте).
			wid, werr := resolveWarehouseID(tx, rid, false, true)
			if werr != nil {
				return werr
			}
			ing := &models.Ingredient{
				ID: uuid.NewString(), Name: mi.Name, Category: mi.Category,
				Qty: decimal.Zero, MinQty: minQty, Unit: &unit, PricePerUnit: price,
				WarehouseID: wid, RestaurantID: &rid,
			}
			if err := tx.Create(ing).Error; err != nil {
				return err
			}
			if err := tx.Create(mi).Error; err != nil {
				return err
			}
			line := &models.TechCardLine{
				ID: uuid.NewString(), MenuItemID: &mi.ID, IngredientID: &ing.ID,
				Name: mi.Name, Qty: decimal.MustFromString("1"), Unit: &unit, RestaurantID: &rid,
			}
			return tx.Create(line).Error
		})
		if txErr != nil {
			return nil, txErr
		}
		return mi, nil
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

	if in.IsPurchased != nil {
		updates["is_purchased"] = *in.IsPurchased
		if *in.IsPurchased {
			return s.patchPurchased(ctx, &mi, in, updates)
		}
	}
	if in.IsBundle != nil {
		updates["is_bundle"] = *in.IsBundle
	}

	if len(updates) == 1 { // только updated_at — нечего обновлять
		return &mi, nil
	}

	scoped2, _ := s.r.ForTenant(ctx)
	if err := scoped2.Model(&mi).Updates(updates).Error; err != nil {
		return nil, err
	}
	// Имя родителя входит в производные имена вариантов («Fanta 1 л») — пересчёт.
	// Цены вариантов от родителя не зависят (Σ цен значений атрибутов).
	if mi.ParentID == nil && in.Name != nil {
		if err := s.recomputeVariants(ctx, id); err != nil {
			return nil, err
		}
	}
	// Перечитываем (через свежий scope) чтобы получить актуальные default-fields.
	scoped3, _ := s.r.ForTenant(ctx)
	var updated models.MenuItem
	if err := scoped3.Where("id = ?", id).First(&updated).Error; err != nil {
		return nil, err
	}
	return &updated, nil
}

// patchPurchased делает блюдо покупным: гарантирует складской ингредиент
// (реюз 1:1, если уже было покупным; иначе создаёт с 0 остатком), ставит
// station=showcase, cogs=цена и заменяет техкарту на 1:1. Всё в одной транзакции.
func (s *MenuService) patchPurchased(ctx context.Context, mi *models.MenuItem, in MenuItemInput, updates map[string]any) (*models.MenuItem, error) {
	price, unit, minQty, err := parsePurchase(in)
	if err != nil {
		return nil, err
	}
	rid := ""
	if mi.RestaurantID != nil {
		rid = *mi.RestaurantID
	}
	name := ""
	if mi.Name != nil {
		name = *mi.Name
	}
	if in.Name != nil {
		name = *in.Name
	}
	updates["is_purchased"] = true
	// Станция покупного товара: уважаем выбор (бар/витрина), не форсим showcase.
	stationPref := mi.Station
	if in.Station != nil {
		stationPref = in.Station
	}
	updates["station"] = purchasedStation(stationPref)
	updates["cogs"] = price

	txErr := s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)
		// Продукт с вариациями — контейнер: продаются варианты, а не он сам.
		// Склад заводим КАЖДОМУ варианту (свой SKU, свой остаток), у родителя —
		// нет. Иначе покупным становился только «группа», а вариации оставались
		// без склада (баг: конвертация напитка «по объёмам» в покупной).
		var variantCount int64
		if err := tx.Model(&models.MenuItem{}).
			Where("restaurant_id = ? AND parent_id = ? AND is_deleted = ?", rid, mi.ID, false).
			Count(&variantCount).Error; err != nil {
			return err
		}
		if variantCount > 0 {
			if err := tx.Model(&models.MenuItem{}).Where("id = ?", mi.ID).Updates(updates).Error; err != nil {
				return err
			}
			mi.IsPurchased = true
			return s.ensureVariantsPurchasedBacking(tx, rid, mi, unit, price, time.Now().UTC())
		}

		var lines []models.TechCardLine
		if err := tx.Where("menu_item_id = ?", mi.ID).Find(&lines).Error; err != nil {
			return err
		}
		// Мультисклад: складской ингредиент покупного товара живёт на складе
		// «Покупные товары» — привязываем и при реюзе, и при конвертации.
		wid, werr := resolveWarehouseID(tx, rid, false, true)
		if werr != nil {
			return werr
		}
		var ingID string
		if mi.IsPurchased && len(lines) == 1 && lines[0].IngredientID != nil {
			// Уже покупной — реюзаем выделенный ингредиент.
			ingID = *lines[0].IngredientID
			upd := map[string]any{"name": name, "price_per_unit": price, "min_qty": minQty, "unit": unit}
			if wid != nil {
				upd["warehouse_id"] = *wid
			}
			if err := tx.Model(&models.Ingredient{}).Where("id = ?", ingID).Updates(upd).Error; err != nil {
				return err
			}
		} else {
			// Конвертация обычного блюда → новый ингредиент с 0 остатком (общий
			// ингредиент рецепта не трогаем).
			nm := name
			ing := &models.Ingredient{
				ID: uuid.NewString(), Name: &nm, Category: mi.Category,
				Qty: decimal.Zero, MinQty: minQty, Unit: &unit, PricePerUnit: price,
				WarehouseID: wid, RestaurantID: &rid,
			}
			if err := tx.Create(ing).Error; err != nil {
				return err
			}
			ingID = ing.ID
		}
		if err := tx.Model(&models.MenuItem{}).Where("id = ?", mi.ID).Updates(updates).Error; err != nil {
			return err
		}
		if err := tx.Where("menu_item_id = ?", mi.ID).Delete(&models.TechCardLine{}).Error; err != nil {
			return err
		}
		nm := name
		line := &models.TechCardLine{
			ID: uuid.NewString(), MenuItemID: &mi.ID, IngredientID: &ingID,
			Name: &nm, Qty: decimal.MustFromString("1"), Unit: &unit, RestaurantID: &rid,
		}
		return tx.Create(line).Error
	})
	if txErr != nil {
		return nil, txErr
	}
	scoped, _ := s.r.ForTenant(ctx)
	var updated models.MenuItem
	if err := scoped.Where("id = ?", mi.ID).First(&updated).Error; err != nil {
		return nil, err
	}
	return &updated, nil
}

// SoftDeleteItem ставит is_deleted=true. Hard delete недопустим:
// у order_items стоит FK с RESTRICT (см. PRD 06).
// Продукт с атрибутами архивируется вместе со своими вариантами.
func (s *MenuService) SoftDeleteItem(ctx context.Context, id string) error {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return err
	}
	res := scoped.Model(&models.MenuItem{}).
		Where("id = ? OR parent_id = ?", id, id).
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
