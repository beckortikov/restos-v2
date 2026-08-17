'use client'

import { FinanceTabs } from '@/components/finance/finance-tabs'

import { useState, useEffect, useMemo, useCallback } from 'react'
import { formatCurrency } from '@/lib/helpers'
import { type FinancialOperation, finopCategoryLabel } from '@/lib/types'
import { fetchFinancialOperations } from '@/lib/queries'
import { useDataSync } from '@/hooks/use-data-sync'
import { exportToExcel } from '@/lib/export-excel'
import { DateRangePresets, getPresetRange, type RangePreset } from '@/components/finance/date-range-presets'
import { BarChart3, PieChart as PieIcon, Table as TableIcon, Download, TrendingDown, TrendingUp, Layers, ChevronRight } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  PieChart, Pie, Cell,
  BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend,
} from 'recharts'

// «Расходы по статьям» — динамика расходов за выбранный период в трёх видах:
// гистограмма (по периодам, с накоплением по статьям), круговая (доли статей
// за весь период) и таблица (статьи × периоды + Δ к предыдущему).
//
// Данные считаются на клиенте из financial_operations (type=out) — у каждой
// операции есть дата, категория и сумма. Отдельный бэк-эндпоинт не нужен:
// ДДС и так грузит этот же список.

type ViewKind = 'bars' | 'pie' | 'table'
type Gran = 'day' | 'week' | 'month'

const CHART_COLORS = ['#e87c4f', '#4f9ee8', '#5cb85c', '#f0ad4e', '#d9534f', '#9b59b6', '#1abc9c', '#34495e', '#e2a03f', '#7f8c8d']
const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек']

// В стопке/таблице показываем топ-N статей, остальное сворачиваем в «Прочее» —
// иначе на графике каша из десятков цветов.
const TOP_N = 8

function pad(n: number): string { return String(n).padStart(2, '0') }

/** Ключ ведра по гранулярности (локальные даты, как и пресеты периодов). */
function bucketKeyOf(iso: string, gran: Gran): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  if (gran === 'month') return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`
  if (gran === 'week') {
    // Понедельник недели — как начало ведра.
    const wd = (d.getDay() + 6) % 7
    const s = new Date(d.getFullYear(), d.getMonth(), d.getDate() - wd)
    return `${s.getFullYear()}-${pad(s.getMonth() + 1)}-${pad(s.getDate())}`
  }
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Подпись значения в тултипе: сумма + доля от итога периода. */
function tooltipValue(value: number, sum: number): string {
  const pct = sum > 0 ? (value / sum) * 100 : 0
  return `${formatCurrency(value)} · ${pct.toFixed(1)}%`
}

function bucketLabelOf(key: string, gran: Gran): string {
  const [y, m, dd] = key.split('-')
  const mi = Number(m) - 1
  if (gran === 'month') return `${MONTHS_SHORT[mi] ?? m} ${y}`
  return `${Number(dd)} ${MONTHS_SHORT[mi] ?? m}`
}

export default function ExpensesByCategoryPage() {
  const [ops, setOps] = useState<FinancialOperation[]>([])
  const [loading, setLoading] = useState(true)
  const [preset, setPreset] = useState<RangePreset>('month')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [view, setView] = useState<ViewKind>('bars')
  const [gran, setGran] = useState<Gran>('month')
  // Провал внутрь статьи (запрос владельца): клик по категории → детализация
  // операций этой статьи (кому/когда/сколько). Напр. «Оплата труда» → кому и
  // когда платили; «Поставщики» → какому поставщику сколько.
  const [drillCat, setDrillCat] = useState<string | null>(null)

  const load = useCallback(async () => {
    const data = await fetchFinancialOperations()
    setOps(data)
  }, [])

  useEffect(() => { load().finally(() => setLoading(false)) }, [load])
  useDataSync(['financial_operations'], load)

  const range = useMemo(() => getPresetRange(preset, customFrom, customTo), [preset, customFrom, customTo])

  // Быстрые «скользящие» диапазоны для сравнения месяцев: последние N полных
  // месяцев включая текущий. Пресеты общего компонента дают только
  // календарный месяц/квартал/год, а для сравнения нужен именно ряд месяцев.
  const setRollingMonths = useCallback((months: number) => {
    const now = new Date()
    const start = new Date(now.getFullYear(), now.getMonth() - (months - 1), 1)
    const from = `${start.getFullYear()}-${pad(start.getMonth() + 1)}-01`
    const to = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
    setCustomFrom(from)
    setCustomTo(to)
    setPreset('custom')
    setGran('month')
  }, [])

  // Какой из быстрых диапазонов сейчас активен (для подсветки чипа).
  const activeRolling = useMemo(() => {
    if (preset !== 'custom' || !customFrom) return 0
    for (const m of [3, 6, 12]) {
      const now = new Date()
      const start = new Date(now.getFullYear(), now.getMonth() - (m - 1), 1)
      if (customFrom === `${start.getFullYear()}-${pad(start.getMonth() + 1)}-01`) return m
    }
    return 0
  }, [preset, customFrom])

  // Расходы выбранного периода (type=out; переводы между счетами не расход).
  const expenses = useMemo(() => {
    return ops.filter((o) => {
      if (o.type !== 'out') return false
      if (o.activity === 'financial') return false
      const day = (o.date ?? '').slice(0, 10)
      if (!day) return false
      if (range.from && day < range.from) return false
      if (range.to && day > range.to) return false
      return true
    })
  }, [ops, range])

  const total = useMemo(() => expenses.reduce((s, o) => s + o.amount, 0), [expenses])

  // Статьи, отсортированные по сумме; хвост за топ-N — в «Прочее».
  const { categories, byCategory } = useMemo(() => {
    const m = new Map<string, number>()
    for (const o of expenses) {
      const label = finopCategoryLabel(o.category) || 'Без статьи'
      m.set(label, (m.get(label) ?? 0) + o.amount)
    }
    const sorted = [...m.entries()].sort((a, b) => b[1] - a[1])
    return { categories: sorted.map(([name]) => name), byCategory: sorted }
  }, [expenses])

  // Детализация выбранной статьи: операции + разбивка «кому сколько».
  const drillOps = useMemo(() => {
    if (!drillCat) return []
    return expenses
      .filter((o) => (finopCategoryLabel(o.category) || 'Без статьи') === drillCat)
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
  }, [expenses, drillCat])
  const drillByPayee = useMemo(() => {
    const m = new Map<string, number>()
    for (const o of drillOps) {
      const who = (o.counterparty || o.description || '—').trim() || '—'
      m.set(who, (m.get(who) ?? 0) + o.amount)
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [drillOps])
  const drillTotal = useMemo(() => drillOps.reduce((s, o) => s + o.amount, 0), [drillOps])

  const topCategories = useMemo(() => {
    if (categories.length <= TOP_N) return categories
    return [...categories.slice(0, TOP_N), 'Прочее']
  }, [categories])

  const catToSeries = useCallback((label: string): string => {
    if (categories.length <= TOP_N) return label
    return categories.indexOf(label) < TOP_N ? label : 'Прочее'
  }, [categories])

  // Вёдра периода (только те, где были расходы) — по возрастанию.
  const buckets = useMemo(() => {
    const set = new Set<string>()
    for (const o of expenses) {
      const k = bucketKeyOf(o.date, gran)
      if (k) set.add(k)
    }
    return [...set].sort()
  }, [expenses, gran])

  // Матрица «ведро → статья → сумма» для гистограммы и таблицы.
  const matrix = useMemo(() => {
    const m = new Map<string, Map<string, number>>()
    for (const o of expenses) {
      const k = bucketKeyOf(o.date, gran)
      if (!k) continue
      const series = catToSeries(finopCategoryLabel(o.category) || 'Без статьи')
      const row = m.get(k) ?? new Map<string, number>()
      row.set(series, (row.get(series) ?? 0) + o.amount)
      m.set(k, row)
    }
    return m
  }, [expenses, gran, catToSeries])

  const barData = useMemo(() => buckets.map((k) => {
    const row: Record<string, string | number | null> = { bucket: bucketLabelOf(k, gran) }
    const cell = matrix.get(k)
    // Нулевые статьи кладём как null: сегмент не рисуется, и recharts (filterNull)
    // не показывает их строками «0,00 с. · 0.0%» в подсказке.
    for (const c of topCategories) {
      const v = cell?.get(c) ?? 0
      row[c] = v > 0 ? v : null
    }
    return row
  }), [buckets, matrix, topCategories, gran])

  const pieData = useMemo(() => byCategory
    .filter(([, v]) => v > 0)
    .map(([name, value]) => ({ name, value })), [byCategory])

  // Отдельная круговая на каждый период (месяц/неделю/день) — чтобы сравнивать
  // структуру расходов между периодами, а не только суммарную за весь диапазон.
  // Цвет статьи берём по её индексу в topCategories, поэтому один и тот же цвет
  // означает одну и ту же статью на всех диаграммах и в гистограмме.
  const pieByBucket = useMemo(() => buckets.map((k) => {
    const cell = matrix.get(k)
    const data = topCategories
      .map((name) => ({ name, value: cell?.get(name) ?? 0 }))
      .filter((d) => d.value > 0)
    return {
      key: k,
      label: bucketLabelOf(k, gran),
      total: data.reduce((s, d) => s + d.value, 0),
      data,
    }
  }), [buckets, matrix, topCategories, gran])

  // Итог по каждому ведру + Δ к предыдущему — для таблицы и KPI.
  const bucketTotals = useMemo(() => buckets.map((k) => {
    const cell = matrix.get(k)
    let s = 0
    if (cell) for (const v of cell.values()) s += v
    return s
  }), [buckets, matrix])

  const lastDelta = useMemo(() => {
    if (bucketTotals.length < 2) return null
    const cur = bucketTotals[bucketTotals.length - 1]
    const prev = bucketTotals[bucketTotals.length - 2]
    if (prev === 0) return null
    return ((cur - prev) / prev) * 100
  }, [bucketTotals])

  function handleExport() {
    const rows: Record<string, unknown>[] = byCategory.map(([cat, catTotal]) => {
      const row: Record<string, unknown> = { category: cat, total: catTotal }
      for (const k of buckets) row[k] = matrix.get(k)?.get(catToSeries(cat)) ?? 0
      return row
    })
    const columns = [
      { key: 'category', header: 'Статья' },
      ...buckets.map((k) => ({ key: k, header: bucketLabelOf(k, gran) })),
      { key: 'total', header: 'Итого' },
    ]
    exportToExcel(rows, columns, `Расходы_по_статьям_${range.from}_${range.to}`, 'Расходы')
  }

  if (loading) {
    return <div className="p-6 flex items-center justify-center h-64"><div className="size-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" /></div>
  }

  const VIEWS: { key: ViewKind; label: string; icon: typeof BarChart3 }[] = [
    { key: 'bars', label: 'Гистограмма', icon: BarChart3 },
    { key: 'pie', label: 'Круговая', icon: PieIcon },
    { key: 'table', label: 'Таблица', icon: TableIcon },
  ]
  const GRANS: { key: Gran; label: string }[] = [
    { key: 'day', label: 'По дням' },
    { key: 'week', label: 'По неделям' },
    { key: 'month', label: 'По месяцам' },
  ]

  return (
    <div className="p-4 md:p-6 space-y-4 md:space-y-5 max-w-6xl mx-auto">
      <FinanceTabs />
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-foreground">Расходы по статьям</h1>
          <p className="text-muted-foreground text-sm mt-0.5">Динамика и структура расходов за период</p>
        </div>
        {expenses.length > 0 && (
          <button
            onClick={handleExport}
            className="flex items-center gap-2 bg-card border border-border text-foreground px-3.5 py-2 rounded-lg text-sm font-medium hover:bg-muted transition-colors justify-center"
          >
            <Download className="size-4" />
            Excel
          </button>
        )}
      </div>

      {/* Период */}
      <div className="space-y-2">
        <DateRangePresets
          value={preset}
          onChange={(p) => setPreset(p)}
          customFrom={customFrom}
          customTo={customTo}
          onCustomFromChange={setCustomFrom}
          onCustomToChange={setCustomTo}
        />
        {/* Сравнение месяцев: скользящий ряд последних N месяцев */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">Сравнить:</span>
          {[3, 6, 12].map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setRollingMonths(m)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                activeRolling === m
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-card border-border text-foreground hover:bg-muted'
              }`}
            >
              {m} мес.
            </button>
          ))}
        </div>
      </div>

      {/* KPI */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="bg-card rounded-xl border border-border p-4 flex items-center gap-3">
          <div className="size-10 rounded-lg bg-destructive/10 text-destructive flex items-center justify-center shrink-0">
            <TrendingDown className="size-5" />
          </div>
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground uppercase tracking-wide">Расходы за период</p>
            <p className="text-lg font-bold text-foreground tabular-nums truncate">{formatCurrency(total)}</p>
          </div>
        </div>
        <div className="bg-card rounded-xl border border-border p-4 flex items-center gap-3">
          <div className="size-10 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
            <Layers className="size-5" />
          </div>
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground uppercase tracking-wide">Крупнейшая статья</p>
            <p className="text-sm font-bold text-foreground truncate">{byCategory[0]?.[0] ?? '—'}</p>
            {byCategory[0] && (
              <p className="text-xs text-muted-foreground tabular-nums">
                {formatCurrency(byCategory[0][1])} · {total > 0 ? Math.round((byCategory[0][1] / total) * 100) : 0}%
              </p>
            )}
          </div>
        </div>
        <div className="bg-card rounded-xl border border-border p-4 flex items-center gap-3">
          <div className={`size-10 rounded-lg flex items-center justify-center shrink-0 ${lastDelta != null && lastDelta > 0 ? 'bg-destructive/10 text-destructive' : 'bg-emerald-100 dark:bg-emerald-500/15 text-emerald-600'}`}>
            {lastDelta != null && lastDelta > 0 ? <TrendingUp className="size-5" /> : <TrendingDown className="size-5" />}
          </div>
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground uppercase tracking-wide">
              Δ к прошлому {gran === 'month' ? 'месяцу' : gran === 'week' ? 'неделе' : 'дню'}
            </p>
            <p className={`text-lg font-bold tabular-nums ${lastDelta == null ? 'text-muted-foreground' : lastDelta > 0 ? 'text-destructive' : 'text-emerald-600'}`}>
              {lastDelta == null ? '—' : `${lastDelta > 0 ? '+' : ''}${lastDelta.toFixed(1)}%`}
            </p>
          </div>
        </div>
      </div>

      {/* Вид + гранулярность */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1 bg-muted/50 p-1 rounded-xl">
          {VIEWS.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              onClick={() => setView(key)}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap ${
                view === key ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <Icon className="size-3.5" />
              {label}
            </button>
          ))}
        </div>
        {/* Гранулярность нужна только там, где есть ось времени */}
        {view !== 'pie' && (
          <div className="flex flex-wrap gap-2">
            {GRANS.map(({ key, label }) => (
              <button
                key={key}
                onClick={() => setGran(key)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                  gran === key ? 'bg-primary text-primary-foreground border-primary' : 'bg-card border-border text-foreground hover:bg-muted'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Пусто */}
      {expenses.length === 0 ? (
        <div className="bg-card rounded-xl border border-border p-12 text-center">
          <TrendingDown className="size-10 text-muted-foreground/30 mx-auto mb-3" />
          <p className="font-medium text-foreground">Расходов за период нет</p>
          <p className="text-sm text-muted-foreground mt-1">Выберите другой период</p>
        </div>
      ) : view === 'bars' ? (
        <div className="bg-card rounded-xl border border-border p-4">
          <h2 className="text-sm font-semibold text-foreground mb-4">Динамика расходов по статьям</h2>
          <ResponsiveContainer width="100%" height={360}>
            <BarChart data={barData} margin={{ top: 5, right: 5, bottom: 5, left: 10 }} barCategoryGap="25%" maxBarSize={90}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
              <XAxis dataKey="bucket" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} width={70} />
              <Tooltip
                formatter={(v: number, n: string, item: { payload?: Record<string, unknown> }) => {
                  const row = item?.payload ?? {}
                  const rowTotal = topCategories.reduce((s, c) => s + (Number(row[c]) || 0), 0)
                  return [tooltipValue(v, rowTotal), n]
                }}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {topCategories.map((c, i) => (
                // isAnimationActive=false: при переключении вида recharts создаёт
                // пустые recharts-bar-rectangle без path (анимация не стартует)
                // и график остаётся пустым — как было и с круговыми.
                <Bar key={c} dataKey={c} stackId="exp" fill={CHART_COLORS[i % CHART_COLORS.length]} isAnimationActive={false} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      ) : view === 'pie' ? (
        <div className="bg-card rounded-xl border border-border p-4">
          <h2 className="text-sm font-semibold text-foreground mb-1">
            {pieByBucket.length > 1 ? 'Структура расходов по периодам' : 'Структура расходов за период'}
          </h2>
          {pieByBucket.length > 1 && (
            <p className="text-xs text-muted-foreground mb-4">
              Отдельная диаграмма на каждый период — один цвет = одна статья
            </p>
          )}

          {pieByBucket.length > 1 ? (
            // Несколько периодов — сетка круговых для сравнения структуры
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {pieByBucket.map((b) => (
                <div key={b.key} className="rounded-lg border border-border p-3">
                  <div className="flex items-baseline justify-between gap-2 mb-1">
                    <span className="text-sm font-semibold text-foreground">{b.label}</span>
                    <span className="text-xs font-bold text-foreground tabular-nums">{formatCurrency(b.total)}</span>
                  </div>
                  <ResponsiveContainer width="100%" height={200}>
                    <PieChart>
                      <Pie
                        data={b.data}
                        cx="50%"
                        cy="50%"
                        innerRadius={42}
                        outerRadius={72}
                        paddingAngle={2}
                        dataKey="value"
                        nameKey="name"
                        isAnimationActive={false}
                      >
                        {b.data.map((d) => (
                          <Cell key={d.name} fill={CHART_COLORS[Math.max(0, topCategories.indexOf(d.name)) % CHART_COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip formatter={(v: number, n: string) => [tooltipValue(v, b.total), n]} />
                    </PieChart>
                  </ResponsiveContainer>
                  {/* Своя разбивка под каждой диаграммой — иначе под тремя
                      периодами читалась одна общая легенда (сумма за весь
                      диапазон), и сравнить периоды по статьям было нельзя. */}
                  <div className="mt-2 divide-y divide-border border-t border-border">
                    {b.data.map((d) => {
                      const ci = Math.max(0, topCategories.indexOf(d.name))
                      const pct = b.total > 0 ? Math.round((d.value / b.total) * 100) : 0
                      return (
                        <div key={d.name}
                          onClick={d.name !== 'Прочее' ? () => setDrillCat(d.name) : undefined}
                          className={`flex items-center gap-2 py-1.5 text-xs ${d.name !== 'Прочее' ? 'cursor-pointer hover:bg-muted/40 -mx-1 px-1 rounded' : ''}`}>
                          <span className="size-2 rounded-full shrink-0" style={{ background: CHART_COLORS[ci % CHART_COLORS.length] }} />
                          <span className="text-foreground flex-1 truncate">{d.name}</span>
                          <span className="text-muted-foreground tabular-nums">{pct}%</span>
                          <span className="font-semibold text-foreground tabular-nums">{formatCurrency(d.value)}</span>
                        </div>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={360}>
              <PieChart>
                <Pie
                  data={pieData}
                  cx="50%"
                  cy="50%"
                  innerRadius={70}
                  outerRadius={125}
                  paddingAngle={2}
                  dataKey="value"
                  nameKey="name"
                  label={({ name, percent }) => `${name} ${((percent ?? 0) * 100).toFixed(0)}%`}
                  style={{ fontSize: 11 }}
                  isAnimationActive={false}
                >
                  {pieData.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                </Pie>
                <Tooltip formatter={(v: number, n: string) => [tooltipValue(v, total), n]} />
              </PieChart>
            </ResponsiveContainer>
          )}

          {/* Общая легенда только для одного периода — при нескольких у каждой
              диаграммы уже есть своя разбивка выше, а эта показывала бы сумму
              по всему диапазону под видом «текущих» цифр. */}
          {pieByBucket.length <= 1 && (
            <div className="mt-3 divide-y divide-border border-t border-border">
              {byCategory.map(([name, value]) => {
                const ci = Math.max(0, topCategories.indexOf(catToSeries(name)))
                return (
                  <div key={name} className="flex items-center gap-3 py-2">
                    <span className="size-2.5 rounded-full shrink-0" style={{ background: CHART_COLORS[ci % CHART_COLORS.length] }} />
                    <span className="text-sm text-foreground flex-1 truncate">{name}</span>
                    <span className="text-xs text-muted-foreground tabular-nums">{total > 0 ? Math.round((value / total) * 100) : 0}%</span>
                    <span className="text-sm font-semibold text-foreground tabular-nums w-28 text-right">{formatCurrency(value)}</span>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      ) : (
        <div className="bg-card rounded-xl border border-border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/40 text-[11px] uppercase tracking-wider text-muted-foreground">
                  <th className="text-left font-semibold px-3 py-2 sticky left-0 bg-muted/40">Статья</th>
                  {buckets.map((k) => (
                    <th key={k} className="text-right font-semibold px-3 py-2 whitespace-nowrap">{bucketLabelOf(k, gran)}</th>
                  ))}
                  {buckets.length >= 2 && (
                    <th className="text-right font-semibold px-3 py-2 whitespace-nowrap" title="Изменение последнего периода к предыдущему">Δ</th>
                  )}
                  <th className="text-right font-semibold px-3 py-2">Итого</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {byCategory.map(([cat, catTotal]) => {
                  // Δ по статье: последний период против предыдущего — сразу видно,
                  // что именно выросло/упало, а не только общий итог.
                  const series = catToSeries(cat)
                  const inTop = categories.length <= TOP_N || categories.indexOf(cat) < TOP_N
                  const last = buckets.length >= 1 ? (matrix.get(buckets[buckets.length - 1])?.get(series) ?? 0) : 0
                  const prev = buckets.length >= 2 ? (matrix.get(buckets[buckets.length - 2])?.get(series) ?? 0) : 0
                  const diff = last - prev
                  const diffPct = prev > 0 ? (diff / prev) * 100 : null
                  return (
                    <tr key={cat} onClick={() => setDrillCat(cat)} title="Открыть операции статьи"
                      className="hover:bg-muted/30 transition-colors cursor-pointer">
                      <td className="px-3 py-2 text-foreground sticky left-0 bg-card">
                        <span className="inline-flex items-center gap-1">{cat}<ChevronRight className="size-3 text-muted-foreground/40" /></span>
                      </td>
                      {buckets.map((k) => {
                        const v = matrix.get(k)?.get(series) ?? 0
                        // При схлопывании в «Прочее» ячейка общая для хвоста —
                        // показываем её только у самой статьи, чтобы не дублировать.
                        return (
                          <td key={k} className="px-3 py-2 text-right tabular-nums text-muted-foreground whitespace-nowrap">
                            {inTop ? (v > 0 ? formatCurrency(v) : '—') : '·'}
                          </td>
                        )
                      })}
                      {buckets.length >= 2 && (
                        <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
                          {!inTop || (last === 0 && prev === 0) ? (
                            <span className="text-muted-foreground">—</span>
                          ) : (
                            <span className={diff > 0 ? 'text-destructive font-medium' : diff < 0 ? 'text-emerald-600 font-medium' : 'text-muted-foreground'}>
                              {diff > 0 ? '+' : ''}{formatCurrency(diff)}
                              {diffPct != null && <span className="ml-1 text-[11px] opacity-70">{diff > 0 ? '+' : ''}{diffPct.toFixed(0)}%</span>}
                            </span>
                          )}
                        </td>
                      )}
                      <td className="px-3 py-2 text-right font-semibold text-foreground tabular-nums whitespace-nowrap">{formatCurrency(catTotal)}</td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr className="bg-muted/20 border-t border-border font-semibold">
                  <td className="px-3 py-2 text-foreground sticky left-0 bg-muted/20">Итого</td>
                  {bucketTotals.map((v, i) => (
                    <td key={i} className="px-3 py-2 text-right tabular-nums text-foreground whitespace-nowrap">{formatCurrency(v)}</td>
                  ))}
                  {buckets.length >= 2 && (() => {
                    const last = bucketTotals[bucketTotals.length - 1]
                    const prev = bucketTotals[bucketTotals.length - 2]
                    const diff = last - prev
                    const pct = prev > 0 ? (diff / prev) * 100 : null
                    return (
                      <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
                        <span className={diff > 0 ? 'text-destructive' : diff < 0 ? 'text-emerald-600' : 'text-muted-foreground'}>
                          {diff > 0 ? '+' : ''}{formatCurrency(diff)}
                          {pct != null && <span className="ml-1 text-[11px] opacity-70">{diff > 0 ? '+' : ''}{pct.toFixed(0)}%</span>}
                        </span>
                      </td>
                    )
                  })()}
                  <td className="px-3 py-2 text-right tabular-nums text-foreground whitespace-nowrap">{formatCurrency(total)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {/* Детализация статьи — кому / когда / сколько (провал внутрь категории) */}
      <Dialog open={drillCat !== null} onOpenChange={(o) => { if (!o) setDrillCat(null) }}>
        <DialogContent className="sm:max-w-lg max-h-[85vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center justify-between gap-3 pr-6">
              <span className="truncate">{drillCat}</span>
              <span className="text-sm font-bold text-foreground tabular-nums shrink-0">{formatCurrency(drillTotal)}</span>
            </DialogTitle>
          </DialogHeader>
          {drillOps.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">Операций нет</p>
          ) : (
            <div className="overflow-y-auto flex-1 min-h-0 space-y-4">
              {drillByPayee.length > 1 && (
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">Кому · {drillByPayee.length}</p>
                  <div className="divide-y divide-border/60 rounded-lg border border-border">
                    {drillByPayee.map(([who, sum]) => (
                      <div key={who} className="flex items-center justify-between gap-3 px-3 py-1.5">
                        <span className="text-sm text-foreground truncate">{who}</span>
                        <span className="text-sm font-semibold text-foreground tabular-nums shrink-0">{formatCurrency(sum)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">Операции · {drillOps.length}</p>
                <div className="divide-y divide-border/60">
                  {drillOps.map((o) => (
                    <div key={o.id} className="flex items-center gap-3 py-2">
                      <span className="text-xs text-muted-foreground tabular-nums w-20 shrink-0">{(o.date || '').slice(0, 10) || '—'}</span>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-foreground truncate">{o.counterparty || o.description || finopCategoryLabel(o.category) || '—'}</p>
                        {o.accountName && <p className="text-[11px] text-muted-foreground truncate">со счёта «{o.accountName}»</p>}
                      </div>
                      <span className="text-sm font-semibold text-foreground tabular-nums shrink-0">{formatCurrency(o.amount)}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
