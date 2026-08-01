package service

// KitchenStages — отчёт владельца «время блюда по станциям»: сколько блюдо
// стояло в очереди / готовилось / ждало выдачи, по каждой станции, и как это
// соотносится с нормативом (menu_items.cook_time_min) из тех-карты.
//
// Источник — order_item_stage_events (миграция 065, append-only лог переходов
// station_status). Длительность стадии = время МЕЖДУ соседними событиями
// одной позиции (LEAD OVER PARTITION BY order_item_id), просуммированное по
// статусу — так корректно учитываются повторные заходы (блюдо вернули на
// станцию: две "cooking"-стадии суммируются в одну цифру).
//
// В отчёт попадают только позиции, ДОШЕДШИЕ до "served" в периоде — иначе
// открытые (ещё готовящиеся) блюда тянули бы среднее вверх незавершённой
// стадией.

import (
	"context"
	"time"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
)

type KitchenStageRow struct {
	MenuItemID  string          `json:"menu_item_id"`
	DishName    string          `json:"dish_name"`
	Category    string          `json:"category"`
	Station     string          `json:"station"`
	ItemCount   int             `json:"item_count"`
	AvgQueueMin decimal.Decimal `json:"avg_queue_min"`
	AvgCookMin  decimal.Decimal `json:"avg_cook_min"`
	AvgHoldMin  decimal.Decimal `json:"avg_hold_min"`
	AvgTotalMin decimal.Decimal `json:"avg_total_min"`
	// TechCookTimeMin — норматив из тех-карты (menu_items.cook_time_min).
	// nil, если у блюда норматив не заполнен — фронт показывает «—» и не
	// учитывает строку в KPI «доля превышающих».
	TechCookTimeMin *int `json:"tech_cook_time_min,omitempty"`
	// DeltaMin — AvgCookMin минус TechCookTimeMin. nil в паре с TechCookTimeMin.
	DeltaMin *decimal.Decimal `json:"delta_min,omitempty"`
}

type KitchenStageReport struct {
	Period struct {
		From *time.Time `json:"from,omitempty"`
		To   *time.Time `json:"to,omitempty"`
	} `json:"period"`
	Rows []KitchenStageRow `json:"rows"`
}

// kitchenStageSQL — CTE-запрос: LEAD-окно считает длительность между соседними
// событиями одной позиции, FILTER суммирует по статусу стадии. completed
// ограничивает выборку позициями, у которых есть событие to_status='served'
// в периоде (иначе последняя, "зависшая" стадия не имеет конца).
const kitchenStageSQL = `
WITH events AS (
	SELECT order_item_id, menu_item_id, dish_name, station, to_status, created_at,
	       LEAD(created_at) OVER (PARTITION BY order_item_id ORDER BY created_at) AS next_at
	FROM order_item_stage_events
	WHERE restaurant_id = ?
	  AND created_at >= COALESCE(?, '-infinity'::timestamptz)
	  AND created_at <  COALESCE(?, 'infinity'::timestamptz)
),
completed AS (
	SELECT DISTINCT order_item_id FROM events WHERE to_status = 'served'
),
durations AS (
	SELECT e.order_item_id, e.menu_item_id, e.dish_name, e.station, e.to_status,
	       EXTRACT(EPOCH FROM (e.next_at - e.created_at)) / 60.0 AS dur_min
	FROM events e
	JOIN completed c ON c.order_item_id = e.order_item_id
	WHERE e.next_at IS NOT NULL
)
SELECT
	COALESCE(d.menu_item_id::text, '') AS menu_item_id,
	MAX(d.dish_name)                   AS dish_name,
	d.station                          AS station,
	COUNT(DISTINCT d.order_item_id)    AS item_count,
	COALESCE(SUM(dur_min) FILTER (WHERE to_status = 'pending'), 0) AS queue_min_total,
	COALESCE(SUM(dur_min) FILTER (WHERE to_status = 'cooking'), 0) AS cook_min_total,
	COALESCE(SUM(dur_min) FILTER (WHERE to_status = 'ready'),   0) AS hold_min_total
FROM durations d
GROUP BY d.menu_item_id, d.station
ORDER BY cook_min_total DESC
`

type kitchenStageAggRow struct {
	MenuItemID    string          `gorm:"column:menu_item_id"`
	DishName      *string         `gorm:"column:dish_name"`
	Station       string          `gorm:"column:station"`
	ItemCount     int             `gorm:"column:item_count"`
	QueueMinTotal decimal.Decimal `gorm:"column:queue_min_total"`
	CookMinTotal  decimal.Decimal `gorm:"column:cook_min_total"`
	HoldMinTotal  decimal.Decimal `gorm:"column:hold_min_total"`
}

// KitchenStages — GET /api/v1/analytics/kitchen-stage-report.
func (s *AnalyticsService) KitchenStages(ctx context.Context, f PeriodFilter) (*KitchenStageReport, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	out := &KitchenStageReport{Rows: []KitchenStageRow{}}
	out.Period.From = f.From
	out.Period.To = f.To

	var aggRows []kitchenStageAggRow
	if err := s.r.Raw().WithContext(ctx).
		Raw(kitchenStageSQL, rid, f.From, f.To).
		Scan(&aggRows).Error; err != nil {
		return nil, err
	}
	if len(aggRows) == 0 {
		return out, nil
	}

	menuIDs := make([]string, 0, len(aggRows))
	for _, r := range aggRows {
		if r.MenuItemID != "" {
			menuIDs = append(menuIDs, r.MenuItemID)
		}
	}
	menuByID := make(map[string]models.MenuItem, len(menuIDs))
	if len(menuIDs) > 0 {
		var menuItems []models.MenuItem
		if err := s.r.Raw().WithContext(ctx).
			Where("restaurant_id = ? AND id IN ?", rid, menuIDs).
			Find(&menuItems).Error; err != nil {
			return nil, err
		}
		for _, mi := range menuItems {
			menuByID[mi.ID] = mi
		}
	}

	for _, r := range aggRows {
		dishName := ""
		if r.DishName != nil {
			dishName = *r.DishName
		}
		category := "Без категории"
		var techMin *int
		if mi, ok := menuByID[r.MenuItemID]; ok {
			if mi.Category != nil && *mi.Category != "" {
				category = *mi.Category
			}
			if mi.CookTimeMin != nil {
				v := *mi.CookTimeMin
				techMin = &v
			}
		}
		count := decimal.FromInt(int64(r.ItemCount))
		avgQueue := decimal.Normalize(decimal.DivRoundOr(r.QueueMinTotal, count, decimal.Zero))
		avgCook := decimal.Normalize(decimal.DivRoundOr(r.CookMinTotal, count, decimal.Zero))
		avgHold := decimal.Normalize(decimal.DivRoundOr(r.HoldMinTotal, count, decimal.Zero))
		avgTotal := decimal.Normalize(decimal.Add(decimal.Add(avgQueue, avgCook), avgHold))

		row := KitchenStageRow{
			MenuItemID:      r.MenuItemID,
			DishName:        dishName,
			Category:        category,
			Station:         r.Station,
			ItemCount:       r.ItemCount,
			AvgQueueMin:     avgQueue,
			AvgCookMin:      avgCook,
			AvgHoldMin:      avgHold,
			AvgTotalMin:     avgTotal,
			TechCookTimeMin: techMin,
		}
		if techMin != nil {
			delta := decimal.Normalize(decimal.Sub(avgCook, decimal.FromInt(int64(*techMin))))
			row.DeltaMin = &delta
		}
		out.Rows = append(out.Rows, row)
	}
	return out, nil
}
