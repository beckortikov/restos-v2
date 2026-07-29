package service

import (
	"context"

	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// SalesReport — «Отчёт продаж» (Н21). Раньше страница считалась КЛИЕНТСКИ из
// последних 5000 заказов без учёта скидок и voids: выручка завышалась, а старые
// периоды были неполны. Теперь сервер отдаёт агрегированные строки продаж по
// (дата, час, блюдо) по каноническому словарю — фронт только группирует.
//
// Правила (совпадают с ОПиУ/аналитикой):
//   - только status IN ('closed','refunded'), closed_at NOT NULL;
//   - отменённые позиции (oi.cancelled_at) исключены; частичный void уже отражён
//     в текущем oi.qty, поэтому voids учтены автоматически;
//   - выручка строки = цена×кол-во × доля после скидки заказа (сервис/чаевые на
//     блюда не размазываем);
//   - вес нормализуется на unit_size (как в ABC-меню).
type SalesReportRow struct {
	Date        string          `json:"date"` // YYYY-MM-DD (closed_at)
	Hour        int             `json:"hour"` // 0..23
	MenuItemID  *string         `json:"menu_item_id"`
	Name        string          `json:"name"`
	Category    string          `json:"category"`
	IsPurchased bool            `json:"is_purchased"`
	Qty         decimal.Decimal `json:"qty"`
	Revenue     decimal.Decimal `json:"revenue"`
}

type SalesReportTotals struct {
	Revenue decimal.Decimal `json:"revenue"`
	Qty     decimal.Decimal `json:"qty"`
	Orders  int             `json:"orders"`
}

// SalesReportDay — агрегат по дню (для разбивки по датам). Число заказов —
// distinct по orders (строки rows его не несут, т.к. агрегированы по блюду).
type SalesReportDay struct {
	Date    string          `json:"date"`
	Orders  int             `json:"orders"`
	Qty     decimal.Decimal `json:"qty"`
	Revenue decimal.Decimal `json:"revenue"`
}

type SalesReportResult struct {
	Period struct {
		From *string `json:"from,omitempty"`
		To   *string `json:"to,omitempty"`
	} `json:"period"`
	Rows   []SalesReportRow  `json:"rows"`
	ByDate []SalesReportDay  `json:"by_date"`
	Totals SalesReportTotals `json:"totals"`
}

func (s *AnalyticsService) SalesReport(ctx context.Context, f PeriodFilter) (*SalesReportResult, error) {
	scoped, err := s.r.ForTenantQualified(ctx, "o")
	if err != nil {
		return nil, err
	}
	out := &SalesReportResult{Rows: []SalesReportRow{}, ByDate: []SalesReportDay{}}

	q := scoped.Table("order_items AS oi").
		Select(`to_char(o.closed_at, 'YYYY-MM-DD') AS date,
		        EXTRACT(HOUR FROM o.closed_at)::int AS hour,
		        oi.menu_item_id AS menu_item_id,
		        COALESCE(MAX(mi.name), MAX(oi.name), '—') AS name,
		        COALESCE(MAX(NULLIF(mi.category, '')), 'Без категории') AS category,
		        COALESCE(bool_or(mi.is_purchased), false) AS is_purchased,
		        COALESCE(SUM(CASE WHEN oi.unit IN ('g','kg') AND oi.unit_size > 0 THEN oi.qty / oi.unit_size ELSE oi.qty END), 0) AS qty,
		        COALESCE(SUM((CASE WHEN oi.unit IN ('g','kg') AND oi.unit_size > 0 THEN oi.price * oi.qty / oi.unit_size ELSE oi.price * oi.qty END) * COALESCE((o.total - o.discount_amount) / NULLIF(o.total, 0), 1)), 0) AS revenue`).
		Joins("JOIN orders o ON o.id = oi.order_id").
		Joins("LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id").
		Where("o.status IN ? AND o.closed_at IS NOT NULL AND oi.cancelled_at IS NULL", []string{"closed", "refunded"})
	if f.From != nil {
		q = q.Where("o.closed_at >= ?", *f.From)
	}
	if f.To != nil {
		q = q.Where("o.closed_at < ?", *f.To)
	}
	if err := q.Group("date, hour, oi.menu_item_id").Order("date ASC, hour ASC").Scan(&out.Rows).Error; err != nil {
		return nil, err
	}

	// Тоталы: выручка/кол-во — сумма строк; заказы — distinct по периоду.
	for _, r := range out.Rows {
		out.Totals.Revenue = decimal.Add(out.Totals.Revenue, r.Revenue)
		out.Totals.Qty = decimal.Add(out.Totals.Qty, r.Qty)
	}
	out.Totals.Revenue = decimal.Normalize(out.Totals.Revenue)
	out.Totals.Qty = decimal.Normalize(out.Totals.Qty)

	scopedCnt, _ := s.r.ForTenant(ctx)
	qc := scopedCnt.Table("orders").
		Where("status IN ? AND closed_at IS NOT NULL", []string{"closed", "refunded"})
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

	// Разбивка по дням: distinct-заказы + выручка/кол-во (та же скидочная логика).
	scopedDay, _ := s.r.ForTenantQualified(ctx, "o")
	qd := scopedDay.Table("orders AS o").
		Select(`to_char(o.closed_at, 'YYYY-MM-DD') AS date,
		        COUNT(DISTINCT o.id) AS orders,
		        COALESCE(SUM(CASE WHEN oi.unit IN ('g','kg') AND oi.unit_size > 0 THEN oi.qty / oi.unit_size ELSE oi.qty END) FILTER (WHERE oi.id IS NOT NULL AND oi.cancelled_at IS NULL), 0) AS qty,
		        COALESCE(SUM((CASE WHEN oi.unit IN ('g','kg') AND oi.unit_size > 0 THEN oi.price * oi.qty / oi.unit_size ELSE oi.price * oi.qty END) * COALESCE((o.total - o.discount_amount) / NULLIF(o.total, 0), 1)) FILTER (WHERE oi.id IS NOT NULL AND oi.cancelled_at IS NULL), 0) AS revenue`).
		Joins("LEFT JOIN order_items oi ON oi.order_id = o.id").
		Where("o.status IN ? AND o.closed_at IS NOT NULL", []string{"closed", "refunded"})
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
