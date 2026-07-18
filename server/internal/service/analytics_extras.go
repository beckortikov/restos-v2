package service

// Дополнительные аналитические endpoints поверх analytics.go (v3.3.0):
//   - IngredientStockValue: top-N ингредиентов по сумме на складе (qty * price).
//   - FoodCostMonthly: тренд food_cost_pct по месяцам.

import (
	"context"
	"fmt"
	"math"
	"sort"
	"time"

	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// ─── Ingredient stock value ────────────────────────────────────────────────

type IngredientStockRow struct {
	IngredientID string          `json:"ingredient_id"`
	Name         string          `json:"name"`
	Category     string          `json:"category,omitempty"`
	Qty          decimal.Decimal `json:"qty"`
	Unit         string          `json:"unit,omitempty"`
	PricePerUnit decimal.Decimal `json:"price_per_unit"`
	Value        decimal.Decimal `json:"value"` // qty * price_per_unit
	Share        decimal.Decimal `json:"share"` // % от total
}

type IngredientStockReport struct {
	TotalValue decimal.Decimal      `json:"total_value"`
	Items      []IngredientStockRow `json:"items"`
}

// IngredientStockValue — top-N ингредиентов по сумме на складе. Сортирует
// desc по value. Limit передаётся, дефолт 10.
func (s *AnalyticsService) IngredientStockValue(ctx context.Context, limit int) (*IngredientStockReport, error) {
	if limit <= 0 {
		limit = 10
	}
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	out := &IngredientStockReport{Items: []IngredientStockRow{}}

	type row struct {
		ID           string          `gorm:"column:id"`
		Name         *string         `gorm:"column:name"`
		Category     *string         `gorm:"column:category"`
		Qty          decimal.Decimal `gorm:"column:qty"`
		Unit         *string         `gorm:"column:unit"`
		PricePerUnit decimal.Decimal `gorm:"column:price_per_unit"`
	}
	var rows []row
	if err := scoped.Table("ingredients").
		Select("id, name, category, qty, unit, price_per_unit").
		Scan(&rows).Error; err != nil {
		return nil, err
	}

	// Считаем value и сортируем.
	enriched := make([]IngredientStockRow, 0, len(rows))
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
		enriched = append(enriched, IngredientStockRow{
			IngredientID: r.ID,
			Name:         name,
			Category:     cat,
			Qty:          decimal.Normalize(r.Qty),
			Unit:         unit,
			PricePerUnit: decimal.Normalize(r.PricePerUnit),
			Value:        decimal.Normalize(val),
		})
		total = decimal.Add(total, val)
	}
	sort.Slice(enriched, func(i, j int) bool {
		return enriched[i].Value.GreaterThan(enriched[j].Value)
	})
	if len(enriched) > limit {
		enriched = enriched[:limit]
	}
	// Share после top-N — относительно total всего склада, не топа.
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

// ─── Food-cost monthly trend ──────────────────────────────────────────────

type FoodCostMonth struct {
	Month         string          `json:"month"` // YYYY-MM
	Revenue       decimal.Decimal `json:"revenue"`
	COGS          decimal.Decimal `json:"cogs"`
	FoodCostPct   decimal.Decimal `json:"food_cost_pct"`
	MarginPercent decimal.Decimal `json:"margin_percent"`
	Orders        int             `json:"orders"`
}

type FoodCostMonthlyReport struct {
	Period struct {
		From *time.Time `json:"from,omitempty"`
		To   *time.Time `json:"to,omitempty"`
	} `json:"period"`
	Months []FoodCostMonth `json:"months"`
}

// FoodCostMonthly — тренд food_cost_pct по месяцам. По умолчанию (если from
// не задан) — последние 12 месяцев.
func (s *AnalyticsService) FoodCostMonthly(ctx context.Context, f PeriodFilter) (*FoodCostMonthlyReport, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	out := &FoodCostMonthlyReport{Months: []FoodCostMonth{}}
	out.Period.From = f.From
	out.Period.To = f.To

	// Revenue + orders по месяцам.
	type revRow struct {
		Month   string          `gorm:"column:month"`
		Revenue decimal.Decimal `gorm:"column:revenue"`
		Orders  int             `gorm:"column:orders"`
	}
	q := scoped.Table("orders").
		Select(`to_char(closed_at, 'YYYY-MM') AS month,
		        COALESCE(SUM(total_with_service), 0) AS revenue,
		        COUNT(*) AS orders`).
		Where("status IN ? AND closed_at IS NOT NULL", []string{"closed", "refunded"})
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

	// COGS по месяцам (JOIN order_items).
	scoped2, _ := s.r.ForTenant(ctx)
	type cogsRow struct {
		Month string          `gorm:"column:month"`
		COGS  decimal.Decimal `gorm:"column:cogs"`
	}
	q2 := scoped2.Table("orders AS o").
		Select(`to_char(o.closed_at, 'YYYY-MM') AS month,
		        COALESCE(SUM(CASE WHEN oi.unit IN ('g','kg') AND oi.unit_size > 0 THEN oi.cogs * oi.qty / oi.unit_size ELSE oi.cogs * oi.qty END), 0) AS cogs`).
		Joins("JOIN order_items oi ON oi.order_id = o.id").
		Where("o.status IN ? AND o.closed_at IS NOT NULL AND oi.cancelled_at IS NULL", []string{"closed", "refunded"})
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

// ─── Forecast ─────────────────────────────────────────────────────────────

type ForecastMonth struct {
	Month       string          `json:"month"` // YYYY-MM
	Revenue     decimal.Decimal `json:"revenue"`
	COGS        decimal.Decimal `json:"cogs"`
	GrossProfit decimal.Decimal `json:"gross_profit"`
}

type ForecastReport struct {
	Period struct {
		From *time.Time `json:"from,omitempty"`
		To   *time.Time `json:"to,omitempty"`
	} `json:"period"`
	MonthlyRevenue         []ForecastMonth `json:"monthly_revenue"`
	FixedCostsMonthly      decimal.Decimal `json:"fixed_costs_monthly"`       // avg opex/мес (без COGS и закупок)
	AvgGrossMarginPct      decimal.Decimal `json:"avg_gross_margin_pct"`      // (Rev - COGS) / Rev * 100
	BreakevenRevenue       decimal.Decimal `json:"breakeven_revenue"`         // fixedCosts / (margin/100)
	ForecastNextMonth      decimal.Decimal `json:"forecast_next_month"`       // linreg по последним 3 мес
	ForecastNextMonthLabel string          `json:"forecast_next_month_label"` // YYYY-MM
	HistoricalMonths       int             `json:"historical_months"`
}

// EXCLUDED_EXPENSE_CATEGORIES — то же что и на фронте/PnL: не входят в
// fixed_costs (COGS уже учитывается через order_items, а закупки —
// CapEx-подобные траты на склад).
var forecastExcludedExpense = map[string]bool{
	"Себестоимость продукции": true,
}
var forecastStockPurchase = map[string]bool{
	"Закупка продуктов":  true,
	"Закупка хозтоваров": true,
}

// Forecast — комбинированный отчёт для страницы /forecast.
// Считает monthly revenue/cogs/margin + breakeven + projection.
func (s *AnalyticsService) Forecast(ctx context.Context, f PeriodFilter) (*ForecastReport, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	out := &ForecastReport{MonthlyRevenue: []ForecastMonth{}}
	out.Period.From = f.From
	out.Period.To = f.To

	// 1. Monthly revenue.
	type rRow struct {
		Month   string          `gorm:"column:month"`
		Revenue decimal.Decimal `gorm:"column:revenue"`
	}
	q := scoped.Table("orders").
		Select(`to_char(closed_at, 'YYYY-MM') AS month,
		        COALESCE(SUM(total_with_service), 0) AS revenue`).
		Where("status IN ? AND closed_at IS NOT NULL", []string{"closed", "refunded"})
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

	// 2. Monthly COGS.
	scoped2, _ := s.r.ForTenant(ctx)
	type cRow struct {
		Month string          `gorm:"column:month"`
		COGS  decimal.Decimal `gorm:"column:cogs"`
	}
	q2 := scoped2.Table("orders AS o").
		Select(`to_char(o.closed_at, 'YYYY-MM') AS month,
		        COALESCE(SUM(CASE WHEN oi.unit IN ('g','kg') AND oi.unit_size > 0 THEN oi.cogs * oi.qty / oi.unit_size ELSE oi.cogs * oi.qty END), 0) AS cogs`).
		Joins("JOIN order_items oi ON oi.order_id = o.id").
		Where("o.status IN ? AND o.closed_at IS NOT NULL AND oi.cancelled_at IS NULL", []string{"closed", "refunded"})
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

	// 3. Сборка ForecastMonth list.
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

	// 4. Avg gross margin %.
	hundred := decimal.FromInt(100)
	if totalRev.IsPositive() {
		gross := decimal.Sub(totalRev, totalCOGS)
		out.AvgGrossMarginPct = decimal.Normalize(decimal.DivRound(decimal.Mul(gross, hundred), totalRev))
	}

	// 5. Fixed costs: avg по месяцам, opex (out + activity=operational), без
	// COGS-категории и закупок.
	scoped3, _ := s.r.ForTenant(ctx)
	type opexRow struct {
		Month  string          `gorm:"column:month"`
		Amount decimal.Decimal `gorm:"column:amount"`
	}
	q3 := scoped3.Table("financial_operations").
		Select(`to_char(created_at, 'YYYY-MM') AS month,
		        COALESCE(SUM(amount), 0) AS amount`).
		Where("type = ? AND COALESCE(activity, 'operational') = 'operational'", "out")
	if f.From != nil {
		q3 = q3.Where("created_at >= ?", *f.From)
	}
	if f.To != nil {
		q3 = q3.Where("created_at < ?", *f.To)
	}
	// Исключаем COGS и закупки на уровне SQL.
	excl := make([]string, 0, len(forecastExcludedExpense)+len(forecastStockPurchase)+len(opexExcludedCategories))
	for k := range forecastExcludedExpense {
		excl = append(excl, k)
	}
	for k := range forecastStockPurchase {
		excl = append(excl, k)
	}
	// Н25: авто-коды закупок/долгов/обязательств (приёмка со счёта, гашение
	// долга поставщику, гашение обязательства) — не постоянные расходы, это
	// движение запасов/пассива. Раньше они текли в fixed_costs и завышали
	// точку безубыточности. Тот же список исключений, что в ОПиУ/Динамике.
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

	// 6. Breakeven.
	if out.FixedCostsMonthly.IsPositive() && out.AvgGrossMarginPct.IsPositive() {
		// breakeven = fixedCosts / (margin/100) = fixedCosts * 100 / margin
		out.BreakevenRevenue = decimal.Normalize(
			decimal.DivRound(decimal.Mul(out.FixedCostsMonthly, hundred), out.AvgGrossMarginPct),
		)
	}

	// 7. Forecast next month: линейная регрессия по последним 3 месяцам.
	if len(out.MonthlyRevenue) >= 2 {
		last := out.MonthlyRevenue
		if len(last) > 3 {
			last = last[len(last)-3:]
		}
		// Простая formula: slope = (n*sumXY - sumX*sumY) / (n*sumX2 - sumX^2)
		// intercept = (sumY - slope*sumX) / n
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
		next := math.Max(0, intercept+slope*n) // x=n (следующая точка)
		out.ForecastNextMonth = decimal.MustFromString(formatFloat(next))
		out.ForecastNextMonthLabel = nextMonthLabel(last[len(last)-1].Month)
	}
	return out, nil
}

// formatFloat — стабильное представление float как string для decimal.FromString.
// 4 знака после запятой (decimal scale=4).
func formatFloat(v float64) string {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return "0"
	}
	return fmt.Sprintf("%.4f", v)
}

// nextMonthLabel — «2026-06» → «2026-07».
func nextMonthLabel(cur string) string {
	if len(cur) != 7 {
		return ""
	}
	t, err := time.Parse("2006-01", cur)
	if err != nil {
		return ""
	}
	return t.AddDate(0, 1, 0).Format("2006-01")
}

// ─── ABC inventory ─────────────────────────────────────────────────────────

type ABCInventoryRow struct {
	IngredientID   string          `json:"ingredient_id"`
	Name           string          `json:"name"`
	Category       string          `json:"category,omitempty"`
	Unit           string          `json:"unit,omitempty"`
	Qty            decimal.Decimal `json:"qty"` // current stock
	PricePerUnit   decimal.Decimal `json:"price_per_unit"`
	StockValue     decimal.Decimal `json:"stock_value"`   // qty * price
	Consumption    decimal.Decimal `json:"consumption"`   // qty consumed in period
	Turnover       decimal.Decimal `json:"turnover"`      // consumption / qty (раз)
	DaysOfStock    int             `json:"days_of_stock"` // qty / (consumption/30)
	Share          decimal.Decimal `json:"share"`         // % от total consumption value
	CumShare       decimal.Decimal `json:"cum_share"`
	Class          string          `json:"class"` // A|B|C
	Recommendation string          `json:"recommendation"`
}

type ABCInventoryReport struct {
	Period struct {
		From *time.Time `json:"from,omitempty"`
		To   *time.Time `json:"to,omitempty"`
	} `json:"period"`
	TotalConsumptionValue decimal.Decimal   `json:"total_consumption_value"`
	Items                 []ABCInventoryRow `json:"items"`
}

// ABCInventory — ABC по ингредиентам.
// Базис классификации: SUM(qty * ingredients.price_per_unit) расхода за период,
// типы движений: 'out', 'batch', 'semi' (всё что списывает остаток).
// PeriodDays: для days_of_stock пересчитываем потребление в дневной средний.
func (s *AnalyticsService) ABCInventory(ctx context.Context, f PeriodFilter) (*ABCInventoryReport, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	out := &ABCInventoryReport{Items: []ABCInventoryRow{}}
	out.Period.From = f.From
	out.Period.To = f.To

	// 1. Текущие ингредиенты (qty + price).
	type ingRow struct {
		ID           string          `gorm:"column:id"`
		Name         *string         `gorm:"column:name"`
		Category     *string         `gorm:"column:category"`
		Unit         *string         `gorm:"column:unit"`
		Qty          decimal.Decimal `gorm:"column:qty"`
		PricePerUnit decimal.Decimal `gorm:"column:price_per_unit"`
	}
	var iRows []ingRow
	if err := scoped.Table("ingredients").
		Select("id, name, category, unit, qty, price_per_unit").
		Scan(&iRows).Error; err != nil {
		return nil, err
	}

	// 2. Расход по ингредиентам за период (SUM(|qty|) WHERE type IN consumption).
	scoped2, _ := s.r.ForTenant(ctx)
	type mvRow struct {
		IngredientID *string         `gorm:"column:ingredient_id"`
		Qty          decimal.Decimal `gorm:"column:qty"`
	}
	qm := scoped2.Table("stock_movements").
		Select("ingredient_id, COALESCE(SUM(ABS(qty)), 0) AS qty").
		Where("type IN ?", []string{"out", "batch", "semi"})
	if f.From != nil {
		qm = qm.Where("created_at >= ?", *f.From)
	}
	if f.To != nil {
		qm = qm.Where("created_at < ?", *f.To)
	}
	var mRows []mvRow
	_ = qm.Group("ingredient_id").Scan(&mRows).Error
	consByIng := make(map[string]decimal.Decimal, len(mRows))
	for _, r := range mRows {
		if r.IngredientID != nil {
			consByIng[*r.IngredientID] = r.Qty
		}
	}

	// 3. Сборка enriched rows + сортировка по consumption value desc.
	periodDays := computePeriodDays(f.From, f.To)
	if periodDays < 1 {
		periodDays = 1
	}
	type enriched struct {
		ABCInventoryRow
		ConsValue decimal.Decimal // qty consumed * price (для ABC sort)
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
		// days_of_stock: qty / (cons/periodDays) = qty * periodDays / cons.
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
			ABCInventoryRow: ABCInventoryRow{
				IngredientID: r.ID,
				Name:         name,
				Category:     cat,
				Unit:         unit,
				Qty:          decimal.Normalize(r.Qty),
				PricePerUnit: decimal.Normalize(r.PricePerUnit),
				StockValue:   decimal.Normalize(stockValue),
				Consumption:  decimal.Normalize(cons),
				Turnover:     decimal.Normalize(turn),
				DaysOfStock:  daysOfStock,
			},
			ConsValue: consValue,
		})
		totalConsValue = decimal.Add(totalConsValue, consValue)
	}
	sort.Slice(en, func(i, j int) bool {
		return en[i].ConsValue.GreaterThan(en[j].ConsValue)
	})

	// 4. ABC classification (накопительная доля по consumption value).
	hundred := decimal.FromInt(100)
	cum := decimal.Zero
	out.Items = make([]ABCInventoryRow, 0, len(en))
	for _, e := range en {
		var share, cumShare decimal.Decimal
		if totalConsValue.IsPositive() {
			share = decimal.DivRound(decimal.Mul(e.ConsValue, hundred), totalConsValue)
			cum = decimal.Add(cum, share)
			cumShare = cum
		}
		class := "C"
		if totalConsValue.IsPositive() {
			c := cumShare
			switch {
			case c.LessThanOrEqual(decimal.FromInt(80)):
				class = "A"
			case c.LessThanOrEqual(decimal.FromInt(95)):
				class = "B"
			}
		}
		// Recommendation.
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
		row := e.ABCInventoryRow
		row.Share = decimal.Normalize(share)
		row.CumShare = decimal.Normalize(cumShare)
		row.Class = class
		row.Recommendation = rec
		out.Items = append(out.Items, row)
	}
	out.TotalConsumptionValue = decimal.Normalize(totalConsValue)
	return out, nil
}
