package service

import (
	"context"
	"fmt"
	"io"
	"strconv"
	"time"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
	apperrors "github.com/restos/restos-v4/server/internal/pkg/errors"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
	"github.com/restos/restos-v4/server/internal/pkg/xlsx"
	"github.com/restos/restos-v4/server/internal/repo"
)

// ImportResult — стандартный ответ всех импортёров.
type ImportResult struct {
	Created int           `json:"created"`
	Updated int           `json:"updated"`
	Skipped int           `json:"skipped"` // пустые строки
	Errors  []ImportError `json:"errors,omitempty"`
}

// ImportError — ошибка валидации в конкретной строке xlsx.
type ImportError struct {
	Row     int    `json:"row"` // 1-based, считая header
	Message string `json:"message"`
}

// ImportService — обрабатывает xlsx импорт menu / ingredients.
type ImportService struct {
	r *repo.Repo
}

func NewImportService(r *repo.Repo) *ImportService { return &ImportService{r: r} }

// ImportMenuItems — POST /api/v1/menu/items/import (multipart "file").
//
// Колонки (имя header'а — case-insensitive, порядок произвольный):
//
//	name (обязательно), category, price (обязательно), emoji, station, cogs,
//	cook_time_min, unit, unit_size, sale_step, low_stock_threshold,
//	is_available (true/false), is_batch_cooking (true/false).
//
// Upsert: ключ = (restaurant_id, name). Существующий menu_item обновляется.
// Если name пустое — строка пропускается со skipped++.
func (s *ImportService) ImportMenuItems(ctx context.Context, r io.Reader) (*ImportResult, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	rows, err := xlsx.Read(r)
	if err != nil {
		return nil, apperrors.Wrap("BAD_REQUEST", "bad xlsx", err)
	}
	if len(rows) < 1 {
		return &ImportResult{}, nil
	}
	headers := xlsx.IndexHeader(rows[0])
	if _, ok := headers["name"]; !ok {
		return nil, apperrors.Wrap("VALIDATION", "header 'name' is required", nil)
	}
	if _, ok := headers["price"]; !ok {
		return nil, apperrors.Wrap("VALIDATION", "header 'price' is required", nil)
	}

	res := &ImportResult{}
	now := time.Now().UTC()

	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)

		for i, row := range rows[1:] {
			rowNum := i + 2 // 1-based + header
			name := xlsx.Cell(row, headers, "name")
			if name == "" {
				res.Skipped++
				continue
			}
			priceStr := xlsx.Cell(row, headers, "price")
			price, err := decimal.FromString(priceStr)
			if err != nil {
				res.Errors = append(res.Errors, ImportError{Row: rowNum,
					Message: fmt.Sprintf("bad price %q", priceStr)})
				continue
			}

			// Найти существующий по (restaurant_id, name, is_deleted=false).
			var existing models.MenuItem
			err = tx.Where("restaurant_id = ? AND name = ? AND is_deleted = false", rid, name).
				First(&existing).Error

			updates := map[string]any{
				"price":      price,
				"updated_at": now,
			}
			if v := xlsx.Cell(row, headers, "category"); v != "" {
				updates["category"] = v
			}
			if v := xlsx.Cell(row, headers, "emoji"); v != "" {
				updates["emoji"] = v
			}
			if v := xlsx.Cell(row, headers, "station"); v != "" {
				updates["station"] = v
			}
			if v := xlsx.Cell(row, headers, "cogs"); v != "" {
				if d, e := decimal.FromString(v); e == nil {
					updates["cogs"] = d
				}
			}
			if v := xlsx.Cell(row, headers, "cook_time_min"); v != "" {
				if n, e := strconv.Atoi(v); e == nil {
					updates["cook_time_min"] = n
				}
			}
			if v := xlsx.Cell(row, headers, "unit"); v != "" {
				updates["unit"] = v
			}
			if v := xlsx.Cell(row, headers, "unit_size"); v != "" {
				if d, e := decimal.FromString(v); e == nil {
					updates["unit_size"] = d
				}
			}
			if v := xlsx.Cell(row, headers, "sale_step"); v != "" {
				if d, e := decimal.FromString(v); e == nil {
					updates["sale_step"] = d
				}
			}
			if v := xlsx.Cell(row, headers, "low_stock_threshold"); v != "" {
				if n, e := strconv.Atoi(v); e == nil {
					updates["low_stock_threshold"] = n
				}
			}
			if v := xlsx.Cell(row, headers, "is_available"); v != "" {
				updates["is_available"] = parseBool(v)
			}
			if v := xlsx.Cell(row, headers, "is_batch_cooking"); v != "" {
				updates["is_batch_cooking"] = parseBool(v)
			}

			if err == nil {
				// Update.
				if err := tx.Model(&existing).Updates(updates).Error; err != nil {
					res.Errors = append(res.Errors, ImportError{Row: rowNum, Message: err.Error()})
					continue
				}
				res.Updated++
			} else {
				// Create.
				mi := &models.MenuItem{
					ID:           uuid.NewString(),
					Name:         &name,
					Price:        price,
					RestaurantID: &rid,
					COGS:         decimal.Zero,
					UnitSize:     decimal.MustFromString("1"),
					CreatedAt:    now,
					UpdatedAt:    now,
				}
				if v := xlsx.Cell(row, headers, "category"); v != "" {
					mi.Category = &v
				}
				if v := xlsx.Cell(row, headers, "station"); v != "" {
					mi.Station = &v
				}
				if v := xlsx.Cell(row, headers, "unit"); v != "" {
					mi.Unit = &v
				}
				if v := xlsx.Cell(row, headers, "emoji"); v != "" {
					mi.Emoji = &v
				}
				if v := xlsx.Cell(row, headers, "cogs"); v != "" {
					if d, e := decimal.FromString(v); e == nil {
						mi.COGS = d
					}
				}
				if v := xlsx.Cell(row, headers, "unit_size"); v != "" {
					if d, e := decimal.FromString(v); e == nil {
						mi.UnitSize = d
					}
				}
				if v := xlsx.Cell(row, headers, "is_available"); v != "" {
					b := parseBool(v)
					mi.IsAvailable = &b
				}
				if err := tx.Create(mi).Error; err != nil {
					res.Errors = append(res.Errors, ImportError{Row: rowNum, Message: err.Error()})
					continue
				}
				res.Created++
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return res, nil
}

// ImportIngredients — POST /api/v1/stock/ingredients/import.
//
// Колонки: name (обяз), category, unit (обяз), min_qty, price_per_unit,
// waste_percent, is_food.
//
// Upsert ключ = (restaurant_id, name).
//
// Важно: qty НЕ импортируется (qty управляется через stock_movements).
// Чтобы выставить начальный остаток — нужна inventory_check или receipt.
func (s *ImportService) ImportIngredients(ctx context.Context, r io.Reader) (*ImportResult, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	rows, err := xlsx.Read(r)
	if err != nil {
		return nil, apperrors.Wrap("BAD_REQUEST", "bad xlsx", err)
	}
	if len(rows) < 1 {
		return &ImportResult{}, nil
	}
	headers := xlsx.IndexHeader(rows[0])
	if _, ok := headers["name"]; !ok {
		return nil, apperrors.Wrap("VALIDATION", "header 'name' is required", nil)
	}
	if _, ok := headers["unit"]; !ok {
		return nil, apperrors.Wrap("VALIDATION", "header 'unit' is required", nil)
	}

	res := &ImportResult{}
	now := time.Now().UTC()

	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)
		for i, row := range rows[1:] {
			rowNum := i + 2
			name := xlsx.Cell(row, headers, "name")
			if name == "" {
				res.Skipped++
				continue
			}
			unit := xlsx.Cell(row, headers, "unit")
			if unit == "" {
				res.Errors = append(res.Errors, ImportError{Row: rowNum, Message: "unit is required"})
				continue
			}

			var existing models.Ingredient
			err = tx.Where("restaurant_id = ? AND name = ?", rid, name).
				First(&existing).Error

			updates := map[string]any{"updated_at": now, "unit": unit}
			if v := xlsx.Cell(row, headers, "category"); v != "" {
				updates["category"] = v
			}
			if v := xlsx.Cell(row, headers, "min_qty"); v != "" {
				if d, e := decimal.FromString(v); e == nil {
					updates["min_qty"] = d
				}
			}
			if v := xlsx.Cell(row, headers, "price_per_unit"); v != "" {
				if d, e := decimal.FromString(v); e == nil {
					updates["price_per_unit"] = d
				}
			}
			if v := xlsx.Cell(row, headers, "waste_percent"); v != "" {
				if d, e := decimal.FromString(v); e == nil {
					updates["waste_percent"] = d
				}
			}
			if v := xlsx.Cell(row, headers, "is_food"); v != "" {
				updates["is_food"] = parseBool(v)
			}

			if err == nil {
				if err := tx.Model(&existing).Updates(updates).Error; err != nil {
					res.Errors = append(res.Errors, ImportError{Row: rowNum, Message: err.Error()})
					continue
				}
				res.Updated++
			} else {
				ing := &models.Ingredient{
					ID:           uuid.NewString(),
					Name:         &name,
					Unit:         &unit,
					Qty:          decimal.Zero,
					RestaurantID: &rid,
					CreatedAt:    now,
					UpdatedAt:    now,
				}
				if v := xlsx.Cell(row, headers, "category"); v != "" {
					ing.Category = &v
				}
				if v := xlsx.Cell(row, headers, "min_qty"); v != "" {
					if d, e := decimal.FromString(v); e == nil {
						ing.MinQty = d
					}
				}
				if v := xlsx.Cell(row, headers, "price_per_unit"); v != "" {
					if d, e := decimal.FromString(v); e == nil {
						ing.PricePerUnit = d
					}
				}
				if err := tx.Create(ing).Error; err != nil {
					res.Errors = append(res.Errors, ImportError{Row: rowNum, Message: err.Error()})
					continue
				}
				res.Created++
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return res, nil
}

// parseBool — толерантный к разным написаниям. Excel часто пишет "TRUE"/"true"/"1".
func parseBool(s string) bool {
	switch s {
	case "true", "TRUE", "True", "1", "yes", "YES", "да":
		return true
	}
	return false
}
