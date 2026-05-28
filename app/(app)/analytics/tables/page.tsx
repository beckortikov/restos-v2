'use client'

import { lazy, Suspense } from 'react'
import { useState, useEffect, useMemo } from 'react'
import { formatCurrency, getTimeSince } from '@/lib/helpers'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell,
} from 'recharts'
import type { Table, Order, Zone } from '@/lib/types'
import { fetchTables, fetchOrders, fetchZones } from '@/lib/queries'
import { useAuth } from '@/lib/auth-store'
import {
  MapPin,
  Clock,
  TrendingUp,
  Users,
  ArrowUpDown,
  Armchair,
  RotateCcw,
  Download,
} from 'lucide-react'
import { exportToExcel } from '@/lib/export-excel'

const TablesCharts = lazy(() => import('@/components/charts/tables-charts'))

type Period = 'today' | 'week' | 'month' | 'all'
const PERIOD_OPTIONS: { value: Period; label: string }[] = [
  { value: 'today', label: 'Сегодня' },
  { value: 'week', label: 'Неделя' },
  { value: 'month', label: 'Месяц' },
  { value: 'all', label: 'Все время' },
]

function isInPeriod(dateStr: string, period: Period): boolean {
  if (period === 'all') return true
  const d = new Date(dateStr)
  const now = new Date()
  if (period === 'today') return d.toISOString().slice(0, 10) === now.toISOString().slice(0, 10)
  if (period === 'week') return d >= new Date(now.getTime() - 7 * 86400000)
  if (period === 'month') return d >= new Date(now.getTime() - 30 * 86400000)
  return true
}

function periodDays(period: Period): number {
  if (period === 'today') return 1
  if (period === 'week') return 7
  if (period === 'month') return 30
  return 90 // fallback for 'all'
}

const STATUS_COLORS: Record<string, string> = {
  free: 'oklch(0.64 0.18 145)',
  occupied: 'oklch(0.57 0.22 27)',
  reserved: 'oklch(0.55 0.18 240)',
  bill_requested: 'oklch(0.75 0.18 80)',
}
const STATUS_LABELS: Record<string, string> = {
  free: 'Свободен', occupied: 'Занят', reserved: 'Резерв', bill_requested: 'Счёт',
}

type SortBy = 'revenue' | 'orders' | 'turnover' | 'revenuePerSeat'

export default function TablesAnalyticsPage() {
  const { canDo } = useAuth()
  const [tables, setTables] = useState<Table[]>([])
  const [orders, setOrders] = useState<Order[]>([])
  const [zones, setZones] = useState<Zone[]>([])
  const [loading, setLoading] = useState(true)
  const [period, setPeriod] = useState<Period>('month')
  const [zoneFilter, setZoneFilter] = useState<string>('all')
  const [sortBy, setSortBy] = useState<SortBy>('revenue')

  useEffect(() => {
    Promise.all([fetchTables(), fetchOrders(), fetchZones()])
      .then(([t, o, z]) => { setTables(t); setOrders(o); setZones(z) })
      .finally(() => setLoading(false))
  }, [])

  const closedOrders = useMemo(() =>
    orders.filter(o => o.status === 'done' && o.closedAt && isInPeriod(o.closedAt, period)),
    [orders, period]
  )

  const filteredTables = useMemo(() =>
    zoneFilter === 'all' ? tables : tables.filter(t => t.zone === zoneFilter),
    [tables, zoneFilter]
  )

  const days = periodDays(period)

  const tableStats = useMemo(() =>
    filteredTables.map(table => {
      const tableOrders = closedOrders.filter(o => o.tableId === table.id)
      const revenue = tableOrders.reduce((s, o) => s + o.total, 0)
      const orderCount = tableOrders.length
      const avgCheck = orderCount > 0 ? revenue / orderCount : 0
      const turnover = orderCount / days // orders per day
      const revenuePerSeat = table.capacity > 0 ? revenue / table.capacity : 0

      // Average service time
      const serviceTimes = tableOrders
        .filter(o => o.createdAt && o.closedAt)
        .map(o => (new Date(o.closedAt!).getTime() - new Date(o.createdAt).getTime()) / 60000)
      const avgServiceMin = serviceTimes.length > 0 ? serviceTimes.reduce((s, t) => s + t, 0) / serviceTimes.length : 0

      // Occupancy: rough estimate — orders * avg service time / total period hours
      const totalMinutes = days * 12 * 60 // assume 12h working day
      const occupiedMinutes = serviceTimes.reduce((s, t) => s + t, 0)
      const occupancyPct = totalMinutes > 0 ? Math.min(100, (occupiedMinutes / totalMinutes) * 100) : 0

      // Hourly distribution
      const hourlyOrders: Record<number, number> = {}
      tableOrders.forEach(o => {
        const h = new Date(o.createdAt).getHours()
        hourlyOrders[h] = (hourlyOrders[h] || 0) + 1
      })

      const active = orders.find(o => o.tableId === table.id && o.status !== 'done')

      return { ...table, orderCount, revenue, avgCheck, turnover, revenuePerSeat, avgServiceMin, occupancyPct, hourlyOrders, active }
    }),
    [filteredTables, closedOrders, orders, days]
  )

  const sorted = useMemo(() => {
    return [...tableStats].sort((a, b) => {
      if (sortBy === 'revenue') return b.revenue - a.revenue
      if (sortBy === 'orders') return b.orderCount - a.orderCount
      if (sortBy === 'turnover') return b.turnover - a.turnover
      if (sortBy === 'revenuePerSeat') return b.revenuePerSeat - a.revenuePerSeat
      return 0
    })
  }, [tableStats, sortBy])

  const totals = useMemo(() => ({
    revenue: tableStats.reduce((s, t) => s + t.revenue, 0),
    orders: tableStats.reduce((s, t) => s + t.orderCount, 0),
    avgOccupancy: tableStats.length > 0 ? tableStats.reduce((s, t) => s + t.occupancyPct, 0) / tableStats.length : 0,
    avgTurnover: tableStats.length > 0 ? tableStats.reduce((s, t) => s + t.turnover, 0) / tableStats.length : 0,
  }), [tableStats])

  // For charts
  const topByRevenue = useMemo(() => [...tableStats].sort((a, b) => b.revenue - a.revenue).slice(0, 8), [tableStats])
  const statusCounts = useMemo(() =>
    Object.entries(
      tables.reduce<Record<string, number>>((acc, t) => {
        acc[t.status] = (acc[t.status] || 0) + 1
        return acc
      }, {})
    ).map(([status, count]) => ({ name: STATUS_LABELS[status] || status, value: count, status })),
    [tables]
  )

  const zoneStats = useMemo(() =>
    zones.map(zone => {
      const zoneTables = tableStats.filter(t => t.zone === zone.id)
      const zoneRevenue = zoneTables.reduce((s, t) => s + t.revenue, 0)
      const avgOccupancy = zoneTables.length > 0 ? zoneTables.reduce((s, t) => s + t.occupancyPct, 0) / zoneTables.length : 0
      const occupied = filteredTables.filter(t => t.zone === zone.id && (t.status === 'occupied' || t.status === 'bill_requested')).length
      const totalTables = filteredTables.filter(t => t.zone === zone.id).length
      return { ...zone, tables: totalTables, occupied, revenue: zoneRevenue, avgOccupancy }
    }),
    [zones, tableStats, filteredTables]
  )

  // Hourly order distribution
  const hourlyData = useMemo(() => {
    const counts: Record<number, number> = {}
    for (let h = 0; h < 24; h++) counts[h] = 0
    closedOrders.forEach(o => {
      const h = new Date(o.createdAt).getHours()
      counts[h]++
    })
    const maxCount = Math.max(...Object.values(counts), 1)
    return Array.from({ length: 24 }, (_, h) => ({
      hour: `${String(h).padStart(2, '0')}:00`,
      orders: counts[h],
      intensity: counts[h] / maxCount,
    }))
  }, [closedOrders])

  if (loading) return <div className="p-6 flex items-center justify-center h-64"><div className="size-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" /></div>

  if (!canDo('analytics.view')) {
    return <div className="p-6 text-center text-muted-foreground"><p className="text-lg font-semibold">Нет доступа</p></div>
  }

  return (
    <div className="p-4 md:p-6 space-y-4 md:space-y-5">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-foreground">Аналитика по столам</h1>
          <p className="text-muted-foreground text-sm mt-0.5">Загрузка, оборачиваемость и выручка</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              exportToExcel(
                sorted.map(t => {
                  const zone = zones.find(z => z.id === t.zone)
                  return { ...t, zoneName: zone?.name ?? '—' }
                }),
                [
                  { key: 'name', header: 'Стол' },
                  { key: 'zoneName', header: 'Зона' },
                  { key: 'orderCount', header: 'Заказов' },
                  { key: 'revenue', header: 'Выручка' },
                  { key: 'avgCheck', header: 'Ср. чек', format: (v) => Number(Number(v).toFixed(0)) },
                  { key: 'turnover', header: 'Оборот/день', format: (v) => Number(Number(v).toFixed(1)) },
                ],
                'Аналитика-столы'
              )
            }}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium border border-border rounded-lg hover:bg-muted transition-colors"
          >
            <Download className="size-3.5" />
            Excel
          </button>
          <div className="flex gap-1.5">
            {PERIOD_OPTIONS.map(p => (
              <button key={p.value} onClick={() => setPeriod(p.value)} className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${period === p.value ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-muted/80'}`}>
                {p.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* KPI */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="bg-card rounded-xl border border-border p-4">
          <div className="flex items-center gap-2 mb-2"><MapPin className="size-4 text-muted-foreground" /><span className="text-[11px] text-muted-foreground uppercase tracking-wide">Столов</span></div>
          <p className="text-2xl font-bold">{filteredTables.length}</p>
          <p className="text-[11px] text-muted-foreground mt-0.5">{filteredTables.filter(t => t.status !== 'free').length} занято сейчас</p>
        </div>
        <div className="bg-card rounded-xl border border-border p-4">
          <div className="flex items-center gap-2 mb-2"><TrendingUp className="size-4 text-emerald-500" /><span className="text-[11px] text-muted-foreground uppercase tracking-wide">Выручка</span></div>
          <p className="text-2xl font-bold">{formatCurrency(totals.revenue)}</p>
          <p className="text-[11px] text-muted-foreground mt-0.5">{totals.orders} заказов</p>
        </div>
        <div className="bg-card rounded-xl border border-border p-4">
          <div className="flex items-center gap-2 mb-2"><Armchair className="size-4 text-blue-500" /><span className="text-[11px] text-muted-foreground uppercase tracking-wide">Заказов / стол</span></div>
          <p className="text-2xl font-bold">{filteredTables.length > 0 ? (totals.orders / filteredTables.length).toFixed(1) : '0'}</p>
          <p className="text-[11px] text-muted-foreground mt-0.5">в среднем за период</p>
        </div>
        <div className="bg-card rounded-xl border border-border p-4">
          <div className="flex items-center gap-2 mb-2"><RotateCcw className="size-4 text-amber-500" /><span className="text-[11px] text-muted-foreground uppercase tracking-wide">Оборачиваемость</span></div>
          <p className="text-2xl font-bold">{totals.avgTurnover.toFixed(1)}</p>
          <p className="text-[11px] text-muted-foreground mt-0.5">заказов / стол / день</p>
        </div>
      </div>

      {/* Charts */}
      <TablesCharts
        barData={topByRevenue.map(t => ({ name: t.name, revenue: t.revenue }))}
        pieData={statusCounts}
      />

      {/* Zone cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
        {zoneStats.map(zone => (
          <button
            key={zone.id}
            onClick={() => setZoneFilter(zoneFilter === zone.id ? 'all' : zone.id)}
            className={`text-left bg-card rounded-xl border-2 p-4 transition-all ${zoneFilter === zone.id ? 'border-primary bg-primary/5' : 'border-border hover:border-muted-foreground/30'}`}
          >
            <p className="text-sm font-semibold text-foreground">{zone.name}</p>
            <div className="flex items-center justify-between mt-2 text-xs text-muted-foreground">
              <span>{zone.tables} столов</span>
              <span className="text-amber-600 font-medium">{zone.occupied} занято</span>
            </div>
            <div className="flex items-center justify-between mt-1.5">
              <p className="text-base font-bold text-primary">{formatCurrency(zone.revenue)}</p>
              <span className="text-[11px] text-muted-foreground">
                {zone.tables > 0 ? ((closedOrders.filter(o => {
                  const t = filteredTables.find(ft => ft.id === o.tableId)
                  return t && t.zone === zone.id
                }).length) / days / zone.tables).toFixed(1) : '0'} заказ/стол/день
              </span>
            </div>
          </button>
        ))}
      </div>

      {/* Hourly load chart */}
      <div className="bg-card rounded-xl border border-border p-4">
        <h2 className="text-sm font-semibold text-foreground mb-3">Загрузка по часам дня</h2>
        <ResponsiveContainer width="100%" height={240}>
          <BarChart data={hourlyData}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="hour" tick={{ fontSize: 10 }} interval={1} />
            <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
            <Tooltip formatter={(v: number) => [`${v} заказов`, 'Заказы']} labelStyle={{ fontSize: 12 }} />
            <Bar dataKey="orders" radius={[3, 3, 0, 0]}>
              {hourlyData.map((entry, i) => {
                const base = [255, 237, 213]
                const target = [232, 124, 79]
                const t = entry.intensity
                const r = Math.round(base[0] + (target[0] - base[0]) * t)
                const g = Math.round(base[1] + (target[1] - base[1]) * t)
                const b = Math.round(base[2] + (target[2] - base[2]) * t)
                return <Cell key={i} fill={`rgb(${r},${g},${b})`} />
              })}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Sort + Zone filter info */}
      <div className="flex flex-wrap items-center gap-3">
        {zoneFilter !== 'all' && (
          <button onClick={() => setZoneFilter('all')} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-primary/10 text-primary text-xs font-medium">
            {zones.find(z => z.id === zoneFilter)?.name} ✕
          </button>
        )}
        <div className="flex items-center gap-2">
          <ArrowUpDown className="size-3.5 text-muted-foreground" />
          {([
            { value: 'revenue' as SortBy, label: 'Выручка' },
            { value: 'orders' as SortBy, label: 'Заказы' },
            { value: 'turnover' as SortBy, label: 'Оборот' },
            { value: 'revenuePerSeat' as SortBy, label: 'На место' },
          ]).map(opt => (
            <button key={opt.value} onClick={() => setSortBy(opt.value)} className={`px-2 py-1 rounded-md text-xs font-medium transition-colors ${sortBy === opt.value ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted'}`}>
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Full table */}
      <div className="bg-card rounded-xl border border-border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[900px]">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                {['#', 'Стол', 'Зона', 'Мест', 'Статус', 'Заказов', 'Выручка', 'Ср. чек', 'На место', 'Заказ/день', 'Ср. время'].map(h => (
                  <th key={h} className="px-3 py-3 text-left text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map((t, i) => {
                const zone = zones.find(z => z.id === t.zone)
                return (
                  <tr key={t.id} className="border-b border-border last:border-0 hover:bg-muted/30 transition-colors">
                    <td className="px-3 py-3">
                      <span className={`inline-flex items-center justify-center size-5 rounded-full text-[10px] font-bold ${
                        i < 3 ? 'bg-amber-100 text-amber-700' : 'bg-muted text-muted-foreground'
                      }`}>{i + 1}</span>
                    </td>
                    <td className="px-3 py-3 font-semibold text-foreground">{t.name}</td>
                    <td className="px-3 py-3 text-xs text-muted-foreground">{zone?.name ?? '—'}</td>
                    <td className="px-3 py-3 text-muted-foreground">{t.capacity}</td>
                    <td className="px-3 py-3">
                      <span className="inline-flex items-center gap-1 text-xs font-medium">
                        <span className="size-2 rounded-full" style={{ backgroundColor: STATUS_COLORS[t.status] }} />
                        {STATUS_LABELS[t.status]}
                      </span>
                    </td>
                    <td className="px-3 py-3 text-foreground">{t.orderCount}</td>
                    <td className="px-3 py-3 font-semibold text-foreground">{formatCurrency(t.revenue)}</td>
                    <td className="px-3 py-3 text-foreground">{t.avgCheck > 0 ? formatCurrency(t.avgCheck) : '—'}</td>
                    <td className="px-3 py-3 text-foreground">{t.revenuePerSeat > 0 ? formatCurrency(t.revenuePerSeat) : '—'}</td>
                    <td className="px-3 py-3 text-foreground">{t.turnover.toFixed(1)}</td>
                    <td className="px-3 py-3">
                      {t.avgServiceMin > 0 ? (
                        <span className={`inline-flex items-center gap-1 text-xs ${t.avgServiceMin > 60 ? 'text-destructive' : t.avgServiceMin > 30 ? 'text-amber-600' : 'text-emerald-600'}`}>
                          <Clock className="size-3" />{Math.round(t.avgServiceMin)} мин
                        </span>
                      ) : '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
