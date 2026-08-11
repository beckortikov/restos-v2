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

// ═══════════════════════════════════════════════════════════════════════════
// Bundles: фастфуд-сеты («Комбо №1» = Бургер + Картошка + Напиток). Названо
// "bundle", не "combo" — слово занято декартовым произведением атрибутов
// (Размер×Вкус, см. menu_variants.go). Структура по образцу
// ModifierGroup/Modifier (admin_extra.go), но опция ссылается на НАСТОЯЩИЙ
// пункт меню — у выбора есть своя техкарта/станция/сток без спецобработки.
// ═══════════════════════════════════════════════════════════════════════════

// ─── BundleSlots ─────────────────────────────────────────────────────────────

type BundleSlotsService struct{ r *repo.Repo }

func NewBundleSlotsService(r *repo.Repo) *BundleSlotsService { return &BundleSlotsService{r: r} }

type BundleSlotInput struct {
	BundleMenuItemID *string `json:"bundle_menu_item_id,omitempty"`
	Label            *string `json:"label,omitempty"`
	IsRequired       *bool   `json:"is_required,omitempty"`
	MinSelect        *int    `json:"min_select,omitempty"`
	MaxSelect        *int    `json:"max_select,omitempty"`
	SortOrder        *int    `json:"sort_order,omitempty"`
}

// List — GET /menu/bundle-slots?bundle_menu_item_id=...
func (s *BundleSlotsService) List(ctx context.Context, bundleMenuItemID string) ([]models.BundleSlot, error) {
	if bundleMenuItemID == "" {
		return nil, apperrors.Wrap("VALIDATION", "bundle_menu_item_id is required", nil)
	}
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	var rows []models.BundleSlot
	if err := scoped.Where("bundle_menu_item_id = ?", bundleMenuItemID).
		Order("sort_order ASC").Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}

func validateSlotBounds(minSelect, maxSelect int) error {
	if minSelect < 0 {
		return apperrors.Wrap("VALIDATION", "min_select must be >= 0", nil)
	}
	if maxSelect < 1 {
		return apperrors.Wrap("VALIDATION", "max_select must be >= 1", nil)
	}
	if minSelect > maxSelect {
		return apperrors.Wrap("VALIDATION", "min_select must be <= max_select", nil)
	}
	return nil
}

func (s *BundleSlotsService) Create(ctx context.Context, in BundleSlotInput) (*models.BundleSlot, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	if in.BundleMenuItemID == nil || *in.BundleMenuItemID == "" {
		return nil, apperrors.Wrap("VALIDATION", "bundle_menu_item_id is required", nil)
	}
	if in.Label == nil || *in.Label == "" {
		return nil, apperrors.Wrap("VALIDATION", "label is required", nil)
	}
	minSelect, maxSelect := 1, 1
	if in.MinSelect != nil {
		minSelect = *in.MinSelect
	}
	if in.MaxSelect != nil {
		maxSelect = *in.MaxSelect
	}
	if err := validateSlotBounds(minSelect, maxSelect); err != nil {
		return nil, err
	}

	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	// bundle_menu_item_id должен быть реальным is_bundle=true пунктом ЭТОГО
	// ресторана — иначе слот создастся на чужой/несуществующий/обычный товар.
	var bundleItem models.MenuItem
	if err := scoped.Where("id = ?", *in.BundleMenuItemID).First(&bundleItem).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apperrors.Wrap("VALIDATION", "bundle menu item not found in this restaurant", nil)
		}
		return nil, err
	}
	if !bundleItem.IsBundle {
		return nil, apperrors.Wrap("VALIDATION", "menu item is not a bundle (is_bundle=false)", nil)
	}

	isRequired := minSelect > 0
	if in.IsRequired != nil {
		isRequired = *in.IsRequired
	}
	now := time.Now().UTC()
	slot := &models.BundleSlot{
		ID: uuid.NewString(), RestaurantID: &rid, BundleMenuItemID: *in.BundleMenuItemID,
		Label: *in.Label, IsRequired: isRequired, MinSelect: minSelect, MaxSelect: maxSelect,
		CreatedAt: now, UpdatedAt: now,
	}
	if in.SortOrder != nil {
		slot.SortOrder = *in.SortOrder
	}
	freshScoped, _ := s.r.ForTenant(ctx)
	if err := freshScoped.Create(slot).Error; err != nil {
		return nil, err
	}
	return slot, nil
}

func (s *BundleSlotsService) Patch(ctx context.Context, id string, in BundleSlotInput) (*models.BundleSlot, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	var existing models.BundleSlot
	if err := scoped.Where("id = ?", id).First(&existing).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apperrors.ErrNotFound
		}
		return nil, err
	}

	minSelect, maxSelect := existing.MinSelect, existing.MaxSelect
	if in.MinSelect != nil {
		minSelect = *in.MinSelect
	}
	if in.MaxSelect != nil {
		maxSelect = *in.MaxSelect
	}
	if in.MinSelect != nil || in.MaxSelect != nil {
		if err := validateSlotBounds(minSelect, maxSelect); err != nil {
			return nil, err
		}
	}

	updates := map[string]any{"updated_at": time.Now().UTC()}
	if in.Label != nil {
		updates["label"] = *in.Label
	}
	if in.IsRequired != nil {
		updates["is_required"] = *in.IsRequired
	}
	if in.MinSelect != nil {
		updates["min_select"] = minSelect
	}
	if in.MaxSelect != nil {
		updates["max_select"] = maxSelect
	}
	if in.SortOrder != nil {
		updates["sort_order"] = *in.SortOrder
	}
	scoped2, _ := s.r.ForTenant(ctx)
	if err := scoped2.Model(&existing).Updates(updates).Error; err != nil {
		return nil, err
	}
	scoped3, _ := s.r.ForTenant(ctx)
	var out models.BundleSlot
	if err := scoped3.Where("id = ?", id).First(&out).Error; err != nil {
		return nil, err
	}
	return &out, nil
}

// Delete каскадно удаляет опции слота (нет смысла в слоте без опций и
// наоборот) — в транзакции, чтобы не осиротить bundle_slot_options.
func (s *BundleSlotsService) Delete(ctx context.Context, id string) error {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return err
	}
	var existing models.BundleSlot
	if err := scoped.Where("id = ?", id).First(&existing).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return apperrors.ErrNotFound
		}
		return err
	}
	return s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)
		if err := tx.Where("slot_id = ?", id).Delete(&models.BundleSlotOption{}).Error; err != nil {
			return err
		}
		return tx.Where("id = ?", id).Delete(&models.BundleSlot{}).Error
	})
}

// ─── BundleSlotOptions ───────────────────────────────────────────────────────

type BundleSlotOptionsService struct{ r *repo.Repo }

func NewBundleSlotOptionsService(r *repo.Repo) *BundleSlotOptionsService {
	return &BundleSlotOptionsService{r: r}
}

type BundleSlotOptionInput struct {
	SlotID           *string `json:"slot_id,omitempty"`
	OptionMenuItemID *string `json:"option_menu_item_id,omitempty"`
	Price            *string `json:"price,omitempty"`
	IsDefault        *bool   `json:"is_default,omitempty"`
	SortOrder        *int    `json:"sort_order,omitempty"`
}

// slotByIDForTenant — грузит слот с tenant-проверкой (для List/Create опций).
func (s *BundleSlotOptionsService) slotByIDForTenant(ctx context.Context, slotID string) (*models.BundleSlot, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	var slot models.BundleSlot
	if err := scoped.Where("id = ?", slotID).First(&slot).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apperrors.ErrNotFound
		}
		return nil, err
	}
	return &slot, nil
}

// List — GET /menu/bundle-slot-options?slot_id=...
func (s *BundleSlotOptionsService) List(ctx context.Context, slotID string) ([]models.BundleSlotOption, error) {
	if slotID == "" {
		return nil, apperrors.Wrap("VALIDATION", "slot_id is required", nil)
	}
	if _, err := s.slotByIDForTenant(ctx, slotID); err != nil {
		return nil, err
	}
	// Читаем опции без ForTenant (у bundle_slot_options нет restaurant_id) —
	// slot уже tenant-провалидирован выше, тот же паттерн, что у Modifiers.List.
	freshRaw := s.r.DB().Session(&gorm.Session{NewDB: true}).WithContext(ctx)
	var rows []models.BundleSlotOption
	if err := freshRaw.Where("slot_id = ?", slotID).
		Order("sort_order ASC").Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}

func (s *BundleSlotOptionsService) Create(ctx context.Context, in BundleSlotOptionInput) (*models.BundleSlotOption, error) {
	if in.SlotID == nil || *in.SlotID == "" {
		return nil, apperrors.Wrap("VALIDATION", "slot_id is required", nil)
	}
	if in.OptionMenuItemID == nil || *in.OptionMenuItemID == "" {
		return nil, apperrors.Wrap("VALIDATION", "option_menu_item_id is required", nil)
	}
	if _, err := s.slotByIDForTenant(ctx, *in.SlotID); err != nil {
		return nil, err
	}

	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	var option models.MenuItem
	if err := scoped.Where("id = ?", *in.OptionMenuItemID).First(&option).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apperrors.Wrap("VALIDATION", "option menu item not found in this restaurant", nil)
		}
		return nil, err
	}
	// Сет внутри сета не резолвится (нет рекурсии в резолвинге заказа) —
	// блокируем на входе, а не молча ломаем заказ позже.
	if option.IsBundle {
		return nil, apperrors.Wrap("VALIDATION", "нельзя выбрать сет как компонент другого сета", nil)
	}

	price := decimal.Zero
	if in.Price != nil {
		d, perr := decimal.FromString(*in.Price)
		if perr != nil {
			return nil, apperrors.Wrap("VALIDATION", "bad price", perr)
		}
		if decimal.IsNegative(d) {
			return nil, apperrors.Wrap("VALIDATION", "price must be >= 0", nil)
		}
		price = d
	} else {
		// Дефолт — текущая цена меню компонента; владелец видит стартовую
		// точку и уменьшает под цену сета, а не начинает с нуля.
		price = option.Price
	}

	now := time.Now().UTC()
	opt := &models.BundleSlotOption{
		ID: uuid.NewString(), SlotID: *in.SlotID, OptionMenuItemID: *in.OptionMenuItemID,
		Price: price, CreatedAt: now, UpdatedAt: now,
	}
	if in.IsDefault != nil {
		opt.IsDefault = *in.IsDefault
	}
	if in.SortOrder != nil {
		opt.SortOrder = *in.SortOrder
	}
	freshRaw := s.r.DB().Session(&gorm.Session{NewDB: true}).WithContext(ctx)
	if err := freshRaw.Create(opt).Error; err != nil {
		return nil, err
	}
	return opt, nil
}

func (s *BundleSlotOptionsService) Patch(ctx context.Context, id string, in BundleSlotOptionInput) (*models.BundleSlotOption, error) {
	freshRaw := s.r.DB().Session(&gorm.Session{NewDB: true}).WithContext(ctx)
	var opt models.BundleSlotOption
	if err := freshRaw.Where("id = ?", id).First(&opt).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apperrors.ErrNotFound
		}
		return nil, err
	}
	if _, err := s.slotByIDForTenant(ctx, opt.SlotID); err != nil {
		return nil, apperrors.ErrNotFound // tenant mismatch → not found
	}

	updates := map[string]any{"updated_at": time.Now().UTC()}
	if in.IsDefault != nil {
		updates["is_default"] = *in.IsDefault
	}
	if in.SortOrder != nil {
		updates["sort_order"] = *in.SortOrder
	}
	if in.Price != nil {
		d, err := decimal.FromString(*in.Price)
		if err != nil {
			return nil, apperrors.Wrap("VALIDATION", "bad price", err)
		}
		if decimal.IsNegative(d) {
			return nil, apperrors.Wrap("VALIDATION", "price must be >= 0", nil)
		}
		updates["price"] = d
	}
	freshRaw2 := s.r.DB().Session(&gorm.Session{NewDB: true}).WithContext(ctx)
	if err := freshRaw2.Model(&opt).Updates(updates).Error; err != nil {
		return nil, err
	}
	freshRaw3 := s.r.DB().Session(&gorm.Session{NewDB: true}).WithContext(ctx)
	var out models.BundleSlotOption
	if err := freshRaw3.Where("id = ?", id).First(&out).Error; err != nil {
		return nil, err
	}
	return &out, nil
}

func (s *BundleSlotOptionsService) Delete(ctx context.Context, id string) error {
	freshRaw := s.r.DB().Session(&gorm.Session{NewDB: true}).WithContext(ctx)
	var opt models.BundleSlotOption
	if err := freshRaw.Where("id = ?", id).First(&opt).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return apperrors.ErrNotFound
		}
		return err
	}
	if _, err := s.slotByIDForTenant(ctx, opt.SlotID); err != nil {
		return apperrors.ErrNotFound
	}
	freshRaw2 := s.r.DB().Session(&gorm.Session{NewDB: true}).WithContext(ctx)
	res := freshRaw2.Where("id = ?", id).Delete(&models.BundleSlotOption{})
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return apperrors.ErrNotFound
	}
	return nil
}
