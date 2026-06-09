'use client'

import { useState, useEffect, useMemo } from 'react'
import { formatCurrency } from '@/lib/helpers'
import { fetchWaitersAnalytics, type WaitersReport } from '@/lib/queries/analytics'
import { useAuth } from '@/lib/auth-store'
import {
  TrendingUp,
  ShoppingBag,
  Users as UsersIcon,
  Star,
  ArrowUpDown,
  Download,
} from 'lucide-react'
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

type SortBy = 'revenue' | 'orders' | 'avgCheck' | 'items'

interface WaiterStat {
  id: string
  name: string
  revenue: number
  orderCount: number
  avgCheck: number
  itemsServed: number
  serviceEarned: number
  tipAmount: number
}

export default function WaitersAnalyticsPage() {
  const { canDo } = useAuth()
  const [report, setReport] = useState<WaitersReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [period, setPeriod] = useState<Period>('month')
  const [sortBy, setSortBy] = useState<SortBy>('revenue')

  useEffect(() => {
    setLoading(true)
    const { from, to } = periodToRange(period)
    fetchWaitersAnalytics({ from, to })
      .then(setReport)
      .catch(() => toast.error('Ошибка загрузки данных'))
      .finally(() => setLoading(false))
  }, [period])

  const stats: WaiterStat[] = useMemo(() => {
    if (!report) return []
    return report.rows.map(r => ({
      id: r.waiter_id,
      name: r.name,
      revenue: Number(r.revenue),
      orderCount: r.orders,
      avgCheck: Number(r.avg_check),
      itemsServed: Number(r.items_sold),
      serviceEarned: Number(r.service_amount),
      tipAmount: Number(r.tip_amount),
    }))
  }, [report])

  const sorted = useMemo(() => {
    return [...stats].sort((a, b) => {
      if (sortBy === 'revenue') return b.revenue - a.revenue
      if (sortBy === 'orders') return b.orderCount - a.orderCount
      if (sortBy === 'avgCheck') return b.avgCheck - a.avgCheck
      if (sortBy === 'items') return b.itemsServed - a.itemsServed
      return 0
    })
  }, [stats, sortBy])

  const totals = useMemo(() => ({
    revenue: stats.reduce((s, w) => s + w.revenue, 0),
    orders: stats.reduce((s, w) => s + w.orderCount, 0),
    items: stats.reduce((s, w) => s + w.itemsServed, 0),
    service: stats.reduce((s, w) => s + w.serviceEarned, 0),
  }), [stats])

  if (loading) return (
    <div className="p-6 flex items-center justify-center h-64">
      <div className="size-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" />
    </div>
  )

  if (!canDo('analytics.view')) {
    return (
      <div className="p-6 text-center text-muted-foreground">
        <p className="text-lg font-semibold">Нет доступа</p>
        <p className="text-sm mt-1">Эта страница доступна только владельцу и управляющему</p>
      </div>
    )
  }

  return (
    <div className="p-4 md:p-6 space-y-4 md:space-y-5">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-foreground">Аналитика официантов</h1>
          <p className="text-muted-foreground text-sm mt-0.5">Выручка, заказы и эффективность по каждому официанту</p>
        </div>
        {/* Period filter */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              exportToExcel(
                sorted.map(w => ({ ...w })),
                [
                  { key: 'name', header: 'Официант' },
                  { key: 'orderCount', header: 'Заказов' },
                  { key: 'revenue', header: 'Выручка' },
                  { key: 'avgCheck', header: 'Ср. чек', format: (v) => Number(Number(v).toFixed(0)) },
                  { key: 'serviceEarned', header: 'Обслуживание' },
                  { key: 'tipAmount', header: 'Чаевые' },
                ],
                'Аналитика-официанты'
              )
            }}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium border border-border rounded-lg hover:bg-muted transition-colors"
          >
            <Download className="size-3.5" />
            Excel
          </button>
          <div className="flex gap-1.5">
            {PERIOD_OPTIONS.map(p => (
              <button
                key={p.value}
                onClick={() => setPeriod(p.value)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  period === p.value ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-muted/80'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* KPI */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="bg-card rounded-xl border border-border p-4">
          <div className="flex items-center gap-2 mb-2">
            <UsersIcon className="size-4 text-muted-foreground" />
            <span className="text-[11px] text-muted-foreground uppercase tracking-wide">Официантов</span>
          </div>
          <p className="text-2xl font-bold">{stats.length}</p>
        </div>
        <div className="bg-card rounded-xl border border-border p-4">
          <div className="flex items-center gap-2 mb-2">
            <TrendingUp className="size-4 text-emerald-500" />
            <span className="text-[11px] text-muted-foreground uppercase tracking-wide">Общая выручка</span>
          </div>
          <p className="text-2xl font-bold">{formatCurrency(totals.revenue)}</p>
        </div>
        <div className="bg-card rounded-xl border border-border p-4">
          <div className="flex items-center gap-2 mb-2">
            <ShoppingBag className="size-4 text-blue-500" />
            <span className="text-[11px] text-muted-foreground uppercase tracking-wide">Всего заказов</span>
          </div>
          <p className="text-2xl font-bold">{totals.orders}</p>
        </div>
        <div className="bg-card rounded-xl border border-border p-4">
          <div className="flex items-center gap-2 mb-2">
            <Star className="size-4 text-amber-500" />
            <span className="text-[11px] text-muted-foreground uppercase tracking-wide">Ср. чек (общий)</span>
          </div>
          <p className="text-2xl font-bold">{totals.orders > 0 ? formatCurrency(totals.revenue / totals.orders) : '—'}</p>
        </div>
      </div>

      {/* Ranking cards */}
      {sorted.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {sorted.slice(0, 3).map((w, i) => {
            const medals = ['🥇', '🥈', '🥉']
            const bgColors = ['bg-amber-50 border-amber-200', 'bg-slate-50 border-slate-200', 'bg-orange-50 border-orange-200']
            return (
              <div key={w.id} className={`rounded-xl border-2 p-5 ${bgColors[i]}`}>
                <div className="flex items-center gap-3 mb-4">
                  <span className="text-3xl">{medals[i]}</span>
                  <div>
                    <p className="font-bold text-foreground text-lg">{w.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {w.orderCount} заказ. · {w.itemsServed} позиц.
                    </p>
                  </div>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  <div>
                    <p className="text-[10px] text-muted-foreground uppercase">Выручка</p>
                    <p className="text-lg font-bold text-foreground">{formatCurrency(w.revenue)}</p>
                  </div>
                  <div>
                    <p className="text-[10px] text-muted-foreground uppercase">Ср. чек</p>
                    <p className="text-lg font-bold text-foreground">{formatCurrency(w.avgCheck)}</p>
                  </div>
                  <div>
                    <p className="text-[10px] text-muted-foreground uppercase">Чаевые</p>
                    <p className="text-lg font-bold text-foreground">{w.tipAmount > 0 ? formatCurrency(w.tipAmount) : '—'}</p>
                  </div>
                  <div>
                    <p className="text-[10px] text-muted-foreground uppercase">Обслуживание</p>
                    <p className="text-lg font-bold text-emerald-600">{w.serviceEarned > 0 ? formatCurrency(w.serviceEarned) : '—'}</p>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Sort controls */}
      <div className="flex items-center gap-2">
        <ArrowUpDown className="size-4 text-muted-foreground" />
        <span className="text-xs text-muted-foreground">Сортировка:</span>
        {([
          { value: 'revenue' as SortBy, label: 'Выручка' },
          { value: 'orders' as SortBy, label: 'Заказы' },
          { value: 'avgCheck' as SortBy, label: 'Ср. чек' },
          { value: 'items' as SortBy, label: 'Позиций' },
        ]).map(opt => (
          <button
            key={opt.value}
            onClick={() => setSortBy(opt.value)}
            className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
              sortBy === opt.value ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* Full table */}
      <div className="bg-card rounded-xl border border-border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[800px]">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                {['#', 'Официант', 'Заказов', 'Позиций', 'Выручка', 'Обслуж.', 'Чаевые', 'Ср. чек'].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wide">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map((w, i) => (
                <tr key={w.id} className="border-b border-border last:border-0 hover:bg-muted/30 transition-colors">
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center justify-center size-6 rounded-full text-xs font-bold ${
                      i === 0 ? 'bg-amber-100 text-amber-700' :
                      i === 1 ? 'bg-slate-100 text-slate-700' :
                      i === 2 ? 'bg-orange-100 text-orange-700' :
                      'bg-muted text-muted-foreground'
                    }`}>
                      {i + 1}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-semibold text-foreground">{w.name}</td>
                  <td className="px-4 py-3 text-foreground">{w.orderCount}</td>
                  <td className="px-4 py-3 text-muted-foreground">{w.itemsServed}</td>
                  <td className="px-4 py-3 font-semibold text-foreground">{formatCurrency(w.revenue)}</td>
                  <td className="px-4 py-3 text-emerald-600 font-medium">{w.serviceEarned > 0 ? formatCurrency(w.serviceEarned) : '—'}</td>
                  <td className="px-4 py-3 text-foreground">{w.tipAmount > 0 ? formatCurrency(w.tipAmount) : '—'}</td>
                  <td className="px-4 py-3 text-foreground">{w.avgCheck > 0 ? formatCurrency(w.avgCheck) : '—'}</td>
                </tr>
              ))}
              {sorted.length === 0 && (
                <tr><td colSpan={8} className="px-4 py-8 text-center text-muted-foreground">Нет данных за выбранный период</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
