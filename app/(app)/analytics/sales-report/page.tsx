'use client'

import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { TrendingUp, ShoppingBag, Package, Receipt, UtensilsCrossed, ShoppingCart } from 'lucide-react'

import { formatCurrency, calcLineTotal } from '@/lib/helpers'
import { fetchOrders, fetchMenuItems } from '@/lib/queries'
import type { Order, MenuItem } from '@/lib/types'
import { DateRangePicker } from '@/components/ui/date-range-picker'
import { getPresetRange } from '@/components/finance/date-range-presets'

const today = () => new Date().toISOString().slice(0, 10)

// Часы работы для тепловой карты (как в дашборде/weekday).
const HOURS = Array.from({ length: 15 }, (_, i) => i + 8) // 8..22
const WD_LABEL = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб']

// Кол-во «порций»: весовые (unit g/kg) переводим в число порций по unitSize.
function qtyOf(i: Order['items'][number]): number {
  return i.unit && i.unit !== 'piece' ? i.qty / (i.unitSize && i.unitSize > 0 ? i.unitSize : 1) : i.qty
}
function fmtQty(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}

// Насыщенность ячейки теплокарты по доле от максимума (стиль weekday).
function heatClass(v: number, max: number): string {
  if (v <= 0) return 'bg-muted/20 text-muted-foreground'
  const r = v / max
  if (r < 0.2) return 'bg-primary/10'
  if (r < 0.4) return 'bg-primary/25'
  if (r < 0.6) return 'bg-primary/45'
  if (r < 0.8) return 'bg-primary/65 text-white'
  return 'bg-primary text-white'
}

type Kind = 'all' | 'kitchen' | 'purchased'
type Dim = 'dish' | 'category'

interface Row {
  key: string
  name: string
  category: string
  isPurchased: boolean
  qty: number
  revenue: number
}

export default function SalesReportPage() {
  const [orders, setOrders] = useState<Order[]>([])
  const [menuItems, setMenuItems] = useState<MenuItem[]>([])
  const [loading, setLoading] = useState(true)

  const initial = getPresetRange('week')
  const [dateFrom, setDateFrom] = useState(initial.from)
  const [dateTo, setDateTo] = useState(initial.to)
  const [dim, setDim] = useState<Dim>('dish')
  const [kind, setKind] = useState<Kind>('all')

  useEffect(() => {
    setLoading(true)
    Promise.all([fetchOrders(), fetchMenuItems()])
      .then(([o, mi]) => { setOrders(o); setMenuItems(mi) })
      .catch(() => toast.error('Ошибка загрузки отчёта продаж'))
      .finally(() => setLoading(false))
  }, [])

  // id → {category, isPurchased} из меню (в OrderItem этих полей нет).
  const menuMeta = useMemo(() => {
    const m = new Map<string, { category: string; isPurchased: boolean }>()
    for (const mi of menuItems) m.set(mi.id, { category: mi.category || 'Без категории', isPurchased: !!mi.isPurchased })
    return m
  }, [menuItems])

  const inRange = (d?: string | null): boolean => {
    if (!d) return false
    const day = d.slice(0, 10)
    return day >= dateFrom && day <= dateTo
  }

  // Закрытые заказы за период (по дате закрытия = продажи).
  const soldOrders = useMemo(
    () => orders.filter(o => o.status === 'done' && inRange(o.closedAt)),
    [orders, dateFrom, dateTo],
  )

  // Плоский список проданных позиций (без отменённых) с резолвом категории.
  const soldItems = useMemo(() => {
    const rows: { name: string; category: string; isPurchased: boolean; qty: number; revenue: number; hour: number; date: string }[] = []
    for (const o of soldOrders) {
      const when = o.closedAt || o.createdAt
      const hour = new Date(when).getHours()
      const date = (o.closedAt || o.createdAt).slice(0, 10)
      for (const i of o.items) {
        if (i.cancelledAt) continue
        const meta = menuMeta.get(i.menuItemId)
        rows.push({
          name: i.name,
          category: meta?.category ?? 'Без категории',
          isPurchased: meta?.isPurchased ?? false,
          qty: qtyOf(i),
          revenue: calcLineTotal(i.price, i.qty, i.unit, i.unitSize),
          hour,
          date,
        })
      }
    }
    return rows
  }, [soldOrders, menuMeta])

  const items = useMemo(
    () => soldItems.filter(r => kind === 'all' || (kind === 'purchased' ? r.isPurchased : !r.isPurchased)),
    [soldItems, kind],
  )

  // KPI.
  const kpi = useMemo(() => {
    const revenue = items.reduce((s, r) => s + r.revenue, 0)
    const qty = items.reduce((s, r) => s + r.qty, 0)
    const orderCount = new Set(soldOrders.filter(o => kind === 'all' || o.items.some(i => {
      const p = menuMeta.get(i.menuItemId)?.isPurchased ?? false
      return kind === 'purchased' ? p : !p
    })).map(o => o.id)).size
    return { revenue, qty, orderCount, avg: orderCount > 0 ? revenue / orderCount : 0 }
  }, [items, soldOrders, kind, menuMeta])

  // Основная таблица: блюда или категории за период.
  const rows = useMemo(() => {
    const map = new Map<string, Row>()
    for (const r of items) {
      const key = dim === 'dish' ? r.name : r.category
      const ex = map.get(key)
      if (ex) { ex.qty += r.qty; ex.revenue += r.revenue }
      else map.set(key, { key, name: key, category: r.category, isPurchased: r.isPurchased, qty: r.qty, revenue: r.revenue })
    }
    return [...map.values()].sort((a, b) => b.revenue - a.revenue)
  }, [items, dim])
  const rowsTotal = useMemo(() => rows.reduce((s, r) => s + r.revenue, 0), [rows])

  // Тепловая карта: (категория | блюдо) × час, по выручке.
  const heat = useMemo(() => {
    const rowKeys = rows.slice(0, 12).map(r => r.key)
    const rowSet = new Set(rowKeys)
    const cell = new Map<string, number>()
    let max = 0
    for (const r of items) {
      const rk = dim === 'dish' ? r.name : r.category
      if (!rowSet.has(rk)) continue
      const k = `${rk}:${r.hour}`
      const v = (cell.get(k) ?? 0) + r.revenue
      cell.set(k, v)
      if (v > max) max = v
    }
    return { rowKeys, cell, max: Math.max(1, max) }
  }, [items, rows, dim])

  // История по датам: что продано в какой день.
  const byDate = useMemo(() => {
    const map = new Map<string, { date: string; revenue: number; qty: number; orderIds: Set<string>; dish: Map<string, number> }>()
    for (const o of soldOrders) {
      const date = (o.closedAt || o.createdAt).slice(0, 10)
      let e = map.get(date)
      if (!e) { e = { date, revenue: 0, qty: 0, orderIds: new Set(), dish: new Map() }; map.set(date, e) }
      e.orderIds.add(o.id)
      for (const i of o.items) {
        if (i.cancelledAt) continue
        const meta = menuMeta.get(i.menuItemId)
        if (kind !== 'all' && (kind === 'purchased' ? !meta?.isPurchased : meta?.isPurchased)) continue
        e.revenue += calcLineTotal(i.price, i.qty, i.unit, i.unitSize)
        e.qty += qtyOf(i)
        e.dish.set(i.name, (e.dish.get(i.name) ?? 0) + calcLineTotal(i.price, i.qty, i.unit, i.unitSize))
      }
    }
    return [...map.values()]
      .map(e => {
        const top = [...e.dish.entries()].sort((a, b) => b[1] - a[1])[0]
        const d = new Date(e.date + 'T00:00:00')
        return { date: e.date, wd: WD_LABEL[d.getDay()], label: d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }), revenue: e.revenue, qty: e.qty, orders: e.orderIds.size, top: top?.[0] ?? '—' }
      })
      .sort((a, b) => (a.date < b.date ? 1 : -1))
  }, [soldOrders, menuMeta, kind])

  return (
    <div className="p-4 md:p-6 space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">Продажи</h1>
          <p className="text-sm text-muted-foreground">Что и когда продавалось — блюда, категории и покупные товары по дням и часам</p>
        </div>
        <DateRangePicker from={dateFrom} to={dateTo} maxDate={today()} onChange={r => { setDateFrom(r.from); setDateTo(r.to) }} />
      </div>

      {loading ? (
        <div className="flex h-64 items-center justify-center"><div className="size-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" /></div>
      ) : (
        <>
          {/* KPI */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5 md:gap-3">
            <KpiCard label="Выручка" value={formatCurrency(kpi.revenue)} icon={TrendingUp} color="bg-emerald-500/10 text-emerald-600" />
            <KpiCard label="Заказов" value={String(kpi.orderCount)} icon={ShoppingBag} color="bg-primary/10 text-primary" />
            <KpiCard label="Позиций продано" value={fmtQty(kpi.qty)} icon={Package} color="bg-blue-500/10 text-blue-600" />
            <KpiCard label="Средний чек" value={formatCurrency(kpi.avg)} icon={Receipt} color="bg-violet-500/10 text-violet-600" />
          </div>

          {/* Фильтры: разрез (блюда/категории) + тип товара */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex gap-1 bg-muted/50 p-1 rounded-lg">
              {([['dish', 'Блюда'], ['category', 'Категории']] as const).map(([k, l]) => (
                <button key={k} onClick={() => setDim(k)} className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${dim === k ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>{l}</button>
              ))}
            </div>
            <div className="flex gap-1 bg-muted/50 p-1 rounded-lg">
              {([['all', 'Все'], ['kitchen', 'Кухня'], ['purchased', 'Покупные']] as const).map(([k, l]) => (
                <button key={k} onClick={() => setKind(k)} className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${kind === k ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>{l}</button>
              ))}
            </div>
          </div>

          {/* Таблица: топ за период */}
          <div className="bg-card rounded-xl border border-border p-4 md:p-5">
            <h2 className="text-sm font-semibold mb-3">{dim === 'dish' ? 'Блюда' : 'Категории'} за период</h2>
            {rows.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-10">Нет продаж за выбранный период</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-muted-foreground border-b border-border">
                      <th className="text-left font-medium py-2 pr-2">#</th>
                      <th className="text-left font-medium py-2 pr-2">{dim === 'dish' ? 'Блюдо' : 'Категория'}</th>
                      {dim === 'dish' && <th className="text-left font-medium py-2 pr-2 hidden sm:table-cell">Категория</th>}
                      <th className="text-right font-medium py-2 px-2">Кол-во</th>
                      <th className="text-right font-medium py-2 px-2">Выручка</th>
                      <th className="text-right font-medium py-2 pl-2 w-32">Доля</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => {
                      const pct = rowsTotal > 0 ? (r.revenue / rowsTotal) * 100 : 0
                      return (
                        <tr key={r.key} className="border-b border-border/50 last:border-0">
                          <td className="py-2 pr-2 text-muted-foreground tabular-nums">{i + 1}</td>
                          <td className="py-2 pr-2 font-medium">
                            <span className="flex items-center gap-1.5">
                              <span className="truncate max-w-[220px]">{r.name}</span>
                              {dim === 'dish' && r.isPurchased && <ShoppingCart className="size-3 text-blue-500 shrink-0" aria-label="Покупной товар" />}
                            </span>
                          </td>
                          {dim === 'dish' && <td className="py-2 pr-2 text-muted-foreground hidden sm:table-cell truncate max-w-[140px]">{r.category}</td>}
                          <td className="py-2 px-2 text-right tabular-nums">{fmtQty(r.qty)}</td>
                          <td className="py-2 px-2 text-right font-medium tabular-nums">{formatCurrency(r.revenue)}</td>
                          <td className="py-2 pl-2">
                            <div className="flex items-center gap-2 justify-end">
                              <div className="h-1.5 w-16 rounded-full bg-muted overflow-hidden"><div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} /></div>
                              <span className="text-xs text-muted-foreground tabular-nums w-9 text-right">{pct.toFixed(0)}%</span>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Тепловая карта: что продаётся по часам */}
          <div className="bg-card rounded-xl border border-border p-4 md:p-5">
            <h2 className="text-sm font-semibold mb-1">{dim === 'dish' ? 'Блюда' : 'Категории'} по часам</h2>
            <p className="text-xs text-muted-foreground mb-3">Выручка по часам за период — видно, что и когда заходит</p>
            {heat.rowKeys.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">Нет данных</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="border-separate border-spacing-0.5">
                  <thead>
                    <tr>
                      <th className="sticky left-0 bg-card" />
                      {HOURS.map(h => <th key={h} className="text-[10px] font-normal text-muted-foreground w-9 text-center">{h}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {heat.rowKeys.map(rk => (
                      <tr key={rk}>
                        <td className="sticky left-0 bg-card pr-2 text-xs font-medium truncate max-w-[140px]" title={rk}>{rk}</td>
                        {HOURS.map(h => {
                          const v = heat.cell.get(`${rk}:${h}`) ?? 0
                          return (
                            <td key={h} className={`w-9 h-8 text-center text-[10px] rounded tabular-nums ${heatClass(v, heat.max)}`} title={v > 0 ? `${rk} · ${h}:00 — ${formatCurrency(v)}` : `${rk} · ${h}:00`}>
                              {v > 0 ? Math.round(v / 1000) || '·' : ''}
                            </td>
                          )
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="text-[10px] text-muted-foreground mt-2">Числа в ячейках — выручка в тыс. сум. Топ-{heat.rowKeys.length} по выручке.</p>
              </div>
            )}
          </div>

          {/* История по датам */}
          <div className="bg-card rounded-xl border border-border p-4 md:p-5">
            <h2 className="text-sm font-semibold mb-1">По дням</h2>
            <p className="text-xs text-muted-foreground mb-3">Какие дни что продавалось — история по датам</p>
            {byDate.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">Нет продаж</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-muted-foreground border-b border-border">
                      <th className="text-left font-medium py-2 pr-2">Дата</th>
                      <th className="text-left font-medium py-2 pr-2">День</th>
                      <th className="text-right font-medium py-2 px-2">Заказов</th>
                      <th className="text-right font-medium py-2 px-2">Позиций</th>
                      <th className="text-right font-medium py-2 px-2">Выручка</th>
                      <th className="text-left font-medium py-2 pl-2">Топ-блюдо</th>
                    </tr>
                  </thead>
                  <tbody>
                    {byDate.map(d => (
                      <tr key={d.date} className="border-b border-border/50 last:border-0">
                        <td className="py-2 pr-2 font-medium whitespace-nowrap">{d.label}</td>
                        <td className="py-2 pr-2 text-muted-foreground">{d.wd}</td>
                        <td className="py-2 px-2 text-right tabular-nums">{d.orders}</td>
                        <td className="py-2 px-2 text-right tabular-nums">{fmtQty(d.qty)}</td>
                        <td className="py-2 px-2 text-right font-medium tabular-nums">{formatCurrency(d.revenue)}</td>
                        <td className="py-2 pl-2 text-muted-foreground truncate max-w-[200px]">{d.top}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function KpiCard({ label, value, icon: Icon, color }: { label: string; value: string; icon: React.ElementType; color: string }) {
  return (
    <div className="bg-card rounded-xl border border-border p-3.5">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs text-muted-foreground">{label}</span>
        <div className={`size-7 rounded-md flex items-center justify-center ${color}`}><Icon className="size-3.5" /></div>
      </div>
      <p className="text-lg font-bold tabular-nums">{value}</p>
    </div>
  )
}
