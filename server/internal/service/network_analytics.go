package service

import (
	"context"
	"fmt"
	"math"
	"sort"
	"time"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// Сетевые версии отчётов /analytics/* (владелец 2026-08-25: «весь раздел
// аналитики тоже должен в центре показывать всю сводную по филиалам, сейчас
// ничего нет» — central сам не торгует, поэтому локальные версии этих
// отчётов у него всегда пустые). Та же логика, что у каждого одно-тенантного
// метода в analytics.go/analytics_extras.go/analytics_sales.go, но
// restaurant_id IN (<филиалы сети>) вместо ForTenant(ctx) — тот же приём,
// что и во всём network_reports.go.
//
// Группировка по блюду — ПО ИМЕНИ, не menu_item_id: у сетевого блюда своя
// строка menu_items на каждом филиале, общий только master_id (см. ту же
// оговорку в network_reports.go DashboardDetail). Группировка по ингредиенту
// — НАОБОРОТ, каждая строка остаётся своей (с именем филиала): в отличие от
// меню, у складских позиций нет общего сетевого id, «Мука» на двух точках —
// разные закупки с разной ценой, схлопывать их значило бы врать про остаток.

// ─── Пиковые часы ────────────────────────────────────────────────────────

// NetworkPeakHours — сумма по всей сети, group by (weekday, hour).
func (s *NetworkService) PeakHours(ctx context.Context, f PeriodFilter) (*PeakHoursReport, error) {
	ids, err := s.networkBranchIDs(ctx)
	if err != nil {
		return nil, err
	}
	out := &PeakHoursReport{Cells: []PeakHoursCell{}}
	out.Period.From = f.From
	out.Period.To = f.To
	if len(ids) == 0 {
		return out, nil
	}

	type row struct {
		Weekday int             `gorm:"column:weekday"`
		Hour    int             `gorm:"column:hour"`
		Orders  int             `gorm:"column:orders"`
		Revenue decimal.Decimal `gorm:"column:revenue"`
	}
	q := s.r.Raw().WithContext(ctx).Table("orders").
		Select(`EXTRACT(DOW  FROM closed_at AT TIME ZONE 'Asia/Dushanbe')::int AS weekday,
		        EXTRACT(HOUR FROM closed_at AT TIME ZONE 'Asia/Dushanbe')::int AS hour,
		        COUNT(*) AS orders,
		        COALESCE(SUM(total_with_service), 0) AS revenue`).
		Where("restaurant_id IN ? AND status IN ? AND closed_at IS NOT NULL", ids, []string{"closed", "refunded"})
	if f.From != nil {
		q = q.Where("closed_at >= ?", *f.From)
	}
	if f.To != nil {
		q = q.Where("closed_at < ?", *f.To)
	}
	var rows []row
	if err := q.Group("weekday, hour").Scan(&rows).Error; err != nil {
		return nil, err
	}
	total := 0
	totalRev := decimal.Zero
	for _, r := range rows {
		out.Cells = append(out.Cells, PeakHoursCell{
			Weekday: r.Weekday, Hour: r.Hour, Orders: r.Orders, Revenue: decimal.Normalize(r.Revenue),
		})
		total += r.Orders
		totalRev = decimal.Add(totalRev, r.Revenue)
	}
	out.TotalOrders = total
	out.TotalRevenue = decimal.Normalize(totalRev)
	return out, nil
}

// ─── ABC — меню ─────────────────────────────────────────────────────────

// ABCMenuNetwork — тот же Парето-анализ, но группировка по имени блюда по
// всей сети. Классификация (classifyABCMenu) переиспользована 1:1 с локальным
// отчётом — числа считаются идентично, разнится только источник строк.
func (s *NetworkService) ABCMenuNetwork(ctx context.Context, f PeriodFilter) (*ABCMenuReport, error) {
	ids, err := s.networkBranchIDs(ctx)
	if err != nil {
		return nil, err
	}
	out := &ABCMenuReport{Items: []ABCMenuRow{}}
	out.Period.From = f.From
	out.Period.To = f.To
	if len(ids) == 0 {
		return out, nil
	}

	q := s.r.Raw().WithContext(ctx).Table("order_items AS oi").
		Select(`COALESCE(MAX(mi.name), MAX(oi.name), '—') AS menu_item_id,
		        COALESCE(MAX(mi.name), MAX(oi.name), '—') AS name,
		        COALESCE(SUM(CASE WHEN oi.unit IN ('g','kg') AND oi.unit_size > 0 THEN oi.qty / oi.unit_size ELSE oi.qty END), 0) AS qty,
		        COALESCE(SUM((CASE WHEN oi.unit IN ('g','kg') AND oi.unit_size > 0 THEN oi.price * oi.qty / oi.unit_size ELSE oi.price * oi.qty END) * COALESCE((o.total - o.discount_amount) / NULLIF(o.total, 0), 1)), 0) AS revenue,
		        COALESCE(SUM(CASE WHEN oi.unit IN ('g','kg') AND oi.unit_size > 0 THEN oi.cogs  * oi.qty / oi.unit_size ELSE oi.cogs  * oi.qty END), 0) AS cogs`).
		Joins("JOIN orders o ON o.id = oi.order_id").
		Joins("LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id AND mi.restaurant_id = o.restaurant_id").
		Where("o.restaurant_id IN ? AND o.status IN ? AND o.closed_at IS NOT NULL", ids, []string{"closed", "refunded"}).
		Where("oi.cancelled_at IS NULL").
		Where("oi.menu_item_id IS NOT NULL")
	if f.From != nil {
		q = q.Where("o.closed_at >= ?", *f.From)
	}
	if f.To != nil {
		q = q.Where("o.closed_at < ?", *f.To)
	}
	var rows []abcAggRow
	// group by имя (не id — у сетевого блюда свой id на каждом филиале).
	if err := q.Group("COALESCE(mi.name, oi.name)").Scan(&rows).Error; err != nil {
		return nil, err
	}
	classifyABCMenu(rows, out)
	return out, nil
}

// ─── ABC — склад ────────────────────────────────────────────────────────

// NetworkABCInventoryRow — как ABCInventoryRow, но с именем филиала: у
// складских позиций нет сетевой идентичности, «Мука» на двух точках — разные
// закупки, схлопывать их значило бы врать про фактический остаток.
type NetworkABCInventoryRow struct {
	ABCInventoryRow
	RestaurantID   string `json:"restaurant_id"`
	RestaurantName string `json:"restaurant_name"`
}

type NetworkABCInventoryReport struct {
	Period struct {
		From *time.Time `json:"from,omitempty"`
		To   *time.Time `json:"to,omitempty"`
	} `json:"period"`
	TotalConsumptionValue decimal.Decimal          `json:"total_consumption_value"`
	Items                 []NetworkABCInventoryRow `json:"items"`
}

func (s *NetworkService) ABCInventoryNetwork(ctx context.Context, f PeriodFilter) (*NetworkABCInventoryReport, error) {
	account, err := s.accountForCtx(ctx)
	if err != nil {
		return nil, err
	}
	branches, err := s.branchesForAccount(ctx, account)
	if err != nil {
		return nil, err
	}
	ids := branchIDs(branches)
	nameByID := make(map[string]string, len(branches))
	for _, b := range branches {
		nameByID[b.ID] = b.Name
	}
	out := &NetworkABCInventoryReport{Items: []NetworkABCInventoryRow{}}
	out.Period.From = f.From
	out.Period.To = f.To
	if len(ids) == 0 {
		return out, nil
	}

	type ingRow struct {
		ID           string          `gorm:"column:id"`
		RestaurantID string          `gorm:"column:restaurant_id"`
		Name         *string         `gorm:"column:name"`
		Category     *string         `gorm:"column:category"`
		Unit         *string         `gorm:"column:unit"`
		Qty          decimal.Decimal `gorm:"column:qty"`
		PricePerUnit decimal.Decimal `gorm:"column:price_per_unit"`
	}
	var iRows []ingRow
	if err := s.r.Raw().WithContext(ctx).Table("ingredients").
		Select("id, restaurant_id, name, category, unit, qty, price_per_unit").
		Where("restaurant_id IN ?", ids).
		Scan(&iRows).Error; err != nil {
		return nil, err
	}

	type mvRow struct {
		IngredientID *string         `gorm:"column:ingredient_id"`
		Qty          decimal.Decimal `gorm:"column:qty"`
	}
	qm := s.r.Raw().WithContext(ctx).Table("stock_movements").
		Select("ingredient_id, COALESCE(SUM(ABS(qty)), 0) AS qty").
		Where("restaurant_id IN ? AND type IN ?", ids, []string{"out", "batch", "semi"})
	if f.From != nil {
		qm = qm.Where("created_at >= ?", *f.From)
	}
	if f.To != nil {
		qm = qm.Where("created_at < ?", *f.To)
	}
	var mRows []mvRow
	if err := qm.Group("ingredient_id").Scan(&mRows).Error; err != nil {
		return nil, err
	}
	consByIng := make(map[string]decimal.Decimal, len(mRows))
	for _, r := range mRows {
		if r.IngredientID != nil {
			consByIng[*r.IngredientID] = r.Qty
		}
	}

	// periodDays — как в одно-тенантном отчёте: при пустом периоде берём
	// реальный разброс дат расходных движений СЕТИ (не одной точки).
	periodDays := computePeriodDays(f.From, f.To)
	if f.From == nil || f.To == nil {
		var span struct {
			MinAt *time.Time `gorm:"column:min_at"`
			MaxAt *time.Time `gorm:"column:max_at"`
		}
		if err := s.r.Raw().WithContext(ctx).Table("stock_movements").
			Select("MIN(created_at) AS min_at, MAX(created_at) AS max_at").
			Where("restaurant_id IN ? AND type IN ?", ids, []string{"out", "batch", "semi"}).
			Scan(&span).Error; err == nil && span.MinAt != nil && span.MaxAt != nil {
			if d := span.MaxAt.Sub(*span.MinAt).Hours() / 24; d >= 1 {
				periodDays = int(d + 0.999)
			}
		}
	}
	if periodDays < 1 {
		periodDays = 1
	}

	type enriched struct {
		NetworkABCInventoryRow
		ConsValue decimal.Decimal
	}
	en := make([]enriched, 0, len(iRows))
	totalConsValue := decimal.Zero
	for _, r := range iRows {
		cons := consByIng[r.ID]
		consValue := decimal.Mul(cons, r.PricePerUnit)
		stockValue := decimal.Mul(r.Qty, r.PricePerUnit)
		var turn decimal.Decimal
		if r.Qty.IsPositive() {
			turn = decimal.DivRound(cons, r.Qty)
		}
		daysOfStock := 0
		if cons.IsPositive() {
			f1, _ := r.Qty.Float64()
			f2, _ := cons.Float64()
			d := f1 * float64(periodDays) / f2
			if d > 999 {
				d = 999
			}
			daysOfStock = int(d + 0.5)
		} else if r.Qty.IsPositive() {
			daysOfStock = 999
		}
		name := "—"
		if r.Name != nil && *r.Name != "" {
			name = *r.Name
		}
		cat := ""
		if r.Category != nil {
			cat = *r.Category
		}
		unit := ""
		if r.Unit != nil {
			unit = *r.Unit
		}
		en = append(en, enriched{
			NetworkABCInventoryRow: NetworkABCInventoryRow{
				ABCInventoryRow: ABCInventoryRow{
					IngredientID: r.ID, Name: name, Category: cat, Unit: unit,
					Qty: decimal.Normalize(r.Qty), PricePerUnit: decimal.Normalize(r.PricePerUnit),
					StockValue: decimal.Normalize(stockValue), Consumption: decimal.Normalize(cons),
					Turnover: decimal.Normalize(turn), DaysOfStock: daysOfStock,
				},
				RestaurantID:   r.RestaurantID,
				RestaurantName: nameByID[r.RestaurantID],
			},
			ConsValue: consValue,
		})
		totalConsValue = decimal.Add(totalConsValue, consValue)
	}
	sort.Slice(en, func(i, j int) bool { return en[i].ConsValue.GreaterThan(en[j].ConsValue) })

	hundred := decimal.FromInt(100)
	cum := decimal.Zero
	out.Items = make([]NetworkABCInventoryRow, 0, len(en))
	for _, e := range en {
		var share, cumShare decimal.Decimal
		if totalConsValue.IsPositive() {
			share = decimal.DivRound(decimal.Mul(e.ConsValue, hundred), totalConsValue)
			cum = decimal.Add(cum, share)
			cumShare = cum
		}
		class := "C"
		if totalConsValue.IsPositive() {
			switch {
			case cumShare.LessThanOrEqual(decimal.FromInt(80)):
				class = "A"
			case cumShare.LessThanOrEqual(decimal.FromInt(95)):
				class = "B"
			}
		}
		var rec string
		switch class {
		case "A":
			if e.DaysOfStock < 7 {
				rec = "Срочно закупить"
			} else {
				rec = "Держать запас"
			}
		case "B":
			rec = "Стандартные закупки"
		default:
			if e.Consumption.IsZero() {
				rec = "Нет расхода — пересмотреть"
			} else {
				rec = "Уменьшить закупки"
			}
		}
		row := e.NetworkABCInventoryRow
		row.Share = decimal.Normalize(share)
		row.CumShare = decimal.Normalize(cumShare)
		row.Class = class
		row.Recommendation = rec
		out.Items = append(out.Items, row)
	}
	out.TotalConsumptionValue = decimal.Normalize(totalConsValue)
	return out, nil
}

// ─── Продажи ────────────────────────────────────────────────────────────

// SalesReportNetwork — та же (дата, час, блюдо) агрегация, что и локальный
// отчёт, но по имени блюда и по всей сети (см. головной комментарий файла).
func (s *NetworkService) SalesReportNetwork(ctx context.Context, f SalesReportFilter) (*SalesReportResult, error) {
	ids, err := s.networkBranchIDs(ctx)
	if err != nil {
		return nil, err
	}
	out := &SalesReportResult{Rows: []SalesReportRow{}, ByDate: []SalesReportDay{}}
	if len(ids) == 0 {
		return out, nil
	}
	byType := f.OrderType != "" && f.OrderType != "all"

	q := s.r.Raw().WithContext(ctx).Table("order_items AS oi").
		Select(`to_char(o.closed_at AT TIME ZONE 'Asia/Dushanbe', 'YYYY-MM-DD') AS date,
		        EXTRACT(HOUR FROM o.closed_at AT TIME ZONE 'Asia/Dushanbe')::int AS hour,
		        COALESCE(MAX(mi.name), MAX(oi.name), '—') AS menu_item_id,
		        COALESCE(MAX(mi.name), MAX(oi.name), '—') AS name,
		        COALESCE(MAX(NULLIF(mi.category, '')), 'Без категории') AS category,
		        COALESCE(bool_or(mi.is_purchased), false) AS is_purchased,
		        COALESCE(SUM(CASE WHEN oi.unit IN ('g','kg') AND oi.unit_size > 0 THEN oi.qty / oi.unit_size ELSE oi.qty END), 0) AS qty,
		        COALESCE(SUM((CASE WHEN oi.unit IN ('g','kg') AND oi.unit_size > 0 THEN oi.price * oi.qty / oi.unit_size ELSE oi.price * oi.qty END) * COALESCE((o.total - o.discount_amount) / NULLIF(o.total, 0), 1)), 0) AS revenue`).
		Joins("JOIN orders o ON o.id = oi.order_id").
		Joins("LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id AND mi.restaurant_id = o.restaurant_id").
		Where("o.restaurant_id IN ? AND o.status IN ? AND o.closed_at IS NOT NULL AND oi.cancelled_at IS NULL", ids, []string{"closed", "refunded"})
	if f.From != nil {
		q = q.Where("o.closed_at >= ?", *f.From)
	}
	if f.To != nil {
		q = q.Where("o.closed_at < ?", *f.To)
	}
	if byType {
		q = q.Where("o.type = ?", f.OrderType)
	}
	if err := q.Group("date, hour, COALESCE(mi.name, oi.name)").Order("date ASC, hour ASC").Scan(&out.Rows).Error; err != nil {
		return nil, err
	}
	for _, r := range out.Rows {
		out.Totals.Revenue = decimal.Add(out.Totals.Revenue, r.Revenue)
		out.Totals.Qty = decimal.Add(out.Totals.Qty, r.Qty)
	}
	out.Totals.Revenue = decimal.Normalize(out.Totals.Revenue)
	out.Totals.Qty = decimal.Normalize(out.Totals.Qty)

	qc := s.r.Raw().WithContext(ctx).Table("orders").
		Where("restaurant_id IN ? AND status IN ? AND closed_at IS NOT NULL", ids, []string{"closed", "refunded"})
	if f.From != nil {
		qc = qc.Where("closed_at >= ?", *f.From)
	}
	if f.To != nil {
		qc = qc.Where("closed_at < ?", *f.To)
	}
	if byType {
		qc = qc.Where(`"type" = ?`, f.OrderType)
	}
	var cnt int64
	if err := qc.Count(&cnt).Error; err != nil {
		return nil, err
	}
	out.Totals.Orders = int(cnt)

	qd := s.r.Raw().WithContext(ctx).Table("orders AS o").
		Select(`to_char(o.closed_at AT TIME ZONE 'Asia/Dushanbe', 'YYYY-MM-DD') AS date,
		        COUNT(DISTINCT o.id) AS orders,
		        COALESCE(SUM(CASE WHEN oi.unit IN ('g','kg') AND oi.unit_size > 0 THEN oi.qty / oi.unit_size ELSE oi.qty END) FILTER (WHERE oi.id IS NOT NULL AND oi.cancelled_at IS NULL), 0) AS qty,
		        COALESCE(SUM((CASE WHEN oi.unit IN ('g','kg') AND oi.unit_size > 0 THEN oi.price * oi.qty / oi.unit_size ELSE oi.price * oi.qty END) * COALESCE((o.total - o.discount_amount) / NULLIF(o.total, 0), 1)) FILTER (WHERE oi.id IS NOT NULL AND oi.cancelled_at IS NULL), 0) AS revenue`).
		Joins("LEFT JOIN order_items oi ON oi.order_id = o.id").
		Where("o.restaurant_id IN ? AND o.status IN ? AND o.closed_at IS NOT NULL", ids, []string{"closed", "refunded"})
	if f.From != nil {
		qd = qd.Where("o.closed_at >= ?", *f.From)
	}
	if f.To != nil {
		qd = qd.Where("o.closed_at < ?", *f.To)
	}
	if byType {
		qd = qd.Where("o.type = ?", f.OrderType)
	}
	if err := qd.Group("date").Order("date ASC").Scan(&out.ByDate).Error; err != nil {
		return nil, err
	}

	if f.From != nil {
		s := f.From.Format("2006-01-02")
		out.Period.From = &s
	}
	if f.To != nil {
		s := f.To.Format("2006-01-02")
		out.Period.To = &s
	}
	return out, nil
}

// ─── Официанты ──────────────────────────────────────────────────────────

// NetworkWaiterRow — как WaiterRow, но с именем филиала: официант — реальный
// человек со своим users.id на своём филиале, у него нет сетевой идентичности
// (в отличие от блюда) — «Иван» на двух точках почти наверняка разные люди,
// схлопывать их по имени значило бы приписывать чужие продажи.
type NetworkWaiterRow struct {
	WaiterRow
	RestaurantID   string `json:"restaurant_id"`
	RestaurantName string `json:"restaurant_name"`
}

type NetworkWaitersReport struct {
	Period struct {
		From *time.Time `json:"from,omitempty"`
		To   *time.Time `json:"to,omitempty"`
	} `json:"period"`
	TotalRevenue decimal.Decimal    `json:"total_revenue"`
	TotalOrders  int                `json:"total_orders"`
	Rows         []NetworkWaiterRow `json:"rows"`
}

// WaitersNetwork — та же (waiter × метрики) агрегация, что и локальный
// отчёт, но по всей сети, каждая строка помечена филиалом (см. комментарий
// у NetworkWaiterRow). Ключи вспомогательных карт — (restaurant_id,
// waiter_id): без restaurant_id в ключе группа «без официанта» (waiter_id
// NULL) с разных филиалов схлопнулась бы в одну.
func (s *NetworkService) WaitersNetwork(ctx context.Context, f PeriodFilter) (*NetworkWaitersReport, error) {
	account, err := s.accountForCtx(ctx)
	if err != nil {
		return nil, err
	}
	branches, err := s.branchesForAccount(ctx, account)
	if err != nil {
		return nil, err
	}
	ids := branchIDs(branches)
	nameByID := make(map[string]string, len(branches))
	for _, b := range branches {
		nameByID[b.ID] = b.Name
	}
	var central *models.Restaurant
	for i := range branches {
		if branches[i].Kind != nil && *branches[i].Kind == "central_warehouse" {
			central = &branches[i]
			break
		}
	}

	out := &NetworkWaitersReport{Rows: []NetworkWaiterRow{}}
	out.Period.From, out.Period.To = f.From, f.To
	if len(ids) == 0 {
		return out, nil
	}

	// Диспетчеризованные с central заказы (waiter_id=NULL на филиале, см.
	// applyOrder + DeliveryPuller.processCreate) учитываются НИЖЕ отдельно —
	// строкой «Диспетчер», атрибутированной человеку на central, а не месту.
	// Без этого исключения они попадали бы ЕЩЁ РАЗ сюда же под «—» филиала:
	// одна и та же выручка/заказы — дважды в списке и в TotalRevenue/TotalOrders
	// (нашли по жалобе владельца на дубли в аналитике официантов, 2026-08-29).
	dispatchExclude, dispatchExcludeBare := "TRUE", "TRUE"
	dispatchArgs := []any{}
	if central != nil {
		dispatchExclude = `o.id NOT IN (
			SELECT dro.local_order_id FROM delivery_relay_orders dro
			WHERE dro.restaurant_id = ? AND dro.kind = 'create' AND dro.status = 'delivered'
			AND dro.local_order_id IS NOT NULL
		)`
		// qb ниже — Table("orders") без алиаса o, колонки без префикса.
		dispatchExcludeBare = `id NOT IN (
			SELECT dro.local_order_id FROM delivery_relay_orders dro
			WHERE dro.restaurant_id = ? AND dro.kind = 'create' AND dro.status = 'delivered'
			AND dro.local_order_id IS NOT NULL
		)`
		dispatchArgs = append(dispatchArgs, central.ID)
	}

	type row struct {
		RestaurantID  string          `gorm:"column:restaurant_id"`
		WaiterID      *string         `gorm:"column:waiter_id"`
		Name          *string         `gorm:"column:name"`
		Orders        int             `gorm:"column:orders"`
		Revenue       decimal.Decimal `gorm:"column:revenue"`
		ServiceAmount decimal.Decimal `gorm:"column:service_amount"`
		TipAmount     decimal.Decimal `gorm:"column:tip_amount"`
		AvgDurSec     decimal.Decimal `gorm:"column:avg_dur_sec"`
	}
	q := s.r.Raw().WithContext(ctx).Table("orders AS o").
		Select(`o.restaurant_id AS restaurant_id,
		        o.waiter_id AS waiter_id,
		        u.name AS name,
		        COUNT(*) AS orders,
		        COALESCE(SUM(o.total_with_service), 0) AS revenue,
		        COALESCE(SUM(o.service_amount), 0) AS service_amount,
		        COALESCE(SUM(o.tip_amount), 0) AS tip_amount,
		        COALESCE(AVG(EXTRACT(EPOCH FROM (o.closed_at - o.created_at))), 0) AS avg_dur_sec`).
		Joins("LEFT JOIN users u ON u.id::text = o.waiter_id AND u.restaurant_id = o.restaurant_id").
		Where("o.restaurant_id IN ? AND o.status IN ? AND o.closed_at IS NOT NULL", ids, []string{"closed", "refunded"}).
		Where(dispatchExclude, dispatchArgs...)
	if f.From != nil {
		q = q.Where("o.closed_at >= ?", *f.From)
	}
	if f.To != nil {
		q = q.Where("o.closed_at < ?", *f.To)
	}
	var rows []row
	if err := q.Group("o.restaurant_id, o.waiter_id, u.name").Scan(&rows).Error; err != nil {
		return nil, err
	}

	type itemRow struct {
		RestaurantID string          `gorm:"column:restaurant_id"`
		WaiterID     *string         `gorm:"column:waiter_id"`
		Qty          decimal.Decimal `gorm:"column:qty"`
	}
	qi := s.r.Raw().WithContext(ctx).Table("orders AS o").
		Select("o.restaurant_id AS restaurant_id, o.waiter_id AS waiter_id, COALESCE(SUM(oi.qty), 0) AS qty").
		Joins("JOIN order_items oi ON oi.order_id = o.id").
		Where("o.restaurant_id IN ? AND o.status IN ? AND o.closed_at IS NOT NULL", ids, []string{"closed", "refunded"}).
		Where("oi.cancelled_at IS NULL").
		Where(dispatchExclude, dispatchArgs...)
	if f.From != nil {
		qi = qi.Where("o.closed_at >= ?", *f.From)
	}
	if f.To != nil {
		qi = qi.Where("o.closed_at < ?", *f.To)
	}
	var iRows []itemRow
	_ = qi.Group("o.restaurant_id, o.waiter_id").Scan(&iRows).Error
	itemsByKey := make(map[[2]string]decimal.Decimal, len(iRows))
	for _, r := range iRows {
		wid := ""
		if r.WaiterID != nil {
			wid = *r.WaiterID
		}
		itemsByKey[[2]string{r.RestaurantID, wid}] = r.Qty
	}

	type dayRow struct {
		RestaurantID string          `gorm:"column:restaurant_id"`
		WaiterID     *string         `gorm:"column:waiter_id"`
		Day          string          `gorm:"column:day"`
		Revenue      decimal.Decimal `gorm:"column:revenue"`
	}
	qb := s.r.Raw().WithContext(ctx).Table("orders").
		Select(`restaurant_id, waiter_id, to_char(closed_at AT TIME ZONE 'Asia/Dushanbe', 'YYYY-MM-DD') AS day,
		        COALESCE(SUM(total_with_service), 0) AS revenue`).
		Where("restaurant_id IN ? AND status IN ? AND closed_at IS NOT NULL", ids, []string{"closed", "refunded"}).
		Where(dispatchExcludeBare, dispatchArgs...)
	if f.From != nil {
		qb = qb.Where("closed_at >= ?", *f.From)
	}
	if f.To != nil {
		qb = qb.Where("closed_at < ?", *f.To)
	}
	var dRows []dayRow
	_ = qb.Group("restaurant_id, waiter_id, day").Scan(&dRows).Error
	type bestEntry struct {
		Day     string
		Revenue decimal.Decimal
	}
	bestByKey := make(map[[2]string]bestEntry, 16)
	for _, r := range dRows {
		wid := ""
		if r.WaiterID != nil {
			wid = *r.WaiterID
		}
		k := [2]string{r.RestaurantID, wid}
		cur, ok := bestByKey[k]
		if !ok || r.Revenue.GreaterThan(cur.Revenue) {
			bestByKey[k] = bestEntry{Day: r.Day, Revenue: r.Revenue}
		}
	}

	totalRev := decimal.Zero
	totalOrd := 0
	for _, r := range rows {
		wid := ""
		if r.WaiterID != nil {
			wid = *r.WaiterID
		}
		name := "—"
		if r.Name != nil && *r.Name != "" {
			name = *r.Name
		}
		avg := decimal.Zero
		if r.Orders > 0 {
			avg = decimal.DivRound(r.Revenue, decimal.FromInt(int64(r.Orders)))
		}
		avgMin := decimal.DivRound(r.AvgDurSec, decimal.FromInt(60))
		k := [2]string{r.RestaurantID, wid}
		best := bestByKey[k]
		out.Rows = append(out.Rows, NetworkWaiterRow{
			WaiterRow: WaiterRow{
				WaiterID:       wid,
				Name:           name,
				Orders:         r.Orders,
				Revenue:        decimal.Normalize(r.Revenue),
				ItemsSold:      decimal.Normalize(itemsByKey[k]),
				AvgCheck:       decimal.Normalize(avg),
				ServiceAmount:  decimal.Normalize(r.ServiceAmount),
				TipAmount:      decimal.Normalize(r.TipAmount),
				AvgServiceMin:  decimal.Normalize(avgMin),
				BestDay:        best.Day,
				BestDayRevenue: decimal.Normalize(best.Revenue),
			},
			RestaurantID:   r.RestaurantID,
			RestaurantName: nameByID[r.RestaurantID],
		})
		totalRev = decimal.Add(totalRev, r.Revenue)
		totalOrd += r.Orders
	}

	// Диспетчер central (095) — central сам не торгует локально (комментарий
	// в шапке файла), а его диспетчеризованные заказы явно исключены выше
	// (dispatchExclude) из подсчёта по официантам филиала — реальную выручку
	// сети через delivery-relay считаем здесь, отдельной агрегацией по
	// created_by_user_id (kind=create ТОЛЬКО — amend не заводит новый заказ,
	// его выручка уже внутри Revenue родителя, второй раз считать нельзя),
	// джойним к orders реального филиала за фактически оплаченные (closed/
	// refunded) — central пишет только транспорт, деньги/сток остаются
	// филиалу, здесь просто атрибуция человеку, кто отправил.
	if central != nil {
		type dispatchRow struct {
			UserID  *string         `gorm:"column:user_id"`
			Name    *string         `gorm:"column:name"`
			Orders  int             `gorm:"column:orders"`
			Revenue decimal.Decimal `gorm:"column:revenue"`
		}
		dq := s.r.Raw().WithContext(ctx).Table("delivery_relay_orders AS dro").
			Select(`dro.created_by_user_id AS user_id, dro.created_by_name AS name,
			        COUNT(*) AS orders, COALESCE(SUM(o.total_with_service), 0) AS revenue`).
			Joins("JOIN orders o ON o.id = dro.local_order_id").
			Where("dro.restaurant_id = ? AND dro.kind = ? AND dro.status = ? AND o.status IN ?",
				central.ID, "create", "delivered", []string{"closed", "refunded"})
		if f.From != nil {
			dq = dq.Where("o.closed_at >= ?", *f.From)
		}
		if f.To != nil {
			dq = dq.Where("o.closed_at < ?", *f.To)
		}
		var dRows []dispatchRow
		_ = dq.Group("dro.created_by_user_id, dro.created_by_name").Scan(&dRows).Error

		type dispatchDayRow struct {
			UserID  *string         `gorm:"column:user_id"`
			Day     string          `gorm:"column:day"`
			Revenue decimal.Decimal `gorm:"column:revenue"`
		}
		dbq := s.r.Raw().WithContext(ctx).Table("delivery_relay_orders AS dro").
			Select(`dro.created_by_user_id AS user_id, to_char(o.closed_at AT TIME ZONE 'Asia/Dushanbe', 'YYYY-MM-DD') AS day,
			        COALESCE(SUM(o.total_with_service), 0) AS revenue`).
			Joins("JOIN orders o ON o.id = dro.local_order_id").
			Where("dro.restaurant_id = ? AND dro.kind = ? AND dro.status = ? AND o.status IN ?",
				central.ID, "create", "delivered", []string{"closed", "refunded"})
		if f.From != nil {
			dbq = dbq.Where("o.closed_at >= ?", *f.From)
		}
		if f.To != nil {
			dbq = dbq.Where("o.closed_at < ?", *f.To)
		}
		var dbRows []dispatchDayRow
		_ = dbq.Group("dro.created_by_user_id, day").Scan(&dbRows).Error

		type dispatchItemsRow struct {
			UserID *string         `gorm:"column:user_id"`
			Qty    decimal.Decimal `gorm:"column:qty"`
		}
		diq := s.r.Raw().WithContext(ctx).Table("delivery_relay_orders AS dro").
			Select("dro.created_by_user_id AS user_id, COALESCE(SUM(oi.qty), 0) AS qty").
			Joins("JOIN orders o ON o.id = dro.local_order_id").
			Joins("JOIN order_items oi ON oi.order_id = o.id AND oi.cancelled_at IS NULL").
			Where("dro.restaurant_id = ? AND dro.kind = ? AND dro.status = ? AND o.status IN ?",
				central.ID, "create", "delivered", []string{"closed", "refunded"})
		if f.From != nil {
			diq = diq.Where("o.closed_at >= ?", *f.From)
		}
		if f.To != nil {
			diq = diq.Where("o.closed_at < ?", *f.To)
		}
		var diRows []dispatchItemsRow
		_ = diq.Group("dro.created_by_user_id").Scan(&diRows).Error
		dispatchItemsByUser := make(map[string]decimal.Decimal, 4)
		for _, r := range diRows {
			uid := ""
			if r.UserID != nil {
				uid = *r.UserID
			}
			dispatchItemsByUser[uid] = r.Qty
		}

		dispatchBestByUser := make(map[string]bestEntry, 4)
		for _, r := range dbRows {
			uid := ""
			if r.UserID != nil {
				uid = *r.UserID
			}
			cur, ok := dispatchBestByUser[uid]
			if !ok || r.Revenue.GreaterThan(cur.Revenue) {
				dispatchBestByUser[uid] = bestEntry{Day: r.Day, Revenue: r.Revenue}
			}
		}

		for _, r := range dRows {
			uid := ""
			if r.UserID != nil {
				uid = *r.UserID
			}
			name := "Диспетчер"
			if r.Name != nil && *r.Name != "" {
				name = *r.Name
			}
			avg := decimal.Zero
			if r.Orders > 0 {
				avg = decimal.DivRound(r.Revenue, decimal.FromInt(int64(r.Orders)))
			}
			best := dispatchBestByUser[uid]
			out.Rows = append(out.Rows, NetworkWaiterRow{
				WaiterRow: WaiterRow{
					WaiterID:       uid,
					Name:           name,
					Orders:         r.Orders,
					Revenue:        decimal.Normalize(r.Revenue),
					ItemsSold:      decimal.Normalize(dispatchItemsByUser[uid]),
					AvgCheck:       decimal.Normalize(avg),
					BestDay:        best.Day,
					BestDayRevenue: decimal.Normalize(best.Revenue),
				},
				RestaurantID:   central.ID,
				RestaurantName: central.Name,
			})
			totalRev = decimal.Add(totalRev, r.Revenue)
			totalOrd += r.Orders
		}
	}

	sort.Slice(out.Rows, func(i, j int) bool {
		return out.Rows[i].Revenue.GreaterThan(out.Rows[j].Revenue)
	})
	out.TotalRevenue = decimal.Normalize(totalRev)
	out.TotalOrders = totalOrd
	return out, nil
}

// ─── Дни недели ─────────────────────────────────────────────────────────

// WeekdayNetwork — тот же формат ответа (WeekdayReport), что у локального
// A1–A3 отчёта, посчитанный по всей сети. Категория (A2) схлопывается по
// имени — атрибут меню, общий для сети (см. головной комментарий файла),
// в отличие от официанта/ингредиента.
func (s *NetworkService) WeekdayNetwork(ctx context.Context, f PeriodFilter) (*WeekdayReport, error) {
	ids, err := s.networkBranchIDs(ctx)
	if err != nil {
		return nil, err
	}
	out := &WeekdayReport{ByWeekday: []WeekdayRow{}, Heatmap: []WeekdayHourCell{}, ByCategory: []WeekdayCategoryRow{}}
	out.Period.From, out.Period.To = f.From, f.To
	if len(ids) == 0 {
		return out, nil
	}

	type revRow struct {
		Weekday int             `gorm:"column:weekday"`
		Orders  int             `gorm:"column:orders"`
		Revenue decimal.Decimal `gorm:"column:revenue"`
	}
	qr := s.r.Raw().WithContext(ctx).Table("orders").
		Select(`EXTRACT(DOW FROM closed_at AT TIME ZONE 'Asia/Dushanbe')::int AS weekday, COUNT(*) AS orders, COALESCE(SUM(total_with_service),0) AS revenue`).
		Where("restaurant_id IN ? AND status IN ? AND closed_at IS NOT NULL", ids, []string{"closed", "refunded"})
	qr = applyClosedPeriod(qr, f)
	var revRows []revRow
	if err := qr.Group("weekday").Scan(&revRows).Error; err != nil {
		return nil, err
	}

	type cogsRow struct {
		Weekday int             `gorm:"column:weekday"`
		COGS    decimal.Decimal `gorm:"column:cogs"`
	}
	qc := s.r.Raw().WithContext(ctx).Table("order_items AS oi").
		Select(`EXTRACT(DOW FROM o.closed_at AT TIME ZONE 'Asia/Dushanbe')::int AS weekday, COALESCE(SUM(CASE WHEN oi.unit IN ('g','kg') AND oi.unit_size > 0 THEN oi.cogs * oi.qty / oi.unit_size ELSE oi.cogs * oi.qty END),0) AS cogs`).
		Joins("JOIN orders o ON o.id = oi.order_id").
		Where("o.restaurant_id IN ? AND o.status IN ? AND o.closed_at IS NOT NULL", ids, []string{"closed", "refunded"}).
		Where("oi.cancelled_at IS NULL")
	qc = whereClosedQ(qc, f, "o")
	var cogsRows []cogsRow
	if err := qc.Group("weekday").Scan(&cogsRows).Error; err != nil {
		return nil, err
	}

	type laborRow struct {
		Weekday int             `gorm:"column:weekday"`
		Labor   decimal.Decimal `gorm:"column:labor"`
	}
	ql := s.r.Raw().WithContext(ctx).Table("time_entries AS te").
		Select(`EXTRACT(DOW FROM te.clock_in AT TIME ZONE 'Asia/Dushanbe')::int AS weekday, COALESCE(SUM(te.total_hours * COALESCE(u.hourly_rate,0)),0) AS labor`).
		Joins("JOIN users u ON u.id = te.user_id AND u.restaurant_id = te.restaurant_id").
		Where("te.restaurant_id IN ? AND te.clock_in IS NOT NULL", ids)
	if f.From != nil {
		ql = ql.Where("te.clock_in >= ?", *f.From)
	}
	if f.To != nil {
		ql = ql.Where("te.clock_in < ?", *f.To)
	}
	var laborRows []laborRow
	if err := ql.Group("weekday").Scan(&laborRows).Error; err != nil {
		return nil, err
	}

	byWd := make(map[int]*WeekdayRow, 7)
	for wd := 0; wd < 7; wd++ {
		byWd[wd] = &WeekdayRow{Weekday: wd, Revenue: decimal.Zero, COGS: decimal.Zero, Labor: decimal.Zero}
	}
	for _, r := range revRows {
		byWd[r.Weekday].Orders = r.Orders
		byWd[r.Weekday].Revenue = r.Revenue
	}
	for _, r := range cogsRows {
		byWd[r.Weekday].COGS = r.COGS
	}
	for _, r := range laborRows {
		byWd[r.Weekday].Labor = r.Labor
	}
	for wd := 0; wd < 7; wd++ {
		x := byWd[wd]
		gross := decimal.Sub(x.Revenue, x.COGS)
		x.GrossProfit = decimal.Normalize(gross)
		x.NetProfit = decimal.Normalize(decimal.Sub(gross, x.Labor))
		x.AvgCheck = avgCheck(x.Revenue, x.Orders)
		x.Revenue, x.COGS, x.Labor = decimal.Normalize(x.Revenue), decimal.Normalize(x.COGS), decimal.Normalize(x.Labor)
		out.ByWeekday = append(out.ByWeekday, *x)
	}

	type hRow struct {
		Weekday int             `gorm:"column:weekday"`
		Hour    int             `gorm:"column:hour"`
		Orders  int             `gorm:"column:orders"`
		Revenue decimal.Decimal `gorm:"column:revenue"`
	}
	qh := s.r.Raw().WithContext(ctx).Table("orders").
		Select(`EXTRACT(DOW FROM closed_at AT TIME ZONE 'Asia/Dushanbe')::int AS weekday, EXTRACT(HOUR FROM closed_at AT TIME ZONE 'Asia/Dushanbe')::int AS hour, COUNT(*) AS orders, COALESCE(SUM(total_with_service),0) AS revenue`).
		Where("restaurant_id IN ? AND status IN ? AND closed_at IS NOT NULL", ids, []string{"closed", "refunded"})
	qh = applyClosedPeriod(qh, f)
	var hRows []hRow
	if err := qh.Group("weekday, hour").Scan(&hRows).Error; err != nil {
		return nil, err
	}
	type hcRow struct {
		Weekday int             `gorm:"column:weekday"`
		Hour    int             `gorm:"column:hour"`
		COGS    decimal.Decimal `gorm:"column:cogs"`
	}
	qhc := s.r.Raw().WithContext(ctx).Table("order_items AS oi").
		Select(`EXTRACT(DOW FROM o.closed_at AT TIME ZONE 'Asia/Dushanbe')::int AS weekday, EXTRACT(HOUR FROM o.closed_at AT TIME ZONE 'Asia/Dushanbe')::int AS hour, COALESCE(SUM(CASE WHEN oi.unit IN ('g','kg') AND oi.unit_size > 0 THEN oi.cogs * oi.qty / oi.unit_size ELSE oi.cogs * oi.qty END),0) AS cogs`).
		Joins("JOIN orders o ON o.id = oi.order_id").
		Where("o.restaurant_id IN ? AND o.status IN ? AND o.closed_at IS NOT NULL", ids, []string{"closed", "refunded"}).
		Where("oi.cancelled_at IS NULL")
	qhc = whereClosedQ(qhc, f, "o")
	var hcRows []hcRow
	if err := qhc.Group("weekday, hour").Scan(&hcRows).Error; err != nil {
		return nil, err
	}
	cogsByCell := make(map[[2]int]decimal.Decimal, len(hcRows))
	for _, r := range hcRows {
		cogsByCell[[2]int{r.Weekday, r.Hour}] = r.COGS
	}
	for _, r := range hRows {
		cogs := cogsByCell[[2]int{r.Weekday, r.Hour}]
		out.Heatmap = append(out.Heatmap, WeekdayHourCell{
			Weekday: r.Weekday, Hour: r.Hour, Orders: r.Orders,
			Revenue: decimal.Normalize(r.Revenue),
			Profit:  decimal.Normalize(decimal.Sub(r.Revenue, cogs)),
		})
	}

	type catRow struct {
		Weekday  int             `gorm:"column:weekday"`
		Category string          `gorm:"column:category"`
		Qty      decimal.Decimal `gorm:"column:qty"`
		Revenue  decimal.Decimal `gorm:"column:revenue"`
		COGS     decimal.Decimal `gorm:"column:cogs"`
	}
	qcat := s.r.Raw().WithContext(ctx).Table("order_items AS oi").
		Select(`EXTRACT(DOW FROM o.closed_at AT TIME ZONE 'Asia/Dushanbe')::int AS weekday, COALESCE(NULLIF(mi.category,''),'—') AS category,
		        COALESCE(SUM(oi.qty),0) AS qty, COALESCE(SUM((CASE WHEN oi.unit IN ('g','kg') AND oi.unit_size > 0 THEN oi.price * oi.qty / oi.unit_size ELSE oi.price * oi.qty END) * COALESCE((o.total - o.discount_amount) / NULLIF(o.total, 0), 1)),0) AS revenue, COALESCE(SUM(CASE WHEN oi.unit IN ('g','kg') AND oi.unit_size > 0 THEN oi.cogs * oi.qty / oi.unit_size ELSE oi.cogs * oi.qty END),0) AS cogs`).
		Joins("JOIN orders o ON o.id = oi.order_id").
		Joins("LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id AND mi.restaurant_id = o.restaurant_id").
		Where("o.restaurant_id IN ? AND o.status IN ? AND o.closed_at IS NOT NULL", ids, []string{"closed", "refunded"}).
		Where("oi.cancelled_at IS NULL")
	qcat = whereClosedQ(qcat, f, "o")
	var catRows []catRow
	if err := qcat.Group("weekday, category").Scan(&catRows).Error; err != nil {
		return nil, err
	}
	for _, r := range catRows {
		out.ByCategory = append(out.ByCategory, WeekdayCategoryRow{
			Weekday: r.Weekday, Category: r.Category,
			Qty:     decimal.Normalize(r.Qty),
			Revenue: decimal.Normalize(r.Revenue),
			Profit:  decimal.Normalize(decimal.Sub(r.Revenue, r.COGS)),
		})
	}

	return out, nil
}

// ─── Себестоимость ──────────────────────────────────────────────────────

// FoodCostNetwork — та же (блюдо × cogs/margin) агрегация, что и локальный
// отчёт, схлопнутая по имени блюда по всей сети (см. головной комментарий).
func (s *NetworkService) FoodCostNetwork(ctx context.Context, f PeriodFilter) (*FoodCostReport, error) {
	ids, err := s.networkBranchIDs(ctx)
	if err != nil {
		return nil, err
	}
	out := &FoodCostReport{Rows: []FoodCostRow{}}
	out.Period.From = f.From
	out.Period.To = f.To
	if len(ids) == 0 {
		return out, nil
	}

	type row struct {
		MenuItemID string          `gorm:"column:menu_item_id"`
		Name       string          `gorm:"column:name"`
		Qty        decimal.Decimal `gorm:"column:qty"`
		Revenue    decimal.Decimal `gorm:"column:revenue"`
		COGS       decimal.Decimal `gorm:"column:cogs"`
	}
	q := s.r.Raw().WithContext(ctx).Table("order_items AS oi").
		Select(`COALESCE(MAX(mi.name), MAX(oi.name), '—') AS menu_item_id,
		        COALESCE(MAX(mi.name), MAX(oi.name), '—') AS name,
		        COALESCE(SUM(CASE WHEN oi.unit IN ('g','kg') AND oi.unit_size > 0 THEN oi.qty / oi.unit_size ELSE oi.qty END), 0) AS qty,
		        COALESCE(SUM((CASE WHEN oi.unit IN ('g','kg') AND oi.unit_size > 0 THEN oi.price * oi.qty / oi.unit_size ELSE oi.price * oi.qty END) * COALESCE((o.total - o.discount_amount) / NULLIF(o.total, 0), 1)), 0) AS revenue,
		        COALESCE(SUM(CASE WHEN oi.unit IN ('g','kg') AND oi.unit_size > 0 THEN oi.cogs  * oi.qty / oi.unit_size ELSE oi.cogs  * oi.qty END), 0) AS cogs`).
		Joins("JOIN orders o ON o.id = oi.order_id").
		Joins("LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id AND mi.restaurant_id = o.restaurant_id").
		Where("o.restaurant_id IN ? AND o.status IN ? AND o.closed_at IS NOT NULL", ids, []string{"closed", "refunded"}).
		Where("oi.cancelled_at IS NULL").
		Where("oi.menu_item_id IS NOT NULL")
	if f.From != nil {
		q = q.Where("o.closed_at >= ?", *f.From)
	}
	if f.To != nil {
		q = q.Where("o.closed_at < ?", *f.To)
	}
	var rows []row
	if err := q.Group("COALESCE(mi.name, oi.name)").Scan(&rows).Error; err != nil {
		return nil, err
	}
	hundred := decimal.FromInt(100)
	totalRev := decimal.Zero
	totalCOGS := decimal.Zero
	for _, r := range rows {
		gross := decimal.Sub(r.Revenue, r.COGS)
		fcPct := decimal.Zero
		marginPct := decimal.Zero
		if r.Revenue.IsPositive() {
			fcPct = decimal.DivRound(decimal.Mul(r.COGS, hundred), r.Revenue)
			marginPct = decimal.DivRound(decimal.Mul(gross, hundred), r.Revenue)
		}
		out.Rows = append(out.Rows, FoodCostRow{
			MenuItemID:    r.MenuItemID,
			Name:          r.Name,
			Qty:           decimal.Normalize(r.Qty),
			Revenue:       decimal.Normalize(r.Revenue),
			COGS:          decimal.Normalize(r.COGS),
			FoodCostPct:   decimal.Normalize(fcPct),
			GrossProfit:   decimal.Normalize(gross),
			MarginPercent: decimal.Normalize(marginPct),
		})
		totalRev = decimal.Add(totalRev, r.Revenue)
		totalCOGS = decimal.Add(totalCOGS, r.COGS)
	}
	sort.Slice(out.Rows, func(i, j int) bool {
		return out.Rows[i].FoodCostPct.GreaterThan(out.Rows[j].FoodCostPct)
	})
	out.TotalRevenue = decimal.Normalize(totalRev)
	out.TotalCOGS = decimal.Normalize(totalCOGS)
	if totalRev.IsPositive() {
		out.FoodCostPct = decimal.Normalize(decimal.DivRound(decimal.Mul(totalCOGS, hundred), totalRev))
		gross := decimal.Sub(totalRev, totalCOGS)
		out.MarginPercent = decimal.Normalize(decimal.DivRound(decimal.Mul(gross, hundred), totalRev))
	}
	return out, nil
}

// FoodCostMonthlyNetwork — тренд food_cost_pct по месяцам, сумма по сети.
func (s *NetworkService) FoodCostMonthlyNetwork(ctx context.Context, f PeriodFilter) (*FoodCostMonthlyReport, error) {
	ids, err := s.networkBranchIDs(ctx)
	if err != nil {
		return nil, err
	}
	out := &FoodCostMonthlyReport{Months: []FoodCostMonth{}}
	out.Period.From = f.From
	out.Period.To = f.To
	if len(ids) == 0 {
		return out, nil
	}

	type revRow struct {
		Month   string          `gorm:"column:month"`
		Revenue decimal.Decimal `gorm:"column:revenue"`
		Orders  int             `gorm:"column:orders"`
	}
	q := s.r.Raw().WithContext(ctx).Table("orders").
		Select(`to_char(closed_at AT TIME ZONE 'Asia/Dushanbe', 'YYYY-MM') AS month,
		        COALESCE(SUM(total_with_service), 0) AS revenue,
		        COUNT(*) AS orders`).
		Where("restaurant_id IN ? AND status IN ? AND closed_at IS NOT NULL", ids, []string{"closed", "refunded"})
	if f.From != nil {
		q = q.Where("closed_at >= ?", *f.From)
	}
	if f.To != nil {
		q = q.Where("closed_at < ?", *f.To)
	}
	var rRows []revRow
	if err := q.Group("month").Order("month ASC").Scan(&rRows).Error; err != nil {
		return nil, err
	}

	type cogsRow struct {
		Month string          `gorm:"column:month"`
		COGS  decimal.Decimal `gorm:"column:cogs"`
	}
	q2 := s.r.Raw().WithContext(ctx).Table("orders AS o").
		Select(`to_char(o.closed_at AT TIME ZONE 'Asia/Dushanbe', 'YYYY-MM') AS month,
		        COALESCE(SUM(CASE WHEN oi.unit IN ('g','kg') AND oi.unit_size > 0 THEN oi.cogs * oi.qty / oi.unit_size ELSE oi.cogs * oi.qty END), 0) AS cogs`).
		Joins("JOIN order_items oi ON oi.order_id = o.id").
		Where("o.restaurant_id IN ? AND o.status IN ? AND o.closed_at IS NOT NULL AND oi.cancelled_at IS NULL", ids, []string{"closed", "refunded"})
	if f.From != nil {
		q2 = q2.Where("o.closed_at >= ?", *f.From)
	}
	if f.To != nil {
		q2 = q2.Where("o.closed_at < ?", *f.To)
	}
	var cRows []cogsRow
	_ = q2.Group("month").Scan(&cRows).Error
	cogsByMonth := make(map[string]decimal.Decimal, len(cRows))
	for _, r := range cRows {
		cogsByMonth[r.Month] = r.COGS
	}

	hundred := decimal.FromInt(100)
	for _, r := range rRows {
		c := cogsByMonth[r.Month]
		fc := decimal.Zero
		marg := decimal.Zero
		if r.Revenue.IsPositive() {
			fc = decimal.DivRound(decimal.Mul(c, hundred), r.Revenue)
			gross := decimal.Sub(r.Revenue, c)
			marg = decimal.DivRound(decimal.Mul(gross, hundred), r.Revenue)
		}
		out.Months = append(out.Months, FoodCostMonth{
			Month:         r.Month,
			Revenue:       decimal.Normalize(r.Revenue),
			COGS:          decimal.Normalize(c),
			FoodCostPct:   decimal.Normalize(fc),
			MarginPercent: decimal.Normalize(marg),
			Orders:        r.Orders,
		})
	}
	return out, nil
}

// ─── Остаток на складе (топ по стоимости) ──────────────────────────────────

// NetworkIngredientStockRow — как IngredientStockRow, но с именем филиала:
// та же логика, что у ABC-Склад — ингредиенты не схлопываются по имени.
type NetworkIngredientStockRow struct {
	IngredientStockRow
	RestaurantID   string `json:"restaurant_id"`
	RestaurantName string `json:"restaurant_name"`
}

type NetworkIngredientStockReport struct {
	TotalValue decimal.Decimal             `json:"total_value"`
	Items      []NetworkIngredientStockRow `json:"items"`
}

// IngredientStockValueNetwork — top-N позиций по стоимости остатка по всей
// сети (единый рейтинг, не по N на филиал), НЕ схлопывается по имени.
func (s *NetworkService) IngredientStockValueNetwork(ctx context.Context, limit int) (*NetworkIngredientStockReport, error) {
	if limit <= 0 {
		limit = 10
	}
	account, err := s.accountForCtx(ctx)
	if err != nil {
		return nil, err
	}
	branches, err := s.branchesForAccount(ctx, account)
	if err != nil {
		return nil, err
	}
	ids := branchIDs(branches)
	nameByID := make(map[string]string, len(branches))
	for _, b := range branches {
		nameByID[b.ID] = b.Name
	}
	out := &NetworkIngredientStockReport{Items: []NetworkIngredientStockRow{}}
	if len(ids) == 0 {
		return out, nil
	}

	type row struct {
		ID           string          `gorm:"column:id"`
		RestaurantID string          `gorm:"column:restaurant_id"`
		Name         *string         `gorm:"column:name"`
		Category     *string         `gorm:"column:category"`
		Qty          decimal.Decimal `gorm:"column:qty"`
		Unit         *string         `gorm:"column:unit"`
		PricePerUnit decimal.Decimal `gorm:"column:price_per_unit"`
	}
	var rows []row
	if err := s.r.Raw().WithContext(ctx).Table("ingredients").
		Select("id, restaurant_id, name, category, qty, unit, price_per_unit").
		Where("restaurant_id IN ?", ids).
		Scan(&rows).Error; err != nil {
		return nil, err
	}

	enriched := make([]NetworkIngredientStockRow, 0, len(rows))
	total := decimal.Zero
	for _, r := range rows {
		val := decimal.Mul(r.Qty, r.PricePerUnit)
		if !val.IsPositive() {
			continue
		}
		name := "—"
		if r.Name != nil && *r.Name != "" {
			name = *r.Name
		}
		cat := ""
		if r.Category != nil {
			cat = *r.Category
		}
		unit := ""
		if r.Unit != nil {
			unit = *r.Unit
		}
		enriched = append(enriched, NetworkIngredientStockRow{
			IngredientStockRow: IngredientStockRow{
				IngredientID: r.ID, Name: name, Category: cat,
				Qty: decimal.Normalize(r.Qty), Unit: unit,
				PricePerUnit: decimal.Normalize(r.PricePerUnit),
				Value:        decimal.Normalize(val),
			},
			RestaurantID:   r.RestaurantID,
			RestaurantName: nameByID[r.RestaurantID],
		})
		total = decimal.Add(total, val)
	}
	sort.Slice(enriched, func(i, j int) bool {
		return enriched[i].Value.GreaterThan(enriched[j].Value)
	})
	if len(enriched) > limit {
		enriched = enriched[:limit]
	}
	hundred := decimal.FromInt(100)
	for i := range enriched {
		if total.IsPositive() {
			enriched[i].Share = decimal.Normalize(
				decimal.DivRound(decimal.Mul(enriched[i].Value, hundred), total),
			)
		}
	}
	out.Items = enriched
	out.TotalValue = decimal.Normalize(total)
	return out, nil
}

// ─── Динамика ───────────────────────────────────────────────────────────

// TrendsNetwork — тот же временной ряд (revenue/orders/avg_check/expenses по
// бакетам), что и TrendsService.Trends, но по всей сети. НЕ переиспользует
// ReportsService.PnLData/FinanceReportsService.OpexByDay напрямую (они жёстко
// завязаны на ForTenant), а строит те же два запроса заново с
// restaurant_id IN ids — переиспользуя те же пакетные хелперы
// (applyOpexFilter/applyFOPeriod/foBizDay/bucketize/avgCheck), чтобы
// определение opex не разъехалось с локальным отчётом.
func (s *NetworkService) TrendsNetwork(ctx context.Context, f PeriodFilter, granularity string) (*TrendsJSON, error) {
	ids, err := s.networkBranchIDs(ctx)
	if err != nil {
		return nil, err
	}
	gran := normalizeGranularity(granularity)
	from, to := resolveRange(f)
	if len(ids) == 0 {
		return &TrendsJSON{From: from, To: to, Granularity: gran, Buckets: []TrendBucket{}}, nil
	}

	daily, err := s.networkDailyAgg(ctx, ids, from, to)
	if err != nil {
		return nil, err
	}
	buckets := bucketize(from, to, gran, daily)

	totals := TrendTotals{Revenue: decimal.Zero, Expenses: decimal.Zero}
	for _, b := range buckets {
		totals.Revenue = decimal.Add(totals.Revenue, b.Revenue)
		totals.OrdersCount += b.OrdersCount
		totals.Expenses = decimal.Add(totals.Expenses, b.Expenses)
	}
	totals.Revenue = decimal.Normalize(totals.Revenue)
	totals.Expenses = decimal.Normalize(totals.Expenses)
	totals.AvgCheck = avgCheck(totals.Revenue, totals.OrdersCount)

	// Предыдущий равный период [from-len, from): только тоталы для Δ%.
	length := to.Sub(from)
	prevFrom, prevTo := from.Add(-length), from
	prevDaily, err := s.networkDailyAgg(ctx, ids, prevFrom, prevTo)
	if err != nil {
		return nil, err
	}
	prev := TrendTotals{Revenue: decimal.Zero, Expenses: decimal.Zero}
	for _, a := range prevDaily {
		prev.Revenue = decimal.Add(prev.Revenue, a.revenue)
		prev.OrdersCount += a.orders
		prev.Expenses = decimal.Add(prev.Expenses, a.expenses)
	}
	prev.Revenue = decimal.Normalize(prev.Revenue)
	prev.Expenses = decimal.Normalize(prev.Expenses)
	prev.AvgCheck = avgCheck(prev.Revenue, prev.OrdersCount)

	return &TrendsJSON{
		From: from, To: to, Granularity: gran,
		Buckets: buckets, Totals: totals, Previous: prev,
	}, nil
}

// networkDailyAgg — сетевой аналог TrendsService.dailyAgg: revenue+orders из
// orders, expenses из financial_operations (тот же opex-фильтр, что в
// локальном ОПиУ/ДДС — включая исключение зеркальных «оплачено за филиал»
// операций через target_restaurant_id IS NULL внутри applyOpexFilter).
func (s *NetworkService) networkDailyAgg(ctx context.Context, ids []string, from, to time.Time) (map[string]*dayAgg, error) {
	type revRow struct {
		Day   string          `gorm:"column:day"`
		Total decimal.Decimal `gorm:"column:total"`
		Cnt   int             `gorm:"column:cnt"`
	}
	q := s.r.Raw().WithContext(ctx).Table("orders").
		Select("to_char(closed_at AT TIME ZONE 'Asia/Dushanbe', 'YYYY-MM-DD') AS day, COALESCE(SUM(total_with_service), 0) AS total, COUNT(*) AS cnt").
		Where("restaurant_id IN ? AND status IN ? AND closed_at IS NOT NULL", ids, []string{"closed", "refunded"}).
		Where("closed_at >= ? AND closed_at < ?", from, to).
		Group("day")
	var revRows []revRow
	if err := q.Scan(&revRows).Error; err != nil {
		return nil, err
	}
	out := make(map[string]*dayAgg, len(revRows))
	for _, r := range revRows {
		out[r.Day] = &dayAgg{revenue: r.Total, orders: r.Cnt, expenses: decimal.Zero}
	}

	type expRow struct {
		Day   string          `gorm:"column:day"`
		Total decimal.Decimal `gorm:"column:total"`
	}
	fopF := PeriodFilter{From: &from, To: &to}
	qe := applyFOPeriod(applyOpexFilter(s.r.Raw().WithContext(ctx).Table("financial_operations").
		Where("restaurant_id IN ?", ids).
		Select(foBizDay+" AS day, COALESCE(SUM(amount), 0) AS total")), fopF)
	var expRows []expRow
	if err := qe.Group("day").Scan(&expRows).Error; err != nil {
		return nil, err
	}
	for _, r := range expRows {
		a := out[r.Day]
		if a == nil {
			a = &dayAgg{revenue: decimal.Zero, expenses: decimal.Zero}
			out[r.Day] = a
		}
		a.expenses = r.Total
	}
	return out, nil
}

// ─── Прогноз ────────────────────────────────────────────────────────────

// ForecastNetwork — тот же комбинированный прогноз (revenue/cogs/margin +
// точка безубыточности + линрег на след. месяц), что и локальный /forecast,
// но суммой по всей сети: central сам не торгует, поэтому регрессия строится
// на СУММЕ выручки филиалов по месяцам, а не отдельно на каждый — тот же
// принцип, что у сетевого Дашборда/ОПиУ (сеть представляется одним числом,
// не N параллельных прогнозов).
func (s *NetworkService) ForecastNetwork(ctx context.Context, f PeriodFilter) (*ForecastReport, error) {
	ids, err := s.networkBranchIDs(ctx)
	if err != nil {
		return nil, err
	}
	out := &ForecastReport{MonthlyRevenue: []ForecastMonth{}}
	out.Period.From = f.From
	out.Period.To = f.To
	if len(ids) == 0 {
		return out, nil
	}

	type rRow struct {
		Month   string          `gorm:"column:month"`
		Revenue decimal.Decimal `gorm:"column:revenue"`
	}
	q := s.r.Raw().WithContext(ctx).Table("orders").
		Select(`to_char(closed_at AT TIME ZONE 'Asia/Dushanbe', 'YYYY-MM') AS month,
		        COALESCE(SUM(total_with_service), 0) AS revenue`).
		Where("restaurant_id IN ? AND status IN ? AND closed_at IS NOT NULL", ids, []string{"closed", "refunded"})
	if f.From != nil {
		q = q.Where("closed_at >= ?", *f.From)
	}
	if f.To != nil {
		q = q.Where("closed_at < ?", *f.To)
	}
	var rRows []rRow
	if err := q.Group("month").Order("month ASC").Scan(&rRows).Error; err != nil {
		return nil, err
	}
	revByMonth := make(map[string]decimal.Decimal, len(rRows))
	monthsOrder := make([]string, 0, len(rRows))
	for _, r := range rRows {
		revByMonth[r.Month] = r.Revenue
		monthsOrder = append(monthsOrder, r.Month)
	}

	type cRow struct {
		Month string          `gorm:"column:month"`
		COGS  decimal.Decimal `gorm:"column:cogs"`
	}
	q2 := s.r.Raw().WithContext(ctx).Table("orders AS o").
		Select(`to_char(o.closed_at AT TIME ZONE 'Asia/Dushanbe', 'YYYY-MM') AS month,
		        COALESCE(SUM(CASE WHEN oi.unit IN ('g','kg') AND oi.unit_size > 0 THEN oi.cogs * oi.qty / oi.unit_size ELSE oi.cogs * oi.qty END), 0) AS cogs`).
		Joins("JOIN order_items oi ON oi.order_id = o.id").
		Where("o.restaurant_id IN ? AND o.status IN ? AND o.closed_at IS NOT NULL AND oi.cancelled_at IS NULL", ids, []string{"closed", "refunded"})
	if f.From != nil {
		q2 = q2.Where("o.closed_at >= ?", *f.From)
	}
	if f.To != nil {
		q2 = q2.Where("o.closed_at < ?", *f.To)
	}
	var cRows []cRow
	_ = q2.Group("month").Scan(&cRows).Error
	cogsByMonth := make(map[string]decimal.Decimal, len(cRows))
	for _, r := range cRows {
		cogsByMonth[r.Month] = r.COGS
	}

	totalRev := decimal.Zero
	totalCOGS := decimal.Zero
	for _, m := range monthsOrder {
		rev := revByMonth[m]
		cogs := cogsByMonth[m]
		gross := decimal.Sub(rev, cogs)
		out.MonthlyRevenue = append(out.MonthlyRevenue, ForecastMonth{
			Month:       m,
			Revenue:     decimal.Normalize(rev),
			COGS:        decimal.Normalize(cogs),
			GrossProfit: decimal.Normalize(gross),
		})
		totalRev = decimal.Add(totalRev, rev)
		totalCOGS = decimal.Add(totalCOGS, cogs)
	}
	out.HistoricalMonths = len(monthsOrder)

	hundred := decimal.FromInt(100)
	if totalRev.IsPositive() {
		gross := decimal.Sub(totalRev, totalCOGS)
		out.AvgGrossMarginPct = decimal.Normalize(decimal.DivRound(decimal.Mul(gross, hundred), totalRev))
	}

	// Fixed costs: avg по месяцам, СУММА по сети, тот же opex-фильтр и те же
	// исключения (forecastExcludedExpense/forecastStockPurchase/
	// opexExcludedCategories — package-level, определены в analytics_extras.go).
	type opexRow struct {
		Month  string          `gorm:"column:month"`
		Amount decimal.Decimal `gorm:"column:amount"`
	}
	q3 := s.r.Raw().WithContext(ctx).Table("financial_operations").
		Select(`to_char(created_at AT TIME ZONE 'Asia/Dushanbe', 'YYYY-MM') AS month,
		        COALESCE(SUM(amount), 0) AS amount`).
		Where("restaurant_id IN ? AND type = ? AND COALESCE(activity, 'operational') = 'operational'", ids, "out")
	if f.From != nil {
		q3 = q3.Where("created_at >= ?", *f.From)
	}
	if f.To != nil {
		q3 = q3.Where("created_at < ?", *f.To)
	}
	excl := make([]string, 0, len(forecastExcludedExpense)+len(forecastStockPurchase)+len(opexExcludedCategories))
	for k := range forecastExcludedExpense {
		excl = append(excl, k)
	}
	for k := range forecastStockPurchase {
		excl = append(excl, k)
	}
	excl = append(excl, opexExcludedCategories...)
	q3 = q3.Where("COALESCE(category, '') NOT IN ?", excl)
	var opexRows []opexRow
	_ = q3.Group("month").Scan(&opexRows).Error
	if len(opexRows) > 0 {
		sum := decimal.Zero
		for _, r := range opexRows {
			sum = decimal.Add(sum, r.Amount)
		}
		out.FixedCostsMonthly = decimal.Normalize(
			decimal.DivRound(sum, decimal.FromInt(int64(len(opexRows)))),
		)
	}

	if out.FixedCostsMonthly.IsPositive() && out.AvgGrossMarginPct.IsPositive() {
		out.BreakevenRevenue = decimal.Normalize(
			decimal.DivRound(decimal.Mul(out.FixedCostsMonthly, hundred), out.AvgGrossMarginPct),
		)
	}

	// Линейная регрессия по последним 3 точкам сети — та же формула, что в
	// локальном отчёте (formatFloat/nextMonthLabel — те же package-level хелперы).
	if len(out.MonthlyRevenue) >= 2 {
		last := out.MonthlyRevenue
		if len(last) > 3 {
			last = last[len(last)-3:]
		}
		n := float64(len(last))
		var sumX, sumY, sumXY, sumX2 float64
		for i, m := range last {
			x := float64(i)
			y, _ := m.Revenue.Float64()
			sumX += x
			sumY += y
			sumXY += x * y
			sumX2 += x * x
		}
		den := n*sumX2 - sumX*sumX
		if den == 0 {
			den = 1
		}
		slope := (n*sumXY - sumX*sumY) / den
		intercept := (sumY - slope*sumX) / n
		next := math.Max(0, intercept+slope*n)
		out.ForecastNextMonth = decimal.MustFromString(formatFloat(next))
		out.ForecastNextMonthLabel = nextMonthLabel(last[len(last)-1].Month)
	}
	return out, nil
}

// ─── Столы ──────────────────────────────────────────────────────────────

// NetworkTableRow — как TableRow, но с именем филиала и БЕЗ Status: у стола
// нет сетевой идентичности («Стол 1» есть в каждом филиале — это разные
// объекты), поэтому строки не схлопываются, каждая помечена филиалом. Live
// статус (свободен/занят/ждёт счёт) намеренно не включён — это отчёт «за
// период» по всей сети, а не реалтайм-карта зала одного филиала; у центра
// нет единого «сейчас» по N независимым точкам одновременно (см. ту же
// оговорку у Дашборда/isBranchView).
type NetworkTableRow struct {
	TableID        string          `json:"table_id"`
	Name           string          `json:"name"`
	ZoneName       string          `json:"zone_name"`
	RestaurantID   string          `json:"restaurant_id"`
	RestaurantName string          `json:"restaurant_name"`
	Capacity       int             `json:"capacity"`
	Orders         int             `json:"orders"`
	Revenue        decimal.Decimal `json:"revenue"`
	AvgCheck       decimal.Decimal `json:"avg_check"`
	AvgDurationMin decimal.Decimal `json:"avg_duration_min"`
	GuestsTotal    int             `json:"guests_total"`
	RevenuePerSeat decimal.Decimal `json:"revenue_per_seat"`
	OccupancyPct   decimal.Decimal `json:"occupancy_pct"`
}

type NetworkTablesReport struct {
	Period struct {
		From *time.Time `json:"from,omitempty"`
		To   *time.Time `json:"to,omitempty"`
	} `json:"period"`
	TotalRevenue decimal.Decimal   `json:"total_revenue"`
	TotalOrders  int               `json:"total_orders"`
	Rows         []NetworkTableRow `json:"rows"`
}

// TablesNetwork — та же (стол × оборачиваемость) агрегация, что и локальный
// отчёт, по всей сети (см. NetworkTableRow про отсутствие Status).
func (s *NetworkService) TablesNetwork(ctx context.Context, f PeriodFilter) (*NetworkTablesReport, error) {
	account, err := s.accountForCtx(ctx)
	if err != nil {
		return nil, err
	}
	branches, err := s.branchesForAccount(ctx, account)
	if err != nil {
		return nil, err
	}
	ids := branchIDs(branches)
	nameByID := make(map[string]string, len(branches))
	for _, b := range branches {
		nameByID[b.ID] = b.Name
	}

	out := &NetworkTablesReport{Rows: []NetworkTableRow{}}
	out.Period.From = f.From
	out.Period.To = f.To
	if len(ids) == 0 {
		return out, nil
	}

	type row struct {
		RestaurantID string
		TableID      *string         `gorm:"column:table_id"`
		Name         *string         `gorm:"column:name"`
		ZoneName     *string         `gorm:"column:zone_name"`
		Capacity     *int            `gorm:"column:capacity"`
		Orders       int             `gorm:"column:orders"`
		Revenue      decimal.Decimal `gorm:"column:revenue"`
		AvgDurSec    decimal.Decimal `gorm:"column:avg_dur_sec"`
		Guests       int             `gorm:"column:guests_total"`
	}
	q := s.r.Raw().WithContext(ctx).Table("orders AS o").
		Select(`o.restaurant_id AS restaurant_id,
		        o.table_id AS table_id,
		        t.name AS name,
		        z.name AS zone_name,
		        t.capacity AS capacity,
		        COUNT(*) AS orders,
		        COALESCE(SUM(o.total_with_service), 0) AS revenue,
		        COALESCE(AVG(EXTRACT(EPOCH FROM (o.closed_at - o.created_at))), 0) AS avg_dur_sec,
		        COALESCE(SUM(o.guests_count), 0) AS guests_total`).
		Joins("LEFT JOIN tables t ON t.id::text = o.table_id AND t.restaurant_id = o.restaurant_id").
		Joins("LEFT JOIN zones z ON z.id::text = t.zone_id AND z.restaurant_id = o.restaurant_id").
		Where("o.restaurant_id IN ? AND o.status IN ? AND o.closed_at IS NOT NULL", ids, []string{"closed", "refunded"})
	if f.From != nil {
		q = q.Where("o.closed_at >= ?", *f.From)
	}
	if f.To != nil {
		q = q.Where("o.closed_at < ?", *f.To)
	}
	var rows []row
	if err := q.Group("o.restaurant_id, o.table_id, t.name, z.name, t.capacity").Scan(&rows).Error; err != nil {
		return nil, err
	}

	// Столы без закрытых заказов в периоде — тоже включаем (полнота списка).
	type freeTblRow struct {
		RestaurantID string  `gorm:"column:restaurant_id"`
		TableID      string  `gorm:"column:table_id"`
		Name         *string `gorm:"column:name"`
		ZoneName     *string `gorm:"column:zone_name"`
		Capacity     *int    `gorm:"column:capacity"`
	}
	var allTbls []freeTblRow
	_ = s.r.Raw().WithContext(ctx).Table("tables AS t").
		Select("t.restaurant_id AS restaurant_id, t.id AS table_id, t.name, z.name AS zone_name, t.capacity").
		Joins("LEFT JOIN zones z ON z.id::text = t.zone_id AND z.restaurant_id = t.restaurant_id").
		Where("t.restaurant_id IN ?", ids).
		Scan(&allTbls).Error
	seen := make(map[string]bool, len(rows))
	for _, r := range rows {
		if r.TableID != nil {
			seen[r.RestaurantID+":"+*r.TableID] = true
		}
	}

	// periodDays — как в локальном отчёте (Н19), но разброс closed_at по всей
	// сети, не одной точки.
	periodDays := computePeriodDays(f.From, f.To)
	if f.From == nil || f.To == nil {
		var span struct {
			MinAt *time.Time `gorm:"column:min_at"`
			MaxAt *time.Time `gorm:"column:max_at"`
		}
		if err := s.r.Raw().WithContext(ctx).Table("orders").
			Select("MIN(closed_at) AS min_at, MAX(closed_at) AS max_at").
			Where("restaurant_id IN ? AND status IN ? AND closed_at IS NOT NULL", ids, []string{"closed", "refunded"}).
			Scan(&span).Error; err == nil && span.MinAt != nil && span.MaxAt != nil {
			if d := span.MaxAt.Sub(*span.MinAt).Hours() / 24; d >= 1 {
				periodDays = int(d + 0.999)
			}
		}
	}

	totalRev := decimal.Zero
	totalOrd := 0
	sixty := decimal.FromInt(60)
	hundred := decimal.FromInt(100)
	emit := func(r row) {
		id := ""
		if r.TableID != nil {
			id = *r.TableID
		}
		name := "—"
		if r.Name != nil && *r.Name != "" {
			name = *r.Name
		}
		zone := ""
		if r.ZoneName != nil {
			zone = *r.ZoneName
		}
		cap := 0
		if r.Capacity != nil {
			cap = *r.Capacity
		}
		avg := decimal.Zero
		if r.Orders > 0 {
			avg = decimal.DivRound(r.Revenue, decimal.FromInt(int64(r.Orders)))
		}
		dur := decimal.DivRound(r.AvgDurSec, sixty)
		var revPerSeat decimal.Decimal
		if cap > 0 {
			revPerSeat = decimal.DivRound(r.Revenue, decimal.FromInt(int64(cap)))
		}
		var occ decimal.Decimal
		if cap > 0 && periodDays > 0 {
			den := decimal.FromInt(int64(cap) * int64(periodDays))
			occ = decimal.DivRound(decimal.Mul(decimal.FromInt(int64(r.Orders)), hundred), den)
		}
		out.Rows = append(out.Rows, NetworkTableRow{
			TableID: id, Name: name, ZoneName: zone,
			RestaurantID: r.RestaurantID, RestaurantName: nameByID[r.RestaurantID],
			Capacity: cap, Orders: r.Orders,
			Revenue: decimal.Normalize(r.Revenue), AvgCheck: decimal.Normalize(avg),
			AvgDurationMin: decimal.Normalize(dur), GuestsTotal: r.Guests,
			RevenuePerSeat: decimal.Normalize(revPerSeat), OccupancyPct: decimal.Normalize(occ),
		})
		totalRev = decimal.Add(totalRev, r.Revenue)
		totalOrd += r.Orders
	}
	for _, r := range rows {
		emit(r)
	}
	for _, t := range allTbls {
		if seen[t.RestaurantID+":"+t.TableID] {
			continue
		}
		emit(row{RestaurantID: t.RestaurantID, TableID: &t.TableID, Name: t.Name, ZoneName: t.ZoneName, Capacity: t.Capacity})
	}
	sort.Slice(out.Rows, func(i, j int) bool {
		return out.Rows[i].Revenue.GreaterThan(out.Rows[j].Revenue)
	})
	out.TotalRevenue = decimal.Normalize(totalRev)
	out.TotalOrders = totalOrd
	return out, nil
}

// networkBranchIDs — общий вход для методов этого файла: список id узлов
// сети вызывающего. Пустой слайс (не ошибка), если сеть пуста — вызывающий
// сам решает, что за this значит (обычно просто пустой отчёт).
func (s *NetworkService) networkBranchIDs(ctx context.Context) ([]string, error) {
	account, err := s.accountForCtx(ctx)
	if err != nil {
		return nil, err
	}
	branches, err := s.branchesForAccount(ctx, account)
	if err != nil {
		return nil, err
	}
	return branchIDs(branches), nil
}

// ─── Отмены ─────────────────────────────────────────────────────────────

// NetworkCancellationRow — CancellationRow + филиал (свой users.id/order_id
// на каждом филиале, схлопывать по имени нельзя — та же логика, что у
// NetworkWaiterRow).
type NetworkCancellationRow struct {
	CancellationRow
	RestaurantID   string `gorm:"column:restaurant_id" json:"restaurant_id"`
	RestaurantName string `gorm:"-" json:"restaurant_name"`
}

type NetworkCancellationsReport struct {
	Period struct {
		From *string `json:"from,omitempty"`
		To   *string `json:"to,omitempty"`
	} `json:"period"`
	Summary CancellationsSummary     `json:"summary"`
	Rows    []NetworkCancellationRow `json:"rows"`
	Total   int64                    `json:"total"`
	Limit   int                      `json:"limit"`
	Offset  int                      `json:"offset"`
}

// networkCancellationsUnionSQL — тот же UNION ALL, что и локальный отчёт
// (analytics_cancellations.go), но restaurant_id IN (?) вместо = ? и с
// колонкой restaurant_id в SELECT — central видит все филиалы разом.
func networkCancellationsUnionSQL(hasFrom, hasTo bool) string {
	voidWhere := "ov.restaurant_id IN ?"
	cancelWhere := "o.restaurant_id IN ? AND o.cancelled_at IS NOT NULL"
	if hasFrom {
		voidWhere += " AND ov.created_at >= ?"
		cancelWhere += " AND o.cancelled_at >= ?"
	}
	if hasTo {
		voidWhere += " AND ov.created_at < ?"
		cancelWhere += " AND o.cancelled_at < ?"
	}
	return fmt.Sprintf(`
		SELECT 'item_void' AS kind, ov.order_id AS order_id, o.order_number AS order_number,
		       o.type AS order_type, t.name AS table_name, ov.item_name AS item_name,
		       ov.item_qty AS item_qty, (ov.item_price * COALESCE(ov.item_qty, 1)) AS amount,
		       ov.reason AS reason, ov.approved_by_name AS approved_by_name,
		       ov.created_by_name AS created_by_name, ov.created_at AS created_at,
		       ov.restaurant_id AS restaurant_id
		FROM order_voids ov
		JOIN orders o ON o.id = ov.order_id
		LEFT JOIN tables t ON t.id::text = o.table_id
		WHERE %s
		UNION ALL
		SELECT 'order_cancel' AS kind, o.id AS order_id, o.order_number AS order_number,
		       o.type AS order_type, t.name AS table_name, NULL AS item_name,
		       NULL AS item_qty, COALESCE(o.cancelled_total, o.total, 0) AS amount,
		       o.cancel_reason AS reason, NULL AS approved_by_name,
		       u.name AS created_by_name, o.cancelled_at AS created_at,
		       o.restaurant_id AS restaurant_id
		FROM orders o
		LEFT JOIN tables t ON t.id::text = o.table_id
		LEFT JOIN users u ON u.id::text = o.cancelled_by AND u.restaurant_id = o.restaurant_id
		WHERE %s
	`, voidWhere, cancelWhere)
}

// CancellationsReportNetwork — та же (детальные отмены) аналитика, что и
// локальный отчёт, но по всей сети, каждая строка помечена филиалом.
func (s *NetworkService) CancellationsReportNetwork(ctx context.Context, f CancellationFilter) (*NetworkCancellationsReport, error) {
	account, err := s.accountForCtx(ctx)
	if err != nil {
		return nil, err
	}
	branches, err := s.branchesForAccount(ctx, account)
	if err != nil {
		return nil, err
	}
	ids := branchIDs(branches)
	nameByID := make(map[string]string, len(branches))
	for _, b := range branches {
		nameByID[b.ID] = b.Name
	}

	out := &NetworkCancellationsReport{Rows: []NetworkCancellationRow{}, Summary: newCancellationsSummary()}
	if f.From != nil {
		s := f.From.Format("2006-01-02")
		out.Period.From = &s
	}
	if f.To != nil {
		s := f.To.Format("2006-01-02")
		out.Period.To = &s
	}
	if len(ids) == 0 {
		return out, nil
	}

	limit := f.Limit
	if limit <= 0 {
		limit = cancellationsDefaultLimit
	}
	if limit > cancellationsMaxLimit {
		limit = cancellationsMaxLimit
	}
	offset := f.Offset
	if offset < 0 {
		offset = 0
	}

	args := []any{ids}
	if f.From != nil {
		args = append(args, *f.From)
	}
	if f.To != nil {
		args = append(args, *f.To)
	}
	args = append(args, args...)
	unionSQL := networkCancellationsUnionSQL(f.From != nil, f.To != nil)

	if err := s.r.Raw().WithContext(ctx).
		Raw(fmt.Sprintf("SELECT COUNT(*) FROM (%s) x", unionSQL), args...).
		Scan(&out.Total).Error; err != nil {
		return nil, err
	}

	pagedArgs := append(append([]any{}, args...), limit, offset)
	if err := s.r.Raw().WithContext(ctx).
		Raw(unionSQL+" ORDER BY created_at DESC LIMIT ? OFFSET ?", pagedArgs...).
		Scan(&out.Rows).Error; err != nil {
		return nil, err
	}
	for i := range out.Rows {
		out.Rows[i].RestaurantName = nameByID[out.Rows[i].RestaurantID]
	}

	type kindTotal struct {
		Kind   string          `gorm:"column:kind"`
		Amount decimal.Decimal `gorm:"column:amount"`
		Count  int             `gorm:"column:count"`
	}
	var kindTotals []kindTotal
	if err := s.r.Raw().WithContext(ctx).
		Raw(fmt.Sprintf("SELECT kind, COALESCE(SUM(amount),0) AS amount, COUNT(*) AS count FROM (%s) x GROUP BY kind", unionSQL), args...).
		Scan(&kindTotals).Error; err != nil {
		return nil, err
	}
	for _, kt := range kindTotals {
		out.Summary.TotalAmount = decimal.Add(out.Summary.TotalAmount, kt.Amount)
		out.Summary.TotalCount += kt.Count
		if kt.Kind == "item_void" {
			out.Summary.ItemVoidsAmount = kt.Amount
		} else {
			out.Summary.OrderCancelsAmount = kt.Amount
		}
	}
	out.Summary.TotalAmount = decimal.Normalize(out.Summary.TotalAmount)
	out.Summary.ItemVoidsAmount = decimal.Normalize(out.Summary.ItemVoidsAmount)
	out.Summary.OrderCancelsAmount = decimal.Normalize(out.Summary.OrderCancelsAmount)

	topN := func(groupExpr, where string) ([]CancellationBucket, error) {
		rows := []CancellationBucket{}
		sql := fmt.Sprintf(
			"SELECT %s AS name, COALESCE(SUM(amount),0) AS amount, COUNT(*) AS count FROM (%s) x %s GROUP BY name ORDER BY amount DESC LIMIT 10",
			groupExpr, unionSQL, where)
		if err := s.r.Raw().WithContext(ctx).Raw(sql, args...).Scan(&rows).Error; err != nil {
			return nil, err
		}
		return rows, nil
	}
	if out.Summary.ByReason, err = topN("COALESCE(reason, 'Без причины')", ""); err != nil {
		return nil, err
	}
	if out.Summary.ByEmployee, err = topN("COALESCE(created_by_name, 'Неизвестно')", ""); err != nil {
		return nil, err
	}
	if out.Summary.ByDish, err = topN("item_name", "WHERE item_name IS NOT NULL"); err != nil {
		return nil, err
	}
	if out.Summary.ByDay, err = topN("to_char(created_at AT TIME ZONE 'Asia/Dushanbe', 'YYYY-MM-DD')", ""); err != nil {
		return nil, err
	}

	return out, nil
}
