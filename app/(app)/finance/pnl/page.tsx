'use client'

import { lazy, Suspense } from 'react'
import { useState, useEffect, useMemo } from 'react'
import { DatePeriodFilter, filterByDateRange, type PeriodKey } from '@/components/date-period-filter'
import { formatCurrency, calcLineCogs } from '@/lib/helpers'
import { dMul, dSum, dDiv, dSub, dRound } from '@/lib/decimal'
import {
  PieChart, Pie, Cell, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts'
import { Download } from 'lucide-react'
import { exportToExcel } from '@/lib/export-excel'
import {
  type Order,
  type FinancialOperation,
  type MenuItem,
  type User,
} from '@/lib/types'
import { fetchOrders, fetchFinancialOperations, fetchMenuItems, fetchUsers } from '@/lib/queries'

const PnlMarginChart = lazy(() => import('@/components/charts/pnl-margin-chart'))

const CHART_COLORS = ['#e87c4f', '#4f9ee8', '#5cb85c', '#f0ad4e', '#d9534f', '#9b59b6', '#1abc9c', '#34495e']
const MONTH_NAMES = ['Янв', 'Фев', 'Мар', 'Апр', 'Май', 'Июн', 'Июл', 'Авг', 'Сен', 'Окт', 'Ноя', 'Дек']

export default function PnlPage() {
  const [orders, setOrders] = useState<Order[]>([])
  const [finOps, setFinOps] = useState<FinancialOperation[]>([])
  const [menuItems, setMenuItems] = useState<MenuItem[]>([])
  const [users, setUsers] = useState<User[]>([])
  const [loading, setLoading] = useState(true)
  const [period, setPeriod] = useState<PeriodKey>('month')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')

  useEffect(() => {
    Promise.all([fetchOrders(), fetchFinancialOperations(), fetchMenuItems(), fetchUsers()])
      .then(([o, fo, mi, u]) => { setOrders(o); setFinOps(fo); setMenuItems(mi); setUsers(u) })
      .finally(() => setLoading(false))
  }, [])

  // ─── All calculations (hooks must be before any early return) ─────────────
  const filteredOrders = useMemo(() => filterByDateRange(orders, o => o.closedAt, period, customFrom, customTo), [orders, period, customFrom, customTo])
  const filteredFinOps = useMemo(() => filterByDateRange(finOps, o => o.date, period, customFrom, customTo), [finOps, period, customFrom, customTo])
  const closedOrders = useMemo(() => filteredOrders.filter((o) => o.status === 'done'), [filteredOrders])
  // Revenue includes service charge (totalWithService if available, otherwise total)
  const revenue = useMemo(() => closedOrders.reduce((s, o) => s + (o.totalWithService ?? o.total), 0), [closedOrders])
  const serviceRevenue = useMemo(() => closedOrders.reduce((s, o) => s + (o.serviceAmount ?? 0), 0), [closedOrders])
  const salesRevenue = revenue - serviceRevenue
  const cogsTotal = useMemo(() => dSum(closedOrders.flatMap(o => o.items.map(i => calcLineCogs(i.cogs, i.qty, i.unit, i.unitSize)))), [closedOrders])
  const grossProfit = revenue - cogsTotal
  const grossMargin = revenue > 0 ? (grossProfit / revenue) * 100 : 0

  // Operating expenses from financial operations — EXCLUDE:
  // - "Себестоимость продукции" (already counted as COGS from orders)
  // - "Закупка продуктов" / "Закупка хозтоваров" (stock purchases, not period expenses)
  const EXCLUDED_EXPENSE_CATEGORIES = ['Себестоимость продукции']
  const STOCK_PURCHASE_CATEGORIES = ['Закупка продуктов', 'Закупка хозтоваров']

  const expenseByCategory = useMemo(() => {
    const byCategory: Record<string, number> = {}
    filteredFinOps
      .filter(o => o.type === 'out' && o.activity === 'operational' && !EXCLUDED_EXPENSE_CATEGORIES.includes(o.category))
      .forEach(o => { byCategory[o.category] = (byCategory[o.category] || 0) + o.amount })
    return byCategory
  }, [filteredFinOps])

  // Separate stock purchases from operating expenses for display
  const opexCategories = Object.entries(expenseByCategory).filter(([cat]) => !STOCK_PURCHASE_CATEGORIES.includes(cat))
  const stockPurchases = Object.entries(expenseByCategory).filter(([cat]) => STOCK_PURCHASE_CATEGORIES.includes(cat))
  const totalOpex = opexCategories.reduce((s, [, v]) => s + v, 0)
  const totalStockPurchases = stockPurchases.reduce((s, [, v]) => s + v, 0)
  const ebitda = grossProfit - totalOpex
  const ebitdaMargin = revenue > 0 ? (ebitda / revenue) * 100 : 0

  const PNL_ROWS = useMemo(() => {
    const rows: { label: string; value: number; bold: boolean; type: 'in' | 'out' }[] = [
      { label: 'Выручка', value: revenue, bold: true, type: 'in' },
    ]
    if (serviceRevenue > 0) {
      rows.push({ label: '  в т.ч. продажи', value: salesRevenue, bold: false, type: 'in' })
      rows.push({ label: '  в т.ч. обслуживание', value: serviceRevenue, bold: false, type: 'in' })
    }
    rows.push({ label: '— Себестоимость (COGS)', value: -cogsTotal, bold: false, type: 'out' })
    rows.push({ label: 'Валовая прибыль', value: grossProfit, bold: true, type: grossProfit >= 0 ? 'in' : 'out' })

    // Operating expenses (excluding stock purchases and COGS duplicate)
    const sortedOpex = opexCategories.sort((a, b) => b[1] - a[1])
    for (const [cat, amount] of sortedOpex) {
      rows.push({ label: `— ${cat}`, value: -amount, bold: false, type: 'out' })
    }
    rows.push({ label: 'EBITDA', value: ebitda, bold: true, type: ebitda >= 0 ? 'in' : 'out' })

    // Stock purchases shown separately below EBITDA
    if (totalStockPurchases > 0) {
      rows.push({ label: '', value: 0, bold: false, type: 'out' }) // spacer
      rows.push({ label: 'Закупки (пополнение склада)', value: -totalStockPurchases, bold: false, type: 'out' })
    }
    return rows
  }, [revenue, salesRevenue, serviceRevenue, cogsTotal, grossProfit, opexCategories, ebitda, totalStockPurchases])

  const chartData = useMemo(() => menuItems.map((m) => ({
    name: m.name,
    margin: m.price > 0 ? dRound(dMul(dDiv(dSub(m.price, m.cogs), m.price), 100), 0) : 0,
  })).sort((a, b) => b.margin - a.margin), [menuItems])

  // Expense breakdown by category (pie chart)
  const expensePieData = useMemo(() => {
    const byCategory: Record<string, number> = {}
    filteredFinOps.filter(o => o.type === 'out').forEach(o => {
      byCategory[o.category] = (byCategory[o.category] || 0) + o.amount
    })
    const sorted = Object.entries(byCategory).sort((a, b) => b[1] - a[1])
    const top6 = sorted.slice(0, 6).map(([name, value]) => ({ name, value }))
    const rest = sorted.slice(6).reduce((s, [, v]) => s + v, 0)
    if (rest > 0) top6.push({ name: 'Прочее', value: rest })
    return top6
  }, [filteredFinOps])

  // Revenue and margin by month (line chart)
  const monthlyMarginData = useMemo(() => {
    const months: Record<string, { revenue: number; cogs: number }> = {}
    closedOrders.forEach(o => {
      const d = new Date(o.closedAt || o.createdAt)
      const key = `${d.getFullYear()}-${String(d.getMonth()).padStart(2, '0')}`
      if (!months[key]) months[key] = { revenue: 0, cogs: 0 }
      months[key].revenue += o.total
      months[key].cogs += o.items.reduce((s, i) => s + calcLineCogs(i.cogs, i.qty, i.unit, i.unitSize), 0)
    })
    return Object.entries(months)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([key, v]) => ({
        month: MONTH_NAMES[parseInt(key.split('-')[1])],
        revenue: v.revenue,
        margin: v.revenue > 0 ? Math.round(((v.revenue - v.cogs) / v.revenue) * 100) : 0,
      }))
  }, [closedOrders])

  if (loading) return <div className="p-6 flex items-center justify-center h-64"><div className="size-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" /></div>

  return (
    <div className="p-4 md:p-6 space-y-4 md:space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-foreground">Отчёт о прибылях и убытках (ОПиУ)</h1>
          <p className="text-muted-foreground text-sm mt-0.5">Текущий период — март 2026</p>
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
          { label: 'Валовая прибыль', value: formatCurrency(grossProfit), color: 'text-emerald-600', sub: `Маржа ${(grossMargin || 0).toFixed(1)}%` },
          { label: 'EBITDA', value: formatCurrency(ebitda), color: ebitda >= 0 ? 'text-emerald-600' : 'text-destructive', sub: `${(ebitdaMargin || 0).toFixed(1)}%` },
          { label: 'Себестоимость', value: formatCurrency(cogsTotal), color: 'text-destructive', sub: `${revenue > 0 ? (((cogsTotal / revenue) * 100) || 0).toFixed(1) : 0}% от выручки` },
        ].map((item) => (
          <div key={item.label} className="bg-card rounded-xl border border-border p-4">
            <p className="text-xs text-muted-foreground uppercase tracking-wide">{item.label}</p>
            <p className={`text-2xl font-bold mt-1 ${item.color}`}>{item.value}</p>
            {item.sub && <p className="text-xs text-muted-foreground mt-1">{item.sub}</p>}
          </div>
        ))}
      </div>

      {/* Charts: Expense structure + Revenue & Margin */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <div className="bg-card rounded-xl border border-border p-4">
          <h2 className="text-sm font-semibold text-foreground mb-3">Структура расходов</h2>
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
        </div>
        <div className="bg-card rounded-xl border border-border p-4">
          <h2 className="text-sm font-semibold text-foreground mb-3">Выручка и маржинальность</h2>
          <ResponsiveContainer width="100%" height={230}>
            <LineChart data={monthlyMarginData}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="month" tick={{ fontSize: 11 }} />
              <YAxis yAxisId="left" tick={{ fontSize: 11 }} tickFormatter={(v: number) => `${(v / 1000).toFixed(0)}k`} />
              <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11 }} tickFormatter={(v: number) => `${v}%`} domain={[0, 100]} />
              <Tooltip formatter={(v: number, name: string) => name === 'revenue' ? formatCurrency(v) : `${v}%`} labelStyle={{ fontSize: 12 }} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Line yAxisId="left" type="monotone" dataKey="revenue" name="Выручка" stroke="#e87c4f" strokeWidth={2} dot={{ r: 3 }} />
              <Line yAxisId="right" type="monotone" dataKey="margin" name="Маржа %" stroke="#4f9ee8" strokeWidth={2} dot={{ r: 3 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {/* P&L Table */}
        <div className="bg-card rounded-xl border border-border overflow-hidden">
          <div className="px-5 py-4 border-b border-border">
            <h2 className="text-sm font-semibold text-foreground">Структура P&L</h2>
          </div>
          <div className="divide-y divide-border">
            {PNL_ROWS.map((row) => (
              <div
                key={row.label}
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

        {/* Margin by dish chart */}
        <div className="bg-card rounded-xl border border-border p-5">
          <h2 className="text-sm font-semibold text-foreground mb-4">Маржа по блюдам (%)</h2>
          <PnlMarginChart data={chartData} />
        </div>
      </div>
    </div>
  )
}
