package service

import (
	"context"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
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
	q := applyFOPeriod(s.r.Raw().WithContext(ctx).Table("financial_operations").
		Select("restaurant_id, COALESCE(type, '') AS type, COALESCE(SUM(amount), 0) AS total").
		Where("restaurant_id IN ?", ids), f)
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
