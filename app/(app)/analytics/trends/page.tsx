'use client'

import { useState, useEffect, useMemo } from 'react'
import { toast } from 'sonner'
import {
  ComposedChart, Area, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts'
import { ArrowDownRight, ArrowUpRight, Download, Minus } from 'lucide-react'

import { formatCurrency } from '@/lib/helpers'
import { fetchTrends, type TrendsReport, type TrendBucket, type TrendGranularity } from '@/lib/queries/analytics'
import { exportToExcel } from '@/lib/export-excel'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'

// ─── Периоды и гранулярность ────────────────────────────────────────────────

type RangeKey = '7d' | '30d' | '90d' | '365d'
const RANGES: { key: RangeKey; label: string; days: number }[] = [
  { key: '7d', label: '7 дней', days: 7 },
  { key: '30d', label: '30 дней', days: 30 },
  { key: '90d', label: '90 дней', days: 90 },
  { key: '365d', label: 'Год', days: 365 },
]
const GRANS: { key: TrendGranularity; label: string }[] = [
  { key: 'day', label: 'По дням' },
  { key: 'week', label: 'По неделям' },
  { key: 'month', label: 'По месяцам' },
]

function rangeToDates(days: number): { from: string; to: string } {
  const to = new Date()
  const from = new Date()
  from.setDate(to.getDate() - days)
  return { from: from.toISOString(), to: to.toISOString() }
}

// ─── Конфиг метрик (одна вкладка = одна метрика) ─────────────────────────────

type MetricKey = 'revenue' | 'orders_count' | 'avg_check' | 'expenses'
type ChartKind = 'area' | 'bar' | 'line'

const METRICS: Record<MetricKey, {
  label: string
  kind: ChartKind
  color: string
  money: boolean
  goodWhenUp: boolean
  isAvg: boolean // метрика — не сумма (средний чек): «итого» = значение за период
}> = {
  revenue:      { label: 'Выручка',     kind: 'area', color: 'hsl(142 71% 45%)', money: true,  goodWhenUp: true,  isAvg: false },
  orders_count: { label: 'Заказы',      kind: 'bar',  color: 'hsl(217 91% 60%)', money: false, goodWhenUp: true,  isAvg: false },
  avg_check:    { label: 'Средний чек', kind: 'line', color: 'hsl(25 95% 53%)',  money: true,  goodWhenUp: true,  isAvg: true  },
  expenses:     { label: 'Расходы',     kind: 'area', color: 'hsl(0 72% 51%)',   money: true,  goodWhenUp: false, isAvg: false },
}

function fmtNum(v: number, money: boolean): string {
  return money ? formatCurrency(v) : new Intl.NumberFormat('ru-RU').format(Math.round(v))
}

function bucketLabel(date: string, gran: TrendGranularity): string {
  const [y, m, d] = date.split('-')
  if (gran === 'month') return `${m}.${y.slice(2)}`
  return `${d}.${m}`
}

// 7-точечное скользящее среднее (тренд-линия поверх графика).
function withMovingAvg(buckets: TrendBucket[], key: MetricKey, window = 7) {
  return buckets.map((b, i) => {
    const start = Math.max(0, i - window + 1)
    const slice = buckets.slice(start, i + 1)
    const ma = slice.reduce((s, x) => s + (x[key] as number), 0) / slice.length
    return { ...b, __ma: ma }
  })
}

function deltaPct(cur: number, prev: number): number | null {
  if (prev === 0) return cur === 0 ? 0 : null // null = нет базы для сравнения
  return ((cur - prev) / prev) * 100
}

// ─── KPI-карточка ────────────────────────────────────────────────────────────

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
      </CardContent>
    </Card>
  )
}

function DeltaKpi({ label, pct, goodWhenUp }: { label: string; pct: number | null; goodWhenUp: boolean }) {
  let color = 'text-muted-foreground'
  let Icon = Minus
  if (pct !== null && pct !== 0) {
    const up = pct > 0
    Icon = up ? ArrowUpRight : ArrowDownRight
    const good = up === goodWhenUp
    color = good ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'
  }
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className={`mt-1 flex items-center gap-1 text-xl font-semibold tabular-nums ${color}`}>
          <Icon className="h-4 w-4" />
          {pct === null ? '—' : `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`}
        </div>
      </CardContent>
    </Card>
  )
}

// ─── Один таб (метрика) ───────────────────────────────────────────────────────

function MetricTab({ report, metric }: { report: TrendsReport; metric: MetricKey }) {
  const cfg = METRICS[metric]
  const data = useMemo(() => withMovingAvg(report.buckets, metric), [report.buckets, metric])

  const values = report.buckets.map(b => b[metric] as number)
  const sum = values.reduce((s, v) => s + v, 0)
  const peak = values.length ? Math.max(...values) : 0
  const headline = cfg.isAvg ? report.totals.avg_check : sum
  const curForDelta = cfg.isAvg ? report.totals.avg_check : sum
  const prevForDelta = cfg.isAvg ? report.previous.avg_check
    : (metric === 'orders_count' ? report.previous.orders_count
      : metric === 'revenue' ? report.previous.revenue : report.previous.expenses)

  const yFmt = (v: number) => cfg.money ? `${(v / 1000).toFixed(0)}k` : new Intl.NumberFormat('ru-RU').format(v)

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Kpi label={cfg.isAvg ? 'Средний чек за период' : 'За период'} value={fmtNum(headline, cfg.money)} />
        <Kpi label={`Пик (${report.granularity === 'month' ? 'месяц' : report.granularity === 'week' ? 'неделя' : 'день'})`} value={fmtNum(peak, cfg.money)} />
        <DeltaKpi label="Δ к прошлому периоду" pct={deltaPct(curForDelta, prevForDelta)} goodWhenUp={cfg.goodWhenUp} />
      </div>

      <Card>
        <CardContent className="p-3 sm:p-4">
          <ResponsiveContainer width="100%" height={340}>
            <ComposedChart data={data} margin={{ top: 8, right: 16, left: 8, bottom: 4 }}>
              <defs>
                <linearGradient id={`grad-${metric}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={cfg.color} stopOpacity={0.35} />
                  <stop offset="95%" stopColor={cfg.color} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
              <XAxis
                dataKey="date" tick={{ fontSize: 11 }} className="fill-muted-foreground"
                tickFormatter={(d: string) => bucketLabel(d, report.granularity)} minTickGap={16}
              />
              <YAxis tick={{ fontSize: 11 }} className="fill-muted-foreground" tickFormatter={yFmt} width={44} />
              <Tooltip
                labelFormatter={(d: string) => bucketLabel(String(d), report.granularity)}
                formatter={(value: number, name: string) => [fmtNum(value, cfg.money), name === '__ma' ? 'Тренд (ср. 7)' : cfg.label]}
                contentStyle={{ borderRadius: 8, border: '1px solid hsl(var(--border))', background: 'hsl(var(--popover))' }}
              />
              {cfg.kind === 'area' && (
                <Area type="monotone" dataKey={metric} stroke={cfg.color} strokeWidth={2} fill={`url(#grad-${metric})`} />
              )}
              {cfg.kind === 'bar' && (
                <Bar dataKey={metric} fill={cfg.color} radius={[4, 4, 0, 0]} maxBarSize={48} />
              )}
              {cfg.kind === 'line' && (
                <Line type="monotone" dataKey={metric} stroke={cfg.color} strokeWidth={2} dot={false} />
              )}
              <Line type="monotone" dataKey="__ma" stroke="hsl(var(--foreground))" strokeWidth={1.5} strokeDasharray="5 4" dot={false} opacity={0.55} />
            </ComposedChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>
    </div>
  )
}

// ─── Страница ─────────────────────────────────────────────────────────────────

export default function TrendsPage() {
  const [range, setRange] = useState<RangeKey>('30d')
  const [gran, setGran] = useState<TrendGranularity>('day')
  const [report, setReport] = useState<TrendsReport | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    setLoading(true)
    const days = RANGES.find(r => r.key === range)!.days
    fetchTrends({ ...rangeToDates(days), granularity: gran })
      .then(r => { if (alive) setReport(r) })
      .catch((e) => { if (alive) toast.error('Не удалось загрузить динамику: ' + (e?.message ?? e)) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [range, gran])

  function handleExport() {
    if (!report) return
    exportToExcel(
      report.buckets as unknown as Record<string, unknown>[],
      [
        { key: 'date', header: 'Период' },
        { key: 'revenue', header: 'Выручка', format: v => Number(v) },
        { key: 'orders_count', header: 'Заказов', format: v => Number(v) },
        { key: 'avg_check', header: 'Средний чек', format: v => Number(v) },
        { key: 'expenses', header: 'Расходы', format: v => Number(v) },
      ],
      `Динамика_${gran}`,
      'Динамика',
    )
  }

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Динамика</h1>
          <p className="text-sm text-muted-foreground">Выручка, заказы, средний чек и расходы во времени</p>
        </div>
        <Button variant="outline" size="sm" onClick={handleExport} disabled={!report}>
          <Download className="mr-2 h-4 w-4" /> Excel
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-lg border bg-card p-0.5">
          {RANGES.map(r => (
            <Button key={r.key} size="sm" variant={range === r.key ? 'default' : 'ghost'}
              className="h-8" onClick={() => setRange(r.key)}>{r.label}</Button>
          ))}
        </div>
        <div className="inline-flex rounded-lg border bg-card p-0.5">
          {GRANS.map(g => (
            <Button key={g.key} size="sm" variant={gran === g.key ? 'default' : 'ghost'}
              className="h-8" onClick={() => setGran(g.key)}>{g.label}</Button>
          ))}
        </div>
      </div>

      {loading || !report ? (
        <div className="flex h-80 items-center justify-center text-muted-foreground">Загрузка…</div>
      ) : (
        <Tabs defaultValue="revenue">
          <TabsList className="grid w-full grid-cols-2 sm:w-auto sm:inline-flex">
            <TabsTrigger value="revenue">Выручка</TabsTrigger>
            <TabsTrigger value="orders_count">Заказы</TabsTrigger>
            <TabsTrigger value="avg_check">Средний чек</TabsTrigger>
            <TabsTrigger value="expenses">Расходы</TabsTrigger>
          </TabsList>
          <TabsContent value="revenue" className="mt-4"><MetricTab report={report} metric="revenue" /></TabsContent>
          <TabsContent value="orders_count" className="mt-4"><MetricTab report={report} metric="orders_count" /></TabsContent>
          <TabsContent value="avg_check" className="mt-4"><MetricTab report={report} metric="avg_check" /></TabsContent>
          <TabsContent value="expenses" className="mt-4"><MetricTab report={report} metric="expenses" /></TabsContent>
        </Tabs>
      )}
    </div>
  )
}
