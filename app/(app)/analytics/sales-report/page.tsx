'use client'

import { Fragment, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import * as XLSX from 'xlsx'
import { TrendingUp, ShoppingBag, Package, Receipt, ShoppingCart, Download, ChevronDown } from 'lucide-react'

import { formatCurrency } from '@/lib/helpers'
import { fetchSalesReport, type SalesReportResult } from '@/lib/queries/analytics'
import { DateRangePicker } from '@/components/ui/date-range-picker'
import { getPresetRange } from '@/components/finance/date-range-presets'

const today = () => new Date().toISOString().slice(0, 10)

// Часы работы для тепловой карты (как в дашборде/weekday).
const HOURS = Array.from({ length: 15 }, (_, i) => i + 8) // 8..22
const WD_LABEL = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб']

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

// Дни недели с понедельника (getDay: 0=вс..6=сб).
const WD_ORDER = [1, 2, 3, 4, 5, 6, 0]

function appendSheet(wb: XLSX.WorkBook, name: string, rows: Record<string, unknown>[]) {
  const ws = XLSX.utils.json_to_sheet(rows)
  XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 31))
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
  const [report, setReport] = useState<SalesReportResult | null>(null)
  const [loading, setLoading] = useState(true)

  const initial = getPresetRange('week')
  const [dateFrom, setDateFrom] = useState(initial.from)
  const [dateTo, setDateTo] = useState(initial.to)
  const [dim, setDim] = useState<Dim>('dish')
  const [kind, setKind] = useState<Kind>('all')
  const [expandedDate, setExpandedDate] = useState<string | null>(null)
  const [expandedCategory, setExpandedCategory] = useState<string | null>(null)

  // Н21: данные считает СЕРВЕР (скидки/voids/closed+refunded, без лимита 5000).
  // Перезапрос при смене периода — серверная фильтрация по датам.
  useEffect(() => {
    setLoading(true)
    fetchSalesReport({ from: dateFrom, to: dateTo })
      .then(setReport)
      .catch(() => toast.error('Ошибка загрузки отчёта продаж'))
      .finally(() => setLoading(false))
  }, [dateFrom, dateTo])

  // Плоский список проданных позиций (сервер уже отфильтровал/просуммировал:
  // скидка учтена, voids/отменённые исключены, категория/покупной резолвнуты).
  const soldItems = useMemo(() => {
    if (!report) return [] as { name: string; category: string; isPurchased: boolean; qty: number; revenue: number; hour: number; date: string }[]
    return report.rows.map(r => ({
      name: r.name,
      category: r.category || 'Без категории',
      isPurchased: r.is_purchased,
      qty: Number(r.qty),
      revenue: Number(r.revenue),
      hour: r.hour,
      date: r.date,
    }))
  }, [report])

  const items = useMemo(
    () => soldItems.filter(r => kind === 'all' || (kind === 'purchased' ? r.isPurchased : !r.isPurchased)),
    [soldItems, kind],
  )

  // KPI. «Заказов» — всего за период (сервер); построчный разрез по kind order_id
  // не несёт, поэтому счётчик заказов — по всему периоду, а выручка/кол-во — по kind.
  const kpi = useMemo(() => {
    const revenue = items.reduce((s, r) => s + r.revenue, 0)
    const qty = items.reduce((s, r) => s + r.qty, 0)
    const orderCount = report?.totals.orders ?? 0
    return { revenue, qty, orderCount, avg: orderCount > 0 ? revenue / orderCount : 0 }
  }, [items, report])

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

  // История по датам: выручка/кол-во/топ-блюдо из строк (kind-фильтр), число
  // заказов — distinct с сервера (строки order_id не несут).
  const byDate = useMemo(() => {
    const ordersByDate = new Map((report?.by_date ?? []).map(d => [d.date, d.orders]))
    const map = new Map<string, { date: string; revenue: number; qty: number; dish: Map<string, number> }>()
    for (const r of items) {
      let e = map.get(r.date)
      if (!e) { e = { date: r.date, revenue: 0, qty: 0, dish: new Map() }; map.set(r.date, e) }
      e.revenue += r.revenue
      e.qty += r.qty
      e.dish.set(r.name, (e.dish.get(r.name) ?? 0) + r.revenue)
    }
    return [...map.values()]
      .map(e => {
        const top = [...e.dish.entries()].sort((a, b) => b[1] - a[1])[0]
        const d = new Date(e.date + 'T00:00:00')
        return { date: e.date, wd: WD_LABEL[d.getDay()], label: d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }), revenue: e.revenue, qty: e.qty, orders: ordersByDate.get(e.date) ?? 0, top: top?.[0] ?? '—' }
      })
      .sort((a, b) => (a.date < b.date ? 1 : -1))
  }, [items, report])

  // Тепловая карта: блюдо/категория × день недели (сумма выручки за период).
  const weekday = useMemo(() => {
    const rowKeys = rows.slice(0, 12).map(r => r.key)
    const rowSet = new Set(rowKeys)
    const cell = new Map<string, number>()
    let max = 0
    for (const r of items) {
      const rk = dim === 'dish' ? r.name : r.category
      if (!rowSet.has(rk)) continue
      const wd = new Date(r.date + 'T00:00:00').getDay()
      const k = `${rk}:${wd}`
      const v = (cell.get(k) ?? 0) + r.revenue
      cell.set(k, v)
      if (v > max) max = v
    }
    return { rowKeys, cell, max: Math.max(1, max) }
  }, [items, rows, dim])

  // Drill-down: блюда выбранного дня (по выручке).
  const dayDetail = useMemo(() => {
    if (!expandedDate) return []
    const m = new Map<string, { name: string; qty: number; revenue: number; isPurchased: boolean }>()
    for (const r of items) {
      if (r.date !== expandedDate) continue
      const e = m.get(r.name)
      if (e) { e.qty += r.qty; e.revenue += r.revenue }
      else m.set(r.name, { name: r.name, qty: r.qty, revenue: r.revenue, isPurchased: r.isPurchased })
    }
    return [...m.values()].sort((a, b) => b.revenue - a.revenue)
  }, [items, expandedDate])

  // Drill-down: блюда выбранной категории за период (по выручке). Только для
  // dim='category' — в режиме «Блюда» строка уже и есть блюдо, разворачивать нечего.
  const categoryDetail = useMemo(() => {
    if (!expandedCategory) return []
    const m = new Map<string, { name: string; qty: number; revenue: number; isPurchased: boolean }>()
    for (const r of items) {
      if (r.category !== expandedCategory) continue
      const e = m.get(r.name)
      if (e) { e.qty += r.qty; e.revenue += r.revenue }
      else m.set(r.name, { name: r.name, qty: r.qty, revenue: r.revenue, isPurchased: r.isPurchased })
    }
    return [...m.values()].sort((a, b) => b.revenue - a.revenue)
  }, [items, expandedCategory])

  // Экспорт в Excel: листы «Топ за период» + «По дням».
  function exportReport() {
    const wb = XLSX.utils.book_new()
    const dimLabel = dim === 'dish' ? 'Блюдо' : 'Категория'
    const topRows = rows.map((r, i) => ({
      '#': i + 1,
      [dimLabel]: r.name,
      ...(dim === 'dish' ? { 'Категория': r.category, 'Покупной': r.isPurchased ? 'да' : '' } : {}),
      'Кол-во': Number(r.qty.toFixed(2)),
      'Выручка': Number(r.revenue.toFixed(2)),
      'Доля %': rowsTotal > 0 ? Number(((r.revenue / rowsTotal) * 100).toFixed(1)) : 0,
    }))
    appendSheet(wb, dim === 'dish' ? 'Блюда' : 'Категории', topRows)
    const dayRows = byDate.map(d => ({ 'Дата': d.date, 'День': d.wd, 'Заказов': d.orders, 'Позиций': Number(d.qty.toFixed(2)), 'Выручка': Number(d.revenue.toFixed(2)), 'Топ-блюдо': d.top }))
    appendSheet(wb, 'По дням', dayRows)
    XLSX.writeFile(wb, `Продажи_${dateFrom}_${dateTo}.xlsx`)
  }

  return (
    <div className="p-4 md:p-6 space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">Продажи</h1>
          <p className="text-sm text-muted-foreground">Что и когда продавалось — блюда, категории и покупные товары по дням и часам</p>
        </div>
        <div className="flex items-center gap-2">
          <DateRangePicker from={dateFrom} to={dateTo} maxDate={today()} onChange={r => { setDateFrom(r.from); setDateTo(r.to) }} />
          <button onClick={exportReport} className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-sm text-foreground hover:bg-muted transition-colors" title="Выгрузить в Excel">
            <Download className="size-4" />
            <span className="hidden sm:inline">Excel</span>
          </button>
        </div>
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
                      // Раскрытие — только для категорий: в режиме «Блюда» строка уже
                      // и есть блюдо, разворачивать нечего.
                      const expandable = dim === 'category'
                      const isOpen = expandable && expandedCategory === r.key
                      return (
                        <Fragment key={r.key}>
                          <tr
                            className={`border-b border-border/50 last:border-0 ${expandable ? 'cursor-pointer hover:bg-muted/40' : ''}`}
                            onClick={() => expandable && setExpandedCategory(isOpen ? null : r.key)}
                          >
                            <td className="py-2 pr-2 text-muted-foreground tabular-nums">{i + 1}</td>
                            <td className="py-2 pr-2 font-medium">
                              <span className="flex items-center gap-1.5">
                                {expandable && <ChevronDown className={`size-3.5 text-muted-foreground shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`} />}
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
                          {isOpen && (
                            <tr className="bg-muted/20">
                              <td colSpan={5} className="px-3 py-2">
                                {categoryDetail.length === 0 ? (
                                  <p className="text-xs text-muted-foreground py-1">Нет позиций</p>
                                ) : (
                                  <div className="space-y-0.5">
                                    <p className="text-xs font-medium text-muted-foreground mb-1.5">Продано в категории «{r.name}»:</p>
                                    {categoryDetail.map(x => (
                                      <div key={x.name} className="flex items-center justify-between text-xs py-0.5">
                                        <span className="flex items-center gap-1.5 min-w-0">
                                          <span className="truncate max-w-[240px]">{x.name}</span>
                                          {x.isPurchased && <ShoppingCart className="size-3 text-blue-500 shrink-0" />}
                                        </span>
                                        <span className="flex items-center gap-3 shrink-0 tabular-nums">
                                          <span className="text-muted-foreground">{fmtQty(x.qty)} шт</span>
                                          <span className="font-medium w-20 text-right">{formatCurrency(x.revenue)}</span>
                                        </span>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </td>
                            </tr>
                          )}
                        </Fragment>
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

          {/* Тепловая карта: по дням недели */}
          <div className="bg-card rounded-xl border border-border p-4 md:p-5">
            <h2 className="text-sm font-semibold mb-1">{dim === 'dish' ? 'Блюда' : 'Категории'} по дням недели</h2>
            <p className="text-xs text-muted-foreground mb-3">Суммарная выручка по дням недели за период — для планирования заготовок и промо</p>
            {weekday.rowKeys.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">Нет данных</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="border-separate border-spacing-0.5">
                  <thead>
                    <tr>
                      <th className="sticky left-0 bg-card" />
                      {WD_ORDER.map(wd => <th key={wd} className="text-[10px] font-normal text-muted-foreground w-12 text-center">{WD_LABEL[wd]}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {weekday.rowKeys.map(rk => (
                      <tr key={rk}>
                        <td className="sticky left-0 bg-card pr-2 text-xs font-medium truncate max-w-[140px]" title={rk}>{rk}</td>
                        {WD_ORDER.map(wd => {
                          const v = weekday.cell.get(`${rk}:${wd}`) ?? 0
                          return (
                            <td key={wd} className={`w-12 h-8 text-center text-[10px] rounded tabular-nums ${heatClass(v, weekday.max)}`} title={v > 0 ? `${rk} · ${WD_LABEL[wd]} — ${formatCurrency(v)}` : `${rk} · ${WD_LABEL[wd]}`}>
                              {v > 0 ? Math.round(v / 1000) || '·' : ''}
                            </td>
                          )
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="text-[10px] text-muted-foreground mt-2">Числа — выручка в тыс. сум. Топ-{weekday.rowKeys.length} по выручке.</p>
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
                      <th className="w-6" />
                      <th className="text-left font-medium py-2 pr-2">Дата</th>
                      <th className="text-left font-medium py-2 pr-2">День</th>
                      <th className="text-right font-medium py-2 px-2">Заказов</th>
                      <th className="text-right font-medium py-2 px-2">Позиций</th>
                      <th className="text-right font-medium py-2 px-2">Выручка</th>
                      <th className="text-left font-medium py-2 pl-2">Топ-блюдо</th>
                    </tr>
                  </thead>
                  <tbody>
                    {byDate.map(d => {
                      const isOpen = expandedDate === d.date
                      return (
                        <Fragment key={d.date}>
                          <tr className="border-b border-border/50 last:border-0 cursor-pointer hover:bg-muted/40" onClick={() => setExpandedDate(isOpen ? null : d.date)}>
                            <td className="py-2 pl-1 pr-1"><ChevronDown className={`size-3.5 text-muted-foreground transition-transform ${isOpen ? 'rotate-180' : ''}`} /></td>
                            <td className="py-2 pr-2 font-medium whitespace-nowrap">{d.label}</td>
                            <td className="py-2 pr-2 text-muted-foreground">{d.wd}</td>
                            <td className="py-2 px-2 text-right tabular-nums">{d.orders}</td>
                            <td className="py-2 px-2 text-right tabular-nums">{fmtQty(d.qty)}</td>
                            <td className="py-2 px-2 text-right font-medium tabular-nums">{formatCurrency(d.revenue)}</td>
                            <td className="py-2 pl-2 text-muted-foreground truncate max-w-[200px]">{d.top}</td>
                          </tr>
                          {isOpen && (
                            <tr className="bg-muted/20">
                              <td colSpan={7} className="px-3 py-2">
                                {dayDetail.length === 0 ? (
                                  <p className="text-xs text-muted-foreground py-1">Нет позиций</p>
                                ) : (
                                  <div className="space-y-0.5">
                                    <p className="text-xs font-medium text-muted-foreground mb-1.5">Продано {d.label} ({d.wd}):</p>
                                    {dayDetail.map(x => (
                                      <div key={x.name} className="flex items-center justify-between text-xs py-0.5">
                                        <span className="flex items-center gap-1.5 min-w-0">
                                          <span className="truncate max-w-[240px]">{x.name}</span>
                                          {x.isPurchased && <ShoppingCart className="size-3 text-blue-500 shrink-0" />}
                                        </span>
                                        <span className="flex items-center gap-3 shrink-0 tabular-nums">
                                          <span className="text-muted-foreground">{fmtQty(x.qty)} шт</span>
                                          <span className="font-medium w-20 text-right">{formatCurrency(x.revenue)}</span>
                                        </span>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      )
                    })}
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
