package service

import (
	"context"
	"io"
	"time"

	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
	"github.com/restos/restos-v4/server/internal/pkg/xlsx"
)

// gormSessionNewDB — переиспользуемый Session-config для свежей цепочки.
var gormSessionNewDB = gorm.Session{NewDB: true}

// PnL — структура P&L за период (для тестов и SSE-event).
type PnL struct {
	From           *time.Time      `json:"from,omitempty"`
	To             *time.Time      `json:"to,omitempty"`
	Revenue        decimal.Decimal `json:"revenue"`
	COGS           decimal.Decimal `json:"cogs"`
	Writeoffs      decimal.Decimal `json:"writeoffs"`
	SupplyExpenses decimal.Decimal `json:"supply_expenses"`
	GrossProfit    decimal.Decimal `json:"gross_profit"`
	OrdersCount    int             `json:"orders_count"`
}

// PnLReport — Profit & Loss отчёт за период.
//
// Источники:
//   - Revenue       = SUM(orders.total_with_service) WHERE status='closed' AND closed_at IN period
//   - COGS          = SUM(order_items.cogs * order_items.qty) для тех же заказов и не-cancelled items
//   - Writeoffs     = SUM(stock_writeoffs.total_cost) created_at IN period
//   - SupplyExpenses= SUM(qty * ingredient.price_per_unit) supply_expenses IN period
//   - GrossProfit   = Revenue - COGS - Writeoffs - SupplyExpenses
//
// Замечание: COGS считается по snapshot'у `order_items.cogs` (зафиксированному
// в момент создания заказа). Изменение `menu_items.cogs` задним числом не
// перетряхнёт исторический P&L — это правильно.
//
// Лист 1 "Summary" — сводка. Лист 2 "By day" — разрезка по дням.
func (s *ReportsService) PnLReport(ctx context.Context, f PeriodFilter, w io.Writer) error {
	pl, byDay, err := s.computePnL(ctx, f)
	if err != nil {
		return err
	}

	sh := xlsx.New("Summary")
	defer sh.Close()
	sh.Header("Статья", "Сумма")
	sh.AddRow("Выручка (закрытые чеки)", pl.Revenue)
	sh.AddRow("Себестоимость (COGS)", pl.COGS)
	sh.AddRow("Списания со склада", pl.Writeoffs)
	sh.AddRow("Расход хоз. товаров", pl.SupplyExpenses)
	sh.AddRow("ВАЛОВАЯ ПРИБЫЛЬ", pl.GrossProfit)
	sh.AddRow("Закрытых чеков", pl.OrdersCount)

	byDaySheet := sh.AddSheet("By day")
	byDaySheet.Header("Дата", "Выручка", "COGS", "Списания", "Хоз.расход", "Прибыль", "Чеков")
	// Сортируем дни по возрастанию.
	keys := sortedKeys(byDay)
	for _, day := range keys {
		d := byDay[day]
		byDaySheet.AddRow(day, d.Revenue, d.COGS, d.Writeoffs, d.SupplyExpenses, d.GrossProfit, d.OrdersCount)
	}

	_, err = sh.WriteTo(w)
	return err
}

// PnLData — для API/SSE без xlsx. Возвращает агрегаты + breakdown.
func (s *ReportsService) PnLData(ctx context.Context, f PeriodFilter) (*PnL, map[string]PnL, error) {
	return s.computePnL(ctx, f)
}

// computePnL — общая реализация (4 запроса, без N+1).
func (s *ReportsService) computePnL(ctx context.Context, f PeriodFilter) (*PnL, map[string]PnL, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, nil, err
	}
	_ = rid

	pl := &PnL{From: f.From, To: f.To, Revenue: decimal.Zero, COGS: decimal.Zero,
		Writeoffs: decimal.Zero, SupplyExpenses: decimal.Zero}
	byDay := make(map[string]PnL)

	freshScoped := func() (any, error) { return s.r.ForTenant(ctx) }
	_ = freshScoped

	// 1. Revenue + orders_count: GROUP BY closed_at::date.
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, nil, err
	}
	type revRow struct {
		Day   string          `gorm:"column:day"`
		Total decimal.Decimal `gorm:"column:total"`
		Cnt   int             `gorm:"column:cnt"`
	}
	q := scoped.Table("orders").
		Select("to_char(closed_at, 'YYYY-MM-DD') AS day, COALESCE(SUM(total_with_service), 0) AS total, COUNT(*) AS cnt").
		Where("status = ? AND closed_at IS NOT NULL", "closed")
	if f.From != nil {
		q = q.Where("closed_at >= ?", *f.From)
	}
	if f.To != nil {
		q = q.Where("closed_at < ?", *f.To)
	}
	q = q.Group("day")
	var revRows []revRow
	if err := q.Scan(&revRows).Error; err != nil {
		return nil, nil, err
	}
	for _, r := range revRows {
		pl.Revenue = decimal.Add(pl.Revenue, r.Total)
		pl.OrdersCount += r.Cnt
		d := byDay[r.Day]
		d.Revenue = decimal.Add(d.Revenue, r.Total)
		d.OrdersCount += r.Cnt
		byDay[r.Day] = d
	}

	// 2. COGS: JOIN orders + order_items.
	scoped2, _ := s.r.ForTenant(ctx)
	type cogsRow struct {
		Day  string          `gorm:"column:day"`
		Cogs decimal.Decimal `gorm:"column:cogs"`
	}
	q2 := scoped2.Table("orders AS o").
		Select("to_char(o.closed_at, 'YYYY-MM-DD') AS day, COALESCE(SUM(oi.cogs * oi.qty), 0) AS cogs").
		Joins("JOIN order_items oi ON oi.order_id = o.id").
		Where("o.status = ? AND o.closed_at IS NOT NULL AND oi.cancelled_at IS NULL", "closed")
	if f.From != nil {
		q2 = q2.Where("o.closed_at >= ?", *f.From)
	}
	if f.To != nil {
		q2 = q2.Where("o.closed_at < ?", *f.To)
	}
	q2 = q2.Group("day")
	var cogsRows []cogsRow
	if err := q2.Scan(&cogsRows).Error; err != nil {
		return nil, nil, err
	}
	for _, c := range cogsRows {
		pl.COGS = decimal.Add(pl.COGS, c.Cogs)
		d := byDay[c.Day]
		d.COGS = decimal.Add(d.COGS, c.Cogs)
		byDay[c.Day] = d
	}

	// 3. Writeoffs.
	scoped3, _ := s.r.ForTenant(ctx)
	type woRow struct {
		Day  string          `gorm:"column:day"`
		Cost decimal.Decimal `gorm:"column:cost"`
	}
	q3 := scoped3.Table("stock_writeoffs").
		Select("to_char(created_at, 'YYYY-MM-DD') AS day, COALESCE(SUM(total_cost), 0) AS cost")
	if f.From != nil {
		q3 = q3.Where("created_at >= ?", *f.From)
	}
	if f.To != nil {
		q3 = q3.Where("created_at < ?", *f.To)
	}
	q3 = q3.Group("day")
	var woRows []woRow
	if err := q3.Scan(&woRows).Error; err != nil {
		return nil, nil, err
	}
	for _, r := range woRows {
		pl.Writeoffs = decimal.Add(pl.Writeoffs, r.Cost)
		d := byDay[r.Day]
		d.Writeoffs = decimal.Add(d.Writeoffs, r.Cost)
		byDay[r.Day] = d
	}

	// 4. Supply expenses: JOIN с ingredients для получения price_per_unit.
	// Используем Raw (не ForTenant) — у нас два tenant-fields (se и i),
	// и ForTenant добавил бы неквалифицированный WHERE restaurant_id, что
	// привело бы к ambiguous column. Tenant-фильтрация — явно по se.
	type seRow struct {
		Day  string          `gorm:"column:day"`
		Cost decimal.Decimal `gorm:"column:cost"`
	}
	rawQ := s.r.DB().Session(&gormSessionNewDB).WithContext(ctx)
	q4 := rawQ.Table("supply_expenses AS se").
		Select("to_char(se.created_at, 'YYYY-MM-DD') AS day, COALESCE(SUM(se.qty * i.price_per_unit), 0) AS cost").
		Joins("LEFT JOIN ingredients i ON i.id::text = se.ingredient_id::text").
		Where("se.restaurant_id = ?", rid)
	if f.From != nil {
		q4 = q4.Where("se.created_at >= ?", *f.From)
	}
	if f.To != nil {
		q4 = q4.Where("se.created_at < ?", *f.To)
	}
	q4 = q4.Group("day")
	var seRows []seRow
	if err := q4.Scan(&seRows).Error; err != nil {
		// Если supply_expenses неструктурированы — не валим отчёт целиком.
		seRows = nil
	}
	for _, r := range seRows {
		pl.SupplyExpenses = decimal.Add(pl.SupplyExpenses, r.Cost)
		d := byDay[r.Day]
		d.SupplyExpenses = decimal.Add(d.SupplyExpenses, r.Cost)
		byDay[r.Day] = d
	}

	// Финальные нормализации + gross profit.
	pl.Revenue = decimal.Normalize(pl.Revenue)
	pl.COGS = decimal.Normalize(pl.COGS)
	pl.Writeoffs = decimal.Normalize(pl.Writeoffs)
	pl.SupplyExpenses = decimal.Normalize(pl.SupplyExpenses)
	pl.GrossProfit = decimal.Normalize(
		decimal.Sub(decimal.Sub(decimal.Sub(pl.Revenue, pl.COGS), pl.Writeoffs), pl.SupplyExpenses),
	)
	for day, d := range byDay {
		d.GrossProfit = decimal.Normalize(
			decimal.Sub(decimal.Sub(decimal.Sub(d.Revenue, d.COGS), d.Writeoffs), d.SupplyExpenses),
		)
		byDay[day] = d
	}

	return pl, byDay, nil
}

// sortedKeys — без import "sort" (одна функция для одной мапы строк).
func sortedKeys(m map[string]PnL) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	// Простая bubble — дней в году 365, оверхед не важен.
	for i := 0; i < len(keys); i++ {
		for j := i + 1; j < len(keys); j++ {
			if keys[j] < keys[i] {
				keys[i], keys[j] = keys[j], keys[i]
			}
		}
	}
	return keys
}

// _ — keep models import alive (если в будущем сюда добавятся типизированные результаты).
var _ = models.Order{}
