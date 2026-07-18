package service

// Weekday — аналитика по дням недели для владельца (A1–A3):
//   A1: тепловая карта день×час по ПРИБЫЛИ (revenue − cogs), не только выручке;
//   A2: день недели × категория — что продаётся когда;
//   A3: прибыль по дням недели = выручка − себестоимость − ФОТ смены.
//
// DOW (Postgres EXTRACT): 0=воскресенье … 6=суббота. Часовой пояс — как в
// PeakHours (по closed_at), без доп. конвертации.

import (
	"context"
	"time"

	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// whereClosedQ — фильтр периода по <alias>.closed_at (для join-запросов).
func whereClosedQ(q *gorm.DB, f PeriodFilter, alias string) *gorm.DB {
	if f.From != nil {
		q = q.Where(alias+".closed_at >= ?", *f.From)
	}
	if f.To != nil {
		q = q.Where(alias+".closed_at < ?", *f.To)
	}
	return q
}

type WeekdayRow struct {
	Weekday     int             `json:"weekday"`
	Orders      int             `json:"orders"`
	Revenue     decimal.Decimal `json:"revenue"`
	COGS        decimal.Decimal `json:"cogs"`
	Labor       decimal.Decimal `json:"labor"`
	GrossProfit decimal.Decimal `json:"gross_profit"`
	NetProfit   decimal.Decimal `json:"net_profit"`
	AvgCheck    decimal.Decimal `json:"avg_check"`
}

type WeekdayHourCell struct {
	Weekday int             `json:"weekday"`
	Hour    int             `json:"hour"`
	Orders  int             `json:"orders"`
	Revenue decimal.Decimal `json:"revenue"`
	Profit  decimal.Decimal `json:"profit"`
}

type WeekdayCategoryRow struct {
	Weekday  int             `json:"weekday"`
	Category string          `json:"category"`
	Qty      decimal.Decimal `json:"qty"`
	Revenue  decimal.Decimal `json:"revenue"`
	Profit   decimal.Decimal `json:"profit"`
}

type WeekdayReport struct {
	Period struct {
		From *time.Time `json:"from,omitempty"`
		To   *time.Time `json:"to,omitempty"`
	} `json:"period"`
	ByWeekday  []WeekdayRow         `json:"by_weekday"`
	Heatmap    []WeekdayHourCell    `json:"heatmap"`
	ByCategory []WeekdayCategoryRow `json:"by_category"`
}

func (s *AnalyticsService) Weekday(ctx context.Context, f PeriodFilter) (*WeekdayReport, error) {
	out := &WeekdayReport{ByWeekday: []WeekdayRow{}, Heatmap: []WeekdayHourCell{}, ByCategory: []WeekdayCategoryRow{}}
	out.Period.From, out.Period.To = f.From, f.To

	// A3 — выручка + заказы по дням недели.
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	type revRow struct {
		Weekday int             `gorm:"column:weekday"`
		Orders  int             `gorm:"column:orders"`
		Revenue decimal.Decimal `gorm:"column:revenue"`
	}
	qr := scoped.Table("orders").
		Select(`EXTRACT(DOW FROM closed_at)::int AS weekday, COUNT(*) AS orders, COALESCE(SUM(total_with_service),0) AS revenue`).
		Where("status IN ? AND closed_at IS NOT NULL", []string{"closed", "refunded"})
	qr = applyClosedPeriod(qr, f)
	var revRows []revRow
	if err := qr.Group("weekday").Scan(&revRows).Error; err != nil {
		return nil, err
	}

	// A3 — себестоимость по дням недели.
	scopedC, _ := s.r.ForTenantQualified(ctx, "o")
	type cogsRow struct {
		Weekday int             `gorm:"column:weekday"`
		COGS    decimal.Decimal `gorm:"column:cogs"`
	}
	qc := scopedC.Table("order_items AS oi").
		Select(`EXTRACT(DOW FROM o.closed_at)::int AS weekday, COALESCE(SUM(CASE WHEN oi.unit IN ('g','kg') AND oi.unit_size > 0 THEN oi.cogs * oi.qty / oi.unit_size ELSE oi.cogs * oi.qty END),0) AS cogs`).
		Joins("JOIN orders o ON o.id = oi.order_id").
		Where("o.status IN ? AND o.closed_at IS NOT NULL", []string{"closed", "refunded"}).
		Where("oi.cancelled_at IS NULL")
	qc = whereClosedQ(qc, f, "o")
	var cogsRows []cogsRow
	if err := qc.Group("weekday").Scan(&cogsRows).Error; err != nil {
		return nil, err
	}

	// A3 — ФОТ по дням недели (часы × ставка).
	scopedL, _ := s.r.ForTenantQualified(ctx, "te")
	type laborRow struct {
		Weekday int             `gorm:"column:weekday"`
		Labor   decimal.Decimal `gorm:"column:labor"`
	}
	ql := scopedL.Table("time_entries AS te").
		Select(`EXTRACT(DOW FROM te.clock_in)::int AS weekday, COALESCE(SUM(te.total_hours * COALESCE(u.hourly_rate,0)),0) AS labor`).
		Joins("JOIN users u ON u.id = te.user_id").
		Where("te.clock_in IS NOT NULL")
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

	// A1 — тепловая карта день×час (выручка из orders, прибыль с вычетом COGS).
	scopedH, _ := s.r.ForTenant(ctx)
	type hRow struct {
		Weekday int             `gorm:"column:weekday"`
		Hour    int             `gorm:"column:hour"`
		Orders  int             `gorm:"column:orders"`
		Revenue decimal.Decimal `gorm:"column:revenue"`
	}
	qh := scopedH.Table("orders").
		Select(`EXTRACT(DOW FROM closed_at)::int AS weekday, EXTRACT(HOUR FROM closed_at)::int AS hour, COUNT(*) AS orders, COALESCE(SUM(total_with_service),0) AS revenue`).
		Where("status IN ? AND closed_at IS NOT NULL", []string{"closed", "refunded"})
	qh = applyClosedPeriod(qh, f)
	var hRows []hRow
	if err := qh.Group("weekday, hour").Scan(&hRows).Error; err != nil {
		return nil, err
	}
	scopedHC, _ := s.r.ForTenantQualified(ctx, "o")
	type hcRow struct {
		Weekday int             `gorm:"column:weekday"`
		Hour    int             `gorm:"column:hour"`
		COGS    decimal.Decimal `gorm:"column:cogs"`
	}
	qhc := scopedHC.Table("order_items AS oi").
		Select(`EXTRACT(DOW FROM o.closed_at)::int AS weekday, EXTRACT(HOUR FROM o.closed_at)::int AS hour, COALESCE(SUM(CASE WHEN oi.unit IN ('g','kg') AND oi.unit_size > 0 THEN oi.cogs * oi.qty / oi.unit_size ELSE oi.cogs * oi.qty END),0) AS cogs`).
		Joins("JOIN orders o ON o.id = oi.order_id").
		Where("o.status IN ? AND o.closed_at IS NOT NULL", []string{"closed", "refunded"}).
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

	// A2 — день недели × категория.
	scopedCat, _ := s.r.ForTenantQualified(ctx, "o")
	type catRow struct {
		Weekday  int             `gorm:"column:weekday"`
		Category string          `gorm:"column:category"`
		Qty      decimal.Decimal `gorm:"column:qty"`
		Revenue  decimal.Decimal `gorm:"column:revenue"`
		COGS     decimal.Decimal `gorm:"column:cogs"`
	}
	qcat := scopedCat.Table("order_items AS oi").
		Select(`EXTRACT(DOW FROM o.closed_at)::int AS weekday, COALESCE(NULLIF(mi.category,''),'—') AS category,
		        COALESCE(SUM(oi.qty),0) AS qty, COALESCE(SUM(CASE WHEN oi.unit IN ('g','kg') AND oi.unit_size > 0 THEN oi.price * oi.qty / oi.unit_size ELSE oi.price * oi.qty END),0) AS revenue, COALESCE(SUM(CASE WHEN oi.unit IN ('g','kg') AND oi.unit_size > 0 THEN oi.cogs * oi.qty / oi.unit_size ELSE oi.cogs * oi.qty END),0) AS cogs`).
		Joins("JOIN orders o ON o.id = oi.order_id").
		Joins("LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id").
		Where("o.status IN ? AND o.closed_at IS NOT NULL", []string{"closed", "refunded"}).
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
