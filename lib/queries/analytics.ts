import { api, unwrap } from './_client'

// Decimal-as-string from server JSON. Use Number() to parse for display.
type DecStr = string

export type AnalyticsPeriod = { from?: string; to?: string }

export type EngineeringClass = 'star' | 'workhorse' | 'puzzle' | 'dog' | ''

export interface ABCMenuItem {
  menu_item_id: string
  name: string
  qty: DecStr
  revenue: DecStr
  cogs: DecStr
  gross_profit: DecStr
  margin_percent: DecStr
  share: DecStr
  cum_share: DecStr
  class: 'A' | 'B' | 'C'
  engineering_class: EngineeringClass
}

export interface ABCMenuReport {
  period: AnalyticsPeriod
  total_revenue: DecStr
  total_cogs: DecStr
  items: ABCMenuItem[]
}

export interface PeakHoursCell {
  weekday: number
  hour: number
  orders: number
  revenue: DecStr
}

export interface PeakHoursReport {
  period: AnalyticsPeriod
  total_orders: number
  total_revenue: DecStr
  cells: PeakHoursCell[]
}

export interface WaiterRow {
  waiter_id: string
  name: string
  orders: number
  revenue: DecStr
  items_sold: DecStr
  avg_check: DecStr
  service_amount: DecStr
  tip_amount: DecStr
  avg_service_min: DecStr
  best_day: string
  best_day_revenue: DecStr
}

export interface WaitersReport {
  period: AnalyticsPeriod
  total_revenue: DecStr
  total_orders: number
  rows: WaiterRow[]
}

export type TableLiveStatus = 'free' | 'occupied' | 'reserved' | 'bill_requested'

export interface TableAnalyticsRow {
  table_id: string
  name: string
  zone_name: string
  orders: number
  revenue: DecStr
  avg_check: DecStr
  avg_duration_min: DecStr
  guests_total: number
  status: TableLiveStatus
  capacity: number
  revenue_per_seat: DecStr
  occupancy_pct: DecStr
}

export interface TablesAnalyticsReport {
  period: AnalyticsPeriod
  total_revenue: DecStr
  total_orders: number
  rows: TableAnalyticsRow[]
}

export interface FoodCostRow {
  menu_item_id: string
  name: string
  qty: DecStr
  revenue: DecStr
  cogs: DecStr
  food_cost_pct: DecStr
  gross_profit: DecStr
  margin_percent: DecStr
}

export interface FoodCostReport {
  period: AnalyticsPeriod
  total_revenue: DecStr
  total_cogs: DecStr
  food_cost_pct: DecStr
  margin_percent: DecStr
  rows: FoodCostRow[]
}

function isoOrDate(v: Date | string | undefined): string | undefined {
  if (v == null) return undefined
  if (v instanceof Date) return v.toISOString()
  return String(v)
}

function buildQuery(opts: { from?: Date | string; to?: Date | string }): Record<string, string> {
  const q: Record<string, string> = {}
  const from = isoOrDate(opts.from); if (from) q.from = from
  const to = isoOrDate(opts.to); if (to) q.to = to
  return q
}

export async function fetchABCMenu(opts: { from?: Date | string; to?: Date | string } = {}): Promise<ABCMenuReport> {
  const query = buildQuery(opts)
  return (await unwrap(api.GET('/api/v1/analytics/abc-menu', { params: { query: query as any } }))) as ABCMenuReport
}

// ─── Аналитика по дням недели (A1–A3) ───────────────────────────────────────

export interface WeekdayRow {
  weekday: number // 0=вс … 6=сб
  orders: number
  revenue: number
  cogs: number
  labor: number
  gross_profit: number
  net_profit: number
  avg_check: number
}
export interface WeekdayHourCell {
  weekday: number
  hour: number
  orders: number
  revenue: number
  profit: number
}
export interface WeekdayCategoryRow {
  weekday: number
  category: string
  qty: number
  revenue: number
  profit: number
}
export interface WeekdayReport {
  by_weekday: WeekdayRow[]
  heatmap: WeekdayHourCell[]
  by_category: WeekdayCategoryRow[]
}

export async function fetchWeekday(opts: { from?: Date | string; to?: Date | string } = {}): Promise<WeekdayReport> {
  const query = buildQuery(opts)
  const r: any = await unwrap(api.GET('/api/v1/analytics/weekday', { params: { query: query as any } }))
  const n = (v: any) => Number(v ?? 0)
  return {
    by_weekday: (r?.by_weekday ?? []).map((x: any) => ({
      weekday: n(x.weekday), orders: n(x.orders), revenue: n(x.revenue), cogs: n(x.cogs),
      labor: n(x.labor), gross_profit: n(x.gross_profit), net_profit: n(x.net_profit), avg_check: n(x.avg_check),
    })),
    heatmap: (r?.heatmap ?? []).map((x: any) => ({
      weekday: n(x.weekday), hour: n(x.hour), orders: n(x.orders), revenue: n(x.revenue), profit: n(x.profit),
    })),
    by_category: (r?.by_category ?? []).map((x: any) => ({
      weekday: n(x.weekday), category: String(x.category ?? '—'), qty: n(x.qty), revenue: n(x.revenue), profit: n(x.profit),
    })),
  }
}

// ─── Инсайты (кросс-аналитика) ──────────────────────────────────────────────

export type InsightCategory = 'menu' | 'leak' | 'stock' | 'staff'
export type InsightSeverity = 'high' | 'medium' | 'low'

export interface Insight {
  id: string
  category: InsightCategory
  severity: InsightSeverity
  title: string
  detail: string
  impact: number
  impact_label: string
  action: string
  entity_type?: string
  entity_id?: string
}

export interface InsightsReport {
  from?: string
  to?: string
  insights: Insight[]
}

export async function fetchInsights(
  opts: { from?: Date | string; to?: Date | string } = {},
): Promise<InsightsReport> {
  const query = buildQuery(opts)
  const r: any = await unwrap(api.GET('/api/v1/analytics/insights', { params: { query: query as any } }))
  return {
    from: r?.from, to: r?.to,
    insights: (r?.insights ?? []).map((x: any) => ({
      id: String(x.id ?? ''),
      category: (x.category ?? 'menu') as InsightCategory,
      severity: (x.severity ?? 'low') as InsightSeverity,
      title: String(x.title ?? ''),
      detail: String(x.detail ?? ''),
      impact: Number(x.impact ?? 0),
      impact_label: String(x.impact_label ?? ''),
      action: String(x.action ?? ''),
      entity_type: x.entity_type || undefined,
      entity_id: x.entity_id || undefined,
    })),
  }
}

// ─── Динамика (deep analytics) ──────────────────────────────────────────────

export type TrendGranularity = 'day' | 'week' | 'month'

export interface TrendBucket {
  date: string
  revenue: number
  orders_count: number
  avg_check: number
  expenses: number
}

export interface TrendTotals {
  revenue: number
  orders_count: number
  avg_check: number
  expenses: number
}

export interface TrendsReport {
  from?: string
  to?: string
  granularity: TrendGranularity
  buckets: TrendBucket[]
  totals: TrendTotals
  previous: TrendTotals
}

export async function fetchTrends(
  opts: { from?: Date | string; to?: Date | string; granularity?: TrendGranularity } = {},
): Promise<TrendsReport> {
  const query: Record<string, string> = buildQuery(opts)
  if (opts.granularity) query.granularity = opts.granularity
  const r: any = await unwrap(api.GET('/api/v1/analytics/trends', { params: { query: query as any } }))
  const num = (v: any) => Number(v ?? 0)
  const totals = (t: any): TrendTotals => ({
    revenue: num(t?.revenue), orders_count: num(t?.orders_count),
    avg_check: num(t?.avg_check), expenses: num(t?.expenses),
  })
  return {
    from: r?.from, to: r?.to,
    granularity: (r?.granularity ?? 'day') as TrendGranularity,
    buckets: (r?.buckets ?? []).map((b: any) => ({
      date: String(b.date ?? ''), revenue: num(b.revenue), orders_count: num(b.orders_count),
      avg_check: num(b.avg_check), expenses: num(b.expenses),
    })),
    totals: totals(r?.totals), previous: totals(r?.previous),
  }
}

export async function fetchPeakHours(opts: { from?: Date | string; to?: Date | string } = {}): Promise<PeakHoursReport> {
  const query = buildQuery(opts)
  return (await unwrap(api.GET('/api/v1/analytics/peak-hours', { params: { query: query as any } }))) as PeakHoursReport
}

export async function fetchWaitersAnalytics(opts: { from?: Date | string; to?: Date | string } = {}): Promise<WaitersReport> {
  const query = buildQuery(opts)
  return (await unwrap(api.GET('/api/v1/analytics/waiters', { params: { query: query as any } }))) as WaitersReport
}

export async function fetchTablesAnalytics(opts: { from?: Date | string; to?: Date | string } = {}): Promise<TablesAnalyticsReport> {
  const query = buildQuery(opts)
  return (await unwrap(api.GET('/api/v1/analytics/tables', { params: { query: query as any } }))) as TablesAnalyticsReport
}

export async function fetchFoodCost(opts: { from?: Date | string; to?: Date | string } = {}): Promise<FoodCostReport> {
  const query = buildQuery(opts)
  return (await unwrap(api.GET('/api/v1/analytics/food-cost', { params: { query: query as any } }))) as FoodCostReport
}

// --- Sales report (Н21): серверный агрегат вместо клиентского расчёта ---
export interface SalesReportRow {
  date: string
  hour: number
  menu_item_id: string | null
  name: string
  category: string
  is_purchased: boolean
  qty: DecStr
  revenue: DecStr
}
export interface SalesReportDay {
  date: string
  orders: number
  qty: DecStr
  revenue: DecStr
}
export interface SalesReportResult {
  period: { from?: string; to?: string }
  rows: SalesReportRow[]
  by_date: SalesReportDay[]
  totals: { revenue: DecStr; qty: DecStr; orders: number }
}
export async function fetchSalesReport(opts: { from?: Date | string; to?: Date | string } = {}): Promise<SalesReportResult> {
  const query = buildQuery(opts)
  return (await unwrap(api.GET('/api/v1/analytics/sales-report', { params: { query: query as any } }))) as SalesReportResult
}

// --- Ingredient stock value (top-N) ---

export interface IngredientStockRow {
  ingredient_id: string
  name: string
  category: string
  qty: DecStr
  unit: string
  price_per_unit: DecStr
  value: DecStr
  share: DecStr
}

export interface IngredientStockReport {
  total_value: DecStr
  items: IngredientStockRow[]
}

export async function fetchIngredientStockValue(opts: { limit?: number } = {}): Promise<IngredientStockReport> {
  const query: Record<string, string> = {}
  if (opts.limit != null) query.limit = String(opts.limit)
  return (await unwrap(api.GET('/api/v1/analytics/ingredient-stock-value' as any, { params: { query: query as any } }))) as IngredientStockReport
}

// --- Food-cost monthly trend ---

export interface FoodCostMonth {
  month: string // "YYYY-MM"
  revenue: DecStr
  cogs: DecStr
  food_cost_pct: DecStr
  margin_percent: DecStr
  orders: number
}

export interface FoodCostMonthlyReport {
  period: AnalyticsPeriod
  months: FoodCostMonth[]
}

export async function fetchFoodCostMonthly(opts: { from?: Date | string; to?: Date | string } = {}): Promise<FoodCostMonthlyReport> {
  const query = buildQuery(opts)
  return (await unwrap(api.GET('/api/v1/analytics/food-cost/monthly' as any, { params: { query: query as any } }))) as FoodCostMonthlyReport
}

// --- Forecast & break-even ---

export interface ForecastMonth {
  month: string // "YYYY-MM"
  revenue: DecStr
  cogs: DecStr
  gross_profit: DecStr
}

export interface ForecastReport {
  period: AnalyticsPeriod
  monthly_revenue: ForecastMonth[]
  fixed_costs_monthly: DecStr
  avg_gross_margin_pct: DecStr
  breakeven_revenue: DecStr
  forecast_next_month: DecStr
  forecast_next_month_label: string
  historical_months: number
}

export async function fetchForecast(opts: { from?: Date | string; to?: Date | string } = {}): Promise<ForecastReport> {
  const query = buildQuery(opts)
  return (await unwrap(api.GET('/api/v1/analytics/forecast' as any, { params: { query: query as any } }))) as ForecastReport
}

// --- ABC inventory ---

export interface ABCInventoryRow {
  ingredient_id: string
  name: string
  category?: string
  unit?: string
  qty: DecStr
  price_per_unit: DecStr
  stock_value: DecStr
  consumption: DecStr
  turnover: DecStr
  days_of_stock: number
  share: DecStr
  cum_share: DecStr
  class: 'A' | 'B' | 'C'
  recommendation: string
}

export interface ABCInventoryReport {
  period: AnalyticsPeriod
  total_consumption_value: DecStr
  items: ABCInventoryRow[]
}

export async function fetchABCInventory(opts: { from?: Date | string; to?: Date | string } = {}): Promise<ABCInventoryReport> {
  const query = buildQuery(opts)
  return (await unwrap(api.GET('/api/v1/analytics/abc-inventory' as any, { params: { query: query as any } }))) as ABCInventoryReport
}
