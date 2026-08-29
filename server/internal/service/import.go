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
	Created       int            `json:"created"`
	Updated       int            `json:"updated"`
	Skipped       int            `json:"skipped"` // пустые строки
	Errors        []ImportError  `json:"errors,omitempty"`
	GeneratedPINs []GeneratedPIN `json:"generated_pins,omitempty"` // только для ImportUsers
}

// GeneratedPIN — авто-сгенерированный PIN для нового сотрудника.
// Возвращается в UI чтобы менеджер мог раздать новые PIN'ы.
type GeneratedPIN struct {
	Name     string `json:"name"`
	Username string `json:"username,omitempty"`
	Role     string `json:"role"`
	PIN      string `json:"pin"`
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

	var affectedIDs []string
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
				affectedIDs = append(affectedIDs, existing.ID)
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
				affectedIDs = append(affectedIDs, mi.ID)
				res.Created++
			}
		}
		return recordMenuItemsSync(tx, affectedIDs)
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

	var affectedIngredientIDs []string
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
				affectedIngredientIDs = append(affectedIngredientIDs, existing.ID)
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
				affectedIngredientIDs = append(affectedIngredientIDs, ing.ID)
				res.Created++
			}
		}
		return recordIngredientSync(tx, affectedIngredientIDs)
	})
	if err != nil {
		return nil, err
	}
	return res, nil
}

// parseBool — толерантный к разным написаниям. Excel часто пишет "TRUE"/"true"/"1".
func parseBool(s string) bool {
	switch s {
	case "true", "TRUE", "True", "1", "yes", "YES", "да", "Да":
		return true
	}
	return false
}

// ImportUsers — POST /api/v1/users/import.
//
// Колонки: name (обяз), username, role (owner|manager|cashier|cook|waiter),
// pin (4 цифры; если пусто — авто-генерируется), salary, position, station, phone.
//
// Upsert ключ = (restaurant_id, username) если username задан, иначе
// (restaurant_id, name).
//
// Если pin не задан — генерируем уникальный 4-значный. Возвращаемые
// сгенерированные PIN'ы кладём в ImportResult.GeneratedPINs (по строкам).
// Импортёр в UI должен показать их единым списком чтобы кассир/менеджер
// разнёс по сотрудникам.
func (s *ImportService) ImportUsers(ctx context.Context, r io.Reader) (*ImportResult, error) {
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

	res := &ImportResult{}
	now := time.Now().UTC()

	// Соберём существующие PIN'ы чтобы избежать коллизий при автогенерации.
	usedPINs := make(map[string]bool)
	var existingPINs []string
	_ = s.r.DB().WithContext(ctx).
		Table("users").
		Where("restaurant_id = ? AND pin IS NOT NULL", rid).
		Pluck("pin", &existingPINs).Error
	for _, p := range existingPINs {
		usedPINs[p] = true
	}

	validRoles := map[string]bool{
		"owner": true, "manager": true, "cashier": true,
		"cook": true, "waiter": true,
	}

	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)

		for i, row := range rows[1:] {
			rowNum := i + 2
			name := xlsx.Cell(row, headers, "name")
			if name == "" {
				res.Skipped++
				continue
			}
			username := xlsx.Cell(row, headers, "username")
			role := xlsx.Cell(row, headers, "role")
			if role == "" {
				role = "waiter"
			}
			if !validRoles[role] {
				res.Errors = append(res.Errors, ImportError{Row: rowNum,
					Message: fmt.Sprintf("bad role %q (valid: owner|manager|cashier|cook|waiter)", role)})
				continue
			}

			pin := xlsx.Cell(row, headers, "pin")
			if pin == "" {
				pin = genUniquePIN(usedPINs)
			}
			usedPINs[pin] = true

			// Найти существующего: сначала по username, потом по name.
			var existing models.User
			q := tx.Where("restaurant_id = ?", rid)
			if username != "" {
				q = q.Where("username = ?", username)
			} else {
				q = q.Where("name = ?", name)
			}
			lookupErr := q.First(&existing).Error

			updates := map[string]any{
				"name":       name,
				"role":       role,
				"updated_at": now,
			}
			if username != "" {
				updates["username"] = username
			}
			if pin != "" {
				updates["pin"] = pin
			}
			if v := xlsx.Cell(row, headers, "position"); v != "" {
				updates["position"] = v
			}
			if v := xlsx.Cell(row, headers, "station"); v != "" {
				updates["station"] = v
			}
			if v := xlsx.Cell(row, headers, "phone"); v != "" {
				updates["phone"] = v
			}
			if v := xlsx.Cell(row, headers, "salary"); v != "" {
				if d, e := decimal.FromString(v); e == nil {
					updates["salary"] = d
				}
			}

			if lookupErr == nil {
				if err := tx.Model(&existing).Updates(updates).Error; err != nil {
					res.Errors = append(res.Errors, ImportError{Row: rowNum, Message: err.Error()})
					continue
				}
				// Свежая строка для payload синка — без этого central никогда
				// не узнаёт про сотрудника, импортированного массово (не через
				// UsersService.Patch, у которого recordUserSync уже есть) —
				// см. network_analytics.go WaitersNetwork: реальный официант
				// с 88 заказами показывался пустым именем, найдено 2026-08-29.
				var fresh models.User
				if err := tx.Where("id = ?", existing.ID).First(&fresh).Error; err != nil {
					res.Errors = append(res.Errors, ImportError{Row: rowNum, Message: err.Error()})
					continue
				}
				if err := recordUserSync(tx, &fresh, "update"); err != nil {
					res.Errors = append(res.Errors, ImportError{Row: rowNum, Message: err.Error()})
					continue
				}
				res.Updated++
			} else {
				u := &models.User{
					ID:           uuid.NewString(),
					Name:         &name,
					Role:         &role,
					RestaurantID: &rid,
					CreatedAt:    now,
					UpdatedAt:    now,
				}
				if username != "" {
					u.Username = &username
				}
				if pin != "" {
					u.PIN = &pin
				}
				if v := xlsx.Cell(row, headers, "position"); v != "" {
					u.Position = &v
				}
				if v := xlsx.Cell(row, headers, "station"); v != "" {
					u.Station = &v
				}
				if v := xlsx.Cell(row, headers, "phone"); v != "" {
					u.Phone = &v
				}
				if v := xlsx.Cell(row, headers, "salary"); v != "" {
					if d, e := decimal.FromString(v); e == nil {
						u.Salary = d
					}
				}
				if err := tx.Create(u).Error; err != nil {
					res.Errors = append(res.Errors, ImportError{Row: rowNum, Message: err.Error()})
					continue
				}
				if err := recordUserSync(tx, u, "insert"); err != nil {
					res.Errors = append(res.Errors, ImportError{Row: rowNum, Message: err.Error()})
					continue
				}
				res.Created++
				res.GeneratedPINs = append(res.GeneratedPINs, GeneratedPIN{
					Name:     name,
					Username: username,
					Role:     role,
					PIN:      pin,
				})
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return res, nil
}

// ImportTables — POST /api/v1/tables/import.
//
// Колонки: name (обяз), number, zone (имя зоны — авто-создаётся если не
// существует), capacity.
//
// Upsert ключ = (restaurant_id, name). Status у новых столов = 'free'.
// Зоны: если в файле есть имя зоны которой нет в БД — создаём.
func (s *ImportService) ImportTables(ctx context.Context, r io.Reader) (*ImportResult, error) {
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

	res := &ImportResult{}
	now := time.Now().UTC()

	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)

		// Кэш зон по имени для быстрого upsert'а.
		zoneCache := make(map[string]string)
		var existingZones []models.Zone
		if err := tx.Where("restaurant_id = ?", rid).Find(&existingZones).Error; err != nil {
			return err
		}
		for _, z := range existingZones {
			zoneCache[z.Name] = z.ID
		}

		for i, row := range rows[1:] {
			rowNum := i + 2
			name := xlsx.Cell(row, headers, "name")
			if name == "" {
				res.Skipped++
				continue
			}

			// Резолв zone_id: создаём зону если нет.
			var zoneID *string
			if zoneName := xlsx.Cell(row, headers, "zone"); zoneName != "" {
				if id, ok := zoneCache[zoneName]; ok {
					zoneID = &id
				} else {
					z := &models.Zone{
						ID:           uuid.NewString(),
						Name:         zoneName,
						RestaurantID: &rid,
						CreatedAt:    now,
						UpdatedAt:    now,
					}
					if err := tx.Create(z).Error; err != nil {
						res.Errors = append(res.Errors, ImportError{Row: rowNum,
							Message: fmt.Sprintf("create zone %q: %s", zoneName, err.Error())})
						continue
					}
					zoneCache[zoneName] = z.ID
					zoneID = &z.ID
				}
			}

			var existing models.Table
			lookupErr := tx.Where("restaurant_id = ? AND name = ?", rid, name).
				First(&existing).Error

			updates := map[string]any{
				"name":       name,
				"updated_at": now,
			}
			if v := xlsx.Cell(row, headers, "number"); v != "" {
				if n, e := strconv.Atoi(v); e == nil {
					updates["number"] = n
				}
			}
			if v := xlsx.Cell(row, headers, "capacity"); v != "" {
				if n, e := strconv.Atoi(v); e == nil {
					updates["capacity"] = n
				}
			}
			if zoneID != nil {
				updates["zone_id"] = *zoneID
			}

			if lookupErr == nil {
				if err := tx.Model(&existing).Updates(updates).Error; err != nil {
					res.Errors = append(res.Errors, ImportError{Row: rowNum, Message: err.Error()})
					continue
				}
				res.Updated++
			} else {
				free := "free"
				cap4 := 4
				t := &models.Table{
					ID:           uuid.NewString(),
					Name:         &name,
					Capacity:     &cap4,
					ZoneID:       zoneID,
					Status:       &free,
					RestaurantID: &rid,
					CreatedAt:    now,
					UpdatedAt:    now,
				}
				if v := xlsx.Cell(row, headers, "number"); v != "" {
					if n, e := strconv.Atoi(v); e == nil {
						t.Number = &n
					}
				}
				if v := xlsx.Cell(row, headers, "capacity"); v != "" {
					if n, e := strconv.Atoi(v); e == nil {
						t.Capacity = &n
					}
				}
				if err := tx.Create(t).Error; err != nil {
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

// genUniquePIN — 4-значный PIN, избегая used. Не использует 0000.
func genUniquePIN(used map[string]bool) string {
	for i := 0; i < 1000; i++ {
		// Простой LCG в диапазоне [0001, 9999], детерминированно по времени+i.
		now := time.Now().UnixNano()
		v := int((now/int64(i+1))%9999) + 1
		s := fmt.Sprintf("%04d", v)
		if !used[s] && s != "0000" {
			return s
		}
	}
	// Fallback — крайне маловероятно при 10к попыток.
	return fmt.Sprintf("%04d", time.Now().Nanosecond()%9999+1)
}
