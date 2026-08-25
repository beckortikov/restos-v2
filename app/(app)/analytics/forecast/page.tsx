'use client'

import { lazy, Suspense, useState, useEffect, useMemo } from 'react'
import { formatCurrency } from '@/lib/helpers'
import { useAuth } from '@/lib/auth-store'
import { toast } from 'sonner'
import { fetchForecast, fetchNetworkForecast, type ForecastReport } from '@/lib/queries/analytics'
import { DatePeriodFilter, getDateRange, type PeriodKey } from '@/components/date-period-filter'
import { useBranchView } from '@/hooks/use-branch-view'

const RevenueForecastChart = lazy(() => import('@/components/charts/revenue-forecast-chart'))
const PlanVsFactChart = lazy(() => import('@/components/charts/plan-vs-fact-chart'))
const BreakevenChart = lazy(() => import('@/components/charts/breakeven-chart'))

export default function ForecastPage() {
  const { canDo, restaurant } = useAuth()
  const isBranchView = useBranchView()
  const isCentral = restaurant?.kind === 'central_warehouse' && !isBranchView
  const [report, setReport] = useState<ForecastReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [period, setPeriod] = useState<PeriodKey>('all')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')

  useEffect(() => {
    setLoading(true)
    const { from, to } = getDateRange(period, customFrom, customTo)
    const fetcher = isCentral ? fetchNetworkForecast : fetchForecast
    fetcher({ from: from ?? undefined, to: to ?? undefined })
      .then(setReport)
      .catch(() => toast.error('Ошибка загрузки прогноза'))
      .finally(() => setLoading(false))
  }, [period, customFrom, customTo, isCentral])

  const monthly = useMemo(() => {
    if (!report) return [] as { month: string; revenue: number; cogs: number; gross_profit: number }[]
    return report.monthly_revenue.map(m => ({
      month: m.month,
      revenue: Number(m.revenue),
      cogs: Number(m.cogs),
      gross_profit: Number(m.gross_profit),
    }))
  }, [report])

  const fixedCosts = report ? Number(report.fixed_costs_monthly) : 0
  const avgGrossMarginPct = report ? Number(report.avg_gross_margin_pct) : 0
  const breakeven = report && Number(report.breakeven_revenue) > 0 ? Number(report.breakeven_revenue) : null
  const forecastRevenue = report ? Number(report.forecast_next_month) : 0
  const forecastLabel = report?.forecast_next_month_label ?? ''
  const historicalMonths = report?.historical_months ?? 0

  // Last 6 months actuals + forecast tail
  const forecastChartData = useMemo(() => {
    const last6 = monthly.slice(-6)
    const data: { month: string; actual?: number; forecast?: number }[] = last6.map(m => ({
      month: m.month,
      actual: m.revenue,
    }))
    if (forecastLabel && forecastRevenue > 0) {
      data.push({ month: forecastLabel, forecast: forecastRevenue })
    }
    return data
  }, [monthly, forecastLabel, forecastRevenue])

  // Plan vs Fact — server doesn't carry plan; fall back to using last month's revenue as plan baseline
  // To keep the chart meaningful without backend support, show fact only with plan = previous-month fact.
  const planVsFactData = useMemo(() => {
    const last6 = monthly.slice(-6)
    return last6.map((m, i) => ({
      month: m.month,
      plan: i > 0 ? last6[i - 1].revenue : m.revenue,
      fact: m.revenue,
    }))
  }, [monthly])

  // Break-even chart
  const breakevenChartData = useMemo(() => {
    const avgCogsPct = Math.max(0, 100 - avgGrossMarginPct)
    return monthly.slice(-6).map(m => ({
      month: m.month,
      fixed: fixedCosts,
      variable: m.revenue * (avgCogsPct / 100),
      revenue: m.revenue,
    }))
  }, [monthly, fixedCosts, avgGrossMarginPct])

  const currentRevenue = monthly.length > 0 ? monthly[monthly.length - 1].revenue : 0
  const safetyMarginPct = breakeven !== null && currentRevenue > 0
    ? ((currentRevenue - breakeven) / currentRevenue) * 100
    : null

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

  const insufficientData = historicalMonths < 2

  return (
    <div className="p-4 md:p-6 space-y-4 md:space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-foreground">Прогноз и безубыточность</h1>
          <p className="text-muted-foreground text-sm mt-0.5">
            {isCentral ? 'Проекции и анализ точки безубыточности по всей сети' : 'Проекции и анализ точки безубыточности'}
          </p>
        </div>
        <DatePeriodFilter
          period={period}
          onPeriodChange={setPeriod}
          customFrom={customFrom}
          customTo={customTo}
          onCustomFromChange={setCustomFrom}
          onCustomToChange={setCustomTo}
        />
      </div>

      {insufficientData ? (
        <div className="bg-card rounded-xl border border-border p-8 text-center">
          <p className="text-muted-foreground text-sm">
            Недостаточно данных для прогноза. Нужно минимум 2 месяца истории.
          </p>
        </div>
      ) : (
        <>
          {/* KPI cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-card rounded-xl border border-border p-5">
              <p className="text-xs text-muted-foreground font-medium">Прогноз выручки {forecastLabel && `(${forecastLabel})`}</p>
              <p className="text-2xl font-bold text-foreground mt-1">{formatCurrency(forecastRevenue)}</p>
            </div>
            <div className="bg-card rounded-xl border border-border p-5">
              <p className="text-xs text-muted-foreground font-medium">Точка безубыточности</p>
              <p className="text-2xl font-bold text-foreground mt-1">
                {breakeven !== null ? formatCurrency(breakeven) : '—'}
              </p>
            </div>
            <div className="bg-card rounded-xl border border-border p-5">
              <p className="text-xs text-muted-foreground font-medium">Средняя маржа</p>
              <p className="text-2xl font-bold text-foreground mt-1">{avgGrossMarginPct.toFixed(1)}%</p>
            </div>
            <div className="bg-card rounded-xl border border-border p-5">
              <p className="text-xs text-muted-foreground font-medium">Постоянные расходы/мес</p>
              <p className="text-2xl font-bold text-foreground mt-1">{formatCurrency(fixedCosts)}</p>
            </div>
          </div>

          {/* Revenue trend + forecast */}
          <div className="bg-card rounded-xl border border-border p-5">
            <h2 className="text-sm font-semibold text-foreground mb-4">Тренд выручки + прогноз</h2>
            <Suspense fallback={null}>
              <RevenueForecastChart data={forecastChartData} />
            </Suspense>
          </div>

          {/* Plan vs Fact */}
          <div className="bg-card rounded-xl border border-border p-5">
            <h2 className="text-sm font-semibold text-foreground mb-4">План vs Факт</h2>
            <p className="text-xs text-muted-foreground mb-3">
              План = выручка предыдущего месяца
            </p>
            <Suspense fallback={null}>
              <PlanVsFactChart data={planVsFactData} />
            </Suspense>
          </div>

          {/* Break-even structure */}
          <div className="bg-card rounded-xl border border-border p-5">
            <h2 className="text-sm font-semibold text-foreground mb-4">
              Структура расходов и точка безубыточности
            </h2>
            {safetyMarginPct !== null && (
              <div className="flex flex-wrap gap-4 mb-3 text-xs text-muted-foreground">
                <span>Текущая выручка: {formatCurrency(currentRevenue)}</span>
                <span className={safetyMarginPct >= 0 ? 'text-emerald-600' : 'text-destructive'}>
                  Запас прочности: {safetyMarginPct.toFixed(1)}%
                </span>
              </div>
            )}
            <Suspense fallback={null}>
              <BreakevenChart data={breakevenChartData} breakevenLine={breakeven ?? 0} />
            </Suspense>
          </div>
        </>
      )}
    </div>
  )
}
