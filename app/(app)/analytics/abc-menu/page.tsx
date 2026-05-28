'use client'

import { lazy, Suspense } from 'react'
import { useState, useEffect, useMemo } from 'react'
import { formatCurrency, calcLineTotal, calcLineCogs } from '@/lib/helpers'
import { dDiv, dMul, dSub, dSum } from '@/lib/decimal'
import type { ABCClass, MenuItem, Order } from '@/lib/types'
import { fetchMenuItems, fetchOrders } from '@/lib/queries'
import { useAuth } from '@/lib/auth-store'
import { Download } from 'lucide-react'
import { exportToExcel } from '@/lib/export-excel'
import { DatePeriodFilter, filterByDateRange, type PeriodKey } from '@/components/date-period-filter'

const AbcMenuScatter = lazy(() => import('@/components/charts/abc-menu-scatter'))

type MenuClass = 'star' | 'workhorse' | 'puzzle' | 'dog'
const MENU_CLASS_LABELS: Record<MenuClass, { label: string; emoji: string; color: string; desc: string }> = {
  star:      { label: 'Звезда',           emoji: '⭐', color: 'text-emerald-600', desc: 'Продвигать' },
  workhorse: { label: 'Рабочая лошадка', emoji: '🐴', color: 'text-blue-600',    desc: 'Поднять цену' },
  puzzle:    { label: 'Загадка',          emoji: '❓', color: 'text-amber-600',   desc: 'Продвигать активнее' },
  dog:       { label: 'Собака',           emoji: '🐕', color: 'text-red-600',     desc: 'Убрать из меню' },
}

// ABC + Menu Engineering: popularity × profitability
function computeABC(menuItems: MenuItem[], orders: Order[]) {
  const salesMap: Record<string, { qty: number; revenue: number; cogs: number }> = {}
  menuItems.forEach((m) => {
    salesMap[m.id] = { qty: 0, revenue: 0, cogs: 0 }
  })
  orders.forEach((o) => {
    o.items.forEach((item) => {
      if (!salesMap[item.menuItemId]) salesMap[item.menuItemId] = { qty: 0, revenue: 0, cogs: 0 }
      // For weight items (g/kg), accumulate effective portions (qty / unitSize), so
      // salesMap.qty and averages compare apples-to-apples with piece items.
      const effectivePortions = item.unit && item.unit !== 'piece'
        ? item.qty / (item.unitSize && item.unitSize > 0 ? item.unitSize : 1)
        : item.qty
      salesMap[item.menuItemId].qty += effectivePortions
      salesMap[item.menuItemId].revenue += calcLineTotal(item.price, item.qty, item.unit, item.unitSize)
      salesMap[item.menuItemId].cogs += calcLineCogs(item.cogs, item.qty, item.unit, item.unitSize)
    })
  })

  const totalRevenue = dSum(Object.values(salesMap).map(v => v.revenue))
  const enriched = menuItems.map((m) => {
    const s = salesMap[m.id] || { qty: 0, revenue: 0, cogs: 0 }
    const margin = s.revenue > 0
      ? dMul(dDiv(dSub(s.revenue, s.cogs), s.revenue), 100)
      : (m.price > 0 ? dMul(dDiv(dSub(m.price, m.cogs), m.price), 100) : 0)
    return { ...m, ...s, margin }
  })

  // Calculate medians for menu engineering classification
  const soldItems = enriched.filter(i => i.qty > 0)
  const avgQty = soldItems.length > 0 ? dDiv(dSum(soldItems.map(i => i.qty)), soldItems.length) : 0
  const avgMargin = soldItems.length > 0 ? dDiv(dSum(soldItems.map(i => i.margin)), soldItems.length) : 50

  const sorted = enriched.sort((a, b) => b.revenue - a.revenue)

  let cumulative = 0
  return sorted.map((item) => {
    cumulative += item.revenue
    const share = totalRevenue > 0 ? (cumulative / totalRevenue) * 100 : 0
    const abc: ABCClass = share <= 80 ? 'A' : share <= 95 ? 'B' : 'C'

    // Menu engineering: popularity (qty) × profitability (margin)
    const highPop = item.qty >= avgQty
    const highMargin = item.margin >= avgMargin
    const menuClass: MenuClass = highPop && highMargin ? 'star'
      : highPop && !highMargin ? 'workhorse'
      : !highPop && highMargin ? 'puzzle'
      : 'dog'

    return { ...item, abc, menuClass, share: totalRevenue > 0 ? (item.revenue / totalRevenue) * 100 : 0 }
  })
}

const ABC_COLORS: Record<ABCClass, string> = {
  A: 'oklch(0.64 0.18 145)',
  B: 'var(--color-primary)',
  C: 'oklch(0.57 0.22 27)',
}

const ABC_BG: Record<ABCClass, string> = {
  A: 'bg-emerald-100 text-emerald-700',
  B: 'bg-primary/10 text-primary',
  C: 'bg-red-100 text-red-700',
}

const ABC_DESC: Record<ABCClass, string> = {
  A: 'Приоритет — дают 80% выручки',
  B: 'Резерв — следующие 15%',
  C: 'Слабые — нижние 5%',
}

export default function AbcMenuPage() {
  const { canDo } = useAuth()
  const [menuItems, setMenuItems] = useState<MenuItem[]>([])
  const [orders, setOrders] = useState<Order[]>([])
  const [loading, setLoading] = useState(true)
  const [period, setPeriod] = useState<PeriodKey>('month')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')

  useEffect(() => {
    Promise.all([fetchMenuItems(), fetchOrders()])
      .then(([mi, o]) => { setMenuItems(mi); setOrders(o) })
      .finally(() => setLoading(false))
  }, [])

  const filteredOrders = useMemo(() => filterByDateRange(orders, o => o.closedAt, period, customFrom, customTo), [orders, period, customFrom, customTo])

  const items = useMemo(() => computeABC(menuItems, filteredOrders), [menuItems, filteredOrders])

  const summaryKPIs = useMemo(() => {
    if (items.length === 0) return null
    const totalItems = items.length
    const aItems = items.filter(i => i.abc === 'A')
    const bItems = items.filter(i => i.abc === 'B')
    const cItems = items.filter(i => i.abc === 'C')
    const totalRevenue = items.reduce((s, i) => s + i.revenue, 0)
    const totalCogs = items.reduce((s, i) => s + i.cogs, 0)
    const avgFoodCost = totalRevenue > 0 ? (totalCogs / totalRevenue) * 100 : 0
    const aRevenue = aItems.reduce((s, i) => s + i.revenue, 0)
    const aRevenueShare = totalRevenue > 0 ? (aRevenue / totalRevenue) * 100 : 0
    return {
      avgFoodCost,
      aCount: aItems.length,
      bCount: bItems.length,
      cCount: cItems.length,
      aRevenueShare,
    }
  }, [items])

  const recommendations = useMemo(() => {
    const recs: { type: 'warning' | 'tip' | 'opportunity'; text: string }[] = []
    for (const item of items) {
      if (item.abc === 'C' && item.margin < 30) {
        recs.push({
          type: 'warning',
          text: `⚠️ Рекомендуем убрать ${item.name} — ${item.share.toFixed(1)}% выручки, маржа ${item.margin.toFixed(1)}%`,
        })
      }
      if (item.abc === 'A' && item.margin < 25) {
        recs.push({
          type: 'tip',
          text: `💡 ${item.name} — лидер продаж, но маржа всего ${item.margin.toFixed(1)}%. Рассмотрите повышение цены`,
        })
      }
      if (item.abc === 'B' && item.margin > 60) {
        recs.push({
          type: 'opportunity',
          text: `📈 ${item.name} — высокая маржа ${item.margin.toFixed(1)}%. Продвигайте активнее`,
        })
      }
    }
    return recs
  }, [items])

  if (!canDo('analytics.view')) {
    return <div className="p-6 text-center text-muted-foreground">Нет доступа</div>
  }

  if (loading) return <div className="p-6 flex items-center justify-center h-64"><div className="size-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" /></div>

  const byClass = (cls: ABCClass) => items.filter((i) => i.abc === cls)

  const scatterData = items.map((item) => ({
    x: item.qty,
    y: item.margin,
    name: item.name,
    abc: item.abc,
  }))

  return (
    <div className="p-4 md:p-6 space-y-4 md:space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-foreground">ABC-анализ меню</h1>
          <p className="text-muted-foreground text-sm mt-0.5">Популярность × Маржинальность — какие блюда оставить, какие убрать</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              exportToExcel(
                items.map(i => ({ ...i })),
                [
                  { key: 'name', header: 'Блюдо' },
                  { key: 'category', header: 'Категория' },
                  { key: 'qty', header: 'Продано' },
                  { key: 'revenue', header: 'Выручка' },
                  { key: 'cogs', header: 'Себестоимость' },
                  { key: 'margin', header: 'Маржа %', format: (v) => Number(Number(v).toFixed(1)) },
                  { key: 'abc', header: 'ABC класс' },
                ],
                'ABC-анализ'
              )
            }}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium border border-border rounded-lg hover:bg-muted transition-colors"
          >
            <Download className="size-3.5" />
            Excel
          </button>
          <DatePeriodFilter period={period} onPeriodChange={setPeriod} customFrom={customFrom} customTo={customTo} onCustomFromChange={setCustomFrom} onCustomToChange={setCustomTo} />
        </div>
      </div>

      {/* ABC group summary */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {(['A', 'B', 'C'] as ABCClass[]).map((cls) => {
          const group = byClass(cls)
          const groupRevenue = group.reduce((s, i) => s + i.revenue, 0)
          return (
            <div key={cls} className="bg-card rounded-xl border border-border p-5">
              <div className="flex items-center gap-2 mb-3">
                <span className={`size-8 rounded-lg flex items-center justify-center font-bold text-base ${ABC_BG[cls]}`}>{cls}</span>
                <div>
                  <p className="text-sm font-semibold text-foreground">{group.length} блюд</p>
                  <p className="text-xs text-muted-foreground">{ABC_DESC[cls]}</p>
                </div>
              </div>
              <p className="text-xl font-bold text-foreground">{formatCurrency(groupRevenue)}</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {group.map((i) => i.name).join(', ')}
              </p>
            </div>
          )
        })}
      </div>

      {/* Scatter chart: qty vs margin */}
      <div className="bg-card rounded-xl border border-border p-5">
        <h2 className="text-sm font-semibold text-foreground mb-1">Матрица: Объём продаж vs Маржинальность</h2>
        <p className="text-xs text-muted-foreground mb-4">Размер точки = выручка</p>
        <AbcMenuScatter data={scatterData} />
        <div className="flex items-center gap-4 mt-2 justify-center text-xs text-muted-foreground">
          {(['A', 'B', 'C'] as ABCClass[]).map((cls) => (
            <span key={cls} className="flex items-center gap-1.5">
              <span className="size-2.5 rounded-full inline-block" style={{ backgroundColor: ABC_COLORS[cls] }} />
              Группа {cls}
            </span>
          ))}
        </div>
      </div>

      {/* Full table */}
      <div className="bg-card rounded-xl border border-border overflow-hidden">
        <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[700px]">
          <thead>
            <tr className="border-b border-border bg-muted/40">
              {['Класс', 'Тип', 'Блюдо', 'Категория', 'Продано', 'Выручка', 'Маржа', 'Действие'].map((h) => (
                <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wide">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id} className="border-b border-border last:border-0 hover:bg-muted/30 transition-colors">
                <td className="px-4 py-3">
                  <span className={`size-6 rounded font-bold text-xs flex items-center justify-center ${ABC_BG[item.abc]}`}>{item.abc}</span>
                </td>
                <td className="px-4 py-3">
                  <span className={`text-xs font-medium ${MENU_CLASS_LABELS[item.menuClass].color}`}>
                    {MENU_CLASS_LABELS[item.menuClass].emoji} {MENU_CLASS_LABELS[item.menuClass].label}
                  </span>
                </td>
                <td className="px-4 py-3 font-medium text-foreground">{item.name}</td>
                <td className="px-4 py-3">
                  <span className="text-xs bg-muted text-muted-foreground px-2 py-0.5 rounded">{item.category}</span>
                </td>
                <td className="px-4 py-3 text-foreground">{item.qty} порц.</td>
                <td className="px-4 py-3 font-medium text-foreground">{formatCurrency(item.revenue)}</td>
                <td className="px-4 py-3">
                  <span className={`text-sm font-semibold ${item.margin >= 60 ? 'text-emerald-600' : item.margin >= 40 ? 'text-amber-600' : 'text-destructive'}`}>
                    {(item.margin || 0).toFixed(1)}%
                  </span>
                </td>
                <td className="px-4 py-3">
                  <span className={`text-xs font-medium ${MENU_CLASS_LABELS[item.menuClass].color}`}>
                    {MENU_CLASS_LABELS[item.menuClass].desc}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>

      {/* Summary KPIs */}
      {summaryKPIs && (
        <div className="bg-card rounded-xl border border-border p-5">
          <h2 className="text-sm font-semibold text-foreground mb-4">Сводные показатели</h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="bg-muted/30 rounded-lg p-4">
              <p className="text-xs text-muted-foreground mb-1">Средний Food Cost %</p>
              <p className="text-2xl font-bold text-foreground">{(summaryKPIs.avgFoodCost || 0).toFixed(1)}%</p>
            </div>
            <div className="bg-muted/30 rounded-lg p-4">
              <p className="text-xs text-muted-foreground mb-1">Количество блюд</p>
              <p className="text-2xl font-bold text-foreground">
                <span className="text-emerald-600">{summaryKPIs.aCount}A</span>
                {' / '}
                <span className="text-primary">{summaryKPIs.bCount}B</span>
                {' / '}
                <span className="text-red-600">{summaryKPIs.cCount}C</span>
              </p>
            </div>
            <div className="bg-muted/30 rounded-lg p-4">
              <p className="text-xs text-muted-foreground mb-1">Доля A-класса в выручке</p>
              <p className="text-2xl font-bold text-emerald-600">{(summaryKPIs.aRevenueShare || 0).toFixed(1)}%</p>
            </div>
          </div>
        </div>
      )}

      {/* Recommendations */}
      {recommendations.length > 0 && (
        <div className="bg-card rounded-xl border border-border p-5">
          <h2 className="text-sm font-semibold text-foreground mb-4">Рекомендации</h2>
          <div className="space-y-3">
            {recommendations.map((rec, idx) => (
              <div
                key={idx}
                className={`rounded-lg p-4 text-sm font-medium ${
                  rec.type === 'warning'
                    ? 'bg-amber-50 text-amber-800 border border-amber-200 dark:bg-amber-950/30 dark:text-amber-300 dark:border-amber-800'
                    : rec.type === 'tip'
                    ? 'bg-blue-50 text-blue-800 border border-blue-200 dark:bg-blue-950/30 dark:text-blue-300 dark:border-blue-800'
                    : 'bg-emerald-50 text-emerald-800 border border-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-300 dark:border-emerald-800'
                }`}
              >
                {rec.text}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
