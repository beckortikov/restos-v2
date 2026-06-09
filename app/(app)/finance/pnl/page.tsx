'use client'

import { useState, useEffect, useMemo } from 'react'
import { DatePeriodFilter, getDateRange, type PeriodKey } from '@/components/date-period-filter'
import { formatCurrency } from '@/lib/helpers'
import {
  PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend,
} from 'recharts'
import { Download } from 'lucide-react'
import { exportToExcel } from '@/lib/export-excel'
import { fetchPnLReport, type PnLReport } from '@/lib/queries/finance'
import { toast } from 'sonner'

const CHART_COLORS = ['#e87c4f', '#4f9ee8', '#5cb85c', '#f0ad4e', '#d9534f', '#9b59b6', '#1abc9c', '#34495e']

export default function PnlPage() {
  const [report, setReport] = useState<PnLReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [period, setPeriod] = useState<PeriodKey>(() => {
    try {
      const v = localStorage.getItem('pnl:period') as PeriodKey | null
      if (v) return v
    } catch {}
    return 'month'
  })
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')

  useEffect(() => {
    if (period !== 'custom') {
      try { localStorage.setItem('pnl:period', period) } catch {}
    }
  }, [period])

  useEffect(() => {
    setLoading(true)
    const { from, to } = getDateRange(period, customFrom, customTo)
    fetchPnLReport({ from: from ?? undefined, to: to ?? undefined })
      .then(setReport)
      .catch(() => toast.error('Ошибка загрузки отчёта'))
      .finally(() => setLoading(false))
  }, [period, customFrom, customTo])

  const PNL_ROWS = useMemo(() => {
    if (!report) return [] as { label: string; value: number; bold: boolean }[]
    const rows: { label: string; value: number; bold: boolean }[] = [
      { label: 'Выручка', value: report.revenue.total, bold: true },
      { label: '— Себестоимость (COGS)', value: -report.cogs.total, bold: false },
    ]
    if (report.writeoffs > 0) {
      rows.push({ label: '— Списания (брак/порча)', value: -report.writeoffs, bold: false })
    }
    rows.push({ label: 'Валовая прибыль', value: report.gross_profit, bold: true })
    const sortedOpex = [...report.opex.by_category].sort((a, b) => b.amount - a.amount)
    for (const { category, amount } of sortedOpex) {
      rows.push({ label: `— ${category}`, value: -amount, bold: false })
    }
    rows.push({ label: 'Чистая прибыль', value: report.net_profit, bold: true })
    return rows
  }, [report])

  const expensePieData = useMemo(() => {
    if (!report) return [] as { name: string; value: number }[]
    const items: { name: string; value: number }[] = []
    if (report.cogs.total > 0) items.push({ name: 'Себестоимость (COGS)', value: report.cogs.total })
    if (report.writeoffs > 0) items.push({ name: 'Списания', value: report.writeoffs })
    for (const c of report.opex.by_category) {
      items.push({ name: c.category, value: c.amount })
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

  return (
    <div className="p-4 md:p-6 space-y-4 md:space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-foreground">Отчёт о прибылях и убытках (ОПиУ)</h1>
          <p className="text-muted-foreground text-sm mt-0.5">Расчёт на сервере</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              exportToExcel(
                PNL_ROWS.map(r => ({ label: r.label, value: Math.abs(r.value), sign: r.value >= 0 ? '+' : '−' })),
                [
                  { key: 'label', header: 'Статья' },
                  { key: 'sign', header: 'Знак' },
                  { key: 'value', header: 'Сумма' },
                ],
                'ОПиУ'
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

      {/* Charts: Expense structure */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
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
        {report.revenue.by_method.length > 0 && (
          <div className="bg-card rounded-xl border border-border p-4">
            <h2 className="text-sm font-semibold text-foreground mb-3">Выручка по методам оплаты</h2>
            <div className="divide-y divide-border">
              {report.revenue.by_method.map((m) => (
                <div key={m.method} className="flex items-center justify-between px-2 py-2.5">
                  <span className="text-sm text-foreground">{m.method}</span>
                  <span className="text-sm font-semibold text-emerald-600">{formatCurrency(m.amount)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* P&L Table */}
      <div className="bg-card rounded-xl border border-border overflow-hidden">
        <div className="px-5 py-4 border-b border-border">
          <h2 className="text-sm font-semibold text-foreground">Структура P&L</h2>
        </div>
        <div className="divide-y divide-border">
          {PNL_ROWS.map((row, idx) => (
            <div
              key={`${row.label}-${idx}`}
              className={`flex items-center justify-between px-5 py-3 ${row.bold ? 'bg-muted/30' : ''}`}
            >
              <span className={`text-sm ${row.bold ? 'font-semibold text-foreground' : 'text-muted-foreground'}`}>
                {row.label}
              </span>
              <span className={`text-sm font-semibold ${row.value >= 0 ? 'text-emerald-600' : 'text-destructive'} ${row.bold ? 'text-base' : ''}`}>
                {row.value >= 0 ? '+' : ''}{formatCurrency(Math.abs(row.value))}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
