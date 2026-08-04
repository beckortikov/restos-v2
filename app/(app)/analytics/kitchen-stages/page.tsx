'use client'

import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import * as XLSX from 'xlsx'
import { Download, Timer, Hourglass, Flame, AlertTriangle } from 'lucide-react'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts'

import { fetchKitchenStageReport, type KitchenStageReport, type KitchenStageRow } from '@/lib/queries/analytics'
import { DateRangePicker } from '@/components/ui/date-range-picker'
import { getPresetRange } from '@/components/finance/date-range-presets'
import { STATION_LABELS, type MenuStation } from '@/lib/types'
import { useAuth } from '@/lib/auth-store'

const today = () => new Date().toISOString().slice(0, 10)

// Превышение тех-карты меньше этого запаса не считаем «медленно» — норматив
// редко бьётся секунда-в-секунду, 15% — разумный люфт до алерта.
const OVER_THRESHOLD = 1.15

type Dim = 'dish' | 'category'

function fmtMin(n: number): string {
  return n.toFixed(1)
}

function stationLabel(s: string): string {
  return STATION_LABELS[s as MenuStation] ?? s
}

function appendSheet(wb: XLSX.WorkBook, name: string, rows: Record<string, unknown>[]) {
  const ws = XLSX.utils.json_to_sheet(rows)
  XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 31))
}

interface DisplayRow {
  key: string
  name: string
  station: string
  itemCount: number
  avgQueueMin: number
  avgCookMin: number
  avgHoldMin: number
  avgTotalMin: number
  techMin: number | null
  deltaMin: number | null
}

function toDisplayRow(r: KitchenStageRow, name: string): DisplayRow {
  return {
    key: `${name}|${r.station}`,
    name,
    station: r.station,
    itemCount: r.item_count,
    avgQueueMin: Number(r.avg_queue_min),
    avgCookMin: Number(r.avg_cook_min),
    avgHoldMin: Number(r.avg_hold_min),
    avgTotalMin: Number(r.avg_total_min),
    techMin: r.tech_cook_time_min ?? null,
    deltaMin: r.delta_min != null ? Number(r.delta_min) : null,
  }
}

// Агрегация дишей в категории: средние — взвешенные по item_count, иначе
// категория из одного популярного блюда искажает картину.
function aggregateByCategory(rows: KitchenStageRow[]): DisplayRow[] {
  const map = new Map<string, { name: string; station: string; count: number; queue: number; cook: number; hold: number; total: number; techSum: number; techCount: number }>()
  for (const r of rows) {
    const key = `${r.category || 'Без категории'}|${r.station}`
    let e = map.get(key)
    if (!e) {
      e = { name: r.category || 'Без категории', station: r.station, count: 0, queue: 0, cook: 0, hold: 0, total: 0, techSum: 0, techCount: 0 }
      map.set(key, e)
    }
    const c = r.item_count
    e.count += c
    e.queue += Number(r.avg_queue_min) * c
    e.cook += Number(r.avg_cook_min) * c
    e.hold += Number(r.avg_hold_min) * c
    e.total += Number(r.avg_total_min) * c
    if (r.tech_cook_time_min != null) { e.techSum += r.tech_cook_time_min * c; e.techCount += c }
  }
  return [...map.values()].map(e => {
    const avgCook = e.count > 0 ? e.cook / e.count : 0
    const techMin = e.techCount > 0 ? e.techSum / e.techCount : null
    return {
      key: `${e.name}|${e.station}`,
      name: e.name,
      station: e.station,
      itemCount: e.count,
      avgQueueMin: e.count > 0 ? e.queue / e.count : 0,
      avgCookMin: avgCook,
      avgHoldMin: e.count > 0 ? e.hold / e.count : 0,
      avgTotalMin: e.count > 0 ? e.total / e.count : 0,
      techMin,
      deltaMin: techMin != null ? avgCook - techMin : null,
    }
  })
}

export default function KitchenStagesPage() {
  const { canDo } = useAuth()
  const [report, setReport] = useState<KitchenStageReport | null>(null)
  const [loading, setLoading] = useState(true)

  const initial = getPresetRange('week')
  const [dateFrom, setDateFrom] = useState(initial.from)
  const [dateTo, setDateTo] = useState(initial.to)
  const [dim, setDim] = useState<Dim>('dish')
  const [station, setStation] = useState<string>('all')

  useEffect(() => {
    setLoading(true)
    fetchKitchenStageReport({ from: dateFrom, to: dateTo })
      .then(setReport)
      .catch(() => toast.error('Ошибка загрузки отчёта по кухне'))
      .finally(() => setLoading(false))
  }, [dateFrom, dateTo])

  const stations = useMemo(() => {
    const set = new Set((report?.rows ?? []).map(r => r.station))
    return [...set].sort()
  }, [report])

  const filteredRows = useMemo(() => {
    const rows = report?.rows ?? []
    return station === 'all' ? rows : rows.filter(r => r.station === station)
  }, [report, station])

  const displayRows = useMemo(() => {
    const rows = dim === 'dish'
      ? filteredRows.map(r => toDisplayRow(r, r.dish_name))
      : aggregateByCategory(filteredRows)
    return rows.sort((a, b) => b.avgCookMin - a.avgCookMin)
  }, [filteredRows, dim])

  // KPI — взвешенные по item_count, всегда на dish-уровне (точнее категорийного).
  const kpi = useMemo(() => {
    const rows = filteredRows
    const totalCount = rows.reduce((s, r) => s + r.item_count, 0)
    if (totalCount === 0) return null
    const wsum = (pick: (r: KitchenStageRow) => number) => rows.reduce((s, r) => s + pick(r) * r.item_count, 0) / totalCount
    const withTech = rows.filter(r => r.tech_cook_time_min != null)
    const techCount = withTech.reduce((s, r) => s + r.item_count, 0)
    const avgTech = techCount > 0 ? withTech.reduce((s, r) => s + (r.tech_cook_time_min as number) * r.item_count, 0) / techCount : null
    const overCount = withTech
      .filter(r => Number(r.avg_cook_min) > (r.tech_cook_time_min as number) * OVER_THRESHOLD)
      .reduce((s, r) => s + r.item_count, 0)
    return {
      avgCook: wsum(r => Number(r.avg_cook_min)),
      avgQueue: wsum(r => Number(r.avg_queue_min)),
      avgHold: wsum(r => Number(r.avg_hold_min)),
      deltaVsTech: avgTech != null ? wsum(r => Number(r.avg_cook_min)) - avgTech : null,
      overPct: techCount > 0 ? (overCount / techCount) * 100 : null,
    }
  }, [filteredRows])

  // Стадии по станциям — всегда dish-уровень, свёрнутый по станции (не зависит от dim).
  const stationChart = useMemo(() => {
    const map = new Map<string, { station: string; count: number; queue: number; cook: number; hold: number }>()
    for (const r of filteredRows) {
      let e = map.get(r.station)
      if (!e) { e = { station: r.station, count: 0, queue: 0, cook: 0, hold: 0 }; map.set(r.station, e) }
      const c = r.item_count
      e.count += c
      e.queue += Number(r.avg_queue_min) * c
      e.cook += Number(r.avg_cook_min) * c
      e.hold += Number(r.avg_hold_min) * c
    }
    return [...map.values()]
      .map(e => ({
        station: stationLabel(e.station),
        Ожидание: e.count > 0 ? Number((e.queue / e.count).toFixed(1)) : 0,
        Готовка: e.count > 0 ? Number((e.cook / e.count).toFixed(1)) : 0,
        Остывание: e.count > 0 ? Number((e.hold / e.count).toFixed(1)) : 0,
      }))
      .sort((a, b) => (b.Ожидание + b.Готовка + b.Остывание) - (a.Ожидание + a.Готовка + a.Остывание))
  }, [filteredRows])

  // Топ-5 блюд с наибольшим превышением тех-карты (факт vs норматив).
  const compareChart = useMemo(() => {
    return filteredRows
      .filter(r => r.tech_cook_time_min != null)
      .map(r => ({ name: r.dish_name, Факт: Number(Number(r.avg_cook_min).toFixed(1)), 'Тех.карта': r.tech_cook_time_min as number, delta: Number(r.delta_min ?? 0) }))
      .sort((a, b) => b.delta - a.delta)
      .slice(0, 5)
  }, [filteredRows])

  function exportReport() {
    const wb = XLSX.utils.book_new()
    const rows = displayRows.map((r, i) => ({
      '#': i + 1,
      [dim === 'dish' ? 'Блюдо' : 'Категория']: r.name,
      'Станция': stationLabel(r.station),
      'Кол-во': r.itemCount,
      'Ожидание, мин': Number(r.avgQueueMin.toFixed(1)),
      'Готовка, мин': Number(r.avgCookMin.toFixed(1)),
      'Тех.карта, мин': r.techMin != null ? Number(r.techMin.toFixed(1)) : '',
      'Δ, мин': r.deltaMin != null ? Number(r.deltaMin.toFixed(1)) : '',
      'Остывание, мин': Number(r.avgHoldMin.toFixed(1)),
      'Итого, мин': Number(r.avgTotalMin.toFixed(1)),
    }))
    appendSheet(wb, dim === 'dish' ? 'Блюда' : 'Категории', rows)
    XLSX.writeFile(wb, `Время_блюда_${dateFrom}_${dateTo}.xlsx`)
  }

  if (!canDo('analytics.view')) {
    return <div className="p-6 text-center text-muted-foreground">Нет доступа</div>
  }

  return (
    <div className="p-4 md:p-6 space-y-4 md:space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-foreground">Время блюда по станциям</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Сколько блюдо стоит на каждой стадии — и как это соотносится с тех-картой</p>
        </div>
        <div className="flex items-center gap-2">
          <DateRangePicker from={dateFrom} to={dateTo} maxDate={today()} onChange={r => { setDateFrom(r.from); setDateTo(r.to) }} />
          <button onClick={exportReport} disabled={displayRows.length === 0} className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-sm text-foreground hover:bg-muted transition-colors disabled:opacity-50 disabled:pointer-events-none" title="Выгрузить в Excel">
            <Download className="size-4" />
            <span className="hidden sm:inline">Excel</span>
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex h-64 items-center justify-center"><div className="size-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" /></div>
      ) : !kpi ? (
        <div className="bg-card rounded-xl border border-border p-10 text-center text-sm text-muted-foreground">
          Нет завершённых блюд за выбранный период
        </div>
      ) : (
        <>
          {/* KPI */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5 md:gap-3">
            <KpiCard label="Ср. готовка" value={`${fmtMin(kpi.avgCook)} мин`} sub={kpi.deltaVsTech != null ? `${kpi.deltaVsTech >= 0 ? '+' : ''}${fmtMin(kpi.deltaVsTech)} мин к тех.карте` : 'нет норматива'} icon={Flame} color="bg-orange-500/10 text-orange-600" warn={kpi.deltaVsTech != null && kpi.deltaVsTech > 0} />
            <KpiCard label="Ср. ожидание в очереди" value={`${fmtMin(kpi.avgQueue)} мин`} sub="до старта готовки" icon={Hourglass} color="bg-amber-500/10 text-amber-600" />
            <KpiCard label="Ср. остывание" value={`${fmtMin(kpi.avgHold)} мин`} sub="готово → подано" icon={Timer} color="bg-blue-500/10 text-blue-600" />
            <KpiCard label="Превышают норматив" value={kpi.overPct != null ? `${kpi.overPct.toFixed(0)}%` : '—'} sub="блюд с тех.картой" icon={AlertTriangle} color="bg-red-500/10 text-red-600" warn={(kpi.overPct ?? 0) > 20} />
          </div>

          {/* Фильтры */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex gap-1 bg-muted/50 p-1 rounded-lg">
              {([['dish', 'Блюда'], ['category', 'Категории']] as const).map(([k, l]) => (
                <button key={k} onClick={() => setDim(k)} className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${dim === k ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>{l}</button>
              ))}
            </div>
            <div className="flex flex-wrap gap-1 bg-muted/50 p-1 rounded-lg">
              <button onClick={() => setStation('all')} className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${station === 'all' ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>Все станции</button>
              {stations.map(s => (
                <button key={s} onClick={() => setStation(s)} className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${station === s ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>{stationLabel(s)}</button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Стадии по станциям */}
            <div className="bg-card rounded-xl border border-border p-4 md:p-5">
              <h2 className="text-sm font-semibold text-foreground mb-1">Стадии по станциям</h2>
              <p className="text-xs text-muted-foreground mb-3">Средние минуты на блюдо — где копится время, видно по длине сегмента</p>
              {stationChart.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-10">Нет данных</p>
              ) : (
                <ResponsiveContainer width="100%" height={Math.max(200, stationChart.length * 56)}>
                  <BarChart data={stationChart} layout="vertical" margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-border" horizontal={false} />
                    <XAxis type="number" tick={{ fontSize: 12 }} className="fill-muted-foreground" unit=" мин" />
                    <YAxis type="category" dataKey="station" tick={{ fontSize: 12 }} className="fill-muted-foreground" width={90} />
                    <Tooltip formatter={(v: number) => `${v} мин`} />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Bar dataKey="Ожидание" stackId="a" fill="hsl(40, 30%, 75%)" />
                    <Bar dataKey="Готовка" stackId="a" fill="hsl(30, 70%, 55%)" />
                    <Bar dataKey="Остывание" stackId="a" fill="hsl(25, 50%, 35%)" radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>

            {/* Факт vs тех.карта */}
            <div className="bg-card rounded-xl border border-border p-4 md:p-5">
              <h2 className="text-sm font-semibold text-foreground mb-1">Факт vs тех.карта</h2>
              <p className="text-xs text-muted-foreground mb-3">Топ-5 блюд по превышению норматива готовки</p>
              {compareChart.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-10">Нет блюд с заполненным нормативом</p>
              ) : (
                <ResponsiveContainer width="100%" height={Math.max(200, compareChart.length * 56)}>
                  <BarChart data={compareChart} layout="vertical" margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-border" horizontal={false} />
                    <XAxis type="number" tick={{ fontSize: 12 }} className="fill-muted-foreground" unit=" мин" />
                    <YAxis type="category" dataKey="name" tick={{ fontSize: 12 }} className="fill-muted-foreground" width={110} />
                    <Tooltip formatter={(v: number) => `${v} мин`} />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Bar dataKey="Факт" fill="hsl(4, 70%, 50%)" radius={[0, 4, 4, 0]} />
                    <Bar dataKey="Тех.карта" fill="hsl(30, 10%, 75%)" radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>

          {/* Таблица */}
          <div className="bg-card rounded-xl border border-border p-4 md:p-5">
            <h2 className="text-sm font-semibold text-foreground mb-3">{dim === 'dish' ? 'Блюда' : 'Категории'} · детализация по станциям</h2>
            {displayRows.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-10">Нет данных за выбранный период</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-muted-foreground border-b border-border">
                      <th className="text-left font-medium py-2 pr-2">{dim === 'dish' ? 'Блюдо' : 'Категория'}</th>
                      <th className="text-left font-medium py-2 px-2">Станция</th>
                      <th className="text-right font-medium py-2 px-2">Кол-во</th>
                      <th className="text-right font-medium py-2 px-2">Ожидание</th>
                      <th className="text-right font-medium py-2 px-2">Готовка</th>
                      <th className="text-right font-medium py-2 px-2">Тех.карта</th>
                      <th className="text-right font-medium py-2 px-2">Δ</th>
                      <th className="text-right font-medium py-2 px-2">Остывание</th>
                      <th className="text-right font-medium py-2 px-2">Итого</th>
                      <th className="text-left font-medium py-2 pl-2">Статус</th>
                    </tr>
                  </thead>
                  <tbody>
                    {displayRows.map(r => {
                      const isOver = r.techMin != null && r.avgCookMin > r.techMin * OVER_THRESHOLD
                      const isFast = r.techMin != null && !isOver
                      return (
                        <tr key={r.key} className="border-b border-border/50 last:border-0">
                          <td className="py-2 pr-2 font-medium truncate max-w-[220px]">{r.name}</td>
                          <td className="py-2 px-2 text-muted-foreground">{stationLabel(r.station)}</td>
                          <td className="py-2 px-2 text-right tabular-nums">{r.itemCount}</td>
                          <td className="py-2 px-2 text-right tabular-nums">{fmtMin(r.avgQueueMin)}</td>
                          <td className="py-2 px-2 text-right tabular-nums font-medium">{fmtMin(r.avgCookMin)}</td>
                          <td className="py-2 px-2 text-right tabular-nums text-muted-foreground">{r.techMin != null ? fmtMin(r.techMin) : '—'}</td>
                          <td className={`py-2 px-2 text-right tabular-nums font-medium ${r.deltaMin == null ? 'text-muted-foreground' : r.deltaMin > 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
                            {r.deltaMin != null ? `${r.deltaMin >= 0 ? '+' : ''}${fmtMin(r.deltaMin)}` : '—'}
                          </td>
                          <td className="py-2 px-2 text-right tabular-nums">{fmtMin(r.avgHoldMin)}</td>
                          <td className="py-2 px-2 text-right tabular-nums">{fmtMin(r.avgTotalMin)}</td>
                          <td className="py-2 pl-2">
                            {isOver && <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-red-500/10 text-red-600 dark:text-red-400">Медленно</span>}
                            {isFast && <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">В норме</span>}
                          </td>
                        </tr>
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

function KpiCard({ label, value, sub, icon: Icon, color, warn }: { label: string; value: string; sub: string; icon: React.ElementType; color: string; warn?: boolean }) {
  return (
    <div className="bg-card rounded-xl border border-border p-3.5">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs text-muted-foreground">{label}</span>
        <div className={`size-7 rounded-md flex items-center justify-center ${color}`}><Icon className="size-3.5" /></div>
      </div>
      <p className="text-lg font-bold tabular-nums">{value}</p>
      <p className={`text-xs mt-0.5 ${warn ? 'text-red-600 dark:text-red-400 font-medium' : 'text-muted-foreground'}`}>{sub}</p>
    </div>
  )
}
