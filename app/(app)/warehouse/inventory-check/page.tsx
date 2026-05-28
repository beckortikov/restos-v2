'use client'

import { useState, useEffect, useMemo } from 'react'
import { useAuth } from '@/lib/auth-store'
import { formatCurrency, formatNum } from '@/lib/helpers'
import { DecimalInput } from '@/components/ui/decimal-input'
import { type Ingredient } from '@/lib/types'
import {
  fetchIngredients,
  fetchInventoryChecks,
  fetchInventoryCheckLines,
  applyInventoryCheck,
  type InventoryCheck,
  type InventoryCheckLine,
} from '@/lib/queries'
import { DatePeriodFilter, type PeriodKey, filterByDateRange } from '@/components/date-period-filter'
import { Search, ClipboardCheck, Clock, ChevronDown, ChevronRight, AlertTriangle, CheckCircle2, Download, Plus, X } from 'lucide-react'
import { dSub, dMul } from '@/lib/decimal'
import { toast } from 'sonner'
import { exportToExcel } from '@/lib/export-excel'

interface InventoryLine {
  id: string
  name: string
  unit: string
  category: string
  pricePerUnit: number
  systemQty: number
  actualQty: number | null
  diff: number | null
}

type CategoryFilter = 'all' | string
type StatusFilter = 'all' | 'with_diff' | 'not_filled'

export default function InventoryCheckPage() {
  const { user, canDo } = useAuth()
  const [mode, setMode] = useState<'overview' | 'input'>('overview')
  const [lines, setLines] = useState<InventoryLine[]>([])
  const [submitted, setSubmitted] = useState(false)
  const [loading, setLoading] = useState(true)
  const [applying, setApplying] = useState(false)
  const [note, setNote] = useState('')
  const [search, setSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('all')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')

  // History
  const [history, setHistory] = useState<InventoryCheck[]>([])
  const [expandedCheck, setExpandedCheck] = useState<string | null>(null)
  const [expandedLines, setExpandedLines] = useState<InventoryCheckLine[]>([])

  // Overview KPI
  const [lastCheckLines, setLastCheckLines] = useState<InventoryCheckLine[]>([])
  const [ingredientPriceMap, setIngredientPriceMap] = useState<Map<string, number>>(new Map())

  // Period filter
  const [period, setPeriod] = useState<PeriodKey>('all')

  useEffect(() => {
    fetchIngredients()
      .then(ings => {
        setLines(ings.map(i => ({
          id: i.id,
          name: i.name,
          unit: i.unit,
          category: i.category,
          pricePerUnit: i.pricePerUnit,
          systemQty: i.qty,
          actualQty: null,
          diff: null,
        })))
        // Build price map for overview KPI
        const pm = new Map<string, number>()
        ings.forEach(i => pm.set(i.id, i.pricePerUnit))
        setIngredientPriceMap(pm)
      })
      .catch(() => {})
      .finally(() => setLoading(false))

    // Load history + last check lines
    fetchInventoryChecks()
      .then(checks => {
        setHistory(checks)
        if (checks.length > 0) {
          fetchInventoryCheckLines(checks[0].id)
            .then(setLastCheckLines)
            .catch(() => {})
        }
      })
      .catch(() => {})
  }, [])

  function updateActual(id: string, val: number) {
    setLines(prev => prev.map(l =>
      l.id === id ? { ...l, actualQty: val, diff: dSub(val, l.systemQty) } : l
    ))
  }

  async function handleApply() {
    if (!user) return
    setApplying(true)
    try {
      const filledLines = lines.filter(l => l.actualQty !== null)
      if (filledLines.length === 0) {
        toast.error('Заполните хотя бы одну позицию')
        setApplying(false)
        return
      }
      await applyInventoryCheck(
        filledLines.map(l => ({
          ingredientId: l.id,
          ingredientName: l.name,
          unit: l.unit,
          systemQty: l.systemQty,
          actualQty: l.actualQty!,
        })),
        user.name,
        user.id,
        note
      )
      setSubmitted(true)
      toast.success(`Инвентаризация проведена: ${filledLines.filter(l => l.diff !== 0).length} корректировок`)
      // Refresh history and switch to overview
      const checks = await fetchInventoryChecks()
      setHistory(checks)
      if (checks.length > 0) {
        const newLines = await fetchInventoryCheckLines(checks[0].id)
        setLastCheckLines(newLines)
      }
      // Reset input state
      setLines(prev => prev.map(l => ({ ...l, actualQty: null, diff: null })))
      setNote('')
      setSubmitted(false)
      setMode('overview')
    } catch (e) {
      toast.error('Ошибка при проведении инвентаризации')
    } finally {
      setApplying(false)
    }
  }

  async function loadCheckLines(checkId: string) {
    if (expandedCheck === checkId) {
      setExpandedCheck(null)
      return
    }
    try {
      const data = await fetchInventoryCheckLines(checkId)
      setExpandedLines(data)
      setExpandedCheck(checkId)
    } catch {
      toast.error('Ошибка загрузки')
    }
  }

  // Categories
  const categories = useMemo(() => {
    const cats = new Set(lines.map(l => l.category))
    return Array.from(cats).sort()
  }, [lines])

  // Filtered lines (input mode)
  const filteredLines = useMemo(() => {
    let result = lines
    if (search) {
      const q = search.toLowerCase()
      result = result.filter(l => l.name.toLowerCase().includes(q))
    }
    if (categoryFilter !== 'all') {
      result = result.filter(l => l.category === categoryFilter)
    }
    if (statusFilter === 'with_diff') {
      result = result.filter(l => l.diff !== null && l.diff !== 0)
    } else if (statusFilter === 'not_filled') {
      result = result.filter(l => l.actualQty === null)
    }
    return result
  }, [lines, search, categoryFilter, statusFilter])

  // Input mode stats
  const totalItems = lines.length
  const filledItems = lines.filter(l => l.actualQty !== null).length
  const inputWithDiff = lines.filter(l => l.diff !== null && l.diff !== 0)
  const inputShortages = inputWithDiff.filter(l => l.diff! < 0)
  const inputSurpluses = inputWithDiff.filter(l => l.diff! > 0)
  const inputShortageCost = inputShortages.reduce((s, l) => s + dMul(Math.abs(l.diff!), l.pricePerUnit), 0)
  const inputSurplusCost = inputSurpluses.reduce((s, l) => s + dMul(l.diff!, l.pricePerUnit), 0)

  // Overview stats from last check
  const overviewStats = useMemo(() => {
    if (!lastCheckLines.length || !history.length) return null
    const lastCheck = history[0]
    const linesWithPrice = lastCheckLines.map(l => ({
      ...l,
      pricePerUnit: ingredientPriceMap.get(l.ingredientId) ?? 0,
    }))
    const withDiff = linesWithPrice.filter(l => l.diff !== 0)
    const shortages = withDiff.filter(l => l.diff < 0)
    const surpluses = withDiff.filter(l => l.diff > 0)
    return {
      totalItems: lastCheck.totalItems,
      itemsWithDiff: withDiff.length,
      shortagesCount: shortages.length,
      shortageCost: shortages.reduce((s, l) => s + dMul(Math.abs(l.diff), l.pricePerUnit), 0),
      surplusCost: surpluses.reduce((s, l) => s + dMul(l.diff, l.pricePerUnit), 0),
      diffItems: withDiff,
      lastDate: lastCheck.createdAt,
    }
  }, [lastCheckLines, ingredientPriceMap, history])

  // Filtered history by period
  const filteredHistory = useMemo(() => {
    return filterByDateRange(history, h => h.createdAt, period)
  }, [history, period])

  const now = new Date()
  const dateStr = now.toLocaleDateString('ru', { day: 'numeric', month: 'long', year: 'numeric' })

  function handleExport() {
    const data = lines.filter(l => l.actualQty !== null).map(l => ({
      name: l.name,
      unit: l.unit,
      category: l.category,
      systemQty: l.systemQty,
      actualQty: l.actualQty,
      diff: l.diff,
      cost: dMul(l.diff || 0, l.pricePerUnit),
    }))
    exportToExcel(data, [
      { key: 'name', header: 'Наименование' },
      { key: 'category', header: 'Категория' },
      { key: 'unit', header: 'Ед.' },
      { key: 'systemQty', header: 'По учёту' },
      { key: 'actualQty', header: 'Фактически' },
      { key: 'diff', header: 'Расхождение' },
      { key: 'cost', header: 'Стоимость разницы' },
    ], 'Инвентаризация')
  }

  if (loading) return <div className="p-6 flex items-center justify-center h-64"><div className="size-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" /></div>

  // ── OVERVIEW MODE ──
  if (mode === 'overview') {
    const lastDateStr = overviewStats
      ? new Date(overviewStats.lastDate).toLocaleDateString('ru', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })
      : null

    return (
      <div className="p-4 md:p-6 space-y-4 md:space-y-5">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-foreground">Инвентаризация</h1>
            <p className="text-muted-foreground text-sm mt-0.5">
              {lastDateStr ? `Последняя: ${lastDateStr}` : 'Нет проведённых инвентаризаций'}
            </p>
          </div>
          <div className="flex gap-2">
            {canDo('inventory.manage') && (
              <button onClick={() => { setMode('input'); setSubmitted(false) }}
                className="flex items-center gap-1.5 px-4 py-2 bg-primary text-primary-foreground text-sm font-medium rounded-lg hover:bg-primary/90 transition-colors">
                <Plus className="size-4" />
                Новая инвентаризация
              </button>
            )}
          </div>
        </div>

        {/* KPI Cards from last check */}
        {overviewStats ? (
          <>
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
              <div className="bg-card rounded-xl border border-border p-3.5">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Позиций</p>
                <p className="text-xl font-bold mt-0.5">{overviewStats.totalItems}</p>
              </div>
              <div className="bg-card rounded-xl border border-border p-3.5">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Расхождений</p>
                <p className="text-xl font-bold mt-0.5">{overviewStats.itemsWithDiff}</p>
              </div>
              <div className="bg-card rounded-xl border border-border p-3.5">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Недостачи</p>
                <p className="text-xl font-bold mt-0.5 text-destructive">{overviewStats.shortagesCount}</p>
              </div>
              <div className="bg-card rounded-xl border border-border p-3.5">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Стоимость недостач</p>
                <p className="text-xl font-bold mt-0.5 text-destructive">{formatCurrency(overviewStats.shortageCost)}</p>
              </div>
              <div className="bg-card rounded-xl border border-border p-3.5">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Излишки</p>
                <p className="text-xl font-bold mt-0.5 text-emerald-600">{formatCurrency(overviewStats.surplusCost)}</p>
              </div>
            </div>

            {/* Diff summary */}
            {overviewStats.diffItems.length > 0 && (
              <div className="bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 rounded-xl p-4">
                <div className="flex items-center gap-2 mb-2">
                  <AlertTriangle className="size-4 text-amber-600" />
                  <p className="text-sm font-semibold text-amber-800 dark:text-amber-400">
                    Расхождений: {overviewStats.diffItems.length} позиций
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {overviewStats.diffItems.slice(0, 20).map((l, i) => (
                    <span key={i} className={`text-xs px-2 py-1 rounded font-medium ${l.diff < 0 ? 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400' : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400'}`}>
                      {l.ingredientName}: {l.diff > 0 ? '+' : ''}{formatNum(l.diff)} {l.unit}
                    </span>
                  ))}
                  {overviewStats.diffItems.length > 20 && <span className="text-xs text-muted-foreground px-2 py-1">+{overviewStats.diffItems.length - 20} ещё</span>}
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="bg-card rounded-xl border border-border p-8 text-center text-muted-foreground">
            <ClipboardCheck className="size-10 mx-auto mb-3 opacity-30" />
            <p className="text-sm">Нет проведённых инвентаризаций</p>
            <p className="text-xs mt-1">Нажмите «Новая инвентаризация», чтобы начать</p>
          </div>
        )}

        {/* History */}
        <div className="bg-card rounded-xl border border-border overflow-hidden">
          <div className="px-5 py-4 border-b border-border flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-foreground">История инвентаризаций</h2>
            <DatePeriodFilter
              period={period}
              onPeriodChange={setPeriod}
              compact
              periods={['today', 'week', 'month', 'all']}
            />
          </div>
          {filteredHistory.length === 0 ? (
            <div className="px-5 py-8 text-center text-muted-foreground text-sm">
              {history.length === 0 ? 'Нет проведённых инвентаризаций' : 'Нет инвентаризаций за выбранный период'}
            </div>
          ) : (
            <div className="divide-y divide-border">
              {filteredHistory.map(check => (
                <div key={check.id}>
                  <button onClick={() => loadCheckLines(check.id)}
                    className="w-full flex items-center justify-between px-5 py-3 hover:bg-muted/30 transition-colors text-left">
                    <div className="flex items-center gap-3">
                      {expandedCheck === check.id ? <ChevronDown className="size-4 text-muted-foreground" /> : <ChevronRight className="size-4 text-muted-foreground" />}
                      <div>
                        <p className="text-sm font-medium text-foreground">
                          {new Date(check.createdAt).toLocaleDateString('ru', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                        </p>
                        <p className="text-xs text-muted-foreground">{check.conductedBy} · {check.totalItems} позиций · {check.itemsWithDiff} расхождений</p>
                        {check.note && <p className="text-xs text-muted-foreground mt-0.5">{check.note}</p>}
                      </div>
                    </div>
                    <span className={`text-xs px-2 py-1 rounded font-medium ${check.status === 'applied' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>
                      {check.status === 'applied' ? 'Проведена' : 'Черновик'}
                    </span>
                  </button>
                  {expandedCheck === check.id && expandedLines.length > 0 && (
                    <div className="px-5 pb-4">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="text-muted-foreground">
                            <th className="text-left py-1 font-medium">Позиция</th>
                            <th className="text-right py-1 font-medium">По учёту</th>
                            <th className="text-right py-1 font-medium">Факт</th>
                            <th className="text-right py-1 font-medium">Разница</th>
                          </tr>
                        </thead>
                        <tbody>
                          {expandedLines.filter(l => l.diff !== 0).map((l, i) => (
                            <tr key={i} className="border-t border-border/50">
                              <td className="py-1.5 text-foreground">{l.ingredientName}</td>
                              <td className="py-1.5 text-right text-muted-foreground">{formatNum(l.systemQty)} {l.unit}</td>
                              <td className="py-1.5 text-right">{formatNum(l.actualQty)} {l.unit}</td>
                              <td className={`py-1.5 text-right font-medium ${l.diff < 0 ? 'text-destructive' : 'text-emerald-600'}`}>
                                {l.diff > 0 ? '+' : ''}{formatNum(l.diff)} {l.unit}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    )
  }

  // ── INPUT MODE ──
  return (
    <div className="p-4 md:p-6 space-y-4 md:space-y-5">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-foreground">Инвентаризация</h1>
          <p className="text-muted-foreground text-sm mt-0.5">{dateStr} · {submitted ? 'Проведена' : 'Введите фактические остатки'}</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => { setMode('overview'); setLines(prev => prev.map(l => ({ ...l, actualQty: null, diff: null }))); setNote('') }}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium border border-border rounded-lg hover:bg-muted transition-colors">
            <X className="size-3.5" /> Отмена
          </button>
          <button onClick={handleExport}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium border border-border rounded-lg hover:bg-muted transition-colors">
            <Download className="size-3.5" /> Excel
          </button>
          {!submitted && canDo('inventory.manage') && (
            <button onClick={handleApply} disabled={applying || filledItems === 0}
              className="flex items-center gap-1.5 px-4 py-2 bg-primary text-primary-foreground text-sm font-medium rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50">
              <ClipboardCheck className="size-4" />
              {applying ? 'Проводим...' : 'Провести инвентаризацию'}
            </button>
          )}
          {submitted && (
            <span className="flex items-center gap-1.5 text-sm text-emerald-600 font-medium px-4 py-2">
              <CheckCircle2 className="size-4" /> Проведена
            </span>
          )}
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <div className="bg-card rounded-xl border border-border p-3.5">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Позиций</p>
          <p className="text-xl font-bold mt-0.5">{filledItems} / {totalItems}</p>
        </div>
        <div className="bg-card rounded-xl border border-border p-3.5">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Расхождений</p>
          <p className="text-xl font-bold mt-0.5">{inputWithDiff.length}</p>
        </div>
        <div className="bg-card rounded-xl border border-border p-3.5">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Недостачи</p>
          <p className="text-xl font-bold mt-0.5 text-destructive">{inputShortages.length}</p>
        </div>
        <div className="bg-card rounded-xl border border-border p-3.5">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Стоимость недостач</p>
          <p className="text-xl font-bold mt-0.5 text-destructive">{formatCurrency(inputShortageCost)}</p>
        </div>
        <div className="bg-card rounded-xl border border-border p-3.5">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Излишки</p>
          <p className="text-xl font-bold mt-0.5 text-emerald-600">{formatCurrency(inputSurplusCost)}</p>
        </div>
      </div>

      {/* Diff summary */}
      {inputWithDiff.length > 0 && (
        <div className="bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <AlertTriangle className="size-4 text-amber-600" />
            <p className="text-sm font-semibold text-amber-800 dark:text-amber-400">
              Расхождений: {inputWithDiff.length} позиций
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {inputWithDiff.slice(0, 20).map(l => (
              <span key={l.id} className={`text-xs px-2 py-1 rounded font-medium ${l.diff! < 0 ? 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400' : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400'}`}>
                {l.name}: {l.diff! > 0 ? '+' : ''}{l.diff} {l.unit}
              </span>
            ))}
            {inputWithDiff.length > 20 && <span className="text-xs text-muted-foreground px-2 py-1">+{inputWithDiff.length - 20} ещё</span>}
          </div>
        </div>
      )}

      {/* Note */}
      {!submitted && (
        <div>
          <input type="text" value={note} onChange={e => setNote(e.target.value)}
            placeholder="Примечание к инвентаризации..."
            className="w-full px-3 py-2 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30" />
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap gap-2">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <input type="text" value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Поиск по названию..."
            className="w-full pl-9 pr-3 py-2 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30" />
        </div>
        <select value={categoryFilter} onChange={e => setCategoryFilter(e.target.value)}
          className="px-3 py-2 text-sm bg-card border border-border rounded-lg">
          <option value="all">Все категории</option>
          {categories.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value as StatusFilter)}
          className="px-3 py-2 text-sm bg-card border border-border rounded-lg">
          <option value="all">Все позиции</option>
          <option value="with_diff">С расхождением</option>
          <option value="not_filled">Не заполнены</option>
        </select>
      </div>

      {/* Main table */}
      <div className="bg-card rounded-xl border border-border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[700px]">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wide w-8">#</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wide">Наименование</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wide">Категория</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-muted-foreground uppercase tracking-wide">По учёту</th>
                <th className="px-4 py-3 text-center text-xs font-semibold text-muted-foreground uppercase tracking-wide">Фактически</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-muted-foreground uppercase tracking-wide">Расхождение</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-muted-foreground uppercase tracking-wide">Стоимость</th>
              </tr>
            </thead>
            <tbody>
              {filteredLines.map((line, idx) => {
                const hasDiff = line.diff !== null && line.diff !== 0
                const diffCost = hasDiff ? dMul(line.diff!, line.pricePerUnit) : 0
                return (
                  <tr key={line.id} className={`border-b border-border last:border-0 transition-colors ${
                    hasDiff ? (line.diff! < 0 ? 'bg-red-50 dark:bg-red-950/10' : 'bg-emerald-50 dark:bg-emerald-950/10') : 'hover:bg-muted/30'
                  }`}>
                    <td className="px-4 py-2 text-xs text-muted-foreground">{idx + 1}</td>
                    <td className="px-4 py-2 font-medium text-foreground">{line.name}</td>
                    <td className="px-4 py-2 text-xs text-muted-foreground">{line.category}</td>
                    <td className="px-4 py-2 text-right text-foreground">
                      {formatNum(line.systemQty)} <span className="text-muted-foreground text-xs">{line.unit}</span>
                    </td>
                    <td className="px-4 py-2 text-center">
                      <DecimalInput
                        min={0}
                        value={line.actualQty ?? 0}
                        onChange={(v) => updateActual(line.id, v)}
                        placeholder="Введите..."
                        disabled={submitted}
                        className="w-28 mx-auto px-3 py-1.5 text-sm text-center bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-60"
                      />
                    </td>
                    <td className="px-4 py-2 text-right">
                      {line.diff !== null ? (
                        <span className={`font-semibold ${line.diff < 0 ? 'text-destructive' : line.diff > 0 ? 'text-emerald-600' : 'text-muted-foreground'}`}>
                          {line.diff > 0 ? '+' : ''}{formatNum(line.diff)} {line.unit}
                        </span>
                      ) : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="px-4 py-2 text-right">
                      {hasDiff ? (
                        <span className={`text-xs font-medium ${diffCost < 0 ? 'text-destructive' : 'text-emerald-600'}`}>
                          {diffCost > 0 ? '+' : ''}{formatCurrency(Math.abs(diffCost))}
                        </span>
                      ) : <span className="text-muted-foreground text-xs">—</span>}
                    </td>
                  </tr>
                )
              })}
              {filteredLines.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">Ничего не найдено</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
