'use client'

import { FinanceTabs } from '@/components/finance/finance-tabs'

import { useState, useEffect, useMemo } from 'react'
import { useAuth } from '@/lib/auth-store'
import { formatCurrency } from '@/lib/helpers'
import {
  type FinancialActivity,
  type FinancialOperation,
  type FinancialAccount,
  finopCategoryLabel,
} from '@/lib/types'
import {
  fetchFinancialOperations, fetchFinancialAccounts, createFinancialOperation,
  fetchCashflowReport, type CashflowReport,
} from '@/lib/queries'
import { ArrowDownCircle, ArrowUpCircle, ArrowLeftRight, Plus, Download, Search, ChevronRight } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { exportToExcel } from '@/lib/export-excel'
import { CreateOperationDialog } from '@/components/dialogs/create-operation-dialog'
import { DateRangePresets, getPresetRange, readStoredPreset, type RangePreset } from '@/components/finance/date-range-presets'
import { readSharedPeriod, writeSharedPeriod, readSharedCustomRange } from '@/lib/finance-period'
import { useDataSync } from '@/hooks/use-data-sync'
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
  // Период общий с ОПиУ (вкладки «Отчёты»): выбрал месяц — на соседней вкладке
  // те же границы. Свой ключ страницы остаётся запасным.
  const [preset, setPreset] = useState<RangePreset>(() =>
    readSharedPeriod<RangePreset>(['today', 'yesterday', 'week', 'month', 'quarter', 'year', 'custom'], readStoredPreset('cashflow:preset', 'month')))
  const initialRange = preset === 'custom' ? readSharedCustomRange() : getPresetRange(preset)
  const [dateFrom, setDateFrom] = useState(initialRange.from)
  const [dateTo, setDateTo] = useState(initialRange.to)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [detailFor, setDetailFor] = useState<FinancialOperation | null>(null)
  const [operations, setOperations] = useState<FinancialOperation[]>([])
  const [accounts, setAccounts] = useState<FinancialAccount[]>([])
  const [report, setReport] = useState<CashflowReport | null>(null)
  const [loading, setLoading] = useState(true)

  const reloadAll = () => {
    const reportArgs = { from: dateFrom || undefined, to: dateTo || undefined }
    Promise.all([fetchFinancialOperations(), fetchFinancialAccounts(), fetchCashflowReport(reportArgs)])
      .then(([ops, accs, rep]) => { setOperations(ops); setAccounts(accs); setReport(rep) })
      .catch(() => {})
  }

  useEffect(() => {
    const reportArgs = { from: dateFrom || undefined, to: dateTo || undefined }
    Promise.all([fetchFinancialOperations(), fetchFinancialAccounts(), fetchCashflowReport(reportArgs)])
      .then(([ops, accs, rep]) => { setOperations(ops); setAccounts(accs); setReport(rep) })
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Re-fetch report when date range changes (operations list itself is unfiltered server-side).
  useEffect(() => {
    if (loading) return
    fetchCashflowReport({ from: dateFrom || undefined, to: dateTo || undefined })
      .then(setReport)
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateFrom, dateTo])

  // SSE-driven auto-refresh: другой кассир провёл операцию, закрылась смена и т.п.
  useDataSync(['financial_operations', 'cash_shifts'], reloadAll)

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
      reloadAll()
    } catch {}
  }

  if (loading) return <div className="p-6 flex items-center justify-center h-64"><div className="size-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" /></div>

  const q = search.trim().toLowerCase()
  const filtered = operations.filter((op) => {
    const matchType = typeFilter === 'all' || op.type === typeFilter
    const matchActivity = activityFilter === 'all' || op.activity === activityFilter
    const matchDateFrom = !dateFrom || op.date >= dateFrom
    const matchDateTo = !dateTo || op.date <= dateTo
    // Поиск по описанию / категории (с русской подписью) / счёту / контрагенту —
    // раньше в реестре не было никакого способа найти операцию.
    const matchSearch = !q || [
      op.description,
      op.category,
      finopCategoryLabel(op.category),
      op.accountName,
      op.counterparty,
    ].some((v) => (v ?? '').toLowerCase().includes(q))
    return matchType && matchActivity && matchDateFrom && matchDateTo && matchSearch
  }).sort((a, b) => {
    // Реестр читается хронологически: новые сверху. Ключ — бизнес-дата (date),
    // а не порядок прихода с бэка: операция с задней датой раньше стояла вверху
    // (её ввели последней) и ломала хронологию. Внутри дня — по времени ввода,
    // затем id как стабильный тай-брейк.
    if (a.date !== b.date) return a.date < b.date ? 1 : -1
    const ca = a.createdAt ?? '', cb = b.createdAt ?? ''
    if (ca !== cb) return ca < cb ? 1 : -1
    return a.id < b.id ? 1 : -1
  })

  // Totals from server report (period-aware, decimal-precise).
  // Н23: финансовая активность (переводы между счетами, займы) исключается из
  // «Поступления/Выплаты» — иначе переводы раздувают обе цифры (нога-в-нога
  // +/−) и создают видимость оборота, которого по бизнесу нет. netFlow считаем
  // из тех же операционных+инвестиционных потоков, чтобы шапка была консистентна.
  const totalIn = report
    ? Object.entries(report.by_activity).filter(([k]) => k !== 'financial').reduce((s, [, v]) => s + v.in, 0)
    : 0
  const totalOut = report
    ? Object.entries(report.by_activity).filter(([k]) => k !== 'financial').reduce((s, [, v]) => s + v.out, 0)
    : 0
  const netFlow = totalIn - totalOut

  return (
    <div className="p-4 md:p-6 space-y-4 md:space-y-5">
      <FinanceTabs />
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
                  { key: 'category', header: 'Категория', format: (v) => finopCategoryLabel(String(v ?? '')) },
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

      {/* Charts driven by server report */}
      <CashflowCharts report={report} operations={filtered} />

      {/* Filters */}
      {/* Поиск по реестру — в таблице его не было вовсе */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Поиск по описанию, категории, счёту…"
          className="w-full pl-10 pr-3 py-2.5 bg-card border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
        />
      </div>

      <div className="flex flex-wrap gap-3 items-center">
        <DateRangePresets
          value={preset}
          onChange={(p, r) => { setPreset(p); setDateFrom(r.from); setDateTo(r.to); writeSharedPeriod(p, r.from, r.to) }}
          customFrom={dateFrom}
          customTo={dateTo}
          onCustomFromChange={(v) => { setPreset('custom'); setDateFrom(v); writeSharedPeriod('custom', v, dateTo) }}
          onCustomToChange={(v) => { setPreset('custom'); setDateTo(v); writeSharedPeriod('custom', dateFrom, v) }}
          storageKey="cashflow:preset"
        />
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

      {/* Реестр операций — тач-карточки; тап открывает детали.
          Таблица с горизонтальным скроллом на узких экранах не читалась. */}
      {filtered.length === 0 ? (
        <div className="bg-card rounded-xl border border-border p-10 text-center">
          <p className="text-sm text-muted-foreground">
            {search ? `Ничего не найдено по запросу «${search}»` : 'Операций за период нет'}
          </p>
        </div>
      ) : (
        <div className="bg-card rounded-xl border border-border overflow-hidden divide-y divide-border">
          {filtered.map((op) => (
            <button
              key={op.id}
              type="button"
              onClick={() => setDetailFor(op)}
              className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-muted/40 transition-colors"
            >
              <div className={`size-9 rounded-lg flex items-center justify-center shrink-0 ${
                op.type === 'in'
                  ? 'bg-emerald-100 dark:bg-emerald-500/15 text-emerald-600'
                  : op.type === 'out'
                    ? 'bg-red-100 dark:bg-red-500/15 text-destructive'
                    : 'bg-muted text-muted-foreground'
              }`}>
                {op.type === 'in' ? <ArrowDownCircle className="size-4" /> : op.type === 'out' ? <ArrowUpCircle className="size-4" /> : <ArrowLeftRight className="size-4" />}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground truncate">
                  {String(op.description || finopCategoryLabel(op.category) || '—')}
                </p>
                <p className="text-xs text-muted-foreground truncate">
                  {(op.date ?? '').slice(0, 10)} · {finopCategoryLabel(op.category)}
                  {op.accountName ? ` · ${op.accountName}` : ''}
                </p>
              </div>
              <div className="flex flex-col items-end gap-0.5 shrink-0">
                {/* Н23: перевод между счетами — нейтрально (↔), не красный расход. */}
                <span className={`text-sm font-bold tabular-nums ${op.type === 'in' ? 'text-emerald-600' : op.type === 'out' ? 'text-destructive' : 'text-muted-foreground'}`}>
                  {op.type === 'in' ? '+' : op.type === 'out' ? '−' : '↔ '}{formatCurrency(op.amount)}
                </span>
                {!op.isAuto && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-muted text-muted-foreground">ручная</span>
                )}
              </div>
              <ChevronRight className="size-4 text-muted-foreground shrink-0" />
            </button>
          ))}
        </div>
      )}

      {/* Детали операции */}
      <Dialog open={!!detailFor} onOpenChange={(v) => { if (!v) setDetailFor(null) }}>
        <DialogContent className="sm:max-w-md rounded-xl">
          {detailFor && (
            <>
              <DialogHeader>
                <DialogTitle className="truncate">
                  {String(detailFor.description || finopCategoryLabel(detailFor.category) || 'Операция')}
                </DialogTitle>
              </DialogHeader>
              <div className="space-y-3 py-1">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Сумма</span>
                  <span className={`text-lg font-bold tabular-nums ${detailFor.type === 'in' ? 'text-emerald-600' : detailFor.type === 'out' ? 'text-destructive' : 'text-foreground'}`}>
                    {detailFor.type === 'in' ? '+' : detailFor.type === 'out' ? '−' : '↔ '}{formatCurrency(detailFor.amount)}
                  </span>
                </div>
                <div className="rounded-lg border border-border divide-y divide-border text-sm">
                  {[
                    ['Дата', (detailFor.date ?? '').slice(0, 10)],
                    ['Категория', finopCategoryLabel(detailFor.category)],
                    ['Счёт', detailFor.accountName || '—'],
                    ['Вид деятельности', ACTIVITY_LABELS[detailFor.activity]],
                    ['Контрагент', detailFor.counterparty || '—'],
                    ['Источник', detailFor.isAuto ? 'Создана автоматически' : 'Внесена вручную'],
                  ].map(([k, v]) => (
                    <div key={k} className="flex items-center justify-between gap-3 px-3 py-2">
                      <span className="text-muted-foreground shrink-0">{k}</span>
                      <span className="text-foreground text-right truncate">{v}</span>
                    </div>
                  ))}
                </div>
              </div>
              <DialogFooter>
                <button
                  type="button"
                  onClick={() => setDetailFor(null)}
                  className="px-4 py-2 text-sm font-medium bg-card border border-border rounded-lg hover:bg-muted"
                >
                  Закрыть
                </button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

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

const ACTIVITY_LABELS_LOCAL: Record<string, string> = {
  operational: 'Операционная',
  investment: 'Инвестиционная',
  financial: 'Финансовая',
}

function CashflowCharts({ report, operations }: { report: CashflowReport | null; operations: FinancialOperation[] }) {
  // 1. Out flow по конкретным статьям (server-side `out_by_category`,
  // отсортировано desc). Если бэк ничего не отдал (старый сервер) —
  // фоллбэк на by_activity, чтобы pie не оставался пустым.
  const pieData = useMemo(() => {
    if (!report) return [] as { name: string; value: number }[]
    if (report.out_by_category && report.out_by_category.length > 0) {
      return report.out_by_category
        .filter((c) => c.amount > 0)
        .map((c) => ({ name: finopCategoryLabel(c.category), value: c.amount }))
    }
    return Object.entries(report.by_activity)
      .map(([key, v]) => ({ name: ACTIVITY_LABELS_LOCAL[key] ?? key, value: v.out }))
      .filter((x) => x.value > 0)
      .sort((a, b) => b.value - a.value)
  }, [report])

  // 2. In/Out per day from server by_day (last 14 days slice).
  const barData = useMemo(() => {
    if (!report) return [] as { date: string; income: number; expense: number }[]
    return report.by_day.slice(-14).map((d) => ({
      date: d.date.slice(5),
      income: d.in,
      expense: d.out,
    }))
  }, [report])

  // 3. Cumulative net cash flow from server by_day (last 30 days).
  const areaData = useMemo(() => {
    if (!report) return [] as { date: string; flow: number }[]
    const slice = report.by_day.slice(-30)
    let cumulative = 0
    return slice.map((d) => {
      cumulative += d.in - d.out
      return { date: d.date.slice(5), flow: cumulative }
    })
  }, [report])

  // 4. Top-5 expense ops — still needs raw ops (server report is aggregated).
  const topExpenses = useMemo(() => {
    // Н23: только реальные расходы — исключаем переводы (type=transfer) и
    // финансовую активность (займы). Имя — описание или подпись категории.
    return operations
      .filter((o) => o.type === 'out' && o.activity !== 'financial')
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 5)
      .map((o) => {
        const label = o.description || finopCategoryLabel(o.category) || '—'
        return {
          name: label.length > 30 ? label.slice(0, 27) + '...' : label,
          amount: o.amount,
        }
      })
  }, [operations])

  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
      {/* 1. Расходы по статьям — Pie (out_by_category) */}
      <div className="bg-card rounded-xl border border-border p-5">
        <h2 className="text-sm font-semibold text-foreground mb-4">Расходы по статьям</h2>
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
        {barData.length === 0 ? (
          <div className="h-[250px] flex items-center justify-center text-sm text-muted-foreground">Нет данных</div>
        ) : (
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
        )}
      </div>

      {/* 3. Чистый денежный поток — Area */}
      <div className="bg-card rounded-xl border border-border p-5">
        <h2 className="text-sm font-semibold text-foreground mb-4">Чистый денежный поток (30 дней)</h2>
        {areaData.length === 0 ? (
          <div className="h-[250px] flex items-center justify-center text-sm text-muted-foreground">Нет данных</div>
        ) : (
          <ResponsiveContainer width="100%" height={250}>
            <AreaChart data={areaData} margin={{ top: 5, right: 5, bottom: 5, left: 10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: 'var(--color-muted-foreground)' }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 10, fill: 'var(--color-muted-foreground)' }} axisLine={false} tickLine={false} tickFormatter={(v) => `${(v / 1000).toFixed(0)}K`} />
              <Tooltip contentStyle={tooltipStyle} formatter={(val: number) => [formatCurrency(val), '']} />
              <Area type="monotone" dataKey="flow" name="Чистый поток" stroke="#5cb85c" fill="#5cb85c" fillOpacity={0.15} strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        )}
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
