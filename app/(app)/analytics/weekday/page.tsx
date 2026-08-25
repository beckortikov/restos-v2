'use client'

import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell, ReferenceLine } from 'recharts'

import { formatCurrency } from '@/lib/helpers'
import { fetchWeekday, fetchNetworkWeekday, type WeekdayReport } from '@/lib/queries/analytics'
import { DatePeriodFilter, getDateRange, type PeriodKey } from '@/components/date-period-filter'
import { useAuth } from '@/lib/auth-store'
import { useBranchView } from '@/hooks/use-branch-view'

// Postgres DOW: 0=вс … 6=сб. Отображаем с понедельника.
const ORDER = [1, 2, 3, 4, 5, 6, 0]
const LABEL: Record<number, string> = { 1: 'Пн', 2: 'Вт', 3: 'Ср', 4: 'Чт', 5: 'Пт', 6: 'Сб', 0: 'Вс' }

function profitClass(v: number, max: number): string {
  if (v <= 0) return 'bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300'
  if (max <= 0) return 'bg-muted/20'
  const r = v / max
  if (r < 0.25) return 'bg-emerald-100 dark:bg-emerald-950/40'
  if (r < 0.5) return 'bg-emerald-200 dark:bg-emerald-900/50'
  if (r < 0.75) return 'bg-emerald-400 dark:bg-emerald-700/60'
  return 'bg-emerald-600 text-white dark:bg-emerald-600'
}

export default function WeekdayPage() {
  const { restaurant } = useAuth()
  const isBranchView = useBranchView()
  const isCentral = restaurant?.kind === 'central_warehouse' && !isBranchView
  const [report, setReport] = useState<WeekdayReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [period, setPeriod] = useState<PeriodKey>('month')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')

  useEffect(() => {
    setLoading(true)
    const { from, to } = getDateRange(period, customFrom, customTo)
    const fetcher = isCentral ? fetchNetworkWeekday : fetchWeekday
    fetcher({ from: from ?? undefined, to: to ?? undefined })
      .then(setReport)
      .catch(() => toast.error('Ошибка загрузки аналитики по дням недели'))
      .finally(() => setLoading(false))
  }, [period, customFrom, customTo, isCentral])

  // A3 bars (Пн-first).
  const byWd = useMemo(() => {
    const m = new Map((report?.by_weekday ?? []).map(r => [r.weekday, r]))
    return ORDER.map(wd => ({ wd, label: LABEL[wd], ...(m.get(wd) ?? { orders: 0, revenue: 0, cogs: 0, labor: 0, gross_profit: 0, net_profit: 0, avg_check: 0 }) }))
  }, [report])

  const best = useMemo(() => byWd.filter(d => d.orders > 0).sort((a, b) => b.net_profit - a.net_profit)[0], [byWd])
  const worst = useMemo(() => byWd.filter(d => d.orders > 0).sort((a, b) => a.net_profit - b.net_profit)[0], [byWd])

  // A1 heatmap.
  const hours = useMemo(() => {
    const set = new Set((report?.heatmap ?? []).map(c => c.hour))
    return [...set].sort((a, b) => a - b)
  }, [report])
  const cellMap = useMemo(() => {
    const m = new Map<string, number>()
    for (const c of report?.heatmap ?? []) m.set(`${c.weekday}:${c.hour}`, c.profit)
    return m
  }, [report])
  const maxCellProfit = useMemo(() => Math.max(1, ...(report?.heatmap ?? []).map(c => c.profit)), [report])

  // A2 category × weekday (revenue).
  const cats = useMemo(() => {
    const totals = new Map<string, number>()
    for (const r of report?.by_category ?? []) totals.set(r.category, (totals.get(r.category) ?? 0) + r.revenue)
    return [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(e => e[0])
  }, [report])
  const catMap = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of report?.by_category ?? []) m.set(`${r.category}:${r.weekday}`, r.revenue)
    return m
  }, [report])
  const maxCatRev = useMemo(() => Math.max(1, ...(report?.by_category ?? []).map(c => c.revenue)), [report])

  return (
    <div className="p-4 md:p-6 space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">Дни недели</h1>
          <p className="text-sm text-muted-foreground">
            {isCentral
              ? 'Прибыль по дням, день×час и категории по всей сети — чтобы планировать смены, заготовки и промо'
              : 'Прибыль по дням, день×час и категории — чтобы планировать смены, заготовки и промо'}
          </p>
        </div>
        <DatePeriodFilter period={period} onPeriodChange={setPeriod} customFrom={customFrom} customTo={customTo} onCustomFromChange={setCustomFrom} onCustomToChange={setCustomTo} />
      </div>

      {loading ? (
        <div className="flex h-64 items-center justify-center"><div className="size-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" /></div>
      ) : (
        <>
          {/* A3 — прибыль по дням недели */}
          <div className="bg-card rounded-xl border border-border p-4 md:p-5 space-y-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-sm font-semibold">Прибыль по дням недели</h2>
              <div className="text-xs text-muted-foreground">Прибыль после ФОТ = выручка − себестоимость − ФОТ смены (без прочих расходов)</div>
            </div>
            {best && worst && best.wd !== worst.wd && (
              <div className="flex flex-wrap gap-2 text-sm">
                <span className="rounded-lg bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300 px-3 py-1.5">
                  Лучший день: <b>{best.label}</b> · {formatCurrency(best.net_profit)}
                </span>
                <span className="rounded-lg bg-rose-50 text-rose-800 dark:bg-rose-950/40 dark:text-rose-300 px-3 py-1.5">
                  Худший день: <b>{worst.label}</b> · {formatCurrency(worst.net_profit)}
                </span>
              </div>
            )}
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={byWd} margin={{ top: 5, right: 16, left: 8, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis dataKey="label" tick={{ fontSize: 12 }} className="fill-muted-foreground" />
                <YAxis tick={{ fontSize: 12 }} className="fill-muted-foreground" tickFormatter={(v: number) => `${Math.round(v / 1000)}k`} />
                <Tooltip
                  formatter={(v: number, name) => [formatCurrency(v), name === 'net_profit' ? 'Прибыль после ФОТ' : name]}
                  labelFormatter={(l) => `${l}`}
                />
                <ReferenceLine y={0} className="stroke-border" />
                <Bar dataKey="net_profit" radius={[4, 4, 0, 0]}>
                  {byWd.map((d, i) => (
                    <Cell key={i} fill={d.net_profit >= 0 ? 'hsl(160 60% 40%)' : 'hsl(350 70% 55%)'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-muted-foreground text-xs border-b border-border">
                    <th className="text-left font-medium py-1.5">День</th>
                    <th className="text-right font-medium">Заказы</th>
                    <th className="text-right font-medium">Выручка</th>
                    <th className="text-right font-medium">Себест.</th>
                    <th className="text-right font-medium">ФОТ</th>
                    <th className="text-right font-medium">Чистая</th>
                    <th className="text-right font-medium">Ср. чек</th>
                  </tr>
                </thead>
                <tbody>
                  {byWd.map(d => (
                    <tr key={d.wd} className="border-b border-border/50">
                      <td className="py-1.5 font-medium">{d.label}</td>
                      <td className="text-right tabular-nums">{d.orders}</td>
                      <td className="text-right tabular-nums">{formatCurrency(d.revenue)}</td>
                      <td className="text-right tabular-nums text-muted-foreground">{formatCurrency(d.cogs)}</td>
                      <td className="text-right tabular-nums text-muted-foreground">{formatCurrency(d.labor)}</td>
                      <td className={`text-right tabular-nums font-semibold ${d.net_profit < 0 ? 'text-rose-600' : 'text-emerald-600'}`}>{formatCurrency(d.net_profit)}</td>
                      <td className="text-right tabular-nums">{formatCurrency(d.avg_check)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* A1 — heatmap день×час по прибыли */}
          {hours.length > 0 && (
            <div className="bg-card rounded-xl border border-border p-4 md:p-5 space-y-3">
              <h2 className="text-sm font-semibold">Прибыль по дням и часам</h2>
              <div className="overflow-x-auto">
                <table className="border-separate" style={{ borderSpacing: 2 }}>
                  <thead>
                    <tr>
                      <th></th>
                      {hours.map(h => <th key={h} className="text-[10px] font-normal text-muted-foreground px-1">{h}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {ORDER.map(wd => (
                      <tr key={wd}>
                        <td className="text-xs font-medium text-muted-foreground pr-2">{LABEL[wd]}</td>
                        {hours.map(h => {
                          const v = cellMap.get(`${wd}:${h}`) ?? 0
                          return (
                            <td key={h}>
                              <div
                                className={`h-7 w-9 rounded text-[9px] flex items-center justify-center tabular-nums ${profitClass(v, maxCellProfit)}`}
                                title={`${LABEL[wd]} ${h}:00 — прибыль ${formatCurrency(v)}`}
                              >
                                {v > 0 ? Math.round(v / 1000) + 'k' : ''}
                              </div>
                            </td>
                          )
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-muted-foreground">Тёмно-зелёные ячейки — самые прибыльные окна; розовые — в минус (выручка не покрывает себестоимость). Час — местное время кассы.</p>
            </div>
          )}

          {/* A2 — категории по дням недели */}
          {cats.length > 0 && (
            <div className="bg-card rounded-xl border border-border p-4 md:p-5 space-y-3">
              <h2 className="text-sm font-semibold">Что продаётся по дням недели</h2>
              <div className="overflow-x-auto">
                <table className="border-separate" style={{ borderSpacing: 2 }}>
                  <thead>
                    <tr>
                      <th className="text-left text-xs font-medium text-muted-foreground pr-2">Категория</th>
                      {ORDER.map(wd => <th key={wd} className="text-[11px] font-normal text-muted-foreground px-1">{LABEL[wd]}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {cats.map(cat => (
                      <tr key={cat}>
                        <td className="text-xs font-medium pr-2 max-w-[140px] truncate" title={cat}>{cat}</td>
                        {ORDER.map(wd => {
                          const v = catMap.get(`${cat}:${wd}`) ?? 0
                          return (
                            <td key={wd}>
                              <div
                                className={`h-7 w-12 rounded text-[9px] flex items-center justify-center tabular-nums ${profitClass(v, maxCatRev)}`}
                                title={`${cat} · ${LABEL[wd]} — выручка ${formatCurrency(v)}`}
                              >
                                {v > 0 ? Math.round(v / 1000) + 'k' : ''}
                              </div>
                            </td>
                          )
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-muted-foreground">Выручка по категориям ×  день недели. Видно, что и когда заходит — под дневное меню, заготовки и промо.</p>
            </div>
          )}
        </>
      )}
    </div>
  )
}
