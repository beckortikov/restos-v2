// restaurants_seed — Phase 18 F22: POST /restaurants/{id}/seed?dataset=demo.
// Owner-only. Создаёт демо-данные для нового ресторана: зоны, столы, меню,
// ингредиенты. Идемпотентно по факту: если зоны/меню уже есть — fail с CONFLICT.
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

// SeedCounts — что добавили.
type SeedCounts struct {
	Zones       int `json:"zones"`
	Tables      int `json:"tables"`
	MenuItems   int `json:"menu_items"`
	Ingredients int `json:"ingredients"`
}

// SeedDemo — наполняет ресторан демо-данными. Допустимо только если в
// ресторане нет ни zones, ни menu_items, ни tables — защита от случайной
// повторной загрузки в живой ресторан.
func (s *RestaurantsService) SeedDemo(ctx context.Context, id string) (*SeedCounts, error) {
	// Validate restaurant exists.
	var existing models.Restaurant
	if err := s.r.Raw().WithContext(ctx).Where("id = ?", id).First(&existing).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apperrors.ErrNotFound
		}
		return nil, err
	}

	out := &SeedCounts{}
	err := s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)

		// Guard: не сеять если уже есть данные.
		var cnt int64
		if err := tx.Model(&models.Zone{}).Where("restaurant_id = ?", id).Count(&cnt).Error; err != nil {
			return err
		}
		if cnt > 0 {
			return apperrors.Wrap("CONFLICT", "restaurant already has zones — refuse to seed", nil)
		}
		if err := tx.Model(&models.MenuItem{}).Where("restaurant_id = ?", id).Count(&cnt).Error; err != nil {
			return err
		}
		if cnt > 0 {
			return apperrors.Wrap("CONFLICT", "restaurant already has menu items — refuse to seed", nil)
		}

		now := time.Now().UTC()

		// 2 zones.
		zoneNames := []string{"Зал", "Терраса"}
		zoneIDs := make([]string, 0, len(zoneNames))
		for i, zn := range zoneNames {
			zID := uuid.NewString()
			zoneIDs = append(zoneIDs, zID)
			sort := i
			if err := tx.Create(&models.Zone{
				ID: zID, Name: zn, SortOrder: &sort,
				RestaurantID: &id, CreatedAt: now, UpdatedAt: now,
			}).Error; err != nil {
				return err
			}
			out.Zones++
		}

		// 8 tables (4 per zone).
		for zi, zID := range zoneIDs {
			for j := 1; j <= 4; j++ {
				num := zi*4 + j
				cap := 4
				stat := "free"
				zCopy := zID
				if err := tx.Create(&models.Table{
					ID: uuid.NewString(), Number: &num, Capacity: &cap,
					ZoneID: &zCopy, Status: &stat,
					RestaurantID: &id, CreatedAt: now, UpdatedAt: now,
				}).Error; err != nil {
					return err
				}
				out.Tables++
			}
		}

		// 10 ingredients.
		ingredients := []struct {
			name, unit string
			qty        string
		}{
			{"Рис", "kg", "10"},
			{"Мука", "kg", "20"},
			{"Сахар", "kg", "5"},
			{"Соль", "kg", "2"},
			{"Масло", "l", "5"},
			{"Лук", "kg", "5"},
			{"Морковь", "kg", "5"},
			{"Мясо", "kg", "10"},
			{"Курица", "kg", "8"},
			{"Зелень", "kg", "1"},
		}
		for _, ing := range ingredients {
			n := ing.name
			u := ing.unit
			q, err := decimal.FromString(ing.qty)
			if err != nil {
				return err
			}
			if err := tx.Create(&models.Ingredient{
				ID: uuid.NewString(), Name: &n, Unit: &u, Qty: q,
				RestaurantID: &id, CreatedAt: now, UpdatedAt: now,
			}).Error; err != nil {
				return err
			}
			out.Ingredients++
		}

		// 5 menu items.
		menuItems := []struct {
			name  string
			price string
		}{
			{"Плов", "45"},
			{"Лагман", "35"},
			{"Шашлык", "60"},
			{"Манты", "40"},
			{"Чай", "5"},
		}
		for _, mi := range menuItems {
			n := mi.name
			p, err := decimal.FromString(mi.price)
			if err != nil {
				return err
			}
			if err := tx.Create(&models.MenuItem{
				ID: uuid.NewString(), Name: &n, Price: p,
				RestaurantID: &id, CreatedAt: now, UpdatedAt: now,
			}).Error; err != nil {
				return err
			}
			out.MenuItems++
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}
