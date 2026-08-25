package service

import (
	"context"
	"strconv"
	"time"

	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
	apperrors "github.com/restos/restos-v4/server/internal/pkg/errors"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
)

// Сетевые консолидированные отчёты (ADR-003 «Central видит всё», Ф8) —
// режим (3) из плана: суммарные цифры по ВСЕЙ сети с разбивкой по филиалам.
// Каждый метод повторяет ЛОГИКУ уже существующего одно-тенантного отчёта
// (computePnL/Cashflow/IngredientStockValue/FinancialAccountsService.List),
// но заменяет ForTenant(ctx) на Raw()+restaurant_id IN (<филиалы сети>) и
// группирует по restaurant_id вместо/вдобавок к дню. НЕ трогаем ForTenant/
// BranchOverride — они остаются одно-tenant'ными по построению (план,
// раздел «Механизм»).
//
// Источники — только сущности, реплицированные Ф1-Ф4 (orders/order_items,
// stock_writeoffs, supply_expenses, financial_operations, ingredients,
// financial_accounts) — то же ограничение, что уже применялось построчно
// при формировании allowlist/blocklist в branch_override.go (Ф1-Ф7): не
// добавляем сюда ничего, что зависит от нереплицированных таблиц
// (order_splits, semi_finished_stock, assets/liabilities/equity_entries —
// те же блокеры, что у /finance/pnl и /finance/balance).

// ─── P&L ────────────────────────────────────────────────────────────────────

// PnLAmounts — денежные показатели P&L (переиспользуется для строки филиала
// и для итога по сети).
type PnLAmounts struct {
	Revenue        decimal.Decimal `json:"revenue"`
	COGS           decimal.Decimal `json:"cogs"`
	Writeoffs      decimal.Decimal `json:"writeoffs"`
	SupplyExpenses decimal.Decimal `json:"supply_expenses"`
	GrossProfit    decimal.Decimal `json:"gross_profit"`
	OrdersCount    int             `json:"orders_count"`
}

type NetworkPnLBranch struct {
	ID   string  `json:"id"`
	Name string  `json:"name"`
	Kind *string `json:"kind"`
	PnLAmounts
}

type NetworkPnL struct {
	Total    PnLAmounts         `json:"total"`
	Branches []NetworkPnLBranch `json:"branches"`
}

// PnL — P&L сети за период: итог + разбивка по филиалам. Те же 4 источника,
// что computePnL (reports_pl.go) — orders+order_items/stock_writeoffs/
// supply_expenses, все реплицированы (Ф1/Ф4) — GROUP BY restaurant_id вместо
// GROUP BY day. Сознательно НЕ реализация /finance/pnl (та зависит от
// нереплицированного order_splits, см. комментарий в branch_override.go).
func (s *NetworkService) PnL(ctx context.Context, f PeriodFilter) (*NetworkPnL, error) {
	account, err := s.accountForCtx(ctx)
	if err != nil {
		return nil, err
	}
	branches, err := s.branchesForAccount(ctx, account)
	if err != nil {
		return nil, err
	}
	ids := branchIDs(branches)
	out := &NetworkPnL{}
	if len(ids) == 0 {
		return out, nil
	}

	amounts := make(map[string]*PnLAmounts, len(ids))
	for _, id := range ids {
		amounts[id] = &PnLAmounts{}
	}

	// 1. Revenue + orders_count.
	type revRow struct {
		RestaurantID string          `gorm:"column:restaurant_id"`
		Total        decimal.Decimal `gorm:"column:total"`
		Cnt          int             `gorm:"column:cnt"`
	}
	q := s.r.Raw().WithContext(ctx).Table("orders").
		Select("restaurant_id, COALESCE(SUM(total_with_service), 0) AS total, COUNT(*) AS cnt").
		Where("restaurant_id IN ? AND status IN ? AND closed_at IS NOT NULL", ids, []string{"closed", "refunded"})
	if f.From != nil {
		q = q.Where("closed_at >= ?", *f.From)
	}
	if f.To != nil {
		q = q.Where("closed_at < ?", *f.To)
	}
	var revRows []revRow
	if err := q.Group("restaurant_id").Scan(&revRows).Error; err != nil {
		return nil, err
	}
	for _, r := range revRows {
		if a, ok := amounts[r.RestaurantID]; ok {
			a.Revenue = decimal.Normalize(r.Total)
			a.OrdersCount = r.Cnt
		}
	}

	// 2. COGS: JOIN orders + order_items.
	type cogsRow struct {
		RestaurantID string          `gorm:"column:restaurant_id"`
		Cogs         decimal.Decimal `gorm:"column:cogs"`
	}
	q2 := s.r.Raw().WithContext(ctx).Table("orders AS o").
		Select("o.restaurant_id, COALESCE(SUM(CASE WHEN oi.unit IN ('g','kg') AND oi.unit_size > 0 THEN oi.cogs * oi.qty / oi.unit_size ELSE oi.cogs * oi.qty END), 0) AS cogs").
		Joins("JOIN order_items oi ON oi.order_id = o.id").
		Where("o.restaurant_id IN ? AND o.status IN ? AND o.closed_at IS NOT NULL AND oi.cancelled_at IS NULL", ids, []string{"closed", "refunded"})
	if f.From != nil {
		q2 = q2.Where("o.closed_at >= ?", *f.From)
	}
	if f.To != nil {
		q2 = q2.Where("o.closed_at < ?", *f.To)
	}
	var cogsRows []cogsRow
	if err := q2.Group("o.restaurant_id").Scan(&cogsRows).Error; err != nil {
		return nil, err
	}
	for _, r := range cogsRows {
		if a, ok := amounts[r.RestaurantID]; ok {
			a.COGS = decimal.Normalize(r.Cogs)
		}
	}

	// 3. Writeoffs.
	type woRow struct {
		RestaurantID string          `gorm:"column:restaurant_id"`
		Cost         decimal.Decimal `gorm:"column:cost"`
	}
	q3 := s.r.Raw().WithContext(ctx).Table("stock_writeoffs").
		Select("restaurant_id, COALESCE(SUM(total_cost), 0) AS cost").
		Where("restaurant_id IN ?", ids)
	if f.From != nil {
		q3 = q3.Where("created_at >= ?", *f.From)
	}
	if f.To != nil {
		q3 = q3.Where("created_at < ?", *f.To)
	}
	var woRows []woRow
	if err := q3.Group("restaurant_id").Scan(&woRows).Error; err != nil {
		return nil, err
	}
	for _, r := range woRows {
		if a, ok := amounts[r.RestaurantID]; ok {
			a.Writeoffs = decimal.Normalize(r.Cost)
		}
	}

	// 4. Supply expenses (стоимость заморожена в supply_expenses.cost, см. Н8).
	type seRow struct {
		RestaurantID string          `gorm:"column:restaurant_id"`
		Cost         decimal.Decimal `gorm:"column:cost"`
	}
	q4 := s.r.Raw().WithContext(ctx).Table("supply_expenses").
		Select("restaurant_id, COALESCE(SUM(cost), 0) AS cost").
		Where("restaurant_id IN ?", ids)
	if f.From != nil {
		q4 = q4.Where("created_at >= ?", *f.From)
	}
	if f.To != nil {
		q4 = q4.Where("created_at < ?", *f.To)
	}
	var seRows []seRow
	if err := q4.Group("restaurant_id").Scan(&seRows).Error; err != nil {
		return nil, err
	}
	for _, r := range seRows {
		if a, ok := amounts[r.RestaurantID]; ok {
			a.SupplyExpenses = decimal.Normalize(r.Cost)
		}
	}

	for _, b := range branches {
		a := amounts[b.ID]
		a.GrossProfit = decimal.Normalize(
			decimal.Sub(decimal.Sub(decimal.Sub(a.Revenue, a.COGS), a.Writeoffs), a.SupplyExpenses),
		)
		out.Branches = append(out.Branches, NetworkPnLBranch{ID: b.ID, Name: b.Name, Kind: b.Kind, PnLAmounts: *a})
		out.Total.Revenue = decimal.Add(out.Total.Revenue, a.Revenue)
		out.Total.COGS = decimal.Add(out.Total.COGS, a.COGS)
		out.Total.Writeoffs = decimal.Add(out.Total.Writeoffs, a.Writeoffs)
		out.Total.SupplyExpenses = decimal.Add(out.Total.SupplyExpenses, a.SupplyExpenses)
		out.Total.OrdersCount += a.OrdersCount
	}
	out.Total.Revenue = decimal.Normalize(out.Total.Revenue)
	out.Total.COGS = decimal.Normalize(out.Total.COGS)
	out.Total.Writeoffs = decimal.Normalize(out.Total.Writeoffs)
	out.Total.SupplyExpenses = decimal.Normalize(out.Total.SupplyExpenses)
	out.Total.GrossProfit = decimal.Normalize(
		decimal.Sub(decimal.Sub(decimal.Sub(out.Total.Revenue, out.Total.COGS), out.Total.Writeoffs), out.Total.SupplyExpenses),
	)
	return out, nil
}

// ─── Cashflow (ДДС) ─────────────────────────────────────────────────────────

type CashflowAmounts struct {
	In  decimal.Decimal `json:"in"`
	Out decimal.Decimal `json:"out"`
	Net decimal.Decimal `json:"net"`
}

type NetworkCashflowBranch struct {
	ID   string  `json:"id"`
	Name string  `json:"name"`
	Kind *string `json:"kind"`
	CashflowAmounts
}

type NetworkCashflow struct {
	Total    CashflowAmounts         `json:"total"`
	Branches []NetworkCashflowBranch `json:"branches"`
}

// Cashflow — ДДС сети за период: итог + разбивка по филиалам. Источник —
// financial_operations (реплицирован с Ф1), тот же foBizDay/applyFOPeriod,
// что и одно-тенантный FinanceReportsService.Cashflow — только по/итого
// (In/Out/Net), без разбивки по дням/категориям/активностям — те детальные
// срезы для сетевого обзора избыточны, доступны на филиале через override.
func (s *NetworkService) Cashflow(ctx context.Context, f PeriodFilter) (*NetworkCashflow, error) {
	account, err := s.accountForCtx(ctx)
	if err != nil {
		return nil, err
	}
	branches, err := s.branchesForAccount(ctx, account)
	if err != nil {
		return nil, err
	}
	ids := branchIDs(branches)
	out := &NetworkCashflow{}
	if len(ids) == 0 {
		return out, nil
	}

	amounts := make(map[string]*CashflowAmounts, len(ids))
	for _, id := range ids {
		amounts[id] = &CashflowAmounts{}
	}

	type row struct {
		RestaurantID string          `gorm:"column:restaurant_id"`
		Type         string          `gorm:"column:type"`
		Total        decimal.Decimal `gorm:"column:total"`
	}
	// applyCashflowFilter — тот же, что в локальном ДДС: зеркала расходов,
	// оплаченных одним узлом за другой, здесь особенно опасны — без фильтра
	// один платёж посчитался бы дважды (отток у плательщика + «отток» у того,
	// за кого платили), и сетевой ДДС перестал бы сходиться с кассой.
	q := applyFOPeriod(applyCashflowFilter(s.r.Raw().WithContext(ctx).Table("financial_operations").
		Select("restaurant_id, COALESCE(type, '') AS type, COALESCE(SUM(amount), 0) AS total").
		Where("restaurant_id IN ?", ids)), f)
	var rows []row
	if err := q.Group("restaurant_id, type").Scan(&rows).Error; err != nil {
		return nil, err
	}
	for _, r := range rows {
		a, ok := amounts[r.RestaurantID]
		if !ok {
			continue
		}
		switch r.Type {
		case "in":
			a.In = decimal.Normalize(decimal.Add(a.In, r.Total))
		case "out":
			a.Out = decimal.Normalize(decimal.Add(a.Out, r.Total))
		}
	}

	for _, b := range branches {
		a := amounts[b.ID]
		a.Net = decimal.Normalize(decimal.Sub(a.In, a.Out))
		out.Branches = append(out.Branches, NetworkCashflowBranch{ID: b.ID, Name: b.Name, Kind: b.Kind, CashflowAmounts: *a})
		out.Total.In = decimal.Add(out.Total.In, a.In)
		out.Total.Out = decimal.Add(out.Total.Out, a.Out)
	}
	out.Total.In = decimal.Normalize(out.Total.In)
	out.Total.Out = decimal.Normalize(out.Total.Out)
	out.Total.Net = decimal.Normalize(decimal.Sub(out.Total.In, out.Total.Out))
	return out, nil
}

// ─── Склад (стоимость остатков) ─────────────────────────────────────────────

type NetworkWarehouseBranch struct {
	ID    string          `json:"id"`
	Name  string          `json:"name"`
	Kind  *string         `json:"kind"`
	Value decimal.Decimal `json:"value"`
}

type NetworkWarehouse struct {
	TotalValue decimal.Decimal          `json:"total_value"`
	Branches   []NetworkWarehouseBranch `json:"branches"`
}

// Warehouse — стоимость остатков (qty * price_per_unit) по филиалам + сумма
// по сети. Источник — ingredients (реплицирован с Ф3, денормализованный qty),
// та же формула, что AnalyticsService.IngredientStockValue, но SUM сразу в
// SQL по restaurant_id — сетевому обзору нужна только сумма, не top-N строк.
func (s *NetworkService) Warehouse(ctx context.Context) (*NetworkWarehouse, error) {
	account, err := s.accountForCtx(ctx)
	if err != nil {
		return nil, err
	}
	branches, err := s.branchesForAccount(ctx, account)
	if err != nil {
		return nil, err
	}
	ids := branchIDs(branches)
	out := &NetworkWarehouse{}
	if len(ids) == 0 {
		return out, nil
	}

	type row struct {
		RestaurantID string          `gorm:"column:restaurant_id"`
		Value        decimal.Decimal `gorm:"column:value"`
	}
	var rows []row
	if err := s.r.Raw().WithContext(ctx).Table("ingredients").
		Select("restaurant_id, COALESCE(SUM(qty * price_per_unit), 0) AS value").
		Where("restaurant_id IN ?", ids).
		Group("restaurant_id").Scan(&rows).Error; err != nil {
		return nil, err
	}
	valByRest := make(map[string]decimal.Decimal, len(rows))
	for _, r := range rows {
		valByRest[r.RestaurantID] = decimal.Normalize(r.Value)
	}

	for _, b := range branches {
		v := valByRest[b.ID]
		out.Branches = append(out.Branches, NetworkWarehouseBranch{ID: b.ID, Name: b.Name, Kind: b.Kind, Value: v})
		out.TotalValue = decimal.Add(out.TotalValue, v)
	}
	out.TotalValue = decimal.Normalize(out.TotalValue)
	return out, nil
}

// ─── Счета ──────────────────────────────────────────────────────────────────

// NetworkAccountRow — счёт филиала + подпись самого филиала (для группировки
// на фронте без второго запроса).
type NetworkAccountRow struct {
	models.FinancialAccount
	BranchName string  `json:"branch_name"`
	BranchKind *string `json:"branch_kind"`
}

type NetworkAccounts struct {
	TotalBalance decimal.Decimal     `json:"total_balance"`
	Accounts     []NetworkAccountRow `json:"accounts"`
}

// Accounts — ВСЕ счета сети (включая отключённые — деньги на них реальны и
// никуда не делись, см. [[account-disable-not-delete]]) с балансами,
// сгруппированные по филиалу, + итог «всего денег в сети». Источник —
// financial_accounts, реплицирован с Ф5 через generic trackedSave-хук.
func (s *NetworkService) Accounts(ctx context.Context) (*NetworkAccounts, error) {
	account, err := s.accountForCtx(ctx)
	if err != nil {
		return nil, err
	}
	branches, err := s.branchesForAccount(ctx, account)
	if err != nil {
		return nil, err
	}
	ids := branchIDs(branches)
	out := &NetworkAccounts{}
	if len(ids) == 0 {
		return out, nil
	}
	nameByID := make(map[string]string, len(branches))
	kindByID := make(map[string]*string, len(branches))
	for _, b := range branches {
		nameByID[b.ID] = b.Name
		kindByID[b.ID] = b.Kind
	}

	var rows []models.FinancialAccount
	if err := s.r.Raw().WithContext(ctx).
		Where("restaurant_id IN ?", ids).
		Order("restaurant_id, name ASC").Find(&rows).Error; err != nil {
		return nil, err
	}
	for _, acc := range rows {
		row := NetworkAccountRow{FinancialAccount: acc}
		if acc.RestaurantID != nil {
			row.BranchName = nameByID[*acc.RestaurantID]
			row.BranchKind = kindByID[*acc.RestaurantID]
		}
		out.Accounts = append(out.Accounts, row)
		out.TotalBalance = decimal.Add(out.TotalBalance, acc.Balance)
	}
	out.TotalBalance = decimal.Normalize(out.TotalBalance)
	return out, nil
}

// ─── Персонал сети (Фаза П) ─────────────────────────────────────────────────

// NetworkStaffRow — сотрудник + подпись его филиала. models.User встраивается
// целиком: Password/PIN в нём помечены `json:"-"` и не сериализуются никогда
// (см. комментарий у модели), поэтому встраивание безопасно.
type NetworkStaffRow struct {
	models.User
	BranchName string  `json:"branch_name"`
	BranchKind *string `json:"branch_kind"`
}

// NetworkStaffBranch — сводка по филиалу: сколько человек.
//
// Суммы ФОТ здесь сознательно НЕТ. Часть сотрудников на окладе (users.salary —
// сумма за месяц), часть на дневной ставке (users.daily_rate — сумма за день):
// сложить их в одно число нельзя, получится величина без смысла, но с видом
// денег. Честный ФОТ считается за период по табелю — это Фаза З (зарплата),
// там для этого есть SalaryAccrual.
type NetworkStaffBranch struct {
	ID    string  `json:"id"`
	Name  string  `json:"name"`
	Kind  *string `json:"kind"`
	Count int     `json:"count"`
}

type NetworkStaff struct {
	TotalCount int                  `json:"total_count"`
	Branches   []NetworkStaffBranch `json:"branches"`
	Staff      []NetworkStaffRow    `json:"staff"`
}

// Staff — весь персонал сети одним списком, с указанием филиала (ADR-003,
// Фаза П). Источник — users, реплицированы с Ф1: central физически хранит
// учётки всех филиалов, но обычный /users tenant-scoped и показывает только
// свои — сводного списка «кто где работает» не существовало.
//
// Только чтение. Править сотрудника филиала из центра нельзя: филиал —
// авторитет по своим учёткам, его следующий пуш перезапишет чужую правку
// (нужны правила разрешения конфликтов — отдельная фаза).
func (s *NetworkService) Staff(ctx context.Context) (*NetworkStaff, error) {
	// Оклады и ставки всех филиалов — то же право, что и зарплата, а не общий
	// finance.view: серверная проверка обязательна, гейт в меню от прямого
	// запроса к API не защищает.
	if err := requirePermFor(ctx, s.r, "payroll.manage"); err != nil {
		return nil, err
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
	out := &NetworkStaff{}
	if len(ids) == 0 {
		return out, nil
	}
	nameByID := make(map[string]string, len(branches))
	kindByID := make(map[string]*string, len(branches))
	for _, b := range branches {
		nameByID[b.ID] = b.Name
		kindByID[b.ID] = b.Kind
	}

	var rows []models.User
	if err := s.r.Raw().WithContext(ctx).
		Where("restaurant_id IN ?", ids).
		Order("restaurant_id, name ASC").Find(&rows).Error; err != nil {
		return nil, err
	}
	countByID := make(map[string]int, len(branches))
	for i := range rows {
		u := rows[i]
		row := NetworkStaffRow{User: u}
		if u.RestaurantID != nil {
			row.BranchName = nameByID[*u.RestaurantID]
			row.BranchKind = kindByID[*u.RestaurantID]
			countByID[*u.RestaurantID]++
		}
		out.Staff = append(out.Staff, row)
	}
	out.TotalCount = len(rows)
	// Порядок филиалов — как у branchesForAccount (central первым), чтобы
	// сводка и остальные сетевые отчёты не разъезжались.
	for _, b := range branches {
		out.Branches = append(out.Branches, NetworkStaffBranch{
			ID: b.ID, Name: b.Name, Kind: b.Kind, Count: countByID[b.ID],
		})
	}
	return out, nil
}

// ─── Сводный дашборд сети (Ф-С1) ────────────────────────────────────────────
//
// Central — офис: продаж на нём нет, локальный дашборд показывал нули и
// операционные виджеты кассы. Владелец сети хочет видеть на главном экране
// свод по ВСЕМ филиалам разом. Все данные уже реплицированы («central видит
// всё», Ф1-Ф8) — считаем из своей БД одним запросом, без обращений к узлам.

type NetworkDashboardBranch struct {
	ID          string          `json:"id"`
	Name        string          `json:"name"`
	Kind        *string         `json:"kind"`
	Revenue     decimal.Decimal `json:"revenue"`
	OrdersCount int             `json:"orders_count"`
	CashBalance decimal.Decimal `json:"cash_balance"`
	OpenShift   bool            `json:"open_shift"`
}

type NetworkDashboard struct {
	Revenue     decimal.Decimal `json:"revenue"`
	OrdersCount int             `json:"orders_count"`
	AvgCheck    decimal.Decimal `json:"avg_check"`
	// Expenses — отток денег сети за период по правилам ДДС: без зеркал
	// (paid_by_restaurant_id — деньги ушли у плательщика, не здесь), без
	// финансовой активности (внутрисетевые переводы — не расход сети).
	Expenses   decimal.Decimal          `json:"expenses"`
	TotalCash  decimal.Decimal          `json:"total_cash"`
	OpenShifts int                      `json:"open_shifts"`
	Branches   []NetworkDashboardBranch `json:"branches"`
	// «Требует внимания» — та же природа, что у локального дашборда
	// (overdueSuppliers/duePayments), но по ВСЕЙ сети: остаток долга по
	// накладным (stock_receipts.debt_amount — тот же источник, что
	// BranchPayables, не suppliers.current_debt, чтобы не разойтись с
	// экраном «Расходы за филиалы») и регулярные платежи со сроком в
	// ближайшие 7 дней (включая просроченные) — НЕЗАВИСИМО от периода f.
	SupplierDebt      decimal.Decimal `json:"supplier_debt"`
	SupplierDebtCount int             `json:"supplier_debt_count"`
	DuePayments       decimal.Decimal `json:"due_payments"`
	DuePaymentsCount  int             `json:"due_payments_count"`
}

// Dashboard — сводка «на сегодня» (или произвольный период f) по всей сети.
func (s *NetworkService) Dashboard(ctx context.Context, f PeriodFilter) (*NetworkDashboard, error) {
	account, err := s.accountForCtx(ctx)
	if err != nil {
		return nil, err
	}
	branches, err := s.branchesForAccount(ctx, account)
	if err != nil {
		return nil, err
	}
	ids := branchIDs(branches)
	out := &NetworkDashboard{}
	if len(ids) == 0 {
		return out, nil
	}

	type agg struct {
		revenue decimal.Decimal
		orders  int
		cash    decimal.Decimal
		open    bool
	}
	byID := make(map[string]*agg, len(ids))
	for _, id := range ids {
		byID[id] = &agg{}
	}

	// 1. Выручка и число заказов — из закрытых заказов (как сетевой ОПиУ):
	// это факт продажи, не зависящий от того, как разложилась оплата по
	// financial_operations.
	type revRow struct {
		RestaurantID string          `gorm:"column:restaurant_id"`
		Total        decimal.Decimal `gorm:"column:total"`
		Cnt          int             `gorm:"column:cnt"`
	}
	q := s.r.Raw().WithContext(ctx).Table("orders").
		Select("restaurant_id, COALESCE(SUM(total_with_service), 0) AS total, COUNT(*) AS cnt").
		Where("restaurant_id IN ? AND status IN ? AND closed_at IS NOT NULL", ids, []string{"closed", "refunded"})
	if f.From != nil {
		q = q.Where("closed_at >= ?", *f.From)
	}
	if f.To != nil {
		q = q.Where("closed_at < ?", *f.To)
	}
	var revRows []revRow
	if err := q.Group("restaurant_id").Scan(&revRows).Error; err != nil {
		return nil, err
	}
	for _, r := range revRows {
		if a, ok := byID[r.RestaurantID]; ok {
			a.revenue = decimal.Normalize(r.Total)
			a.orders = r.Cnt
		}
	}

	// 2. Расходы за период — те же правила, что сетевой ДДС (applyCashflowFilter
	// исключает зеркала Ф-Р; activity='financial' — переводы между узлами,
	// движение денег внутри сети, а не её расход).
	var expenses decimal.Decimal
	if err := applyFOPeriod(applyCashflowFilter(s.r.Raw().WithContext(ctx).Table("financial_operations").
		Select("COALESCE(SUM(amount), 0)").
		Where("restaurant_id IN ? AND type = ?", ids, "out").
		Where("COALESCE(activity, '') <> ?", "financial")), f).
		Scan(&expenses).Error; err != nil {
		return nil, err
	}
	out.Expenses = decimal.Normalize(expenses)

	// 3. Кассы: только включённые счета — отключённый счёт хранит историю,
	// но деньгами сети не является (см. account-disable-not-delete).
	type cashRow struct {
		RestaurantID string          `gorm:"column:restaurant_id"`
		Total        decimal.Decimal `gorm:"column:total"`
	}
	var cashRows []cashRow
	if err := s.r.Raw().WithContext(ctx).Table("financial_accounts").
		Select("restaurant_id, COALESCE(SUM(balance), 0) AS total").
		Where("restaurant_id IN ? AND is_enabled = ?", ids, true).
		Group("restaurant_id").Scan(&cashRows).Error; err != nil {
		return nil, err
	}
	for _, r := range cashRows {
		if a, ok := byID[r.RestaurantID]; ok {
			a.cash = decimal.Normalize(r.Total)
		}
	}

	// 4. Открытые смены — «филиал сейчас работает».
	var openRows []string
	if err := s.r.Raw().WithContext(ctx).Table("cash_shifts").
		Select("DISTINCT restaurant_id").
		Where("restaurant_id IN ? AND status = ?", ids, "open").
		Scan(&openRows).Error; err != nil {
		return nil, err
	}
	for _, id := range openRows {
		if a, ok := byID[id]; ok {
			a.open = true
		}
	}

	for _, b := range branches {
		a := byID[b.ID]
		out.Branches = append(out.Branches, NetworkDashboardBranch{
			ID: b.ID, Name: b.Name, Kind: b.Kind,
			Revenue: a.revenue, OrdersCount: a.orders, CashBalance: a.cash, OpenShift: a.open,
		})
		out.Revenue = decimal.Add(out.Revenue, a.revenue)
		out.OrdersCount += a.orders
		out.TotalCash = decimal.Add(out.TotalCash, a.cash)
		if a.open {
			out.OpenShifts++
		}
	}
	out.Revenue = decimal.Normalize(out.Revenue)
	out.TotalCash = decimal.Normalize(out.TotalCash)
	if out.OrdersCount > 0 {
		out.AvgCheck = decimal.DivRound(out.Revenue, decimal.MustFromString(strconv.Itoa(out.OrdersCount)))
	}

	// 5. Долг поставщикам — по всей сети, независимо от периода f (это остаток,
	// не поток). Источник — stock_receipts, тот же что BranchPayables.
	type debtRow struct {
		Total decimal.Decimal `gorm:"column:total"`
		Cnt   int             `gorm:"column:cnt"`
	}
	var debt debtRow
	if err := s.r.Raw().WithContext(ctx).Table("stock_receipts").
		Select("COALESCE(SUM(debt_amount), 0) AS total, COUNT(*) AS cnt").
		Where("restaurant_id IN ? AND debt_amount > 0", ids).
		Scan(&debt).Error; err != nil {
		return nil, err
	}
	out.SupplierDebt = decimal.Normalize(debt.Total)
	out.SupplierDebtCount = debt.Cnt

	// 6. Регулярные платежи к оплате — активные, срок ≤ 7 дней (включая
	// просроченные). Остаток — remaining_amount, если задан (частичная
	// оплата), иначе вся amount.
	type dueRow struct {
		Amount          decimal.Decimal  `gorm:"column:amount"`
		RemainingAmount *decimal.Decimal `gorm:"column:remaining_amount"`
	}
	var dueRows []dueRow
	if err := s.r.Raw().WithContext(ctx).Table("recurring_payments").
		Select("amount, remaining_amount").
		Where("restaurant_id IN ? AND active = ? AND next_due IS NOT NULL AND next_due <> '' AND next_due <= ?",
			ids, true, time.Now().UTC().AddDate(0, 0, 7).Format("2006-01-02")).
		Scan(&dueRows).Error; err != nil {
		return nil, err
	}
	for _, r := range dueRows {
		amt := r.Amount
		if r.RemainingAmount != nil {
			amt = *r.RemainingAmount
		}
		out.DuePayments = decimal.Add(out.DuePayments, amt)
		out.DuePaymentsCount++
	}
	out.DuePayments = decimal.Normalize(out.DuePayments)

	return out, nil
}

// ─── Динамика выручки сети (Ф-С1, продолжение) ──────────────────────────────
//
// «Общая динамика» — сетевой аналог FinanceReportsService.MonthlyRevenue
// (finance.go): та же схема (revenue из orders, expenses из financial_operations
// с applyOpexFilter, profit = revenue-expenses), но restaurant_id IN ids
// вместо ForTenant(ctx) — central видит тренд по ВСЕЙ сети одним запросом,
// без обращения к узлам.

type NetworkMonthlyRevenueRow struct {
	Month       string          `json:"month"`
	Revenue     decimal.Decimal `json:"revenue"`
	OrdersCount int             `json:"orders_count"`
	Expenses    decimal.Decimal `json:"expenses"`
	Profit      decimal.Decimal `json:"profit"`
}

// MonthlyRevenue — последние N месяцев (по умолчанию/максимум — как в
// одно-тенантном отчёте) для графика «Динамика выручки» сети.
func (s *NetworkService) MonthlyRevenue(ctx context.Context, months int) ([]NetworkMonthlyRevenueRow, error) {
	if months <= 0 {
		months = 12
	}
	if months > 60 {
		months = 60
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
	if len(ids) == 0 {
		return []NetworkMonthlyRevenueRow{}, nil
	}

	now := time.Now().UTC()
	startMonth := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC).AddDate(0, -(months - 1), 0)

	type row struct {
		Month string          `gorm:"column:month"`
		Total decimal.Decimal `gorm:"column:total"`
		Cnt   int             `gorm:"column:cnt"`
	}
	var rows []row
	if err := s.r.Raw().WithContext(ctx).Table("orders").
		Select("to_char(closed_at, 'YYYY-MM') AS month, COALESCE(SUM(total_with_service), 0) AS total, COUNT(*) AS cnt").
		Where("restaurant_id IN ? AND status IN ? AND closed_at IS NOT NULL AND closed_at >= ?",
			ids, []string{"closed", "refunded"}, startMonth).
		Group("month").
		Scan(&rows).Error; err != nil {
		return nil, err
	}
	byMonth := map[string]row{}
	for _, r := range rows {
		byMonth[r.Month] = r
	}

	type expRow struct {
		Month string          `gorm:"column:month"`
		Total decimal.Decimal `gorm:"column:total"`
	}
	var expRows []expRow
	if err := applyOpexFilter(s.r.Raw().WithContext(ctx).Table("financial_operations").
		Select("left("+foBizDay+", 7) AS month, COALESCE(SUM(amount), 0) AS total").
		Where("restaurant_id IN ?", ids)).
		Where(foBizDay+" >= ?", startMonth.Format("2006-01-02")).
		Group("month").
		Scan(&expRows).Error; err != nil {
		return nil, err
	}
	byMonthExp := map[string]decimal.Decimal{}
	for _, r := range expRows {
		byMonthExp[r.Month] = r.Total
	}

	out := make([]NetworkMonthlyRevenueRow, 0, months)
	for i := 0; i < months; i++ {
		t := startMonth.AddDate(0, i, 0)
		key := t.Format("2006-01")
		r, ok := byMonth[key]
		total, cnt := decimal.Zero, 0
		if ok {
			total, cnt = decimal.Normalize(r.Total), r.Cnt
		}
		exp := decimal.Normalize(byMonthExp[key])
		out = append(out, NetworkMonthlyRevenueRow{
			Month: key, Revenue: total, OrdersCount: cnt, Expenses: exp,
			Profit: decimal.Normalize(decimal.Sub(total, exp)),
		})
	}
	return out, nil
}

// ─── Детали дашборда сети (Ф-С1, продолжение) ───────────────────────────────
//
// Тяжёлая, item-level часть — топ блюда/категории/способы оплаты/по часам
// требуют JOIN с order_items по всей сети, поэтому отдельный эндпоинт от
// лёгкого Dashboard() (KPI+алерты+филиалы): страница может отрисовать быстрое
// первым, тяжёлое — вторым запросом параллельно.
//
// Ключевое отличие от одно-тенантных виджетов дашборда: группировка ПО ИМЕНИ
// (name), не по menu_item_id — у одного и того же сетевого блюда на каждом
// филиале СВОЙ локальный menu_item_id (материализация мастера, ADR-004), id
// не совпадают между узлами, а имя — совпадает.

type NetworkTopDish struct {
	Name    string          `json:"name"`
	Qty     decimal.Decimal `json:"qty"`
	Revenue decimal.Decimal `json:"revenue"`
}

type NetworkCategorySale struct {
	Name    string          `json:"name"`
	Revenue decimal.Decimal `json:"revenue"`
}

type NetworkLowStockItem struct {
	BranchName string          `json:"branch_name"`
	Name       string          `json:"name"`
	Qty        decimal.Decimal `json:"qty"`
	MinQty     decimal.Decimal `json:"min_qty"`
	Unit       string          `json:"unit"`
}

type NetworkOrderTypeCount struct {
	Type  string `json:"type"`
	Count int    `json:"count"`
}

type NetworkHourlyRevenue struct {
	Hour    int             `json:"hour"`
	Revenue decimal.Decimal `json:"revenue"`
}

type NetworkDashboardDetail struct {
	TopDishes        []NetworkTopDish        `json:"top_dishes"`
	PaymentBreakdown map[string]string       `json:"payment_breakdown"` // cash/card/transfer → Decimal-строка
	CategorySales    []NetworkCategorySale   `json:"category_sales"`
	LowStock         []NetworkLowStockItem   `json:"low_stock"`
	OrdersByType     []NetworkOrderTypeCount `json:"orders_by_type"`
	HourlyRevenue    []NetworkHourlyRevenue  `json:"hourly_revenue"`
}

// lineRevenueSQL — та же формула, что client-side calcLineTotal (helpers.ts):
// весовая позиция — price × qty/unit_size, штучная — price × qty. Дублируем
// в SQL по тому же принципу, что и COGS в PnL (см. выше в этом файле) —
// разошлись бы, если считать по-разному на сервере и на клиенте.
const lineRevenueSQL = "CASE WHEN oi.unit IN ('g','kg') AND oi.unit_size > 0 THEN oi.price * oi.qty / oi.unit_size ELSE oi.price * oi.qty END"
const lineQtySQL = "CASE WHEN oi.unit IN ('g','kg') AND oi.unit_size > 0 THEN oi.qty / oi.unit_size ELSE oi.qty END"

func (s *NetworkService) DashboardDetail(ctx context.Context, f PeriodFilter) (*NetworkDashboardDetail, error) {
	account, err := s.accountForCtx(ctx)
	if err != nil {
		return nil, err
	}
	branches, err := s.branchesForAccount(ctx, account)
	if err != nil {
		return nil, err
	}
	ids := branchIDs(branches)
	out := &NetworkDashboardDetail{
		PaymentBreakdown: map[string]string{"cash": "0", "card": "0", "transfer": "0"},
	}
	if len(ids) == 0 {
		return out, nil
	}
	nameByID := make(map[string]string, len(branches))
	for _, b := range branches {
		nameByID[b.ID] = b.Name
	}

	closedOrders := func(alias string) *gorm.DB {
		q := s.r.Raw().WithContext(ctx).Table("orders "+alias).
			Where(alias+".restaurant_id IN ? AND "+alias+".status IN ? AND "+alias+".closed_at IS NOT NULL",
				ids, []string{"closed", "refunded"})
		if f.From != nil {
			q = q.Where(alias+".closed_at >= ?", *f.From)
		}
		if f.To != nil {
			q = q.Where(alias+".closed_at < ?", *f.To)
		}
		return q
	}

	// 1. Топ блюда — 5 позиций по выручке.
	type dishRow struct {
		Name    string          `gorm:"column:name"`
		Qty     decimal.Decimal `gorm:"column:qty"`
		Revenue decimal.Decimal `gorm:"column:revenue"`
	}
	var dishRows []dishRow
	if err := closedOrders("o").
		Select("COALESCE(oi.name, '—') AS name, COALESCE(SUM(" + lineQtySQL + "), 0) AS qty, COALESCE(SUM(" + lineRevenueSQL + "), 0) AS revenue").
		Joins("JOIN order_items oi ON oi.order_id = o.id AND oi.cancelled_at IS NULL").
		Group("oi.name").
		Order("revenue DESC").
		Limit(5).
		Scan(&dishRows).Error; err != nil {
		return nil, err
	}
	for _, r := range dishRows {
		out.TopDishes = append(out.TopDishes, NetworkTopDish{
			Name: r.Name, Qty: decimal.Normalize(r.Qty), Revenue: decimal.Normalize(r.Revenue),
		})
	}

	// 2. Способы оплаты — по способу оплаты ЗАКАЗА (сплит-платежи по
	// смешанной оплате не разложены в БД отдельной таблицей — тот же уровень
	// точности, что и у одно-тенантного дашборда: o.payments там тоже почти
	// всегда пуст, реально работает paymentMethod-ветка).
	type payRow struct {
		Method string          `gorm:"column:payment_method"`
		Total  decimal.Decimal `gorm:"column:total"`
	}
	var payRows []payRow
	if err := closedOrders("o").
		Select("COALESCE(o.payment_method, 'cash') AS payment_method, COALESCE(SUM(o.total_with_service), 0) AS total").
		Group("o.payment_method").
		Scan(&payRows).Error; err != nil {
		return nil, err
	}
	for _, r := range payRows {
		if _, ok := out.PaymentBreakdown[r.Method]; ok {
			out.PaymentBreakdown[r.Method] = decimal.Normalize(r.Total).String()
		}
	}

	// 3. Категории — по menu_items.category (реплицирован, привязан через
	// menu_item_id; своя строка на каждом узле — id не совпадают, но JOIN
	// делается В ПРЕДЕЛАХ одного restaurant_id неявно: order_items.order_id
	// принадлежит заказу узла, у которого мы и ищем его menu_items).
	type catRow struct {
		Name    string          `gorm:"column:cat_name"`
		Revenue decimal.Decimal `gorm:"column:revenue"`
	}
	var catRows []catRow
	if err := closedOrders("o").
		Select("COALESCE(mi.category, 'Без категории') AS cat_name, COALESCE(SUM(" + lineRevenueSQL + "), 0) AS revenue").
		Joins("JOIN order_items oi ON oi.order_id = o.id AND oi.cancelled_at IS NULL").
		Joins("LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id AND mi.restaurant_id = o.restaurant_id").
		Group("cat_name").
		Order("revenue DESC").
		Limit(6).
		Scan(&catRows).Error; err != nil {
		return nil, err
	}
	for _, r := range catRows {
		out.CategorySales = append(out.CategorySales, NetworkCategorySale{Name: r.Name, Revenue: decimal.Normalize(r.Revenue)})
	}

	// 4. Низкий остаток — до 20 позиций по всей сети, с именем филиала.
	type stockRow struct {
		RestaurantID string          `gorm:"column:restaurant_id"`
		Name         string          `gorm:"column:name"`
		Qty          decimal.Decimal `gorm:"column:qty"`
		MinQty       decimal.Decimal `gorm:"column:min_qty"`
		Unit         string          `gorm:"column:unit"`
	}
	var stockRows []stockRow
	if err := s.r.Raw().WithContext(ctx).Table("ingredients").
		Select("restaurant_id, COALESCE(name, '—') AS name, qty, min_qty, COALESCE(unit, '') AS unit").
		Where("restaurant_id IN ? AND qty < min_qty", ids).
		Order("(min_qty - qty) DESC").
		Limit(20).
		Scan(&stockRows).Error; err != nil {
		return nil, err
	}
	for _, r := range stockRows {
		out.LowStock = append(out.LowStock, NetworkLowStockItem{
			BranchName: nameByID[r.RestaurantID], Name: r.Name,
			Qty: decimal.Normalize(r.Qty), MinQty: decimal.Normalize(r.MinQty), Unit: r.Unit,
		})
	}

	// 5. Заказы по типам.
	type typeRow struct {
		Type string `gorm:"column:type"`
		Cnt  int    `gorm:"column:cnt"`
	}
	var typeRows []typeRow
	if err := closedOrders("o").
		Select("o.type AS type, COUNT(*) AS cnt").
		Group("o.type").
		Scan(&typeRows).Error; err != nil {
		return nil, err
	}
	for _, r := range typeRows {
		if r.Type == "" {
			continue
		}
		out.OrdersByType = append(out.OrdersByType, NetworkOrderTypeCount{Type: r.Type, Count: r.Cnt})
	}

	// 6. Выручка по часам — по часу СОЗДАНИЯ заказа (created_at), как в
	// одно-тенантном дашборде; при многодневном периоде часы суммируются по
	// всем дням (это ответ на «когда обычно пик», не «выручка сегодня по часам»).
	type hourRow struct {
		Hour    int             `gorm:"column:hour"`
		Revenue decimal.Decimal `gorm:"column:revenue"`
	}
	var hourRows []hourRow
	if err := closedOrders("o").
		Select("EXTRACT(HOUR FROM o.created_at)::int AS hour, COALESCE(SUM(o.total_with_service), 0) AS revenue").
		Group("hour").
		Scan(&hourRows).Error; err != nil {
		return nil, err
	}
	byHour := map[int]decimal.Decimal{}
	for _, r := range hourRows {
		byHour[r.Hour] = decimal.Normalize(r.Revenue)
	}
	for h := 10; h <= 22; h++ {
		out.HourlyRevenue = append(out.HourlyRevenue, NetworkHourlyRevenue{Hour: h, Revenue: byHour[h]})
	}

	return out, nil
}

// ─── Смены сети ──────────────────────────────────────────────────────────
//
// «Операции» на central скрыты целиком (Ф-С4) — карта зала/конвейер заказов
// читают живой статус, который сеть не реплицирует (тот же принцип, что у
// «Точки сети» на дашборде). Но cash_shifts РЕПЛИЦИРОВАНА — её уже читает
// Dashboard для open_shifts (см. выше) — сводный список смен по сети возможен
// без новых зависимостей. Разбор ОДНОЙ смены (Z-отчёт) — не новый запрос, а
// ShiftsService.ZReport с подменённым tenant на филиал этой смены, тот же
// приём, что у PayBranchSalary → salaryCapForPeriod(branchCtx, ...).

// NetworkShiftRow — одна смена одного филиала, для сводного списка.
type NetworkShiftRow struct {
	ID             string           `json:"id"`
	RestaurantID   string           `json:"restaurant_id"`
	RestaurantName string           `json:"restaurant_name"`
	Status         string           `json:"status"`
	OpenedAt       time.Time        `json:"opened_at"`
	ClosedAt       *time.Time       `json:"closed_at,omitempty"`
	OpenedByName   string           `json:"opened_by_name"`
	ClosedByName   string           `json:"closed_by_name,omitempty"`
	AccountName    string           `json:"account_name"`
	OpeningBalance decimal.Decimal  `json:"opening_balance"`
	ClosingBalance *decimal.Decimal `json:"closing_balance,omitempty"`
	ExpectedCash   *decimal.Decimal `json:"expected_cash,omitempty"`
	// Discrepancy — closing_balance − expected_cash, только у закрытых смен
	// (недостача/излишек). Не хранится в БД, считается здесь же, как и в
	// одно-тенантном ZReport.
	Discrepancy *decimal.Decimal `json:"discrepancy,omitempty"`
	CashRevenue decimal.Decimal  `json:"cash_revenue"`
	CardRevenue decimal.Decimal  `json:"card_revenue"`
	OrdersCount int              `json:"orders_count"`
}

type NetworkShiftsTotals struct {
	OpenCount        int             `json:"open_count"`
	ClosedCount      int             `json:"closed_count"`
	Revenue          decimal.Decimal `json:"revenue"`
	OrdersCount      int             `json:"orders_count"`
	DiscrepancyCount int             `json:"discrepancy_count"`
}

type NetworkShiftsResult struct {
	Shifts []NetworkShiftRow   `json:"shifts"`
	Totals NetworkShiftsTotals `json:"totals"`
}

// networkShiftsLimit — «сводно», не бесконечная история: чтобы копнуть
// глубже, сузить период/филиал. Владелец просил обзор, не архив.
const networkShiftsLimit = 300

// Shifts — GET /network/shifts?from=&to=&branch_id=&status=. Сводный список
// смен по всей сети (или одному филиалу, если указан branch_id), новые сверху.
func (s *NetworkService) Shifts(ctx context.Context, f PeriodFilter, branchID, status string) (*NetworkShiftsResult, error) {
	account, err := s.accountForCtx(ctx)
	if err != nil {
		return nil, err
	}
	branches, err := s.branchesForAccount(ctx, account)
	if err != nil {
		return nil, err
	}
	ids := branchIDs(branches)
	out := &NetworkShiftsResult{Shifts: []NetworkShiftRow{}}
	if len(ids) == 0 {
		return out, nil
	}
	if branchID != "" {
		if !containsID(ids, branchID) {
			return nil, apperrors.Wrap("VALIDATION", "branch_id не входит в эту сеть", nil)
		}
		ids = []string{branchID}
	}

	type row struct {
		ID             string           `gorm:"column:id"`
		RestaurantID   string           `gorm:"column:restaurant_id"`
		RestaurantName string           `gorm:"column:restaurant_name"`
		Status         string           `gorm:"column:status"`
		OpenedAt       time.Time        `gorm:"column:opened_at"`
		ClosedAt       *time.Time       `gorm:"column:closed_at"`
		OpenedByName   string           `gorm:"column:opened_by_name"`
		ClosedByName   string           `gorm:"column:closed_by_name"`
		AccountName    string           `gorm:"column:account_name"`
		OpeningBalance decimal.Decimal  `gorm:"column:opening_balance"`
		ClosingBalance decimal.Decimal  `gorm:"column:closing_balance"`
		ExpectedCash   *decimal.Decimal `gorm:"column:expected_cash"`
		CashRevenue    decimal.Decimal  `gorm:"column:cash_revenue"`
		CardRevenue    decimal.Decimal  `gorm:"column:card_revenue"`
		OrdersCount    int              `gorm:"column:orders_count"`
	}

	q := s.r.Raw().WithContext(ctx).Table("cash_shifts AS cs").
		Select(`cs.id, cs.restaurant_id, COALESCE(r.name,'') AS restaurant_name,
		        COALESCE(cs.status,'') AS status, cs.opened_at, cs.closed_at,
		        COALESCE(ou.name,'') AS opened_by_name, COALESCE(cu.name,'') AS closed_by_name,
		        COALESCE(acc.name,'') AS account_name,
		        COALESCE(cs.opening_balance,0) AS opening_balance, COALESCE(cs.closing_balance,0) AS closing_balance,
		        cs.expected_cash, COALESCE(cs.cash_revenue,0) AS cash_revenue,
		        COALESCE(cs.card_revenue,0) AS card_revenue, COALESCE(cs.orders_count,0) AS orders_count`).
		Joins("LEFT JOIN restaurants r ON r.id::text = cs.restaurant_id").
		Joins("LEFT JOIN users ou ON ou.id::text = cs.opened_by").
		Joins("LEFT JOIN users cu ON cu.id::text = cs.closed_by").
		Joins("LEFT JOIN financial_accounts acc ON acc.id::text = cs.account_id").
		Where("cs.restaurant_id IN ?", ids)
	if status == "open" || status == "closed" {
		q = q.Where("cs.status = ?", status)
	}
	if f.From != nil {
		q = q.Where("cs.opened_at >= ?", *f.From)
	}
	if f.To != nil {
		q = q.Where("cs.opened_at < ?", *f.To)
	}

	var rows []row
	if err := q.Order("cs.opened_at DESC").Limit(networkShiftsLimit).Scan(&rows).Error; err != nil {
		return nil, err
	}

	for _, r := range rows {
		nr := NetworkShiftRow{
			ID: r.ID, RestaurantID: r.RestaurantID, RestaurantName: r.RestaurantName,
			Status: r.Status, OpenedAt: r.OpenedAt, ClosedAt: r.ClosedAt,
			OpenedByName: r.OpenedByName, ClosedByName: r.ClosedByName, AccountName: r.AccountName,
			OpeningBalance: decimal.Normalize(r.OpeningBalance),
			CashRevenue:    decimal.Normalize(r.CashRevenue),
			CardRevenue:    decimal.Normalize(r.CardRevenue),
			OrdersCount:    r.OrdersCount,
		}
		if r.Status == "closed" {
			cb := decimal.Normalize(r.ClosingBalance)
			nr.ClosingBalance = &cb
			out.Totals.ClosedCount++
			if r.ExpectedCash != nil {
				ec := decimal.Normalize(*r.ExpectedCash)
				nr.ExpectedCash = &ec
				disc := decimal.Sub(cb, ec)
				nr.Discrepancy = &disc
				if !disc.IsZero() {
					out.Totals.DiscrepancyCount++
				}
			}
		} else {
			out.Totals.OpenCount++
		}
		out.Totals.Revenue = decimal.Add(out.Totals.Revenue, decimal.Add(r.CashRevenue, r.CardRevenue))
		out.Totals.OrdersCount += r.OrdersCount
		out.Shifts = append(out.Shifts, nr)
	}
	out.Totals.Revenue = decimal.Normalize(out.Totals.Revenue)
	return out, nil
}

// ShiftZReport — GET /network/shifts/{id}/zreport. Полный разбор ОДНОЙ смены
// сети: тот же ShiftsService.ZReport, что и в одно-тенантном /shifts/{id}/zreport,
// просто с подменённым tenant на филиал этой смены — сама смена и все её
// операции/заказы уже лежат в БД central (реплика), точно так же, как
// PayBranchSalary читает кап филиала через tenant.WithRestaurant(ctx, branchID).
func (s *NetworkService) ShiftZReport(ctx context.Context, shiftID string) (*ZReport, error) {
	account, err := s.accountForCtx(ctx)
	if err != nil {
		return nil, err
	}
	branches, err := s.branchesForAccount(ctx, account)
	if err != nil {
		return nil, err
	}
	ids := branchIDs(branches)

	type shiftRid struct {
		RestaurantID string `gorm:"column:restaurant_id"`
	}
	var sr shiftRid
	if err := s.r.Raw().WithContext(ctx).Table("cash_shifts").
		Select("restaurant_id").Where("id = ?", shiftID).
		Scan(&sr).Error; err != nil {
		return nil, err
	}
	if sr.RestaurantID == "" || !containsID(ids, sr.RestaurantID) {
		return nil, apperrors.ErrNotFound
	}

	branchCtx := tenant.WithRestaurant(ctx, sr.RestaurantID)
	return NewShiftsService(s.r).ZReport(branchCtx, shiftID)
}

func containsID(ids []string, id string) bool {
	for _, x := range ids {
		if x == id {
			return true
		}
	}
	return false
}
