package service

// Analytics — серверные аггрегаты для экранов /analytics/*.
//
// Принципы:
//   - Один SQL на отчёт (GROUP BY) — не качаем raw заказы клиенту.
//   - Только закрытые заказы (status='closed'), только не-cancelled items.
//   - Revenue = orders.total_with_service, COGS = order_items.cogs * qty
//     (snapshot на момент закрытия — изменение себестоимости задним числом
//     не перетряхивает исторические отчёты).
//   - Tenant-фильтрация через ForTenant.
//   - Все деньги — decimal.Decimal, без float.

import (
	"context"
	"sort"
	"time"

	"github.com/restos/restos-v4/server/internal/pkg/decimal"
	"github.com/restos/restos-v4/server/internal/repo"
)

type AnalyticsService struct {
	r *repo.Repo
}

func NewAnalyticsService(r *repo.Repo) *AnalyticsService { return &AnalyticsService{r: r} }

// computePeriodDays — длительность периода в днях (округление вверх до 1).
// Используется для occupancy = orders / (capacity * days).
func computePeriodDays(from, to *time.Time) int {
	if from == nil || to == nil {
		return 1
	}
	d := to.Sub(*from).Hours() / 24
	if d < 1 {
		return 1
	}
	return int(d + 0.999)
}

// ─── ABC menu ──────────────────────────────────────────────────────────────

type ABCMenuRow struct {
	MenuItemID    string          `json:"menu_item_id"`
	Name          string          `json:"name"`
	Qty           decimal.Decimal `json:"qty"`
	Revenue       decimal.Decimal `json:"revenue"`
	COGS          decimal.Decimal `json:"cogs"`
	GrossProfit   decimal.Decimal `json:"gross_profit"`
	MarginPercent decimal.Decimal `json:"margin_percent"`
	Share         decimal.Decimal `json:"share"`     // % от total revenue
	CumShare      decimal.Decimal `json:"cum_share"` // нарастающая
	Class         string          `json:"class"`    // "A"|"B"|"C"
	// Menu Engineering (Boston matrix) на основе медиан qty + margin_percent:
	//   star      — высокая популярность + высокая маржа
	//   workhorse — высокая популярность + низкая маржа
	//   puzzle    — низкая популярность + высокая маржа
	//   dog       — низкая популярность + низкая маржа
	EngineeringClass string `json:"engineering_class,omitempty"`
}

type ABCMenuReport struct {
	Period struct {
		From *time.Time `json:"from,omitempty"`
		To   *time.Time `json:"to,omitempty"`
	} `json:"period"`
	TotalRevenue decimal.Decimal `json:"total_revenue"`
	TotalCOGS    decimal.Decimal `json:"total_cogs"`
	Items        []ABCMenuRow    `json:"items"`
}

// ABCMenu — Pareto-анализ блюд по выручке. A=80%, B=80–95%, C=95–100%.
//
// Источник: order_items × orders × menu_items.
// Revenue = SUM(price * qty), COGS = SUM(cogs * qty) — на сами строки
// (НЕ order.total, потому что нужна разбивка по блюду).
//
// Когда нет продаж — items[] пуст, все нули, fronend показывает empty-state.
func (s *AnalyticsService) ABCMenu(ctx context.Context, f PeriodFilter) (*ABCMenuReport, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	out := &ABCMenuReport{Items: []ABCMenuRow{}}
	out.Period.From = f.From
	out.Period.To = f.To

	q := scoped.Table("order_items AS oi").
		Select(`oi.menu_item_id AS menu_item_id,
		        COALESCE(MAX(mi.name), MAX(oi.name), '—') AS name,
		        COALESCE(SUM(oi.qty), 0) AS qty,
		        COALESCE(SUM(oi.price * oi.qty), 0) AS revenue,
		        COALESCE(SUM(oi.cogs  * oi.qty), 0) AS cogs`).
		Joins("JOIN orders o ON o.id = oi.order_id").
		Joins("LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id").
		Where("o.status = ? AND o.closed_at IS NOT NULL", "closed").
		Where("oi.cancelled_at IS NULL").
		Where("oi.menu_item_id IS NOT NULL")
	if f.From != nil {
		q = q.Where("o.closed_at >= ?", *f.From)
	}
	if f.To != nil {
		q = q.Where("o.closed_at < ?", *f.To)
	}
	var rows []abcAggRow
	if err := q.Group("oi.menu_item_id").Scan(&rows).Error; err != nil {
		return nil, err
	}

	// Сортировка по выручке desc.
	sort.Slice(rows, func(i, j int) bool {
		return rows[i].Revenue.GreaterThan(rows[j].Revenue)
	})

	// Подсчёт total.
	totalRev := decimal.Zero
	totalCOGS := decimal.Zero
	for _, r := range rows {
		totalRev = decimal.Add(totalRev, r.Revenue)
		totalCOGS = decimal.Add(totalCOGS, r.COGS)
	}
	out.TotalRevenue = decimal.Normalize(totalRev)
	out.TotalCOGS = decimal.Normalize(totalCOGS)

	// Menu Engineering: считаем медианы qty и margin_percent ДО основного
	// цикла. Класс присваиваем в основном цикле.
	medQty := medianQty(rows)
	medMargin := medianMargin(rows)

	// ABC классификация.
	// Если totalRev == 0 (нет продаж) — все позиции класс C, share/cumShare = 0.
	hundred := decimal.FromInt(100)
	cum := decimal.Zero
	out.Items = make([]ABCMenuRow, 0, len(rows))
	for _, r := range rows {
		var share, cumShare decimal.Decimal
		if totalRev.IsPositive() {
			share = decimal.DivRound(decimal.Mul(r.Revenue, hundred), totalRev)
			cum = decimal.Add(cum, share)
			cumShare = cum
		}
		gross := decimal.Sub(r.Revenue, r.COGS)
		margin := decimal.Zero
		if r.Revenue.IsPositive() {
			margin = decimal.DivRound(decimal.Mul(gross, hundred), r.Revenue)
		}
		class := "C"
		if totalRev.IsPositive() {
			c := cumShare
			eighty := decimal.FromInt(80)
			ninetyFive := decimal.FromInt(95)
			switch {
			case c.LessThanOrEqual(eighty):
				class = "A"
			case c.LessThanOrEqual(ninetyFive):
				class = "B"
			default:
				class = "C"
			}
		}
		// Menu engineering: квадрант относительно медиан.
		eng := ""
		if totalRev.IsPositive() {
			highPop := r.Qty.GreaterThanOrEqual(medQty)
			highMargin := margin.GreaterThanOrEqual(medMargin)
			switch {
			case highPop && highMargin:
				eng = "star"
			case highPop && !highMargin:
				eng = "workhorse"
			case !highPop && highMargin:
				eng = "puzzle"
			default:
				eng = "dog"
			}
		}
		out.Items = append(out.Items, ABCMenuRow{
			MenuItemID:       r.MenuItemID,
			Name:             r.Name,
			Qty:              decimal.Normalize(r.Qty),
			Revenue:          decimal.Normalize(r.Revenue),
			COGS:             decimal.Normalize(r.COGS),
			GrossProfit:      decimal.Normalize(gross),
			MarginPercent:    decimal.Normalize(margin),
			Share:            decimal.Normalize(share),
			CumShare:         decimal.Normalize(cumShare),
			Class:            class,
			EngineeringClass: eng,
		})
	}
	return out, nil
}

// abcAggRow — внутренний named-тип для медиан и сортировки в ABC.
type abcAggRow struct {
	MenuItemID string          `gorm:"column:menu_item_id"`
	Name       string          `gorm:"column:name"`
	Qty        decimal.Decimal `gorm:"column:qty"`
	Revenue    decimal.Decimal `gorm:"column:revenue"`
	COGS       decimal.Decimal `gorm:"column:cogs"`
}

func medianQty(rows []abcAggRow) decimal.Decimal {
	if len(rows) == 0 {
		return decimal.Zero
	}
	xs := make([]decimal.Decimal, len(rows))
	for i, r := range rows {
		xs[i] = r.Qty
	}
	sort.Slice(xs, func(i, j int) bool { return xs[i].LessThan(xs[j]) })
	return xs[len(xs)/2]
}

func medianMargin(rows []abcAggRow) decimal.Decimal {
	if len(rows) == 0 {
		return decimal.Zero
	}
	hundred := decimal.FromInt(100)
	xs := make([]decimal.Decimal, 0, len(rows))
	for _, r := range rows {
		if r.Revenue.IsPositive() {
			gross := decimal.Sub(r.Revenue, r.COGS)
			xs = append(xs, decimal.DivRound(decimal.Mul(gross, hundred), r.Revenue))
		} else {
			xs = append(xs, decimal.Zero)
		}
	}
	sort.Slice(xs, func(i, j int) bool { return xs[i].LessThan(xs[j]) })
	return xs[len(xs)/2]
}

// ─── Peak hours ────────────────────────────────────────────────────────────

type PeakHoursCell struct {
	Weekday int             `json:"weekday"` // 0=Sun..6=Sat (Postgres EXTRACT(DOW))
	Hour    int             `json:"hour"`
	Orders  int             `json:"orders"`
	Revenue decimal.Decimal `json:"revenue"`
}

type PeakHoursReport struct {
	Period struct {
		From *time.Time `json:"from,omitempty"`
		To   *time.Time `json:"to,omitempty"`
	} `json:"period"`
	TotalOrders  int             `json:"total_orders"`
	TotalRevenue decimal.Decimal `json:"total_revenue"`
	Cells        []PeakHoursCell `json:"cells"`
}

// PeakHours — гистограмма weekday × hour. Для каждого закрытого заказа
// берём EXTRACT(DOW), EXTRACT(HOUR) из closed_at.
func (s *AnalyticsService) PeakHours(ctx context.Context, f PeriodFilter) (*PeakHoursReport, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	out := &PeakHoursReport{Cells: []PeakHoursCell{}}
	out.Period.From = f.From
	out.Period.To = f.To

	type row struct {
		Weekday int             `gorm:"column:weekday"`
		Hour    int             `gorm:"column:hour"`
		Orders  int             `gorm:"column:orders"`
		Revenue decimal.Decimal `gorm:"column:revenue"`
	}
	q := scoped.Table("orders").
		Select(`EXTRACT(DOW  FROM closed_at)::int AS weekday,
		        EXTRACT(HOUR FROM closed_at)::int AS hour,
		        COUNT(*) AS orders,
		        COALESCE(SUM(total_with_service), 0) AS revenue`).
		Where("status = ? AND closed_at IS NOT NULL", "closed")
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
			Weekday: r.Weekday,
			Hour:    r.Hour,
			Orders:  r.Orders,
			Revenue: decimal.Normalize(r.Revenue),
		})
		total += r.Orders
		totalRev = decimal.Add(totalRev, r.Revenue)
	}
	out.TotalOrders = total
	out.TotalRevenue = decimal.Normalize(totalRev)
	return out, nil
}

// ─── Waiters ───────────────────────────────────────────────────────────────

type WaiterRow struct {
	WaiterID        string          `json:"waiter_id"`
	Name            string          `json:"name"`
	Orders          int             `json:"orders"`
	Revenue         decimal.Decimal `json:"revenue"`
	ItemsSold       decimal.Decimal `json:"items_sold"`
	AvgCheck        decimal.Decimal `json:"avg_check"`
	ServiceAmount   decimal.Decimal `json:"service_amount"`
	TipAmount       decimal.Decimal `json:"tip_amount"`
	AvgServiceMin   decimal.Decimal `json:"avg_service_min"`   // среднее (closed_at - created_at) в минутах
	BestDay         string          `json:"best_day"`          // YYYY-MM-DD с максимальной выручкой
	BestDayRevenue  decimal.Decimal `json:"best_day_revenue"`
}

type WaitersReport struct {
	Period struct {
		From *time.Time `json:"from,omitempty"`
		To   *time.Time `json:"to,omitempty"`
	} `json:"period"`
	TotalRevenue decimal.Decimal `json:"total_revenue"`
	TotalOrders  int             `json:"total_orders"`
	Rows         []WaiterRow     `json:"rows"`
}

// Waiters — статистика по официантам. waiter_id NULL → группа «без официанта».
func (s *AnalyticsService) Waiters(ctx context.Context, f PeriodFilter) (*WaitersReport, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	out := &WaitersReport{Rows: []WaiterRow{}}
	out.Period.From = f.From
	out.Period.To = f.To

	type row struct {
		WaiterID      *string         `gorm:"column:waiter_id"`
		Name          *string         `gorm:"column:name"`
		Orders        int             `gorm:"column:orders"`
		Revenue       decimal.Decimal `gorm:"column:revenue"`
		ServiceAmount decimal.Decimal `gorm:"column:service_amount"`
		TipAmount     decimal.Decimal `gorm:"column:tip_amount"`
		AvgDurSec     decimal.Decimal `gorm:"column:avg_dur_sec"`
	}
	q := scoped.Table("orders AS o").
		Select(`o.waiter_id AS waiter_id,
		        u.name AS name,
		        COUNT(*) AS orders,
		        COALESCE(SUM(o.total_with_service), 0) AS revenue,
		        COALESCE(SUM(o.service_amount), 0) AS service_amount,
		        COALESCE(SUM(o.tip_amount), 0) AS tip_amount,
		        COALESCE(AVG(EXTRACT(EPOCH FROM (o.closed_at - o.created_at))), 0) AS avg_dur_sec`).
		Joins("LEFT JOIN users u ON u.id = o.waiter_id").
		Where("o.status = ? AND o.closed_at IS NOT NULL", "closed")
	if f.From != nil {
		q = q.Where("o.closed_at >= ?", *f.From)
	}
	if f.To != nil {
		q = q.Where("o.closed_at < ?", *f.To)
	}
	var rows []row
	if err := q.Group("o.waiter_id, u.name").Scan(&rows).Error; err != nil {
		return nil, err
	}

	// items_sold — отдельным запросом GROUP BY waiter_id, JOIN order_items.
	scoped2, _ := s.r.ForTenant(ctx)
	type itemRow struct {
		WaiterID *string         `gorm:"column:waiter_id"`
		Qty      decimal.Decimal `gorm:"column:qty"`
	}
	qi := scoped2.Table("orders AS o").
		Select("o.waiter_id AS waiter_id, COALESCE(SUM(oi.qty), 0) AS qty").
		Joins("JOIN order_items oi ON oi.order_id = o.id").
		Where("o.status = ? AND o.closed_at IS NOT NULL", "closed").
		Where("oi.cancelled_at IS NULL")
	if f.From != nil {
		qi = qi.Where("o.closed_at >= ?", *f.From)
	}
	if f.To != nil {
		qi = qi.Where("o.closed_at < ?", *f.To)
	}
	var iRows []itemRow
	_ = qi.Group("o.waiter_id").Scan(&iRows).Error
	itemsByWaiter := make(map[string]decimal.Decimal, len(iRows))
	for _, r := range iRows {
		k := ""
		if r.WaiterID != nil {
			k = *r.WaiterID
		}
		itemsByWaiter[k] = r.Qty
	}

	// Best day per waiter — сначала GROUP BY (waiter, day), потом в Go
	// max-find. ForTenant добавляет restaurant_id WHERE.
	scoped3, _ := s.r.ForTenant(ctx)
	type dayRow struct {
		WaiterID *string         `gorm:"column:waiter_id"`
		Day      string          `gorm:"column:day"`
		Revenue  decimal.Decimal `gorm:"column:revenue"`
	}
	qb := scoped3.Table("orders").
		Select(`waiter_id, to_char(closed_at, 'YYYY-MM-DD') AS day,
		        COALESCE(SUM(total_with_service), 0) AS revenue`).
		Where("status = ? AND closed_at IS NOT NULL", "closed")
	if f.From != nil {
		qb = qb.Where("closed_at >= ?", *f.From)
	}
	if f.To != nil {
		qb = qb.Where("closed_at < ?", *f.To)
	}
	var dRows []dayRow
	_ = qb.Group("waiter_id, day").Scan(&dRows).Error
	type bestEntry struct {
		Day     string
		Revenue decimal.Decimal
	}
	bestByWaiter := make(map[string]bestEntry, 16)
	for _, r := range dRows {
		k := ""
		if r.WaiterID != nil {
			k = *r.WaiterID
		}
		cur, ok := bestByWaiter[k]
		if !ok || r.Revenue.GreaterThan(cur.Revenue) {
			bestByWaiter[k] = bestEntry{Day: r.Day, Revenue: r.Revenue}
		}
	}

	totalRev := decimal.Zero
	totalOrd := 0
	for _, r := range rows {
		id := ""
		if r.WaiterID != nil {
			id = *r.WaiterID
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
		best := bestByWaiter[id]
		out.Rows = append(out.Rows, WaiterRow{
			WaiterID:       id,
			Name:           name,
			Orders:         r.Orders,
			Revenue:        decimal.Normalize(r.Revenue),
			ItemsSold:      decimal.Normalize(itemsByWaiter[id]),
			AvgCheck:       decimal.Normalize(avg),
			ServiceAmount:  decimal.Normalize(r.ServiceAmount),
			TipAmount:      decimal.Normalize(r.TipAmount),
			AvgServiceMin:  decimal.Normalize(avgMin),
			BestDay:        best.Day,
			BestDayRevenue: decimal.Normalize(best.Revenue),
		})
		totalRev = decimal.Add(totalRev, r.Revenue)
		totalOrd += r.Orders
	}
	// Сортировка по выручке desc.
	sort.Slice(out.Rows, func(i, j int) bool {
		return out.Rows[i].Revenue.GreaterThan(out.Rows[j].Revenue)
	})
	out.TotalRevenue = decimal.Normalize(totalRev)
	out.TotalOrders = totalOrd
	return out, nil
}

// ─── Tables ────────────────────────────────────────────────────────────────

type TableRow struct {
	TableID        string          `json:"table_id"`
	Name           string          `json:"name"`
	ZoneName       string          `json:"zone_name"`
	Status         string          `json:"status"`         // live: free|occupied|reserved|bill_requested
	Capacity       int             `json:"capacity"`
	Orders         int             `json:"orders"`
	Revenue        decimal.Decimal `json:"revenue"`
	AvgCheck       decimal.Decimal `json:"avg_check"`
	AvgDurationMin decimal.Decimal `json:"avg_duration_min"`
	GuestsTotal    int             `json:"guests_total"`
	RevenuePerSeat decimal.Decimal `json:"revenue_per_seat"` // revenue/capacity (если capacity>0)
	OccupancyPct   decimal.Decimal `json:"occupancy_pct"`    // orders/(capacity*period_days) * 100
}

type TablesReport struct {
	Period struct {
		From *time.Time `json:"from,omitempty"`
		To   *time.Time `json:"to,omitempty"`
	} `json:"period"`
	TotalRevenue decimal.Decimal `json:"total_revenue"`
	TotalOrders  int             `json:"total_orders"`
	Rows         []TableRow      `json:"rows"`
}

// Tables — оборачиваемость столов. AvgDuration — среднее (closed_at-created_at)
// в минутах.
func (s *AnalyticsService) Tables(ctx context.Context, f PeriodFilter) (*TablesReport, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	out := &TablesReport{Rows: []TableRow{}}
	out.Period.From = f.From
	out.Period.To = f.To

	type row struct {
		TableID   *string         `gorm:"column:table_id"`
		Name      *string         `gorm:"column:name"`
		ZoneName  *string         `gorm:"column:zone_name"`
		Status    *string         `gorm:"column:status"`
		Capacity  *int            `gorm:"column:capacity"`
		Orders    int             `gorm:"column:orders"`
		Revenue   decimal.Decimal `gorm:"column:revenue"`
		AvgDurSec decimal.Decimal `gorm:"column:avg_dur_sec"`
		Guests    int             `gorm:"column:guests_total"`
	}
	q := scoped.Table("orders AS o").
		Select(`o.table_id AS table_id,
		        t.name AS name,
		        z.name AS zone_name,
		        t.status AS status,
		        t.capacity AS capacity,
		        COUNT(*) AS orders,
		        COALESCE(SUM(o.total_with_service), 0) AS revenue,
		        COALESCE(AVG(EXTRACT(EPOCH FROM (o.closed_at - o.created_at))), 0) AS avg_dur_sec,
		        COALESCE(SUM(o.guests_count), 0) AS guests_total`).
		Joins("LEFT JOIN tables t ON t.id = o.table_id").
		Joins("LEFT JOIN zones z ON z.id = t.zone_id").
		Where("o.status = ? AND o.closed_at IS NOT NULL", "closed")
	if f.From != nil {
		q = q.Where("o.closed_at >= ?", *f.From)
	}
	if f.To != nil {
		q = q.Where("o.closed_at < ?", *f.To)
	}
	var rows []row
	if err := q.Group("o.table_id, t.name, z.name, t.status, t.capacity").Scan(&rows).Error; err != nil {
		return nil, err
	}

	// Также добавляем столы без закрытых заказов (для live-status картины).
	scopedT, _ := s.r.ForTenant(ctx)
	type freeTblRow struct {
		TableID  string  `gorm:"column:id"`
		Name     *string `gorm:"column:name"`
		ZoneName *string `gorm:"column:zone_name"`
		Status   *string `gorm:"column:status"`
		Capacity *int    `gorm:"column:capacity"`
	}
	var allTbls []freeTblRow
	_ = scopedT.Table("tables AS t").
		Select("t.id, t.name, z.name AS zone_name, t.status, t.capacity").
		Joins("LEFT JOIN zones z ON z.id = t.zone_id").
		Where("t.is_deleted = false").Scan(&allTbls).Error
	seen := make(map[string]bool, len(rows))
	for _, r := range rows {
		if r.TableID != nil {
			seen[*r.TableID] = true
		}
	}

	// period_days для occupancy% — если from/to не заданы, используем
	// разброс между min(closed_at) и max(closed_at), fallback = 1.
	periodDays := computePeriodDays(f.From, f.To)
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
		status := "free"
		if r.Status != nil && *r.Status != "" {
			status = *r.Status
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
		// occupancy% = orders / (capacity * periodDays) * 100. Если capacity=0
		// или periodDays=0 — 0.
		var occ decimal.Decimal
		if cap > 0 && periodDays > 0 {
			den := decimal.FromInt(int64(cap) * int64(periodDays))
			occ = decimal.DivRound(decimal.Mul(decimal.FromInt(int64(r.Orders)), hundred), den)
		}
		out.Rows = append(out.Rows, TableRow{
			TableID:        id,
			Name:           name,
			ZoneName:       zone,
			Status:         status,
			Capacity:       cap,
			Orders:         r.Orders,
			Revenue:        decimal.Normalize(r.Revenue),
			AvgCheck:       decimal.Normalize(avg),
			AvgDurationMin: decimal.Normalize(dur),
			GuestsTotal:    r.Guests,
			RevenuePerSeat: decimal.Normalize(revPerSeat),
			OccupancyPct:   decimal.Normalize(occ),
		})
		totalRev = decimal.Add(totalRev, r.Revenue)
		totalOrd += r.Orders
	}
	for _, r := range rows {
		emit(r)
	}
	// Столы без заказов в периоде — добавляем с orders=0.
	for _, t := range allTbls {
		if seen[t.TableID] {
			continue
		}
		emit(row{TableID: &t.TableID, Name: t.Name, ZoneName: t.ZoneName, Status: t.Status, Capacity: t.Capacity})
	}
	sort.Slice(out.Rows, func(i, j int) bool {
		return out.Rows[i].Revenue.GreaterThan(out.Rows[j].Revenue)
	})
	out.TotalRevenue = decimal.Normalize(totalRev)
	out.TotalOrders = totalOrd
	return out, nil
}

// ─── Food cost (per dish revenue / cogs / margin) ──────────────────────────

type FoodCostRow struct {
	MenuItemID    string          `json:"menu_item_id"`
	Name          string          `json:"name"`
	Qty           decimal.Decimal `json:"qty"`
	Revenue       decimal.Decimal `json:"revenue"`
	COGS          decimal.Decimal `json:"cogs"`
	FoodCostPct   decimal.Decimal `json:"food_cost_pct"` // cogs/revenue * 100
	GrossProfit   decimal.Decimal `json:"gross_profit"`
	MarginPercent decimal.Decimal `json:"margin_percent"` // gross/revenue * 100
}

type FoodCostReport struct {
	Period struct {
		From *time.Time `json:"from,omitempty"`
		To   *time.Time `json:"to,omitempty"`
	} `json:"period"`
	TotalRevenue  decimal.Decimal `json:"total_revenue"`
	TotalCOGS     decimal.Decimal `json:"total_cogs"`
	FoodCostPct   decimal.Decimal `json:"food_cost_pct"`
	MarginPercent decimal.Decimal `json:"margin_percent"`
	Rows          []FoodCostRow   `json:"rows"`
}

// FoodCost — себестоимость по блюдам. Сорт по food_cost_pct desc (худшие сверху).
func (s *AnalyticsService) FoodCost(ctx context.Context, f PeriodFilter) (*FoodCostReport, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	out := &FoodCostReport{Rows: []FoodCostRow{}}
	out.Period.From = f.From
	out.Period.To = f.To

	type row struct {
		MenuItemID string          `gorm:"column:menu_item_id"`
		Name       string          `gorm:"column:name"`
		Qty        decimal.Decimal `gorm:"column:qty"`
		Revenue    decimal.Decimal `gorm:"column:revenue"`
		COGS       decimal.Decimal `gorm:"column:cogs"`
	}
	q := scoped.Table("order_items AS oi").
		Select(`oi.menu_item_id AS menu_item_id,
		        COALESCE(MAX(mi.name), MAX(oi.name), '—') AS name,
		        COALESCE(SUM(oi.qty), 0) AS qty,
		        COALESCE(SUM(oi.price * oi.qty), 0) AS revenue,
		        COALESCE(SUM(oi.cogs  * oi.qty), 0) AS cogs`).
		Joins("JOIN orders o ON o.id = oi.order_id").
		Joins("LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id").
		Where("o.status = ? AND o.closed_at IS NOT NULL", "closed").
		Where("oi.cancelled_at IS NULL").
		Where("oi.menu_item_id IS NOT NULL")
	if f.From != nil {
		q = q.Where("o.closed_at >= ?", *f.From)
	}
	if f.To != nil {
		q = q.Where("o.closed_at < ?", *f.To)
	}
	var rows []row
	if err := q.Group("oi.menu_item_id").Scan(&rows).Error; err != nil {
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
	// Худшие food cost сверху — менеджеру первым делом видеть проблемные блюда.
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
