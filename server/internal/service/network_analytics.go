package service

import (
	"context"
	"sort"
	"time"

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
		Select(`EXTRACT(DOW  FROM closed_at)::int AS weekday,
		        EXTRACT(HOUR FROM closed_at)::int AS hour,
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
func (s *NetworkService) SalesReportNetwork(ctx context.Context, f PeriodFilter) (*SalesReportResult, error) {
	ids, err := s.networkBranchIDs(ctx)
	if err != nil {
		return nil, err
	}
	out := &SalesReportResult{Rows: []SalesReportRow{}, ByDate: []SalesReportDay{}}
	if len(ids) == 0 {
		return out, nil
	}

	q := s.r.Raw().WithContext(ctx).Table("order_items AS oi").
		Select(`to_char(o.closed_at, 'YYYY-MM-DD') AS date,
		        EXTRACT(HOUR FROM o.closed_at)::int AS hour,
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
	var cnt int64
	if err := qc.Count(&cnt).Error; err != nil {
		return nil, err
	}
	out.Totals.Orders = int(cnt)

	qd := s.r.Raw().WithContext(ctx).Table("orders AS o").
		Select(`to_char(o.closed_at, 'YYYY-MM-DD') AS date,
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
