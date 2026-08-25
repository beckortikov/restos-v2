'use client'

import { FinanceTabs } from '@/components/finance/finance-tabs'
import { NetworkReportStrip } from '@/components/finance/network-report-strip'

import { useState, useEffect, useMemo } from 'react'
import { DatePeriodFilter, getDateRange, type PeriodKey } from '@/components/date-period-filter'
import { readSharedPeriod, writeSharedPeriod, readSharedCustomRange } from '@/lib/finance-period'
import { formatCurrency } from '@/lib/helpers'
import {
  PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend,
} from 'recharts'
import { Download, ChefHat } from 'lucide-react'
import { Link } from 'react-router-dom'
import { exportToExcel } from '@/lib/export-excel'
import { fetchPnLReport, type PnLReport } from '@/lib/queries/finance'
import { finopCategoryLabel } from '@/lib/types'
import { toast } from 'sonner'

const CHART_COLORS = ['#e87c4f', '#4f9ee8', '#5cb85c', '#f0ad4e', '#d9534f', '#9b59b6', '#1abc9c', '#34495e']

// Русские подписи методов оплаты (в БД — сырой enum). 'split' сервер уже
// раскладывает на реальные методы, оставлен как fallback.
const PAYMENT_METHOD_RU: Record<string, string> = {
  cash: 'Наличные',
  card: 'Карта',
  noncash: 'Безнал',
  transfer: 'Перевод',
  split: 'Раздельно',
  '': 'Не указан',
}

// method=true → строка-разбивка выручки по способу оплаты (не бухгалтерская
// статья, а справочная детализация «Выручки»): показывается серым, с отступом,
// без знака +/−, чтобы не читалась как ещё одно поступление.
type PnlRow = { label: string; value: number; bold: boolean; method?: boolean }

// Строки структуры P&L. Вынесено из компонента, чтобы теми же подписями
// построить прошлый период и посчитать Δ по каждой строке.
function buildPnlRows(report: PnLReport | null): PnlRow[] {
  if (!report) return []
  const rows: PnlRow[] = [
    { label: 'Выручка', value: report.revenue.total, bold: true },
  ]
  // Разбивка выручки по методам оплаты — подстроками под «Выручкой», на русском.
  // 'split' на сервере уже разложен на реальные методы (наличные/карта), так что
  // псевдо-счёта «split» здесь быть не должно.
  for (const m of report.revenue.by_method) {
    if (!m.amount) continue
    rows.push({ label: PAYMENT_METHOD_RU[m.method] ?? m.method, value: m.amount, bold: false, method: true })
  }
  rows.push({ label: '— Себестоимость (COGS)', value: -report.cogs.total, bold: false })
  if (report.writeoffs > 0) {
    rows.push({ label: '— Списания (брак/порча)', value: -report.writeoffs, bold: false })
  }
  rows.push({ label: 'Валовая прибыль', value: report.gross_profit, bold: true })
  const sortedOpex = [...report.opex.by_category].sort((a, b) => b.amount - a.amount)
  for (const { category, amount } of sortedOpex) {
    // Авто-коды (refund и т.п.) → русские подписи; ручные категории — как есть.
    rows.push({ label: `— ${finopCategoryLabel(category)}`, value: -amount, bold: false })
  }
  rows.push({ label: 'Чистая прибыль', value: report.net_profit, bold: true })
  return rows
}

export default function PnlPage() {
  const [report, setReport] = useState<PnLReport | null>(null)
  const [prevReport, setPrevReport] = useState<PnLReport | null>(null)
  const [compare, setCompare] = useState(() => {
    try { return localStorage.getItem('pnl:compare') === '1' } catch { return false }
  })
  const [loading, setLoading] = useState(true)
  // Период общий с ДДС (вкладки «Отчёты»). Значения, которых нет в PeriodKey
  // (напр. 'yesterday' из ДДС), откатываются на 'month'.
  const [period, setPeriod] = useState<PeriodKey>(() => {
    let own: PeriodKey = 'month'
    try {
      const v = localStorage.getItem('pnl:period') as PeriodKey | null
      if (v) own = v
    } catch {}
    return readSharedPeriod<PeriodKey>(['today', 'week', 'month', 'quarter', 'year', 'all', 'custom'], own)
  })
  const sharedRange = readSharedCustomRange()
  const [customFrom, setCustomFrom] = useState(sharedRange.from)
  const [customTo, setCustomTo] = useState(sharedRange.to)
  const [operationalOnly, setOperationalOnly] = useState(() => {
    try { return localStorage.getItem('pnl:operationalOnly') === '1' } catch { return false }
  })

  useEffect(() => {
    if (period !== 'custom') {
      try { localStorage.setItem('pnl:period', period) } catch {}
    }
    // Делимся выбором с ДДС (соседняя вкладка «Отчётов»).
    writeSharedPeriod(period, customFrom, customTo)
  }, [period, customFrom, customTo])

  useEffect(() => {
    try { localStorage.setItem('pnl:operationalOnly', operationalOnly ? '1' : '0') } catch {}
  }, [operationalOnly])

  useEffect(() => {
    try { localStorage.setItem('pnl:compare', compare ? '1' : '0') } catch {}
  }, [compare])

  useEffect(() => {
    setLoading(true)
    const { from, to } = getDateRange(period, customFrom, customTo)
    fetchPnLReport({ from: from ?? undefined, to: to ?? undefined, operationalOnly })
      .then(setReport)
      .catch(() => toast.error('Ошибка загрузки отчёта'))
      .finally(() => setLoading(false))
  }, [period, customFrom, customTo, operationalOnly])

  // Сравнение с прошлым периодом: тот же по длине отрезок непосредственно перед
  // текущим (месяц → предыдущий месяц). Грузим только когда включено — лишний
  // запрос отчёта не бесплатный.
  useEffect(() => {
    if (!compare) { setPrevReport(null); return }
    const { from, to } = getDateRange(period, customFrom, customTo)
    if (!from || !to) { setPrevReport(null); return }
    const lenMs = to.getTime() - from.getTime()
    const prevTo = new Date(from.getTime() - 86400000)
    const prevFrom = new Date(prevTo.getTime() - lenMs)
    fetchPnLReport({ from: prevFrom, to: prevTo, operationalOnly })
      .then(setPrevReport)
      .catch(() => setPrevReport(null))
  }, [compare, period, customFrom, customTo, operationalOnly])

  const PNL_ROWS = useMemo(() => buildPnlRows(report), [report])
  // Строки прошлого периода по тем же подписям — для колонки Δ.
  const prevByLabel = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of buildPnlRows(prevReport)) m.set(r.label, r.value)
    return m
  }, [prevReport])

  const expensePieData = useMemo(() => {
    if (!report) return [] as { name: string; value: number }[]
    const items: { name: string; value: number }[] = []
    if (report.cogs.total > 0) items.push({ name: 'Себестоимость (COGS)', value: report.cogs.total })
    if (report.writeoffs > 0) items.push({ name: 'Списания', value: report.writeoffs })
    for (const c of report.opex.by_category) {
      items.push({ name: finopCategoryLabel(c.category), value: c.amount })
    }
    const sorted = items.sort((a, b) => b.value - a.value)
    const top6 = sorted.slice(0, 6)
    const rest = sorted.slice(6).reduce((s, x) => s + x.value, 0)
    if (rest > 0) top6.push({ name: 'Прочее', value: rest })
    return top6
  }, [report])

  if (loading || !report) return <div className="p-6 flex items-center justify-center h-64"><div className="size-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" /></div>

  const revenue = report.revenue.total
  const cogsTotal = report.cogs.total
  const grossProfit = report.gross_profit
  const grossMargin = report.margin_percent
  const netProfit = report.net_profit
  const netMargin = revenue > 0 ? (netProfit / revenue) * 100 : 0

  // Диапазон для сетевой полосы (Ф-С3) — тот же период, что у отчёта.
  const stripRange = (() => {
    const { from, to } = getDateRange(period, customFrom, customTo)
    const ymd = (d: Date | null) => d
      ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      : undefined
    return { from: ymd(from), to: ymd(to) }
  })()

  return (
    <div className="p-4 md:p-6 space-y-4 md:space-y-5">
      <FinanceTabs />
      <NetworkReportStrip kind="pnl" from={stripRange.from} to={stripRange.to} />
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-foreground">Отчёт о прибылях и убытках (ОПиУ)</h1>
          <p className="text-muted-foreground text-sm mt-0.5">Расчёт на сервере</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            role="switch"
            aria-checked={compare}
            onClick={() => setCompare(v => !v)}
            title="Показать изменение к предыдущему периоду такой же длины (месяц → прошлый месяц)"
            className={`flex items-center gap-2 px-3 py-2 text-xs font-medium border rounded-lg transition-colors whitespace-nowrap shrink-0 ${compare ? 'border-primary/40 bg-primary/10 text-primary' : 'border-border hover:bg-muted text-muted-foreground'}`}
          >
            <span className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors ${compare ? 'bg-primary' : 'bg-muted-foreground/30'}`}>
              <span className={`inline-block size-3 rounded-full bg-white transition-transform ${compare ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
            </span>
            Сравнить с прошлым
          </button>
          <button
            type="button"
            role="switch"
            aria-checked={operationalOnly}
            onClick={() => setOperationalOnly(v => !v)}
            title="Не считать капвложения (оборудование) и финансовую активность в операционных расходах — чтобы разовая крупная покупка не искажала операционную прибыль"
            className={`flex items-center gap-2 px-3 py-2 text-xs font-medium border rounded-lg transition-colors whitespace-nowrap shrink-0 ${operationalOnly ? 'border-primary/40 bg-primary/10 text-primary' : 'border-border hover:bg-muted text-muted-foreground'}`}
          >
            <span className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors ${operationalOnly ? 'bg-primary' : 'bg-muted-foreground/30'}`}>
              <span className={`inline-block size-3 rounded-full bg-white transition-transform ${operationalOnly ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
            </span>
            Только операционные
          </button>
          <Link
            to="/analytics/food-cost"
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium border border-border rounded-lg hover:bg-muted transition-colors whitespace-nowrap shrink-0"
            title="Маржа по каждому блюду — отдельный экран"
          >
            <ChefHat className="size-3.5" />
            Маржа по блюдам
          </Link>
          <button
            onClick={() => {
              exportToExcel(
                // Метод-строки — справочная разбивка выручки, не бухстатьи: в
                // Excel-ОПиУ их не выгружаем, чтобы столбец знака не двоил выручку.
                PNL_ROWS.filter(r => !r.method).map(r => ({ label: r.label, value: Math.abs(r.value), sign: r.value >= 0 ? '+' : '−' })),
                [
                  { key: 'label', header: 'Статья' },
                  { key: 'sign', header: 'Знак' },
                  { key: 'value', header: 'Сумма' },
                ],
                'ОПиУ'
              )
            }}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium border border-border rounded-lg hover:bg-muted transition-colors whitespace-nowrap shrink-0"
          >
            <Download className="size-3.5" />
            Excel
          </button>
          <DatePeriodFilter period={period} onPeriodChange={setPeriod} customFrom={customFrom} customTo={customTo} onCustomFromChange={setCustomFrom} onCustomToChange={setCustomTo} />
        </div>
      </div>

      {/* KPI summary */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        {[
          { label: 'Выручка', value: formatCurrency(revenue), color: 'text-foreground' },
          { label: 'Валовая прибыль', value: formatCurrency(grossProfit), color: grossProfit >= 0 ? 'text-emerald-600' : 'text-destructive', sub: `Маржа ${grossMargin.toFixed(1)}%` },
          { label: 'Чистая прибыль', value: formatCurrency(netProfit), color: netProfit >= 0 ? 'text-emerald-600' : 'text-destructive', sub: `${netMargin.toFixed(1)}%` },
          { label: 'Себестоимость', value: formatCurrency(cogsTotal), color: 'text-destructive', sub: `${revenue > 0 ? ((cogsTotal / revenue) * 100).toFixed(1) : 0}% от выручки` },
        ].map((item) => (
          <div key={item.label} className="bg-card rounded-xl border border-border p-4">
            <p className="text-xs text-muted-foreground uppercase tracking-wide">{item.label}</p>
            <p className={`text-2xl font-bold mt-1 ${item.color}`}>{item.value}</p>
            {item.sub && <p className="text-xs text-muted-foreground mt-1">{item.sub}</p>}
          </div>
        ))}
      </div>

      {/* Chart: Expense structure. Разбивка выручки по методам оплаты теперь
          живёт подстроками под «Выручкой» в таблице P&L ниже (на русском). */}
      <div className="bg-card rounded-xl border border-border p-4">
        <h2 className="text-sm font-semibold text-foreground mb-3">Структура расходов</h2>
        {expensePieData.length === 0 ? (
          <div className="h-[230px] flex items-center justify-center text-sm text-muted-foreground">Нет данных</div>
        ) : (
          <ResponsiveContainer width="100%" height={230}>
            <PieChart>
              <Pie data={expensePieData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={80} label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`} labelLine={false} fontSize={11}>
                {expensePieData.map((_, i) => (
                  <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                ))}
              </Pie>
              <Tooltip formatter={(v: number) => formatCurrency(v)} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
            </PieChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* P&L Table */}
      <div className="bg-card rounded-xl border border-border overflow-hidden">
        <div className="px-5 py-4 border-b border-border">
          <h2 className="text-sm font-semibold text-foreground">Структура P&L</h2>
        </div>
        <div className="divide-y divide-border">
          {PNL_ROWS.map((row, idx) => {
            // Δ к прошлому периоду по этой же строке. Для расходов (значения
            // отрицательные) рост = ухудшение, поэтому цвет считаем по влиянию
            // на прибыль: больше — зелёный, меньше — красный.
            const prev = compare ? prevByLabel.get(row.label) : undefined
            const diff = prev !== undefined ? row.value - prev : null
            const diffPct = prev !== undefined && prev !== 0 ? ((row.value - prev) / Math.abs(prev)) * 100 : null
            return (
            <div
              key={`${row.label}-${idx}`}
              className={`flex items-center justify-between gap-3 px-5 py-3 ${row.bold ? 'bg-muted/30' : ''} ${row.method ? 'py-2' : ''}`}
            >
              <span className={`text-sm ${row.bold ? 'font-semibold text-foreground' : 'text-muted-foreground'} ${row.method ? 'pl-4 text-xs' : ''}`}>
                {row.method ? `• ${row.label}` : row.label}
              </span>
              {compare && (
                <span className="text-xs tabular-nums whitespace-nowrap shrink-0 min-w-[7rem] text-right">
                  {diff === null || (diff === 0 && prev === 0) ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    <span className={diff > 0 ? 'text-emerald-600' : diff < 0 ? 'text-destructive' : 'text-muted-foreground'}>
                      {diff > 0 ? '+' : ''}{formatCurrency(diff)}
                      {diffPct !== null && <span className="ml-1 opacity-70">{diffPct > 0 ? '+' : ''}{diffPct.toFixed(0)}%</span>}
                    </span>
                  )}
                </span>
              )}
              {row.method ? (
                // Разбивка выручки — нейтрально, без знака (не поступление сверху).
                <span className="text-xs font-medium text-muted-foreground tabular-nums">
                  {formatCurrency(row.value)}
                </span>
              ) : row.value === 0 ? (
                // Ноль — нейтрально, без «+»/«−» (иначе «+0,00 с.» смотрелось странно).
                <span className={`text-sm font-semibold text-muted-foreground tabular-nums ${row.bold ? 'text-base' : ''}`}>
                  {formatCurrency(0)}
                </span>
              ) : (
                // Знак согласован с карточками сверху: плюс у доходов, минус у
                // расходов/убытка (formatCurrency сам ставит «−» для отрицательных).
                <span className={`text-sm font-semibold tabular-nums ${row.value > 0 ? 'text-emerald-600' : 'text-destructive'} ${row.bold ? 'text-base' : ''}`}>
                  {row.value > 0 ? '+' : ''}{formatCurrency(row.value)}
                </span>
              )}
            </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
