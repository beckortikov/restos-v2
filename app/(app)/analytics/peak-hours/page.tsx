'use client'

import { useState, useEffect, useMemo } from 'react'
import { lazy, Suspense } from 'react'
import { formatCurrency } from '@/lib/helpers'
import { fetchOrders } from '@/lib/queries'
import { useAuth } from '@/lib/auth-store'
import type { Order } from '@/lib/types'

import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts'

function RechartsBarChart({ data }: { data: { hour: string; revenue: number; intensity: number }[] }) {
  const maxRevenue = Math.max(...data.map(d => d.revenue), 1)
  return (
    <ResponsiveContainer width="100%" height={300}>
      <BarChart data={data} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
        <XAxis dataKey="hour" tick={{ fontSize: 12 }} className="fill-muted-foreground" />
        <YAxis tick={{ fontSize: 12 }} className="fill-muted-foreground" tickFormatter={(v: number) => `${(v / 1000).toFixed(0)}k`} />
        <Tooltip formatter={(value: number) => [formatCurrency(value), 'Выручка']} />
        <Bar dataKey="revenue" radius={[4, 4, 0, 0]}>
          {data.map((entry, index) => {
            const ratio = entry.revenue / maxRevenue
            const lightness = 80 - ratio * 45
            return <Cell key={index} fill={`hsl(25, 90%, ${lightness}%)`} />
          })}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

function RechartsWeekdayChart({ data }: { data: { day: string; revenue: number }[] }) {
  return (
    <ResponsiveContainer width="100%" height={300}>
      <BarChart data={data} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
        <XAxis dataKey="day" tick={{ fontSize: 12 }} className="fill-muted-foreground" />
        <YAxis tick={{ fontSize: 12 }} className="fill-muted-foreground" tickFormatter={(v: number) => `${(v / 1000).toFixed(0)}k`} />
        <Tooltip formatter={(value: number) => [formatCurrency(value), 'Выручка']} />
        <Bar dataKey="revenue" fill="hsl(25, 85%, 55%)" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  )
}

const DAY_NAMES = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб']
const DAY_NAMES_ORDERED = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']
const HOURS_RANGE = Array.from({ length: 16 }, (_, i) => i + 8) // 8-23

type Period = 'week' | 'month' | 'all'

function filterOrdersByPeriod(orders: Order[], period: Period): Order[] {
  if (period === 'all') return orders
  const now = new Date()
  const cutoff = new Date()
  if (period === 'week') cutoff.setDate(now.getDate() - 7)
  else cutoff.setMonth(now.getMonth() - 1)
  return orders.filter(o => new Date(o.createdAt) >= cutoff)
}

function getHeatColor(value: number, max: number): string {
  if (max === 0 || value === 0) return 'bg-muted/20'
  const ratio = value / max
  if (ratio < 0.25) return 'bg-orange-100 dark:bg-orange-950/40'
  if (ratio < 0.5) return 'bg-orange-200 dark:bg-orange-900/50'
  if (ratio < 0.75) return 'bg-orange-400 dark:bg-orange-700/60'
  return 'bg-red-500 dark:bg-red-700 text-white'
}

export default function PeakHoursPage() {
  const { canDo } = useAuth()
  const [orders, setOrders] = useState<Order[]>([])
  const [loading, setLoading] = useState(true)
  const [period, setPeriod] = useState<Period>('all')

  useEffect(() => {
    fetchOrders()
      .then(setOrders)
      .finally(() => setLoading(false))
  }, [])

  const filtered = useMemo(() => filterOrdersByPeriod(orders, period), [orders, period])

  // Hourly revenue data
  const hourlyData = useMemo(() => {
    const map: Record<number, number> = {}
    HOURS_RANGE.forEach(h => { map[h] = 0 })
    filtered.forEach(o => {
      const hour = new Date(o.createdAt).getHours()
      if (map[hour] !== undefined) map[hour] += o.total
    })
    const maxRev = Math.max(...Object.values(map), 1)
    return HOURS_RANGE.map(h => ({
      hour: `${h}:00`,
      revenue: map[h],
      intensity: map[h] / maxRev,
    }))
  }, [filtered])

  // Weekday revenue data
  const weekdayData = useMemo(() => {
    // JS getDay: 0=Sun, we want Mon first
    const map: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 0: 0 }
    filtered.forEach(o => {
      const day = new Date(o.createdAt).getDay()
      map[day] += o.total
    })
    const ordered = [1, 2, 3, 4, 5, 6, 0]
    return ordered.map((d, i) => ({
      day: DAY_NAMES_ORDERED[i],
      revenue: map[d],
    }))
  }, [filtered])

  // Heatmap data: hours x days
  const heatmapData = useMemo(() => {
    const grid: Record<string, number> = {}
    const hours = Array.from({ length: 15 }, (_, i) => i + 8) // 8-22
    const dayIndices = [1, 2, 3, 4, 5, 6, 0]
    hours.forEach(h => dayIndices.forEach(d => { grid[`${h}-${d}`] = 0 }))
    filtered.forEach(o => {
      const date = new Date(o.createdAt)
      const h = date.getHours()
      const d = date.getDay()
      const key = `${h}-${d}`
      if (grid[key] !== undefined) grid[key] += 1
    })
    const maxVal = Math.max(...Object.values(grid), 1)
    return { grid, hours, dayIndices, maxVal }
  }, [filtered])

  // KPIs
  const kpis = useMemo(() => {
    if (filtered.length === 0) return null
    // Revenue per hour
    const hourRevMap: Record<number, number> = {}
    const hourCountMap: Record<number, number> = {}
    filtered.forEach(o => {
      const h = new Date(o.createdAt).getHours()
      hourRevMap[h] = (hourRevMap[h] || 0) + o.total
      hourCountMap[h] = (hourCountMap[h] || 0) + 1
    })
    const peakHourEntry = Object.entries(hourRevMap).sort(([, a], [, b]) => b - a)[0]
    const peakHour = peakHourEntry ? Number(peakHourEntry[0]) : 0
    const peakHourRevenue = peakHourEntry ? peakHourEntry[1] : 0

    // Busiest day
    const dayRevMap: Record<number, number> = {}
    filtered.forEach(o => {
      const d = new Date(o.createdAt).getDay()
      dayRevMap[d] = (dayRevMap[d] || 0) + o.total
    })
    const busiestDayEntry = Object.entries(dayRevMap).sort(([, a], [, b]) => b - a)[0]
    const busiestDay = busiestDayEntry ? DAY_NAMES[Number(busiestDayEntry[0])] : '-'

    // Average orders per hour
    const totalOrders = filtered.length
    const uniqueHours = new Set(filtered.map(o => {
      const d = new Date(o.createdAt)
      return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}-${d.getHours()}`
    })).size
    const avgOrdersPerHour = uniqueHours > 0 ? totalOrders / uniqueHours : 0

    return {
      peakHour: `${peakHour}:00`,
      busiestDay,
      avgOrdersPerHour: avgOrdersPerHour.toFixed(1),
      peakHourRevenue,
    }
  }, [filtered])

  // Shift recommendations
  const shiftRecs = useMemo(() => {
    const hourRevMap: Record<number, number> = {}
    HOURS_RANGE.forEach(h => { hourRevMap[h] = 0 })
    filtered.forEach(o => {
      const h = new Date(o.createdAt).getHours()
      if (hourRevMap[h] !== undefined) hourRevMap[h] += o.total
    })
    const maxRev = Math.max(...Object.values(hourRevMap), 1)
    const peak: string[] = []
    const medium: string[] = []
    const quiet: string[] = []
    HOURS_RANGE.forEach(h => {
      const ratio = hourRevMap[h] / maxRev
      if (ratio >= 0.6) peak.push(`${h}:00`)
      else if (ratio >= 0.25) medium.push(`${h}:00`)
      else quiet.push(`${h}:00`)
    })
    return { peak, medium, quiet }
  }, [filtered])

  if (!canDo('analytics.view')) {
    return <div className="p-6 text-center text-muted-foreground">Нет доступа</div>
  }

  if (loading) return <div className="p-6 flex items-center justify-center h-64"><div className="size-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" /></div>

  return (
    <div className="p-4 md:p-6 space-y-4 md:space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-foreground">Пиковые часы</h1>
          <p className="text-muted-foreground text-sm mt-0.5">Анализ загрузки ресторана по времени</p>
        </div>
        <div className="flex gap-1 bg-muted rounded-lg p-1">
          {([['week', 'Неделя'], ['month', 'Месяц'], ['all', 'Все время']] as const).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setPeriod(key)}
              className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                period === key
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* KPI Cards */}
      {kpis && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="bg-card rounded-xl border border-border p-5">
            <p className="text-xs text-muted-foreground mb-1">Пиковый час</p>
            <p className="text-2xl font-bold text-foreground">{kpis.peakHour}</p>
          </div>
          <div className="bg-card rounded-xl border border-border p-5">
            <p className="text-xs text-muted-foreground mb-1">Самый загруженный день</p>
            <p className="text-2xl font-bold text-foreground">{kpis.busiestDay}</p>
          </div>
          <div className="bg-card rounded-xl border border-border p-5">
            <p className="text-xs text-muted-foreground mb-1">Среднее заказов в час</p>
            <p className="text-2xl font-bold text-foreground">{kpis.avgOrdersPerHour}</p>
          </div>
          <div className="bg-card rounded-xl border border-border p-5">
            <p className="text-xs text-muted-foreground mb-1">Пиковая выручка в час</p>
            <p className="text-2xl font-bold text-foreground">{formatCurrency(kpis.peakHourRevenue)}</p>
          </div>
        </div>
      )}

      {/* Hourly Revenue Chart */}
      <div className="bg-card rounded-xl border border-border p-5">
        <h2 className="text-sm font-semibold text-foreground mb-1">Выручка по часам дня</h2>
        <p className="text-xs text-muted-foreground mb-4">Суммарная выручка за каждый час работы</p>
        <RechartsBarChart data={hourlyData} />
      </div>

      {/* Weekday Revenue Chart */}
      <div className="bg-card rounded-xl border border-border p-5">
        <h2 className="text-sm font-semibold text-foreground mb-1">Выручка по дням недели</h2>
        <p className="text-xs text-muted-foreground mb-4">Распределение выручки по дням</p>
        <RechartsWeekdayChart data={weekdayData} />
      </div>

      {/* Heatmap */}
      <div className="bg-card rounded-xl border border-border p-5">
        <h2 className="text-sm font-semibold text-foreground mb-1">Тепловая карта: Часы x Дни</h2>
        <p className="text-xs text-muted-foreground mb-4">Количество заказов по часам и дням недели</p>
        <div className="overflow-x-auto">
          <div className="min-w-[500px]">
            {/* Header row */}
            <div className="grid gap-1" style={{ gridTemplateColumns: '60px repeat(7, 1fr)' }}>
              <div />
              {DAY_NAMES_ORDERED.map(d => (
                <div key={d} className="text-center text-xs font-semibold text-muted-foreground py-1">{d}</div>
              ))}
            </div>
            {/* Data rows */}
            {heatmapData.hours.map(h => (
              <div key={h} className="grid gap-1 mt-1" style={{ gridTemplateColumns: '60px repeat(7, 1fr)' }}>
                <div className="text-xs text-muted-foreground flex items-center justify-end pr-2">{h}:00</div>
                {heatmapData.dayIndices.map(d => {
                  const val = heatmapData.grid[`${h}-${d}`]
                  return (
                    <div
                      key={d}
                      className={`rounded text-center text-xs py-2 font-medium transition-colors ${getHeatColor(val, heatmapData.maxVal)}`}
                    >
                      {val > 0 ? val : ''}
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
        </div>
        {/* Legend */}
        <div className="flex items-center gap-2 mt-4 text-xs text-muted-foreground justify-center">
          <span>Мало</span>
          <div className="flex gap-0.5">
            <span className="size-4 rounded bg-muted/20 border border-border" />
            <span className="size-4 rounded bg-orange-100 dark:bg-orange-950/40" />
            <span className="size-4 rounded bg-orange-200 dark:bg-orange-900/50" />
            <span className="size-4 rounded bg-orange-400 dark:bg-orange-700/60" />
            <span className="size-4 rounded bg-red-500 dark:bg-red-700" />
          </div>
          <span>Много</span>
        </div>
      </div>

      {/* Shift Recommendations */}
      <div className="bg-card rounded-xl border border-border p-5">
        <h2 className="text-sm font-semibold text-foreground mb-4">Рекомендации по сменам</h2>
        <div className="space-y-3">
          {shiftRecs.peak.length > 0 && (
            <div className="rounded-lg p-4 text-sm font-medium bg-emerald-50 text-emerald-800 border border-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-300 dark:border-emerald-800">
              🟢 Пиковые часы: {shiftRecs.peak.join(', ')} — нужно максимум персонала
            </div>
          )}
          {shiftRecs.medium.length > 0 && (
            <div className="rounded-lg p-4 text-sm font-medium bg-amber-50 text-amber-800 border border-amber-200 dark:bg-amber-950/30 dark:text-amber-300 dark:border-amber-800">
              🟡 Средняя загрузка: {shiftRecs.medium.join(', ')} — стандартная смена
            </div>
          )}
          {shiftRecs.quiet.length > 0 && (
            <div className="rounded-lg p-4 text-sm font-medium bg-red-50 text-red-800 border border-red-200 dark:bg-red-950/30 dark:text-red-300 dark:border-red-800">
              🔴 Тихие часы: {shiftRecs.quiet.join(', ')} — можно сократить персонал
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
