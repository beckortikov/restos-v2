package service

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"github.com/restos/restos-v4/server/internal/db/models"
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
