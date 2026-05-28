'use client'

import { useState, useEffect, useMemo } from 'react'
import { useAuth } from '@/lib/auth-store'
import { formatCurrency } from '@/lib/helpers'
import {
  type FinancialActivity,
  type FinancialOperation,
  type FinancialAccount,
} from '@/lib/types'
import { fetchFinancialOperations, fetchFinancialAccounts, createFinancialOperation } from '@/lib/queries'
import { ArrowDownCircle, ArrowUpCircle, ArrowLeftRight, Plus, Download } from 'lucide-react'
import { exportToExcel } from '@/lib/export-excel'
import { CreateOperationDialog } from '@/components/dialogs/create-operation-dialog'
import {
  PieChart, Pie, Cell,
  BarChart, Bar,
  AreaChart, Area,
  XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend,
} from 'recharts'

type TypeFilter = 'all' | 'in' | 'out' | 'transfer'

const ACTIVITY_LABELS: Record<FinancialActivity, string> = {
  operational: 'Операционная',
  investment: 'Инвестиционная',
  financial: 'Финансовая',
}

const ACTIVITY_COLORS: Record<FinancialActivity, string> = {
  operational: 'bg-primary/10 text-primary',
  investment: 'bg-blue-100 text-blue-700',
  financial: 'bg-amber-100 text-amber-700',
}

export default function CashflowPage() {
  const { canDo } = useAuth()
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all')
  const [activityFilter, setActivityFilter] = useState<FinancialActivity | 'all'>('all')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [operations, setOperations] = useState<FinancialOperation[]>([])
  const [accounts, setAccounts] = useState<FinancialAccount[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([fetchFinancialOperations(), fetchFinancialAccounts()])
      .then(([ops, accs]) => { setOperations(ops); setAccounts(accs) })
      .finally(() => setLoading(false))
  }, [])

  async function handleCreateOperation(data: { type: 'in' | 'out' | 'transfer'; amount: number; category: string; accountId: string; activity: FinancialActivity; description: string; date: string }) {
    try {
      const account = accounts.find((a) => a.id === data.accountId)
      await createFinancialOperation({
        type: data.type,
        amount: data.amount,
        category: data.category,
        accountId: data.accountId,
        accountName: account?.name ?? '',
        activity: data.activity,
        date: data.date,
        description: data.description,
        isAuto: false,
      })
      const ops = await fetchFinancialOperations()
      setOperations(ops)
    } catch {}
  }

  if (loading) return <div className="p-6 flex items-center justify-center h-64"><div className="size-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" /></div>

  const filtered = operations.filter((op) => {
    const matchType = typeFilter === 'all' || op.type === typeFilter
    const matchActivity = activityFilter === 'all' || op.activity === activityFilter
    const matchDateFrom = !dateFrom || op.date >= dateFrom
    const matchDateTo = !dateTo || op.date <= dateTo
    return matchType && matchActivity && matchDateFrom && matchDateTo
  })

  const totalIn = operations.filter((o) => o.type === 'in').reduce((s, o) => s + o.amount, 0)
  const totalOut = operations.filter((o) => o.type === 'out').reduce((s, o) => s + o.amount, 0)
  const netFlow = totalIn - totalOut

  return (
    <div className="p-4 md:p-6 space-y-4 md:space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-foreground">Движение денежных средств (ДДС)</h1>
          <p className="text-muted-foreground text-sm mt-0.5">Все поступления и выплаты по счетам</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              exportToExcel(
                filtered.map(op => ({ ...op })),
                [
                  { key: 'date', header: 'Дата' },
                  { key: 'type', header: 'Тип', format: (v) => v === 'in' ? 'Приход' : v === 'out' ? 'Расход' : 'Перевод' },
                  { key: 'amount', header: 'Сумма' },
                  { key: 'category', header: 'Категория' },
                  { key: 'description', header: 'Описание' },
                  { key: 'accountName', header: 'Счёт' },
                  { key: 'activity', header: 'Вид деятельности', format: (v) => ACTIVITY_LABELS[v as FinancialActivity] ?? String(v) },
                ],
                'ДДС'
              )
            }}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium border border-border rounded-lg hover:bg-muted transition-colors"
          >
            <Download className="size-3.5" />
            Excel
          </button>
          {canDo('finance.manage') && (
            <button
              onClick={() => setDialogOpen(true)}
              className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors w-full sm:w-auto justify-center"
            >
              <Plus className="size-4" />
              Добавить операцию
            </button>
          )}
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-card rounded-xl border border-border p-4 flex items-center gap-3">
          <div className="size-10 rounded-lg bg-emerald-100 flex items-center justify-center">
            <ArrowDownCircle className="size-5 text-emerald-600" />
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Поступления</p>
            <p className="text-lg font-bold text-emerald-600">{formatCurrency(totalIn)}</p>
          </div>
        </div>
        <div className="bg-card rounded-xl border border-border p-4 flex items-center gap-3">
          <div className="size-10 rounded-lg bg-red-100 flex items-center justify-center">
            <ArrowUpCircle className="size-5 text-destructive" />
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Выплаты</p>
            <p className="text-lg font-bold text-destructive">{formatCurrency(totalOut)}</p>
          </div>
        </div>
        <div className="bg-card rounded-xl border border-border p-4 flex items-center gap-3">
          <div className={`size-10 rounded-lg flex items-center justify-center ${netFlow >= 0 ? 'bg-emerald-100' : 'bg-red-100'}`}>
            <ArrowLeftRight className={`size-5 ${netFlow >= 0 ? 'text-emerald-600' : 'text-destructive'}`} />
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Чистый поток</p>
            <p className={`text-lg font-bold ${netFlow >= 0 ? 'text-emerald-600' : 'text-destructive'}`}>{formatCurrency(netFlow)}</p>
          </div>
        </div>
      </div>

      {/* Charts 2x2 grid */}
      <CashflowCharts operations={filtered} />

      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-end">
        <div className="flex items-center gap-2">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">С</label>
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="px-3 py-1.5 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">По</label>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="px-3 py-1.5 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>
          {(dateFrom || dateTo) && (
            <button
              onClick={() => { setDateFrom(''); setDateTo('') }}
              className="px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground mt-4"
            >
              Сбросить
            </button>
          )}
        </div>
        <div className="flex gap-1.5">
          {(['all', 'in', 'out'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTypeFilter(t)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${typeFilter === t ? 'bg-primary text-primary-foreground border-primary' : 'bg-card border-border text-foreground hover:bg-muted'}`}
            >
              {t === 'all' ? 'Все' : t === 'in' ? 'Приходы' : 'Расходы'}
            </button>
          ))}
        </div>
        <div className="flex gap-1.5">
          {(['all', 'operational', 'investment', 'financial'] as const).map((a) => (
            <button
              key={a}
              onClick={() => setActivityFilter(a)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${activityFilter === a ? 'bg-primary text-primary-foreground border-primary' : 'bg-card border-border text-foreground hover:bg-muted'}`}
            >
              {a === 'all' ? 'Все виды' : ACTIVITY_LABELS[a as FinancialActivity]}
            </button>
          ))}
        </div>
      </div>

      {/* Operations table */}
      <div className="bg-card rounded-xl border border-border overflow-hidden">
        <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[600px]">
          <thead>
            <tr className="border-b border-border bg-muted/40">
              {['Дата', 'Описание', 'Категория', 'Счёт', 'Вид', 'Источник', 'Сумма'].map((h) => (
                <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wide">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((op) => (
              <tr key={op.id} className="border-b border-border last:border-0 hover:bg-muted/30 transition-colors">
                <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">{op.date}</td>
                <td className="px-4 py-3 text-sm text-foreground max-w-xs">
                  <span className="truncate block">{String(op.description || op.category || '')}</span>
                </td>
                <td className="px-4 py-3">
                  <span className="text-xs bg-muted text-muted-foreground px-2 py-0.5 rounded">{op.category}</span>
                </td>
                <td className="px-4 py-3 text-xs text-muted-foreground">{String(op.accountName || '')}</td>
                <td className="px-4 py-3">
                  <span className={`text-xs px-2 py-0.5 rounded font-medium ${ACTIVITY_COLORS[op.activity]}`}>
                    {ACTIVITY_LABELS[op.activity]}
                  </span>
                </td>
                <td className="px-4 py-3 text-xs text-muted-foreground">{op.isAuto ? 'Авто' : 'Ручная'}</td>
                <td className="px-4 py-3">
                  <span className={`font-semibold text-sm ${op.type === 'in' ? 'text-emerald-600' : 'text-destructive'}`}>
                    {op.type === 'in' ? '+' : '−'}{formatCurrency(op.amount)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>

      <CreateOperationDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSubmit={handleCreateOperation}
      />
    </div>
  )
}

// ─── Charts section ────────────────────────────────────────────────────────

const CHART_COLORS = ['#e87c4f', '#4f9ee8', '#5cb85c', '#f0ad4e', '#d9534f', '#9b59b6', '#1abc9c', '#34495e']

const tooltipStyle = {
  backgroundColor: 'var(--color-card)',
  border: '1px solid var(--color-border)',
  borderRadius: 8,
  fontSize: 12,
}

function CashflowCharts({ operations }: { operations: FinancialOperation[] }) {
  const pieData = useMemo(() => {
    const map: Record<string, number> = {}
    operations.filter((o) => o.type === 'out').forEach((o) => {
      map[o.category] = (map[o.category] || 0) + o.amount
    })
    const sorted = Object.entries(map).sort((a, b) => b[1] - a[1])
    const top6 = sorted.slice(0, 6).map(([name, value]) => ({ name, value }))
    const rest = sorted.slice(6).reduce((s, [, v]) => s + v, 0)
    if (rest > 0) top6.push({ name: 'Прочее', value: rest })
    return top6
  }, [operations])

  const barData = useMemo(() => {
    const today = new Date()
    const days: Record<string, { date: string; income: number; expense: number }> = {}
    for (let i = 13; i >= 0; i--) {
      const d = new Date(today)
      d.setDate(d.getDate() - i)
      const key = d.toISOString().slice(0, 10)
      days[key] = { date: key.slice(5), income: 0, expense: 0 }
    }
    operations.forEach((op) => {
      if (days[op.date]) {
        if (op.type === 'in') days[op.date].income += op.amount
        else if (op.type === 'out') days[op.date].expense += op.amount
      }
    })
    return Object.values(days)
  }, [operations])

  const areaData = useMemo(() => {
    const today = new Date()
    const days: Record<string, { date: string; net: number }> = {}
    const keys: string[] = []
    for (let i = 29; i >= 0; i--) {
      const d = new Date(today)
      d.setDate(d.getDate() - i)
      const key = d.toISOString().slice(0, 10)
      days[key] = { date: key.slice(5), net: 0 }
      keys.push(key)
    }
    operations.forEach((op) => {
      if (days[op.date]) {
        days[op.date].net += op.type === 'in' ? op.amount : -op.amount
      }
    })
    let cumulative = 0
    return keys.map((k) => {
      cumulative += days[k].net
      return { date: days[k].date, flow: cumulative }
    })
  }, [operations])

  const topExpenses = useMemo(() => {
    return operations
      .filter((o) => o.type === 'out')
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 5)
      .map((o) => ({
        name: o.description.length > 30 ? o.description.slice(0, 27) + '...' : o.description,
        amount: o.amount,
      }))
  }, [operations])

  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
      {/* 1. Расходы по категориям — Pie */}
      <div className="bg-card rounded-xl border border-border p-5">
        <h2 className="text-sm font-semibold text-foreground mb-4">Расходы по категориям</h2>
        {pieData.length === 0 ? (
          <div className="h-[250px] flex items-center justify-center text-sm text-muted-foreground">Нет данных</div>
        ) : (
          <ResponsiveContainer width="100%" height={250}>
            <PieChart>
              <Pie
                data={pieData}
                cx="50%"
                cy="50%"
                innerRadius={50}
                outerRadius={90}
                paddingAngle={2}
                dataKey="value"
                nameKey="name"
                label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                style={{ fontSize: 11 }}
              >
                {pieData.map((_, i) => (
                  <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                ))}
              </Pie>
              <Tooltip contentStyle={tooltipStyle} formatter={(val: number) => [formatCurrency(val), '']} />
            </PieChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* 2. Доходы vs Расходы — Grouped Bar */}
      <div className="bg-card rounded-xl border border-border p-5">
        <h2 className="text-sm font-semibold text-foreground mb-4">Доходы vs Расходы (14 дней)</h2>
        <ResponsiveContainer width="100%" height={250}>
          <BarChart data={barData} margin={{ top: 5, right: 5, bottom: 5, left: 10 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
            <XAxis dataKey="date" tick={{ fontSize: 10, fill: 'var(--color-muted-foreground)' }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fontSize: 10, fill: 'var(--color-muted-foreground)' }} axisLine={false} tickLine={false} tickFormatter={(v) => `${(v / 1000).toFixed(0)}K`} />
            <Tooltip contentStyle={tooltipStyle} formatter={(val: number) => [formatCurrency(val), '']} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar dataKey="income" name="Доходы" fill="#5cb85c" radius={[4, 4, 0, 0]} />
            <Bar dataKey="expense" name="Расходы" fill="#d9534f" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* 3. Чистый денежный поток — Area */}
      <div className="bg-card rounded-xl border border-border p-5">
        <h2 className="text-sm font-semibold text-foreground mb-4">Чистый денежный поток (30 дней)</h2>
        <ResponsiveContainer width="100%" height={250}>
          <AreaChart data={areaData} margin={{ top: 5, right: 5, bottom: 5, left: 10 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
            <XAxis dataKey="date" tick={{ fontSize: 10, fill: 'var(--color-muted-foreground)' }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fontSize: 10, fill: 'var(--color-muted-foreground)' }} axisLine={false} tickLine={false} tickFormatter={(v) => `${(v / 1000).toFixed(0)}K`} />
            <Tooltip contentStyle={tooltipStyle} formatter={(val: number) => [formatCurrency(val), '']} />
            <Area type="monotone" dataKey="flow" name="Чистый поток" stroke="#5cb85c" fill="#5cb85c" fillOpacity={0.15} strokeWidth={2} />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* 4. Топ-5 расходов — Horizontal Bar */}
      <div className="bg-card rounded-xl border border-border p-5">
        <h2 className="text-sm font-semibold text-foreground mb-4">Топ-5 расходов</h2>
        {topExpenses.length === 0 ? (
          <div className="h-[250px] flex items-center justify-center text-sm text-muted-foreground">Нет данных</div>
        ) : (
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={topExpenses} layout="vertical" margin={{ top: 5, right: 5, bottom: 5, left: 10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
              <XAxis type="number" tick={{ fontSize: 10, fill: 'var(--color-muted-foreground)' }} axisLine={false} tickLine={false} tickFormatter={(v) => `${(v / 1000).toFixed(0)}K`} />
              <YAxis type="category" dataKey="name" tick={{ fontSize: 10, fill: 'var(--color-muted-foreground)' }} axisLine={false} tickLine={false} width={120} />
              <Tooltip contentStyle={tooltipStyle} formatter={(val: number) => [formatCurrency(val), '']} />
              <Bar dataKey="amount" name="Сумма" fill="#e87c4f" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  )
}
