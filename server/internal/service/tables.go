package service

import (
	"context"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/repo"
)

// TablesService — чтение table-map: зоны + столы.
//
// Размер данных: ресторан обычно имеет 10–80 столов и 1–6 зон. Пагинацию
// не делаем — выдаём всё одним запросом.
type TablesService struct {
	r *repo.Repo
}

func NewTablesService(r *repo.Repo) *TablesService {
	return &TablesService{r: r}
}

// ListZones — все зоны ресторана.
func (s *TablesService) ListZones(ctx context.Context) ([]models.Zone, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	var rows []models.Zone
	if err := scoped.Order("sort_order ASC, name ASC").Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}

// TablesFilter — фильтр для столов.
type TablesFilter struct {
	ZoneID string // если задан — только столы зоны
	Status string // free/occupied/reserved/dirty
}

// TableWithEnriched — models.Table + display-only поля (zone_name, waiter_name).
// БД-схему не трогаем; поля заполняются батч-запросами на стороне сервиса.
type TableWithEnriched struct {
	models.Table
	ZoneName   string `json:"zone_name,omitempty"`
	WaiterName string `json:"waiter_name,omitempty"`
}

// ListTables — все столы (опционально по зоне/статусу), enriched zone/waiter именами.
// Выполняет до 3 SQL запросов: tables + zones + users (батч-запросы по IN).
func (s *TablesService) ListTables(ctx context.Context, f TablesFilter) ([]TableWithEnriched, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	q := scoped
	if f.ZoneID != "" {
		q = q.Where("zone_id = ?", f.ZoneID)
	}
	if f.Status != "" {
		q = q.Where("status = ?", f.Status)
	}
	var rows []models.Table
	if err := q.Order("number ASC").Find(&rows).Error; err != nil {
		return nil, err
	}

	// Сбор unique zone_ids и waiter_ids.
	zoneSet := make(map[string]struct{})
	waiterSet := make(map[string]struct{})
	for _, t := range rows {
		if t.ZoneID != nil && *t.ZoneID != "" {
			zoneSet[*t.ZoneID] = struct{}{}
		}
		if t.WaiterID != nil && *t.WaiterID != "" {
			waiterSet[*t.WaiterID] = struct{}{}
		}
	}

	zoneNameByID := make(map[string]string, len(zoneSet))
	if len(zoneSet) > 0 {
		ids := make([]string, 0, len(zoneSet))
		for id := range zoneSet {
			ids = append(ids, id)
		}
		zScope, err := s.r.ForTenant(ctx)
		if err != nil {
			return nil, err
		}
		type tinyZone struct {
			ID   string `gorm:"column:id"`
			Name string `gorm:"column:name"`
		}
		var zs []tinyZone
		if err := zScope.Table("zones").
			Select("id, name").
			Where("id IN ?", ids).
			Scan(&zs).Error; err != nil {
			return nil, err
		}
		for _, z := range zs {
			zoneNameByID[z.ID] = z.Name
		}
	}

	waiterNameByID := make(map[string]string, len(waiterSet))
	if len(waiterSet) > 0 {
		ids := make([]string, 0, len(waiterSet))
		for id := range waiterSet {
			ids = append(ids, id)
		}
		uScope, err := s.r.ForTenant(ctx)
		if err != nil {
			return nil, err
		}
		type tinyUser struct {
			ID   string  `gorm:"column:id"`
			Name *string `gorm:"column:name"`
		}
		var us []tinyUser
		if err := uScope.Table("users").
			Select("id, name").
			Where("id IN ?", ids).
			Scan(&us).Error; err != nil {
			return nil, err
		}
		for _, u := range us {
			if u.Name != nil {
				waiterNameByID[u.ID] = *u.Name
			}
		}
	}

	out := make([]TableWithEnriched, 0, len(rows))
	for _, t := range rows {
		e := TableWithEnriched{Table: t}
		if t.ZoneID != nil {
			if n, ok := zoneNameByID[*t.ZoneID]; ok {
				e.ZoneName = n
			}
		}
		if t.WaiterID != nil {
			if n, ok := waiterNameByID[*t.WaiterID]; ok {
				e.WaiterName = n
			}
		}
		out = append(out, e)
	}
	return out, nil
}
