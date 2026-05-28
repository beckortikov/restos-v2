'use client'

import { lazy } from 'react'
import { useState, useEffect, useMemo } from 'react'
import { formatCurrency, calcLineCogs } from '@/lib/helpers'
import { dMul } from '@/lib/decimal'
import { useAuth } from '@/lib/auth-store'
import type { Order, FinancialOperation } from '@/lib/types'
import {
  fetchOrders,
  fetchFinancialOperations,
} from '@/lib/queries'

const RevenueForecastChart = lazy(() => import('@/components/charts/revenue-forecast-chart'))

const PlanVsFactChart = lazy(() => import('@/components/charts/plan-vs-fact-chart'))

const BreakevenChart = lazy(() => import('@/components/charts/breakeven-chart'))

// Categories excluded from fixed costs (same as PnL page)
const EXCLUDED_EXPENSE_CATEGORIES = ['Себестоимость продукции']
const STOCK_PURCHASE_CATEGORIES = ['Закупка продуктов', 'Закупка хозтоваров']

export default function ForecastPage() {
  const { canDo } = useAuth()
  const [orders, setOrders] = useState<Order[]>([])
  const [operations, setOperations] = useState<FinancialOperation[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([fetchOrders(), fetchFinancialOperations()])
      .then(([o, fo]) => {
        setOrders(o)
        setOperations(fo)
      })
      .finally(() => setLoading(false))
  }, [])

  const closedOrders = useMemo(() => orders.filter((o) => o.status === 'done'), [orders])

  // Monthly revenue grouped
  const monthlyRevenue = useMemo(() => {
    const map: Record<string, number> = {}
    closedOrders.forEach((o) => {
      const d = new Date(o.createdAt)
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
      map[key] = (map[key] || 0) + o.total
    })
    return Object.entries(map)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, revenue]) => ({ month, revenue }))
  }, [closedOrders])

  // Fixed costs from real financial operations (same logic as PnL page)
  // Monthly average of operational expenses (excluding COGS and stock purchases)
  const fixedCosts = useMemo(() => {
    const opexOps = operations.filter(
      o => o.type === 'out' && o.activity === 'operational'
        && !EXCLUDED_EXPENSE_CATEGORIES.includes(o.category)
        && !STOCK_PURCHASE_CATEGORIES.includes(o.category)
    )
    if (opexOps.length === 0) return 0
    // Group by month to get average monthly fixed costs
    const byMonth: Record<string, number> = {}
    opexOps.forEach(o => {
      const d = new Date(o.date)
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
      byMonth[key] = (byMonth[key] || 0) + o.amount
    })
    const months = Object.values(byMonth)
    return months.reduce((s, v) => s + v, 0) / months.length
  }, [operations])

  // Average gross margin % from closed orders
  const avgGrossMarginPct = useMemo(() => {
    const totalRevenue = closedOrders.reduce((s, o) => s + o.total, 0)
    const totalCogs = closedOrders.reduce(
      (s, o) => s + o.items.reduce((is, item) => is + calcLineCogs(item.cogs, item.qty, item.unit, item.unitSize), 0),
      0
    )
    return totalRevenue > 0 ? ((totalRevenue - totalCogs) / totalRevenue) * 100 : 0
  }, [closedOrders])

  // Break-even — only calculate when we have both fixed costs and margin data
  const breakeven = useMemo(() => {
    if (fixedCosts <= 0 || avgGrossMarginPct <= 0) return null
    return fixedCosts / (avgGrossMarginPct / 100)
  }, [fixedCosts, avgGrossMarginPct])

  // Last 3 months for linear trend
  const forecastRevenue = useMemo(() => {
    if (monthlyRevenue.length < 2) return 0
    const last3 = monthlyRevenue.slice(-3)
    if (last3.length < 2) return last3[0]?.revenue ?? 0
    const n = last3.length
    const sumX = last3.reduce((s, _, i) => s + i, 0)
    const sumY = last3.reduce((s, m) => s + m.revenue, 0)
    const sumXY = last3.reduce((s, m, i) => s + i * m.revenue, 0)
    const sumX2 = last3.reduce((s, _, i) => s + i * i, 0)
    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX || 1)
    const intercept = (sumY - slope * sumX) / n
    return Math.max(0, slope * n + intercept)
  }, [monthlyRevenue])

  // Current safety margin
  const currentRevenue = useMemo(
    () => (monthlyRevenue.length > 0 ? monthlyRevenue[monthlyRevenue.length - 1].revenue : 0),
    [monthlyRevenue]
  )

  const safetyMarginPct = useMemo(
    () => (breakeven !== null && currentRevenue > 0 ? ((currentRevenue - breakeven) / currentRevenue) * 100 : null),
    [currentRevenue, breakeven]
  )

  // Days to breakeven (in current month)
  const avgDailyRevenue = useMemo(() => {
    const now = new Date()
    const dayOfMonth = now.getDate()
    return dayOfMonth > 0 ? currentRevenue / dayOfMonth : 0
  }, [currentRevenue])

  const daysToBreakeven = useMemo(
    () => (breakeven !== null && avgDailyRevenue > 0 ? Math.ceil(breakeven / avgDailyRevenue) : null),
    [breakeven, avgDailyRevenue]
  )

  // Revenue forecast chart data
  const forecastChartData = useMemo(() => {
    const last6 = monthlyRevenue.slice(-6)
    const actual: { month: string; actual: number | undefined; forecast: number | undefined }[] = last6.map((m) => ({
      month: m.month,
      actual: m.revenue,
      forecast: undefined,
    }))

    if (last6.length > 0) {
      const lastMonth = last6[last6.length - 1].month
      const [y, m] = lastMonth.split('-').map(Number)
      for (let i = 1; i <= 2; i++) {
        const nm = m + i
        const ny = y + Math.floor((nm - 1) / 12)
        const month = `${ny}-${String(((nm - 1) % 12) + 1).padStart(2, '0')}`
        actual.push({ month, actual: undefined, forecast: forecastRevenue })
      }
    }

    return actual
  }, [monthlyRevenue, forecastRevenue])

  // Plan vs Fact chart data
  const planVsFactData = useMemo(() => {
    const inOps = operations.filter((o) => o.type === 'in')
    const monthlyPlan: Record<string, number> = {}
    inOps.forEach((o) => {
      const d = new Date(o.date)
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
      monthlyPlan[key] = (monthlyPlan[key] || 0) + o.amount
    })

    return monthlyRevenue.slice(-6).map((m) => ({
      month: m.month,
      plan: monthlyPlan[m.month] || 0,
      fact: m.revenue,
    }))
  }, [monthlyRevenue, operations])

  // Break-even chart data
  const breakevenChartData = useMemo(() => {
    const avgCogsPct = 100 - avgGrossMarginPct
    return monthlyRevenue.slice(-6).map((m) => ({
      month: m.month,
      fixed: fixedCosts,
      variable: m.revenue * (avgCogsPct / 100),
      revenue: m.revenue,
    }))
  }, [monthlyRevenue, fixedCosts, avgGrossMarginPct])

  // Margin trend for recommendations
  const marginTrend = useMemo(() => {
    if (monthlyRevenue.length < 2) return null
    const months = monthlyRevenue.slice(-3)
    const margins = months.map((m) => {
      const monthOrders = closedOrders.filter((o) => {
        const d = new Date(o.createdAt)
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` === m.month
      })
      const rev = monthOrders.reduce((s, o) => s + o.total, 0)
      const cogs = monthOrders.reduce(
        (s, o) => s + o.items.reduce((is, item) => is + calcLineCogs(item.cogs, item.qty, item.unit, item.unitSize), 0),
        0
      )
      return rev > 0 ? ((rev - cogs) / rev) * 100 : 0
    })
    if (margins.length >= 2) {
      return { first: margins[0], last: margins[margins.length - 1] }
    }
    return null
  }, [monthlyRevenue, closedOrders])

  // Recommendations
  const recommendations = useMemo(() => {
    const recs: { emoji: string; text: string; type: 'danger' | 'success' | 'warning' }[] = []

    if (marginTrend && marginTrend.last < marginTrend.first - 2) {
      recs.push({
        emoji: '⚠️',
        text: `Маржа снижается: ${marginTrend.first.toFixed(1)}% → ${marginTrend.last.toFixed(1)}%. Проверьте закупочные цены`,
        type: 'warning',
      })
    }

    if (safetyMarginPct !== null && safetyMarginPct > 0) {
      recs.push({
        emoji: '✅',
        text: `Запас прочности ${safetyMarginPct.toFixed(1)}% — бизнес прибыльный`,
        type: 'success',
      })
    } else if (breakeven !== null && currentRevenue > 0) {
      recs.push({
        emoji: '🔴',
        text: `Выручка ниже точки безубыточности на ${formatCurrency(breakeven - currentRevenue)}`,
        type: 'danger',
      })
    }

    return recs
  }, [marginTrend, safetyMarginPct, currentRevenue, breakeven])

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
      <div>
        <h1 className="text-xl font-bold text-foreground">Прогноз и безубыточность</h1>
        <p className="text-muted-foreground text-sm mt-0.5">Проекции и анализ точки безубыточности</p>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-card rounded-xl border border-border p-5">
          <p className="text-xs text-muted-foreground font-medium">Прогноз выручки (след. месяц)</p>
          <p className="text-2xl font-bold text-foreground mt-1">{formatCurrency(forecastRevenue)}</p>
        </div>
        <div className="bg-card rounded-xl border border-border p-5">
          <p className="text-xs text-muted-foreground font-medium">Точка безубыточности</p>
          <p className="text-2xl font-bold text-foreground mt-1">{breakeven !== null ? formatCurrency(breakeven) : '—'}</p>
        </div>
        <div className="bg-card rounded-xl border border-border p-5">
          <p className="text-xs text-muted-foreground font-medium">Запас прочности</p>
          <p
            className={`text-2xl font-bold mt-1 ${
              safetyMarginPct === null ? 'text-muted-foreground' : safetyMarginPct >= 0 ? 'text-emerald-600' : 'text-destructive'
            }`}
          >
            {safetyMarginPct !== null ? `${safetyMarginPct.toFixed(1)}%` : '—'}
          </p>
        </div>
        <div className="bg-card rounded-xl border border-border p-5">
          <p className="text-xs text-muted-foreground font-medium">Дней до безубыточности</p>
          <p className="text-2xl font-bold text-foreground mt-1">{daysToBreakeven !== null ? daysToBreakeven : '—'}</p>
        </div>
      </div>

      {/* Revenue trend + forecast */}
      <div className="bg-card rounded-xl border border-border p-5">
        <h2 className="text-sm font-semibold text-foreground mb-4">
          Тренд выручки + прогноз
        </h2>
        <RevenueForecastChart data={forecastChartData} />
      </div>

      {/* Plan vs Fact */}
      <div className="bg-card rounded-xl border border-border p-5">
        <h2 className="text-sm font-semibold text-foreground mb-4">План vs Факт</h2>
        <PlanVsFactChart data={planVsFactData} />
      </div>

      {/* Break-even structure */}
      <div className="bg-card rounded-xl border border-border p-5">
        <h2 className="text-sm font-semibold text-foreground mb-4">
          Структура расходов и точка безубыточности
        </h2>
        {fixedCosts > 0 && (
          <div className="flex gap-4 mb-3 text-xs text-muted-foreground">
            <span>Ср. постоянные расходы/мес: {formatCurrency(fixedCosts)}</span>
          </div>
        )}
        <BreakevenChart data={breakevenChartData} breakevenLine={breakeven ?? 0} />
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
