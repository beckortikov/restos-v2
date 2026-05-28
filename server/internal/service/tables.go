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

// ListTables — все столы (опционально по зоне/статусу).
func (s *TablesService) ListTables(ctx context.Context, f TablesFilter) ([]models.Table, error) {
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
	return rows, nil
}
