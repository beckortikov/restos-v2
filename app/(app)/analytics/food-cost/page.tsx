'use client'

import { lazy, useState, useEffect, useMemo } from 'react'
import { formatCurrency } from '@/lib/helpers'
import { useAuth } from '@/lib/auth-store'
import { Download } from 'lucide-react'
import { exportToExcel } from '@/lib/export-excel'
import { fetchFoodCost, fetchIngredientStockValue, fetchFoodCostMonthly, type FoodCostReport, type IngredientStockReport, type FoodCostMonthlyReport } from '@/lib/queries/analytics'
import { toast } from 'sonner'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip, ResponsiveContainer, LineChart, Line, Legend } from 'recharts'

const FoodCostBarChart = lazy(() => import('@/components/charts/food-cost-bar-chart'))

type Period = 'month' | 'quarter' | 'all'

function periodToRange(period: Period): { from?: string; to?: string } {
  if (period === 'all') return {}
  const now = new Date()
  const from = new Date()
  if (period === 'month') from.setMonth(now.getMonth() - 1)
  else from.setMonth(now.getMonth() - 3)
  return { from: from.toISOString(), to: now.toISOString() }
}

interface DishRow {
  id: string
  name: string
  qty: number
  revenue: number
  cogs: number
  foodCostPct: number
  marginPct: number
  grossProfit: number
}

export default function FoodCostPage() {
  const { canDo } = useAuth()
  const [report, setReport] = useState<FoodCostReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [period, setPeriod] = useState<Period>('all')
  const [stockReport, setStockReport] = useState<IngredientStockReport | null>(null)
  const [monthlyReport, setMonthlyReport] = useState<FoodCostMonthlyReport | null>(null)

  useEffect(() => {
    setLoading(true)
    const { from, to } = periodToRange(period)
    fetchFoodCost({ from, to })
      .then(setReport)
      .catch(() => toast.error('Ошибка загрузки данных'))
      .finally(() => setLoading(false))
    fetchFoodCostMonthly({ from, to })
      .then(setMonthlyReport)
      .catch(() => { /* trend chart is optional */ })
  }, [period])

  useEffect(() => {
    fetchIngredientStockValue({ limit: 10 })
      .then(setStockReport)
      .catch(() => { /* stock chart is optional */ })
  }, [])

  const rows: DishRow[] = useMemo(() => {
    if (!report) return []
    return report.rows.map(r => ({
      id: r.menu_item_id,
      name: r.name,
      qty: Number(r.qty),
      revenue: Number(r.revenue),
      cogs: Number(r.cogs),
      foodCostPct: Number(r.food_cost_pct),
      marginPct: Number(r.margin_percent),
      grossProfit: Number(r.gross_profit),
    }))
  }, [report])

  const kpis = useMemo(() => {
    if (!report) return null
    const avgFoodCostPct = Number(report.food_cost_pct)
    const totalCogs = Number(report.total_cogs)
    const mostExpensive = rows.reduce((max, r) => (r.cogs > max.cogs ? r : max), rows[0] || { name: '—', cogs: 0 })
    const worstMargin = rows.length > 0
      ? rows.reduce((worst, r) => (r.marginPct < worst.marginPct ? r : worst), rows[0])
      : { name: '—', marginPct: 0 }
    return { avgFoodCostPct, totalCogs, mostExpensive, worstMargin }
  }, [report, rows])

  // Food cost per dish bar chart (rows already sorted worst-first by server)
  const foodCostByDish = useMemo(() => {
    return rows.map(r => ({
      name: r.name.length > 20 ? r.name.slice(0, 18) + '...' : r.name,
      foodCostPct: r.foodCostPct,
      price: r.qty > 0 ? r.revenue / r.qty : 0,
      cogs: r.qty > 0 ? r.cogs / r.qty : 0,
    }))
  }, [rows])

  // Recommendations (rules apply on per-dish food cost from server)
  const recommendations = useMemo(() => {
    const recs: { emoji: string; text: string; type: 'danger' | 'success' | 'warning' }[] = []
    for (const r of rows) {
      if (r.foodCostPct > 40) {
        recs.push({
          emoji: '🔴',
          text: `${r.name} — food cost ${r.foodCostPct.toFixed(1)}%. Пересмотрите рецептуру или поставщика`,
          type: 'danger',
        })
      } else if (r.foodCostPct > 0 && r.foodCostPct < 15) {
        recs.push({
          emoji: '💰',
          text: `${r.name} — высокая маржа ${r.marginPct.toFixed(1)}%. Можно использовать для акций`,
          type: 'success',
        })
      }
    }
    return recs
  }, [rows])

  if (!canDo('analytics.view')) {
    return (
      <div className="p-6 flex items-center justify-center h-64">
        <p className="text-muted-foreground">Нет доступа</p>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="p-6 flex items-center justify-center h-64">
        <div className="size-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" />
      </div>
    )
  }

  return (
    <div className="p-4 md:p-6 space-y-4 md:space-y-5">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-foreground">Анализ себестоимости</h1>
          <p className="text-muted-foreground text-sm mt-0.5">Food cost и расходы на ингредиенты</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              exportToExcel(
                rows.map(r => ({ ...r })),
                [
                  { key: 'name', header: 'Блюдо' },
                  { key: 'qty', header: 'Продано' },
                  { key: 'revenue', header: 'Выручка' },
                  { key: 'cogs', header: 'Себестоимость' },
                  { key: 'foodCostPct', header: 'Food Cost %', format: (v) => Number(Number(v).toFixed(1)) },
                  { key: 'marginPct', header: 'Маржа %', format: (v) => Number(Number(v).toFixed(1)) },
                ],
                'Себестоимость'
              )
            }}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium border border-border rounded-lg hover:bg-muted transition-colors"
          >
            <Download className="size-3.5" />
            Excel
          </button>
          <div className="flex gap-1 bg-muted/50 p-1 rounded-lg">
            {([['month', 'Месяц'], ['quarter', 'Квартал'], ['all', 'Все время']] as [Period, string][]).map(
              ([key, label]) => (
                <button
                  key={key}
                  onClick={() => setPeriod(key)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                    period === key
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {label}
                </button>
              )
            )}
          </div>
        </div>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-card rounded-xl border border-border p-5">
          <p className="text-xs text-muted-foreground font-medium">Средний Food Cost %</p>
          <p className={`text-2xl font-bold mt-1 ${(kpis?.avgFoodCostPct || 0) > 40 ? 'text-destructive' : (kpis?.avgFoodCostPct || 0) > 30 ? 'text-amber-600' : 'text-emerald-600'}`}>
            {(kpis?.avgFoodCostPct || 0).toFixed(1)}%
          </p>
        </div>
        <div className="bg-card rounded-xl border border-border p-5">
          <p className="text-xs text-muted-foreground font-medium">Общая себестоимость</p>
          <p className="text-2xl font-bold text-foreground mt-1">{formatCurrency(kpis?.totalCogs || 0)}</p>
        </div>
        <div className="bg-card rounded-xl border border-border p-5">
          <p className="text-xs text-muted-foreground font-medium">Самое дорогое блюдо</p>
          <p className="text-lg font-bold text-foreground mt-1">{kpis?.mostExpensive.name ?? '—'}</p>
          <p className="text-xs text-muted-foreground">{formatCurrency(kpis?.mostExpensive.cogs ?? 0)} COGS</p>
        </div>
        <div className="bg-card rounded-xl border border-border p-5">
          <p className="text-xs text-muted-foreground font-medium">Блюдо с худшей маржой</p>
          <p className="text-lg font-bold text-foreground mt-1">{kpis?.worstMargin.name ?? '—'}</p>
          <p className="text-xs text-muted-foreground">Маржа: {(kpis?.worstMargin.marginPct ?? 0).toFixed(1)}%</p>
        </div>
      </div>

      {/* Top-10 ingredient stock value */}
      {stockReport && stockReport.items.length > 0 && (
        <div className="bg-card rounded-xl border border-border p-5">
          <h2 className="text-sm font-semibold text-foreground mb-1">Топ-10 ингредиентов по стоимости остатка</h2>
          <p className="text-xs text-muted-foreground mb-4">Всего на складе: {formatCurrency(Number(stockReport.total_value))}</p>
          <div style={{ width: '100%', height: Math.max(280, stockReport.items.length * 32) }}>
            <ResponsiveContainer>
              <BarChart
                data={stockReport.items.map(it => ({
                  name: it.name,
                  value: Number(it.value),
                  share: Number(it.share),
                }))}
                layout="vertical"
                margin={{ top: 10, right: 60, left: 10, bottom: 10 }}
              >
                <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 11 }} />
                <YAxis type="category" dataKey="name" width={140} tick={{ fontSize: 11 }} />
                <RTooltip
                  formatter={(v: any, _n, p: any) => [
                    `${formatCurrency(Number(v))} (${p.payload.share.toFixed(1)}% от склада)`,
                    'Стоимость',
                  ]}
                />
                <Bar dataKey="value" fill="#8b5cf6" radius={[0, 4, 4, 0]} label={{ position: 'right', formatter: (v: any) => `${(v / 1000).toFixed(0)}к`, fontSize: 11 }} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Food-cost monthly trend */}
      {monthlyReport && monthlyReport.months.length > 0 && (
        <div className="bg-card rounded-xl border border-border p-5">
          <h2 className="text-sm font-semibold text-foreground mb-1">Динамика Food Cost % по месяцам</h2>
          <p className="text-xs text-muted-foreground mb-4">Food Cost % и маржа по месяцам</p>
          <div style={{ width: '100%', height: 280 }}>
            <ResponsiveContainer>
              <LineChart
                data={monthlyReport.months.map(m => ({
                  month: m.month,
                  foodCostPct: Number(m.food_cost_pct),
                  marginPct: Number(m.margin_percent),
                }))}
                margin={{ top: 10, right: 20, left: 0, bottom: 10 }}
              >
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `${v}%`} />
                <RTooltip formatter={(v: any) => `${Number(v).toFixed(1)}%`} />
                <Legend />
                <Line type="monotone" dataKey="foodCostPct" name="Food Cost %" stroke="#ef4444" strokeWidth={2} />
                <Line type="monotone" dataKey="marginPct" name="Маржа %" stroke="#10b981" strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Food cost by dish */}
      {foodCostByDish.length > 0 && (
        <div className="bg-card rounded-xl border border-border p-5">
          <h2 className="text-sm font-semibold text-foreground mb-4">Food Cost по блюдам (%)</h2>
          <FoodCostBarChart data={foodCostByDish} />
        </div>
      )}

      {/* Table: rows already sorted worst-first by server */}
      <div className="bg-card rounded-xl border border-border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[700px]">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                {['Блюдо', 'Продано', 'Выручка', 'Себестоимость', 'Food Cost %', 'Маржа %'].map((h) => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wide">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const fc = r.foodCostPct
                const fcColor = fc > 40 ? 'text-destructive' : fc >= 30 ? 'text-amber-600' : 'text-emerald-600'
                return (
                  <tr key={r.id} className="border-b border-border last:border-0 hover:bg-muted/30 transition-colors">
                    <td className="px-4 py-3 font-medium text-foreground">{r.name}</td>
                    <td className="px-4 py-3 text-foreground">{r.qty}</td>
                    <td className="px-4 py-3 text-foreground">{formatCurrency(r.revenue)}</td>
                    <td className="px-4 py-3 text-foreground">{formatCurrency(r.cogs)}</td>
                    <td className={`px-4 py-3 font-semibold ${fcColor}`}>{fc.toFixed(1)}%</td>
                    <td className="px-4 py-3 text-foreground">{r.marginPct.toFixed(1)}%</td>
                  </tr>
                )
              })}
              {rows.length === 0 && (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">Нет данных за выбранный период</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Recommendations */}
      {recommendations.length > 0 && (
        <div className="bg-card rounded-xl border border-border p-5">
          <h2 className="text-sm font-semibold text-foreground mb-4">Рекомендации</h2>
          <div className="space-y-2">
            {recommendations.map((rec, i) => (
              <div
                key={i}
                className={`px-4 py-3 rounded-lg text-sm ${
                  rec.type === 'danger'
                    ? 'bg-destructive/10 text-destructive'
                    : rec.type === 'success'
                      ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-400'
                      : 'bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-400'
                }`}
              >
                {rec.emoji} {rec.text}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
