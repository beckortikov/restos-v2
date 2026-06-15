'use client'

import { useState, useEffect, useMemo } from 'react'
import { formatCurrency } from '@/lib/helpers'
import { fetchTablesAnalytics, fetchPeakHours, type TablesAnalyticsReport, type TableLiveStatus, type PeakHoursReport } from '@/lib/queries/analytics'
import { useAuth } from '@/lib/auth-store'
import {
  MapPin,
  Clock,
  TrendingUp,
  Users as UsersIcon,
  ArrowUpDown,
  Download,
  Circle,
} from 'lucide-react'
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip as RTooltip, Legend, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts'
import { exportToExcel } from '@/lib/export-excel'
import { toast } from 'sonner'

type Period = 'today' | 'week' | 'month' | 'all'
const PERIOD_OPTIONS: { value: Period; label: string }[] = [
  { value: 'today', label: 'Сегодня' },
  { value: 'week', label: 'Неделя' },
  { value: 'month', label: 'Месяц' },
  { value: 'all', label: 'Все время' },
]

function periodToRange(period: Period): { from?: string; to?: string } {
  if (period === 'all') return {}
  const now = new Date()
  const from = new Date()
  if (period === 'today') {
    from.setHours(0, 0, 0, 0)
  } else if (period === 'week') {
    from.setDate(now.getDate() - 7)
  } else {
    from.setDate(now.getDate() - 30)
  }
  return { from: from.toISOString(), to: now.toISOString() }
}

function periodDays(period: Period): number {
  if (period === 'today') return 1
  if (period === 'week') return 7
  if (period === 'month') return 30
  return 90
}

type SortBy = 'revenue' | 'orders' | 'avgCheck' | 'guests'

interface TableStat {
  id: string
  name: string
  zoneName: string
  orderCount: number
  revenue: number
  avgCheck: number
  avgDurationMin: number
  guestsTotal: number
  status: TableLiveStatus
  capacity: number
  revenuePerSeat: number
  occupancyPct: number
}

const STATUS_LABEL: Record<TableLiveStatus, string> = {
  free: 'Свободен',
  occupied: 'Занят',
  reserved: 'Бронь',
  bill_requested: 'Просит счёт',
}

const STATUS_BADGE: Record<TableLiveStatus, string> = {
  free: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  occupied: 'bg-red-100 text-red-700 border-red-200',
  reserved: 'bg-blue-100 text-blue-700 border-blue-200',
  bill_requested: 'bg-amber-100 text-amber-700 border-amber-200',
}

const STATUS_COLOR: Record<TableLiveStatus, string> = {
  free: '#10b981',
  occupied: '#ef4444',
  reserved: '#3b82f6',
  bill_requested: '#f59e0b',
}

export default function TablesAnalyticsPage() {
  const { canDo } = useAuth()
  const [report, setReport] = useState<TablesAnalyticsReport | null>(null)
  const [peak, setPeak] = useState<PeakHoursReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [period, setPeriod] = useState<Period>('month')
  const [zoneFilter, setZoneFilter] = useState<string>('all')
  const [sortBy, setSortBy] = useState<SortBy>('revenue')

  useEffect(() => {
    setLoading(true)
    const { from, to } = periodToRange(period)
    fetchTablesAnalytics({ from, to })
      .then(setReport)
      .catch(() => toast.error('Ошибка загрузки данных'))
      .finally(() => setLoading(false))
    // Почасовая загрузка за период — для графика «Загрузка по часам дня».
    fetchPeakHours({ from, to }).then(setPeak).catch(() => setPeak(null))
  }, [period])

  // Загрузка по часам дня: суммируем заказы по часу (0..23) из peak-hours-ячеек.
  const hourlyData = useMemo(() => {
    const byHour = new Array(24).fill(0) as number[]
    for (const c of peak?.cells ?? []) {
      if (c.hour >= 0 && c.hour < 24) byHour[c.hour] += Number(c.orders) || 0
    }
    const max = Math.max(...byHour, 1)
    return byHour.map((orders, hour) => ({
      hour: `${String(hour).padStart(2, '0')}`,
      orders,
      intensity: orders / max,
    }))
  }, [peak])
  const hasHourly = useMemo(() => hourlyData.some(d => d.orders > 0), [hourlyData])

  const allStats: TableStat[] = useMemo(() => {
    if (!report) return []
    return report.rows.map(r => ({
      id: r.table_id,
      name: r.name,
      zoneName: r.zone_name || '—',
      orderCount: r.orders,
      revenue: Number(r.revenue),
      avgCheck: Number(r.avg_check),
      avgDurationMin: Number(r.avg_duration_min),
      guestsTotal: r.guests_total,
      status: (r.status || 'free') as TableLiveStatus,
      capacity: r.capacity || 0,
      revenuePerSeat: Number(r.revenue_per_seat),
      occupancyPct: Number(r.occupancy_pct),
    }))
  }, [report])

  const zones = useMemo(() => {
    const set = new Set<string>()
    for (const s of allStats) if (s.zoneName) set.add(s.zoneName)
    return Array.from(set).sort()
  }, [allStats])

  const tableStats = useMemo(() =>
    zoneFilter === 'all' ? allStats : allStats.filter(s => s.zoneName === zoneFilter),
    [allStats, zoneFilter]
  )

  const days = periodDays(period)

  const sorted = useMemo(() => {
    return [...tableStats].sort((a, b) => {
      if (sortBy === 'revenue') return b.revenue - a.revenue
      if (sortBy === 'orders') return b.orderCount - a.orderCount
      if (sortBy === 'avgCheck') return b.avgCheck - a.avgCheck
      if (sortBy === 'guests') return b.guestsTotal - a.guestsTotal
      return 0
    })
  }, [tableStats, sortBy])

  const totals = useMemo(() => ({
    revenue: tableStats.reduce((s, t) => s + t.revenue, 0),
    orders: tableStats.reduce((s, t) => s + t.orderCount, 0),
    guests: tableStats.reduce((s, t) => s + t.guestsTotal, 0),
    avgTurnover: tableStats.length > 0 ? tableStats.reduce((s, t) => s + t.orderCount, 0) / tableStats.length / days : 0,
    occupiedNow: tableStats.filter(t => t.status !== 'free').length,
  }), [tableStats, days])

  const statusPie = useMemo(() => {
    const counts: Record<TableLiveStatus, number> = { free: 0, occupied: 0, reserved: 0, bill_requested: 0 }
    for (const t of tableStats) counts[t.status] = (counts[t.status] || 0) + 1
    return (['free', 'occupied', 'reserved', 'bill_requested'] as TableLiveStatus[])
      .map(s => ({ name: STATUS_LABEL[s], value: counts[s], key: s }))
      .filter(d => d.value > 0)
  }, [tableStats])

  const zoneStats = useMemo(() =>
    zones.map(zoneName => {
      const zTables = allStats.filter(s => s.zoneName === zoneName)
      const revenue = zTables.reduce((s, t) => s + t.revenue, 0)
      const orders = zTables.reduce((s, t) => s + t.orderCount, 0)
      return { name: zoneName, tables: zTables.length, revenue, orders }
    }),
    [allStats, zones]
  )

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
                sorted.map(t => ({ ...t })),
                [
                  { key: 'name', header: 'Стол' },
                  { key: 'zoneName', header: 'Зона' },
                  { key: 'orderCount', header: 'Заказов' },
                  { key: 'revenue', header: 'Выручка' },
                  { key: 'avgCheck', header: 'Ср. чек', format: (v) => Number(Number(v).toFixed(0)) },
                  { key: 'guestsTotal', header: 'Гостей' },
                  { key: 'avgDurationMin', header: 'Ср. время (мин)', format: (v) => Number(Number(v).toFixed(0)) },
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
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <div className="bg-card rounded-xl border border-border p-4">
          <div className="flex items-center gap-2 mb-2"><MapPin className="size-4 text-muted-foreground" /><span className="text-[11px] text-muted-foreground uppercase tracking-wide">Столов</span></div>
          <p className="text-2xl font-bold">{tableStats.length}</p>
        </div>
        <div className="bg-card rounded-xl border border-border p-4">
          <div className="flex items-center gap-2 mb-2"><TrendingUp className="size-4 text-emerald-500" /><span className="text-[11px] text-muted-foreground uppercase tracking-wide">Выручка</span></div>
          <p className="text-2xl font-bold">{formatCurrency(totals.revenue)}</p>
          <p className="text-[11px] text-muted-foreground mt-0.5">{totals.orders} заказов</p>
        </div>
        <div className="bg-card rounded-xl border border-border p-4">
          <div className="flex items-center gap-2 mb-2"><UsersIcon className="size-4 text-blue-500" /><span className="text-[11px] text-muted-foreground uppercase tracking-wide">Гостей</span></div>
          <p className="text-2xl font-bold">{totals.guests}</p>
        </div>
        <div className="bg-card rounded-xl border border-border p-4">
          <div className="flex items-center gap-2 mb-2"><TrendingUp className="size-4 text-amber-500" /><span className="text-[11px] text-muted-foreground uppercase tracking-wide">Оборачиваемость</span></div>
          <p className="text-2xl font-bold">{totals.avgTurnover.toFixed(1)}</p>
          <p className="text-[11px] text-muted-foreground mt-0.5">заказов / стол / день</p>
        </div>
        <div className="bg-card rounded-xl border border-border p-4">
          <div className="flex items-center gap-2 mb-2"><Circle className="size-4 text-red-500" /><span className="text-[11px] text-muted-foreground uppercase tracking-wide">Занято сейчас</span></div>
          <p className="text-2xl font-bold">{totals.occupiedNow}</p>
          <p className="text-[11px] text-muted-foreground mt-0.5">из {tableStats.length}</p>
        </div>
      </div>

      {/* Загрузка по часам дня (как в v1) + компактный live-статус справа */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-3">
        <div className="xl:col-span-2 bg-card rounded-xl border border-border p-5">
          <h2 className="text-sm font-semibold text-foreground mb-1">Загрузка по часам дня</h2>
          <p className="text-xs text-muted-foreground mb-4">Заказы по часам за выбранный период</p>
          {hasHourly ? (
            <div style={{ width: '100%', height: 240 }}>
              <ResponsiveContainer>
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
          ) : (
            <p className="text-sm text-muted-foreground py-12 text-center">Нет данных за период</p>
          )}
        </div>

        {/* Статусы столов сейчас — компактный live-снимок (операционный) */}
        {statusPie.length > 0 && (
          <div className="bg-card rounded-xl border border-border p-5">
            <h2 className="text-sm font-semibold text-foreground mb-1">Статусы столов сейчас</h2>
            <p className="text-xs text-muted-foreground mb-4">Текущий снимок</p>
            <div style={{ width: '100%', height: 200 }}>
              <ResponsiveContainer>
                <PieChart>
                  <Pie data={statusPie} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={70} label={(d: any) => `${d.value}`}>
                    {statusPie.map((entry, idx) => (
                      <Cell key={idx} fill={STATUS_COLOR[entry.key]} />
                    ))}
                  </Pie>
                  <RTooltip />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}
      </div>

      {/* Zone cards */}
      {zoneStats.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
          {zoneStats.map(zone => (
            <button
              key={zone.name}
              onClick={() => setZoneFilter(zoneFilter === zone.name ? 'all' : zone.name)}
              className={`text-left bg-card rounded-xl border-2 p-4 transition-all ${zoneFilter === zone.name ? 'border-primary bg-primary/5' : 'border-border hover:border-muted-foreground/30'}`}
            >
              <p className="text-sm font-semibold text-foreground">{zone.name}</p>
              <div className="flex items-center justify-between mt-2 text-xs text-muted-foreground">
                <span>{zone.tables} столов</span>
                <span>{zone.orders} заказов</span>
              </div>
              <div className="flex items-center justify-between mt-1.5">
                <p className="text-base font-bold text-primary">{formatCurrency(zone.revenue)}</p>
              </div>
            </button>
          ))}
        </div>
      )}

      {/* Sort + Zone filter info */}
      <div className="flex flex-wrap items-center gap-3">
        {zoneFilter !== 'all' && (
          <button onClick={() => setZoneFilter('all')} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-primary/10 text-primary text-xs font-medium">
            {zoneFilter} ✕
          </button>
        )}
        <div className="flex items-center gap-2">
          <ArrowUpDown className="size-3.5 text-muted-foreground" />
          {([
            { value: 'revenue' as SortBy, label: 'Выручка' },
            { value: 'orders' as SortBy, label: 'Заказы' },
            { value: 'avgCheck' as SortBy, label: 'Ср. чек' },
            { value: 'guests' as SortBy, label: 'Гостей' },
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
          <table className="w-full text-sm min-w-[1100px]">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                {['#', 'Стол', 'Зона', 'Статус', 'Мест', 'Заказов', 'Гостей', 'Выручка', '₸/место', 'Загрузка', 'Ср. чек', 'Ср. время'].map(h => (
                  <th key={h} className="px-3 py-3 text-left text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map((t, i) => (
                <tr key={t.id} className="border-b border-border last:border-0 hover:bg-muted/30 transition-colors">
                  <td className="px-3 py-3">
                    <span className={`inline-flex items-center justify-center size-5 rounded-full text-[10px] font-bold ${
                      i < 3 ? 'bg-amber-100 text-amber-700' : 'bg-muted text-muted-foreground'
                    }`}>{i + 1}</span>
                  </td>
                  <td className="px-3 py-3 font-semibold text-foreground">{t.name}</td>
                  <td className="px-3 py-3 text-xs text-muted-foreground">{t.zoneName}</td>
                  <td className="px-3 py-3">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border ${STATUS_BADGE[t.status]}`}>
                      {STATUS_LABEL[t.status]}
                    </span>
                  </td>
                  <td className="px-3 py-3 text-foreground">{t.capacity || '—'}</td>
                  <td className="px-3 py-3 text-foreground">{t.orderCount}</td>
                  <td className="px-3 py-3 text-foreground">{t.guestsTotal}</td>
                  <td className="px-3 py-3 font-semibold text-foreground">{formatCurrency(t.revenue)}</td>
                  <td className="px-3 py-3 text-foreground">{t.revenuePerSeat > 0 ? formatCurrency(t.revenuePerSeat) : '—'}</td>
                  <td className="px-3 py-3 text-foreground">{t.occupancyPct > 0 ? `${t.occupancyPct.toFixed(0)}%` : '—'}</td>
                  <td className="px-3 py-3 text-foreground">{t.avgCheck > 0 ? formatCurrency(t.avgCheck) : '—'}</td>
                  <td className="px-3 py-3">
                    {t.avgDurationMin > 0 ? (
                      <span className={`inline-flex items-center gap-1 text-xs ${t.avgDurationMin > 60 ? 'text-destructive' : t.avgDurationMin > 30 ? 'text-amber-600' : 'text-emerald-600'}`}>
                        <Clock className="size-3" />{Math.round(t.avgDurationMin)} мин
                      </span>
                    ) : '—'}
                  </td>
                </tr>
              ))}
              {sorted.length === 0 && (
                <tr><td colSpan={12} className="px-3 py-8 text-center text-muted-foreground">Нет данных за выбранный период</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
