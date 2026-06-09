package service

// Дополнительные аналитические endpoints поверх analytics.go (v3.3.0):
//   - IngredientStockValue: top-N ингредиентов по сумме на складе (qty * price).
//   - FoodCostMonthly: тренд food_cost_pct по месяцам.

import (
	"context"
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
		Where("status = ? AND closed_at IS NOT NULL", "closed")
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
		        COALESCE(SUM(oi.cogs * oi.qty), 0) AS cogs`).
		Joins("JOIN order_items oi ON oi.order_id = o.id").
		Where("o.status = ? AND o.closed_at IS NOT NULL AND oi.cancelled_at IS NULL", "closed")
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
