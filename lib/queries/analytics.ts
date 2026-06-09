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
