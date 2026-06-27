package service

// TrendsService — «Динамика» (deep analytics): временные ряды выручки, числа
// заказов, среднего чека и расходов за период с группировкой по дню/неделе/месяцу.
//
// Цифры берутся из УЖЕ существующих отчётов, чтобы гарантированно совпадать с
// ОПиУ и ДДС:
//   - выручка + число чеков → ReportsService.PnLData (GROUP BY closed_at::date),
//   - расходы (денежный отток) → FinanceReportsService.Cashflow (ByDay.Out).
//
// Дни без данных заполняются нулями (для ровного графика). Дополнительно
// считается предыдущий равный по длине период — для Δ% в KPI.

import (
	"context"
	"io"
	"sort"
	"time"

	"github.com/restos/restos-v4/server/internal/pkg/decimal"
	"github.com/restos/restos-v4/server/internal/pkg/xlsx"
)

type TrendsService struct {
	reports *ReportsService
	finance *FinanceReportsService
}

func NewTrendsService(reports *ReportsService, finance *FinanceReportsService) *TrendsService {
	return &TrendsService{reports: reports, finance: finance}
}

// TrendBucket — одна точка временного ряда (день / неделя / месяц).
type TrendBucket struct {
	Date        string          `json:"date"` // начало бакета, YYYY-MM-DD
	Revenue     decimal.Decimal `json:"revenue"`
	OrdersCount int             `json:"orders_count"`
	AvgCheck    decimal.Decimal `json:"avg_check"`
	Expenses    decimal.Decimal `json:"expenses"`
}

// TrendTotals — агрегаты за период (для KPI и сравнения).
type TrendTotals struct {
	Revenue     decimal.Decimal `json:"revenue"`
	OrdersCount int             `json:"orders_count"`
	AvgCheck    decimal.Decimal `json:"avg_check"`
	Expenses    decimal.Decimal `json:"expenses"`
}

type TrendsJSON struct {
	From        time.Time     `json:"from"`
	To          time.Time     `json:"to"`
	Granularity string        `json:"granularity"`
	Buckets     []TrendBucket `json:"buckets"`
	Totals      TrendTotals   `json:"totals"`
	Previous    TrendTotals   `json:"previous"` // равный по длине предыдущий период
}

type dayAgg struct {
	revenue  decimal.Decimal
	orders   int
	expenses decimal.Decimal
}

// Trends собирает временной ряд + тоталы текущего и предыдущего периода.
func (s *TrendsService) Trends(ctx context.Context, f PeriodFilter, granularity string) (*TrendsJSON, error) {
	gran := normalizeGranularity(granularity)
	from, to := resolveRange(f)

	// Текущий период: суточная агрегация → бакеты по гранулярности.
	daily, err := s.dailyAgg(ctx, from, to)
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
	prevDaily, err := s.dailyAgg(ctx, prevFrom, prevTo)
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

// dailyAgg возвращает посуточную агрегацию (revenue/orders из P&L, expenses из ДДС).
func (s *TrendsService) dailyAgg(ctx context.Context, from, to time.Time) (map[string]*dayAgg, error) {
	f := PeriodFilter{From: &from, To: &to}
	_, byDay, err := s.reports.PnLData(ctx, f)
	if err != nil {
		return nil, err
	}
	cf, err := s.finance.Cashflow(ctx, f)
	if err != nil {
		return nil, err
	}
	out := make(map[string]*dayAgg)
	for day, pl := range byDay {
		out[day] = &dayAgg{revenue: pl.Revenue, orders: pl.OrdersCount, expenses: decimal.Zero}
	}
	for _, d := range cf.ByDay {
		a := out[d.Date]
		if a == nil {
			a = &dayAgg{revenue: decimal.Zero, expenses: decimal.Zero}
			out[d.Date] = a
		}
		a.expenses = d.Out
	}
	return out, nil
}

// bucketize раскладывает суточные агрегаты по бакетам гранулярности, заполняя
// пропуски нулями. Возвращает бакеты в хронологическом порядке.
func bucketize(from, to time.Time, gran string, daily map[string]*dayAgg) []TrendBucket {
	order := make([]string, 0)
	acc := make(map[string]*dayAgg)
	// Идём по дням [from, to) и сворачиваем в ключ бакета.
	for d := truncDay(from); d.Before(to); d = d.AddDate(0, 0, 1) {
		key := bucketStart(d, gran).Format("2006-01-02")
		a := acc[key]
		if a == nil {
			a = &dayAgg{revenue: decimal.Zero, expenses: decimal.Zero}
			acc[key] = a
			order = append(order, key)
		}
		if src := daily[d.Format("2006-01-02")]; src != nil {
			a.revenue = decimal.Add(a.revenue, src.revenue)
			a.orders += src.orders
			a.expenses = decimal.Add(a.expenses, src.expenses)
		}
	}
	sort.Strings(order)
	buckets := make([]TrendBucket, 0, len(order))
	for _, key := range order {
		a := acc[key]
		buckets = append(buckets, TrendBucket{
			Date:        key,
			Revenue:     decimal.Normalize(a.revenue),
			OrdersCount: a.orders,
			AvgCheck:    avgCheck(a.revenue, a.orders),
			Expenses:    decimal.Normalize(a.expenses),
		})
	}
	return buckets
}

func avgCheck(revenue decimal.Decimal, orders int) decimal.Decimal {
	if orders <= 0 {
		return decimal.Zero
	}
	return decimal.Normalize(decimal.DivRound(revenue, decimal.FromInt(int64(orders))))
}

func normalizeGranularity(g string) string {
	switch g {
	case "week", "month":
		return g
	default:
		return "day"
	}
}

// resolveRange приводит фильтр к конкретному [from, to). По умолчанию — 30 дней.
func resolveRange(f PeriodFilter) (time.Time, time.Time) {
	var to time.Time
	if f.To != nil {
		to = *f.To
	} else {
		to = truncDay(time.Now()).AddDate(0, 0, 1)
	}
	var from time.Time
	if f.From != nil {
		from = *f.From
	} else {
		from = to.AddDate(0, 0, -30)
	}
	if !from.Before(to) {
		from = to.AddDate(0, 0, -1)
	}
	return from, to
}

func truncDay(t time.Time) time.Time {
	return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, t.Location())
}

// bucketStart — начало бакета для даты: день/понедельник недели/первое число месяца.
func bucketStart(t time.Time, gran string) time.Time {
	switch gran {
	case "week":
		offset := (int(t.Weekday()) + 6) % 7 // Пн=0 … Вс=6
		return truncDay(t).AddDate(0, 0, -offset)
	case "month":
		return time.Date(t.Year(), t.Month(), 1, 0, 0, 0, 0, t.Location())
	default:
		return truncDay(t)
	}
}

// TrendsXLSX — выгрузка временного ряда в Excel.
func (s *TrendsService) TrendsXLSX(ctx context.Context, f PeriodFilter, granularity string, w io.Writer) error {
	data, err := s.Trends(ctx, f, granularity)
	if err != nil {
		return err
	}
	sh := xlsx.New("Динамика")
	defer sh.Close()
	sh.Header("Период", "Выручка", "Заказов", "Средний чек", "Расходы")
	for _, b := range data.Buckets {
		sh.AddRow(b.Date, b.Revenue, b.OrdersCount, b.AvgCheck, b.Expenses)
	}
	totals := sh.AddSheet("Итого")
	totals.Header("Показатель", "Текущий период", "Предыдущий период")
	totals.AddRow("Выручка", data.Totals.Revenue, data.Previous.Revenue)
	totals.AddRow("Заказов", data.Totals.OrdersCount, data.Previous.OrdersCount)
	totals.AddRow("Средний чек", data.Totals.AvgCheck, data.Previous.AvgCheck)
	totals.AddRow("Расходы", data.Totals.Expenses, data.Previous.Expenses)
	_, err = sh.WriteTo(w)
	return err
}
