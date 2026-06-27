package service

// InsightsService — «Инсайты»: кросс-аналитика, которая выдаёт ранжированные
// действия, а не графики. Каждый инсайт = проблема/возможность + цифры + ₽-эффект
// + рекомендация. Источники переиспользуют существующие отчёты (ABCMenu, Waiters)
// и прямые запросы для утечек/неликвида, чтобы цифры совпадали с остальной
// аналитикой.

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
	"github.com/restos/restos-v4/server/internal/repo"
)

type InsightsService struct {
	r         *repo.Repo
	analytics *AnalyticsService
}

func NewInsightsService(r *repo.Repo, analytics *AnalyticsService) *InsightsService {
	return &InsightsService{r: r, analytics: analytics}
}

// Insight — одна карточка ленты.
type Insight struct {
	ID          string          `json:"id"`
	Category    string          `json:"category"` // menu | leak | stock | staff
	Severity    string          `json:"severity"` // high | medium | low
	Title       string          `json:"title"`
	Detail      string          `json:"detail"`
	Impact      decimal.Decimal `json:"impact"`       // ₽-эффект (0 если неприменимо)
	ImpactLabel string          `json:"impact_label"` // что значит impact
	Action      string          `json:"action"`
	EntityType  string          `json:"entity_type,omitempty"` // menu_item | user | ingredient
	EntityID    string          `json:"entity_id,omitempty"`
}

type InsightsReport struct {
	From     *time.Time `json:"from,omitempty"`
	To       *time.Time `json:"to,omitempty"`
	Insights []Insight  `json:"insights"`
}

// Insights собирает все паки и ранжирует (severity, затем ₽-эффект).
func (s *InsightsService) Insights(ctx context.Context, f PeriodFilter) (*InsightsReport, error) {
	out := &InsightsReport{From: f.From, To: f.To, Insights: []Insight{}}

	for _, gen := range []func(context.Context, PeriodFilter) ([]Insight, error){
		s.menuInsights, s.leakInsights, s.deadStockInsights, s.staffInsights,
	} {
		ins, err := gen(ctx, f)
		if err != nil {
			return nil, err
		}
		out.Insights = append(out.Insights, ins...)
	}

	sevRank := map[string]int{"high": 3, "medium": 2, "low": 1}
	sort.SliceStable(out.Insights, func(i, j int) bool {
		si, sj := sevRank[out.Insights[i].Severity], sevRank[out.Insights[j].Severity]
		if si != sj {
			return si > sj
		}
		return out.Insights[i].Impact.GreaterThan(out.Insights[j].Impact)
	})
	return out, nil
}

// ─── Пак 1: меню-инженерия + маржинальные дыры ──────────────────────────────

func (s *InsightsService) menuInsights(ctx context.Context, f PeriodFilter) ([]Insight, error) {
	abc, err := s.analytics.ABCMenu(ctx, f)
	if err != nil {
		return nil, err
	}
	items := abc.Items
	if len(items) == 0 {
		return nil, nil
	}
	var out []Insight

	margins := make([]decimal.Decimal, 0, len(items))
	for _, it := range items {
		if it.Revenue.IsPositive() {
			margins = append(margins, it.MarginPercent)
		}
	}
	medMargin := medianDec(margins)
	hundred := decimal.FromInt(100)

	// Маржинальные дыры: маржа ниже медианы при заметной выручке → ₽-потенциал
	// (оценка) при подъёме маржи до медианы.
	type hole struct {
		it  ABCMenuRow
		pot decimal.Decimal
	}
	var holes []hole
	for _, it := range items {
		if !it.Revenue.IsPositive() || it.MarginPercent.GreaterThanOrEqual(medMargin) {
			continue
		}
		pot := decimal.DivRound(decimal.Mul(it.Revenue, decimal.Sub(medMargin, it.MarginPercent)), hundred)
		if pot.IsPositive() {
			holes = append(holes, hole{it, pot})
		}
	}
	sort.Slice(holes, func(i, j int) bool { return holes[i].pot.GreaterThan(holes[j].pot) })
	for i, h := range holes {
		if i >= 3 {
			break
		}
		sev := "medium"
		if i == 0 {
			sev = "high"
		}
		out = append(out, Insight{
			ID: "menu_margin:" + h.it.MenuItemID, Category: "menu", Severity: sev,
			Title: fmt.Sprintf("«%s»: низкая маржа при высоких продажах", h.it.Name),
			Detail: fmt.Sprintf("Маржа %s%% (медиана по меню %s%%), выручка %s ₽ за период.",
				rub(h.it.MarginPercent), rub(medMargin), rub(h.it.Revenue)),
			Impact: decimal.Normalize(h.pot), ImpactLabel: "Потенциал маржи за период",
			Action:     "Поднять цену или пересмотреть техкарту/порцию.",
			EntityType: "menu_item", EntityID: h.it.MenuItemID,
		})
	}

	// Собаки / загадки (агрегированные карточки).
	var dogs, puzzles []string
	for _, it := range items {
		switch it.EngineeringClass {
		case "dog":
			dogs = append(dogs, it.Name)
		case "puzzle":
			puzzles = append(puzzles, it.Name)
		}
	}
	if len(dogs) > 0 {
		out = append(out, Insight{
			ID: "menu_dogs", Category: "menu", Severity: "low",
			Title:       fmt.Sprintf("%d блюд — «собаки» (мало продаж + низкая маржа)", len(dogs)),
			Detail:      "Кандидаты на удаление или переделку: " + joinTop(dogs, 6) + ".",
			ImpactLabel: "", Action: "Убрать из меню, заменить или переработать рецепт/цену.",
		})
	}
	if len(puzzles) > 0 {
		out = append(out, Insight{
			ID: "menu_puzzles", Category: "menu", Severity: "low",
			Title:       fmt.Sprintf("%d блюд — «загадки» (высокая маржа, мало продаж)", len(puzzles)),
			Detail:      "Маржинальны, но плохо продаются: " + joinTop(puzzles, 6) + ".",
			ImpactLabel: "", Action: "Продвигать: в топ меню, рекомендация официанта, фото/описание.",
		})
	}
	return out, nil
}

// ─── Пак 2: утечки (скидки / возвраты / отмены) ─────────────────────────────

func (s *InsightsService) leakInsights(ctx context.Context, f PeriodFilter) ([]Insight, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	var agg struct {
		Revenue   decimal.Decimal `gorm:"column:revenue"`
		Discount  decimal.Decimal `gorm:"column:discount"`
		Refunds   decimal.Decimal `gorm:"column:refunds"`
		RefundCnt int             `gorm:"column:refund_cnt"`
	}
	q := scoped.Table("orders").Select(`
		COALESCE(SUM(total_with_service),0) AS revenue,
		COALESCE(SUM(discount_amount),0) AS discount,
		COALESCE(SUM(refunded_total),0) AS refunds,
		COUNT(*) FILTER (WHERE refunded_total > 0) AS refund_cnt`).
		Where("status = ? AND closed_at IS NOT NULL", "closed")
	q = applyClosedPeriod(q, f)
	if err := q.Scan(&agg).Error; err != nil {
		return nil, err
	}

	pctSeverity := func(amount decimal.Decimal) string {
		if !agg.Revenue.IsPositive() {
			return "low"
		}
		pct := decimal.DivRound(decimal.Mul(amount, decimal.FromInt(100)), agg.Revenue)
		switch {
		case pct.GreaterThan(decimal.FromInt(10)):
			return "high"
		case pct.GreaterThan(decimal.FromInt(3)):
			return "medium"
		default:
			return "low"
		}
	}
	pctOf := func(amount decimal.Decimal) string {
		if !agg.Revenue.IsPositive() {
			return "0"
		}
		return rub(decimal.DivRound(decimal.Mul(amount, decimal.FromInt(100)), agg.Revenue))
	}

	var out []Insight
	if agg.Discount.IsPositive() {
		out = append(out, Insight{
			ID: "leak_discounts", Category: "leak", Severity: pctSeverity(agg.Discount),
			Title:  fmt.Sprintf("Скидки за период: %s ₽", rub(agg.Discount)),
			Detail: fmt.Sprintf("%s%% от выручки.", pctOf(agg.Discount)),
			Impact: decimal.Normalize(agg.Discount), ImpactLabel: "Сумма скидок",
			Action: "Проверьте, кому и за что даются скидки; включите подтверждение менеджером.",
		})
	}
	if agg.Refunds.IsPositive() {
		out = append(out, Insight{
			ID: "leak_refunds", Category: "leak", Severity: pctSeverity(agg.Refunds),
			Title:  fmt.Sprintf("Возвраты: %s ₽ (%d чеков)", rub(agg.Refunds), agg.RefundCnt),
			Detail: fmt.Sprintf("%s%% от выручки.", pctOf(agg.Refunds)),
			Impact: decimal.Normalize(agg.Refunds), ImpactLabel: "Сумма возвратов",
			Action: "Разберите причины возвратов — частые причины указывают на проблему процесса.",
		})
	}

	// Отмены позиций (order_voids) — сумма + кто больше всех.
	scopedV, _ := s.r.ForTenant(ctx)
	var voidAgg struct {
		Total decimal.Decimal `gorm:"column:total"`
		Cnt   int             `gorm:"column:cnt"`
	}
	qv := scopedV.Table("order_voids").
		Select("COALESCE(SUM(item_price * COALESCE(item_qty,1)),0) AS total, COUNT(*) AS cnt")
	qv = applyCreatedPeriod(qv, f)
	if err := qv.Scan(&voidAgg).Error; err != nil {
		return nil, err
	}
	if voidAgg.Total.IsPositive() {
		scopedT, _ := s.r.ForTenant(ctx)
		var top struct {
			Name  string          `gorm:"column:name"`
			Total decimal.Decimal `gorm:"column:total"`
		}
		qt := scopedT.Table("order_voids").
			Select("COALESCE(created_by_name,'—') AS name, COALESCE(SUM(item_price * COALESCE(item_qty,1)),0) AS total")
		qt = applyCreatedPeriod(qt, f)
		_ = qt.Group("created_by_name").Order("total DESC").Limit(1).Scan(&top).Error

		detail := ""
		if top.Name != "" && top.Total.IsPositive() {
			detail = fmt.Sprintf("Больше всего отмен у: %s (%s ₽).", top.Name, rub(top.Total))
		}
		out = append(out, Insight{
			ID: "leak_voids", Category: "leak", Severity: pctSeverity(voidAgg.Total),
			Title:  fmt.Sprintf("Отмены позиций: %s ₽ (%d шт)", rub(voidAgg.Total), voidAgg.Cnt),
			Detail: detail,
			Impact: decimal.Normalize(voidAgg.Total), ImpactLabel: "Сумма отмен",
			Action: "Проверьте отмены у сотрудника, особенно после печати на кухню.",
		})
	}
	return out, nil
}

// ─── Пак 3: мёртвый склад ───────────────────────────────────────────────────

func (s *InsightsService) deadStockInsights(ctx context.Context, f PeriodFilter) ([]Insight, error) {
	// Ингредиенты с расходом (отрицательное движение) за период — «живые».
	scopedM, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	var movedRows []struct {
		IngredientID *string `gorm:"column:ingredient_id"`
	}
	qm := scopedM.Table("stock_movements").
		Distinct("ingredient_id").
		Where("qty < 0 AND ingredient_id IS NOT NULL")
	qm = applyCreatedPeriod(qm, f)
	if err := qm.Scan(&movedRows).Error; err != nil {
		return nil, err
	}
	moved := make(map[string]bool, len(movedRows))
	for _, m := range movedRows {
		if m.IngredientID != nil {
			moved[*m.IngredientID] = true
		}
	}

	scopedI, _ := s.r.ForTenant(ctx)
	var ings []models.Ingredient
	if err := scopedI.Where("qty > 0 AND price_per_unit > 0").Find(&ings).Error; err != nil {
		return nil, err
	}
	type dead struct {
		name  string
		value decimal.Decimal
	}
	var deads []dead
	total := decimal.Zero
	for _, ing := range ings {
		if moved[ing.ID] {
			continue
		}
		val := decimal.Mul(ing.Qty, ing.PricePerUnit)
		if !val.IsPositive() {
			continue
		}
		name := "—"
		if ing.Name != nil {
			name = *ing.Name
		}
		deads = append(deads, dead{name, val})
		total = decimal.Add(total, val)
	}
	if len(deads) == 0 {
		return nil, nil
	}
	sort.Slice(deads, func(i, j int) bool { return deads[i].value.GreaterThan(deads[j].value) })
	names := make([]string, 0, len(deads))
	for _, d := range deads {
		names = append(names, fmt.Sprintf("%s (%s ₽)", d.name, rub(d.value)))
	}
	sev := "low"
	if total.GreaterThan(decimal.FromInt(5000)) {
		sev = "medium"
	}
	return []Insight{{
		ID: "stock_dead", Category: "stock", Severity: sev,
		Title:       fmt.Sprintf("Неликвид на складе: %s ₽ (%d позиций)", rub(total), len(deads)),
		Detail:      "Нет расхода за период: " + joinTop(names, 6) + ".",
		Impact:      decimal.Normalize(total), ImpactLabel: "Заморожено в неликвиде",
		Action:      "Распродать/списать, убрать из закупок или ввести в блюда дня.",
	}}, nil
}

// ─── Пак 4: официанты — кого учить ──────────────────────────────────────────

func (s *InsightsService) staffInsights(ctx context.Context, f PeriodFilter) ([]Insight, error) {
	rep, err := s.analytics.Waiters(ctx, f)
	if err != nil {
		return nil, err
	}
	rows := make([]WaiterRow, 0, len(rep.Rows))
	checks := make([]decimal.Decimal, 0, len(rep.Rows))
	for _, r := range rep.Rows {
		if r.WaiterID == "" || r.Orders < 5 { // отбрасываем шум и группу «без официанта»
			continue
		}
		rows = append(rows, r)
		checks = append(checks, r.AvgCheck)
	}
	if len(rows) < 2 {
		return nil, nil
	}
	med := medianDec(checks)
	if !med.IsPositive() {
		return nil, nil
	}
	lowBound := decimal.DivRound(decimal.Mul(med, decimal.FromInt(85)), decimal.FromInt(100))
	highBound := decimal.DivRound(decimal.Mul(med, decimal.FromInt(115)), decimal.FromInt(100))

	var out []Insight
	// Худший по среднему чеку → ₽-потенциал до медианы.
	var worst *WaiterRow
	for i := range rows {
		if rows[i].AvgCheck.LessThan(lowBound) {
			if worst == nil || rows[i].AvgCheck.LessThan(worst.AvgCheck) {
				worst = &rows[i]
			}
		}
	}
	if worst != nil {
		pot := decimal.Mul(decimal.Sub(med, worst.AvgCheck), decimal.FromInt(int64(worst.Orders)))
		out = append(out, Insight{
			ID: "staff_low:" + worst.WaiterID, Category: "staff", Severity: "medium",
			Title: fmt.Sprintf("«%s»: средний чек ниже команды", worst.Name),
			Detail: fmt.Sprintf("Чек %s ₽ vs медиана %s ₽ (%d заказов за период).",
				rub(worst.AvgCheck), rub(med), worst.Orders),
			Impact: decimal.Normalize(pot), ImpactLabel: "Потенциал до медианы за период",
			Action:     "Обучить апселлу: предлагать напитки/десерты/допы.",
			EntityType: "user", EntityID: worst.WaiterID,
		})
	}
	// Лучший по среднему чеку → перенять практику.
	var best *WaiterRow
	for i := range rows {
		if rows[i].AvgCheck.GreaterThan(highBound) {
			if best == nil || rows[i].AvgCheck.GreaterThan(best.AvgCheck) {
				best = &rows[i]
			}
		}
	}
	if best != nil {
		out = append(out, Insight{
			ID: "staff_top:" + best.WaiterID, Category: "staff", Severity: "low",
			Title: fmt.Sprintf("«%s» — лучший средний чек в команде", best.Name),
			Detail: fmt.Sprintf("Чек %s ₽ vs медиана %s ₽ — стабильно апселлит.",
				rub(best.AvgCheck), rub(med)),
			ImpactLabel: "", Action: "Разобрать его подход и обучить команду.",
			EntityType: "user", EntityID: best.WaiterID,
		})
	}
	return out, nil
}

// ─── helpers ────────────────────────────────────────────────────────────────

func rub(d decimal.Decimal) string { return d.Round(0).String() }

func medianDec(v []decimal.Decimal) decimal.Decimal {
	if len(v) == 0 {
		return decimal.Zero
	}
	s := append([]decimal.Decimal(nil), v...)
	sort.Slice(s, func(i, j int) bool { return s[i].LessThan(s[j]) })
	n := len(s)
	if n%2 == 1 {
		return s[n/2]
	}
	return decimal.DivRound(decimal.Add(s[n/2-1], s[n/2]), decimal.FromInt(2))
}

func joinTop(names []string, n int) string {
	if len(names) <= n {
		return strings.Join(names, ", ")
	}
	return strings.Join(names[:n], ", ") + fmt.Sprintf(" и ещё %d", len(names)-n)
}

func applyClosedPeriod(q *gorm.DB, f PeriodFilter) *gorm.DB {
	if f.From != nil {
		q = q.Where("closed_at >= ?", *f.From)
	}
	if f.To != nil {
		q = q.Where("closed_at < ?", *f.To)
	}
	return q
}

func applyCreatedPeriod(q *gorm.DB, f PeriodFilter) *gorm.DB {
	if f.From != nil {
		q = q.Where("created_at >= ?", *f.From)
	}
	if f.To != nil {
		q = q.Where("created_at < ?", *f.To)
	}
	return q
}
