package service

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"github.com/restos/restos-v4/server/internal/db/models"
	apperrors "github.com/restos/restos-v4/server/internal/pkg/errors"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
	"github.com/restos/restos-v4/server/internal/repo"
)

// WarehouseService — склады (мультисклад, Фаза 1). Пока read-only: список
// фиксированных складов ресторана. Перемещение — отдельный write-сервис.
type WarehouseService struct{ r *repo.Repo }

func NewWarehouseService(r *repo.Repo) *WarehouseService { return &WarehouseService{r: r} }

// ensureWarehouses создаёт 3 фиксированных склада ресторана, если их ещё нет
// (idempotent, ON CONFLICT DO NOTHING по uq_warehouses_rest_kind). Нужно для
// ресторанов, появившихся ПОСЛЕ миграции 036 (она backf-ит только те, что
// существовали на момент применения).
func ensureWarehouses(tx *gorm.DB, rid string) error {
	defs := []struct{ name, kind string }{
		{"Продукты", "products"},
		{"Покупные товары", "purchased"},
		{"Хозтовары", "supplies"},
	}
	for _, d := range defs {
		name, kind := d.name, d.kind
		w := models.Warehouse{ID: uuid.NewString(), Name: &name, Kind: &kind, RestaurantID: &rid}
		if err := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&w).Error; err != nil {
			return err
		}
	}
	return nil
}

// List — склады ресторана в стабильном порядке: продукты → покупные → хозтовары.
func (s *WarehouseService) List(ctx context.Context) ([]models.Warehouse, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	if err := ensureWarehouses(scoped, rid); err != nil {
		return nil, err
	}
	var rows []models.Warehouse
	if err := scoped.
		Order("CASE kind WHEN 'products' THEN 0 WHEN 'purchased' THEN 1 WHEN 'supplies' THEN 2 ELSE 3 END").
		Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}

// resolveWarehouseID — склад по типу товара для новых ingredient и их движений:
// покупной → purchased, не еда → supplies, иначе → products. Возвращает nil,
// если склад не найден — не критично, привяжется позже. Сначала гарантирует
// наличие складов ресторана (ensureWarehouses).
func resolveWarehouseID(tx *gorm.DB, rid string, isFood, isPurchased bool) (*string, error) {
	if err := ensureWarehouses(tx, rid); err != nil {
		return nil, err
	}
	kind := "products"
	switch {
	case isPurchased:
		kind = "purchased"
	case !isFood:
		kind = "supplies"
	}
	var w models.Warehouse
	err := tx.Where("restaurant_id = ? AND kind = ?", rid, kind).First(&w).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &w.ID, nil
}

// WarehouseTransferInput — перемещение товара на другой склад.
type WarehouseTransferInput struct {
	IngredientID  string `json:"ingredient_id"`
	ToWarehouseID string `json:"to_warehouse_id"`
}

// Transfer перемещает товар ЦЕЛИКОМ на другой склад: меняет
// ingredients.warehouse_id и пишет движение type=transfer (from/to). Остаток
// товара НЕ меняется (denorm-хук игнорирует transfer) — модель «один товар на
// одном складе», остаток не дробится.
func (s *WarehouseService) Transfer(ctx context.Context, in WarehouseTransferInput) error {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return err
	}
	if in.IngredientID == "" || in.ToWarehouseID == "" {
		return apperrors.Wrap("VALIDATION", "ingredient_id и to_warehouse_id обязательны", nil)
	}
	return s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)
		var to models.Warehouse
		if err := tx.Where("restaurant_id = ? AND id = ?", rid, in.ToWarehouseID).First(&to).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return apperrors.Wrap("VALIDATION", "целевой склад не найден", nil)
			}
			return err
		}
		var ing models.Ingredient
		if err := tx.Where("restaurant_id = ? AND id = ?", rid, in.IngredientID).First(&ing).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return apperrors.Wrap("NOT_FOUND", "товар не найден", nil)
			}
			return err
		}
		from := ing.WarehouseID
		if from != nil && *from == in.ToWarehouseID {
			return apperrors.Wrap("VALIDATION", "товар уже на этом складе", nil)
		}
		now := time.Now().UTC()
		if err := tx.Model(&models.Ingredient{}).
			Where("id = ? AND restaurant_id = ?", in.IngredientID, rid).
			Updates(map[string]any{"warehouse_id": in.ToWarehouseID, "updated_at": now}).Error; err != nil {
			return err
		}
		tp := "transfer"
		desc := "warehouse_transfer"
		mv := &models.StockMovement{
			ID: uuid.NewString(), Type: &tp, IngredientID: &ing.ID, IngredientName: ing.Name,
			Description: &desc, Qty: ing.Qty, Unit: ing.Unit,
			WarehouseID: &in.ToWarehouseID, FromWarehouseID: from, ToWarehouseID: &in.ToWarehouseID,
			RestaurantID: &rid, CreatedAt: now,
		}
		return tx.Create(mv).Error
	})
}
