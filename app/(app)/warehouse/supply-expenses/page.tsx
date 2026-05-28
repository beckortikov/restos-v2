'use client'

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useAuth } from '@/lib/auth-store'
import { formatCurrency, formatNum } from '@/lib/helpers'
import { type Ingredient, type SupplyExpense, type User, SUPPLY_EXPENSE_REASONS } from '@/lib/types'
import { fetchIngredients, fetchSupplyExpenses, createSupplyExpense, fetchUsers } from '@/lib/queries'
import { DatePeriodFilter, type PeriodKey, getDateRange } from '@/components/date-period-filter'
import { exportToExcel } from '@/lib/export-excel'
import {
  Package, Loader2, Clock, Search, PackageMinus, AlertTriangle,
  FileSpreadsheet, BarChart3, X, ChevronDown,
} from 'lucide-react'
import { toast } from 'sonner'

type Tab = 'issue' | 'report' | 'history'

export default function SupplyExpensesPage() {
  const { canDo, restaurant } = useAuth()
  const [supplies, setSupplies] = useState<Ingredient[]>([])
  const [expenses, setExpenses] = useState<SupplyExpense[]>([])
  const [staff, setStaff] = useState<User[]>([])
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [tab, setTab] = useState<Tab>('issue')

  // Issue form
  const [selectedId, setSelectedId] = useState('')
  const [qty, setQty] = useState(0)
  const [reason, setReason] = useState<string>(SUPPLY_EXPENSE_REASONS[0])
  const [issuedTo, setIssuedTo] = useState('')
  const [note, setNote] = useState('')

  // Combobox state (searchable supply picker)
  const [comboOpen, setComboOpen] = useState(false)
  const [comboSearch, setComboSearch] = useState('')
  const comboRef = useRef<HTMLDivElement | null>(null)

  // Report filters
  const [period, setPeriod] = useState<PeriodKey>('month')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [filterSupplyId, setFilterSupplyId] = useState<string>('')
  const [filterReason, setFilterReason] = useState<string>('')
  const [filterIssuedTo, setFilterIssuedTo] = useState<string>('')

  const load = useCallback(async () => {
    try {
      const [ings, exps, users] = await Promise.all([
        fetchIngredients(),
        fetchSupplyExpenses({ limit: 1000 }),
        fetchUsers(),
      ])
      setSupplies(ings.filter(i => i.isFood === false))
      setExpenses(exps)
      setStaff(users)
    } catch { /* ignore */ }
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  // Close combobox on outside click
  useEffect(() => {
    if (!comboOpen) return
    const handler = (e: MouseEvent) => {
      if (comboRef.current && !comboRef.current.contains(e.target as Node)) setComboOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [comboOpen])

  const selectedSupply = useMemo(() => supplies.find(s => s.id === selectedId), [supplies, selectedId])

  const filteredSupplies = useMemo(() => {
    if (!comboSearch.trim()) return supplies
    const q = comboSearch.toLowerCase().trim()
    return supplies.filter(s => s.name.toLowerCase().includes(q) || (s.category ?? '').toLowerCase().includes(q))
  }, [supplies, comboSearch])

  const allowNegative = restaurant?.supplyAllowNegative ?? true

  const exceedsStock = !!selectedSupply && qty > selectedSupply.qty
  const blockedByLimit = !allowNegative && exceedsStock

  const handleSubmit = async () => {
    if (!selectedId || qty <= 0 || submitting) return
    if (blockedByLimit) {
      toast.error('Недостаточно на складе. Оформите приёмку или включите режим "разрешить минус" в настройках.')
      return
    }
    const supply = supplies.find(s => s.id === selectedId)
    if (!supply) return

    setSubmitting(true)
    try {
      await createSupplyExpense({
        ingredientId: supply.id,
        ingredientName: supply.name,
        qty,
        unit: supply.unit,
        reason,
        issuedTo: issuedTo || undefined,
        note: note || undefined,
      })
      toast.success(`Расход: ${supply.name} × ${formatNum(qty)} ${supply.unit}`)
      // Сбрасываем только поля, оставляем reason/issuedTo для повторных выдач.
      setSelectedId('')
      setQty(0)
      setNote('')
      setComboSearch('')
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Ошибка')
    }
    setSubmitting(false)
  }

  // ─── Report computations ─────────────────────────────────────────────────────
  const dateRange = useMemo(() => getDateRange(period, customFrom, customTo), [period, customFrom, customTo])

  const filteredExpenses = useMemo(() => {
    return expenses.filter(e => {
      if (dateRange.from && new Date(e.createdAt) < dateRange.from) return false
      if (dateRange.to && new Date(e.createdAt) > dateRange.to) return false
      if (filterSupplyId && e.ingredientId !== filterSupplyId) return false
      if (filterReason && e.reason !== filterReason) return false
      if (filterIssuedTo && e.issuedTo !== filterIssuedTo) return false
      return true
    })
  }, [expenses, dateRange, filterSupplyId, filterReason, filterIssuedTo])

  const priceByIngId = useMemo(() => {
    const m = new Map<string, number>()
    for (const s of supplies) m.set(s.id, s.pricePerUnit ?? 0)
    return m
  }, [supplies])

  const reportStats = useMemo(() => {
    const totalQty = filteredExpenses.reduce((s, e) => s + e.qty, 0)
    const totalCost = filteredExpenses.reduce((s, e) => s + (priceByIngId.get(e.ingredientId) ?? 0) * e.qty, 0)
    const operations = filteredExpenses.length
    const uniqueSupplies = new Set(filteredExpenses.map(e => e.ingredientId)).size
    return { totalQty, totalCost, operations, uniqueSupplies }
  }, [filteredExpenses, priceByIngId])

  // Агрегация по хозтовару: удобно для таблицы и Excel
  type AggRow = {
    ingredientId: string
    name: string
    unit: string
    qty: number
    cost: number
    operations: number
    lastIssuedAt: string
  }
  const aggBySupply = useMemo<AggRow[]>(() => {
    const map = new Map<string, AggRow>()
    for (const e of filteredExpenses) {
      const key = e.ingredientId
      const cur = map.get(key)
      const cost = (priceByIngId.get(e.ingredientId) ?? 0) * e.qty
      if (cur) {
        cur.qty += e.qty
        cur.cost += cost
        cur.operations += 1
        if (e.createdAt > cur.lastIssuedAt) cur.lastIssuedAt = e.createdAt
      } else {
        map.set(key, {
          ingredientId: e.ingredientId,
          name: e.ingredientName,
          unit: e.unit,
          qty: e.qty,
          cost,
          operations: 1,
          lastIssuedAt: e.createdAt,
        })
      }
    }
    return Array.from(map.values()).sort((a, b) => b.cost - a.cost)
  }, [filteredExpenses, priceByIngId])

  const aggByReason = useMemo(() => {
    const map = new Map<string, number>()
    for (const e of filteredExpenses) map.set(e.reason, (map.get(e.reason) ?? 0) + e.qty)
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1])
  }, [filteredExpenses])

  const aggByReceiver = useMemo(() => {
    const map = new Map<string, number>()
    for (const e of filteredExpenses) {
      const key = e.issuedTo || '—'
      map.set(key, (map.get(key) ?? 0) + e.qty)
    }
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10)
  }, [filteredExpenses])

  const handleExportXlsx = () => {
    const rows = filteredExpenses.map(e => ({
      date: new Date(e.createdAt).toLocaleString('ru-RU'),
      name: e.ingredientName,
      qty: e.qty,
      unit: e.unit,
      price: priceByIngId.get(e.ingredientId) ?? 0,
      cost: (priceByIngId.get(e.ingredientId) ?? 0) * e.qty,
      reason: e.reason,
      issuedTo: e.issuedTo ?? '',
      note: e.note ?? '',
      createdBy: e.createdBy ?? '',
    }))
    exportToExcel(
      rows,
      [
        { key: 'date', header: 'Дата / Время' },
        { key: 'name', header: 'Хозтовар' },
        { key: 'qty', header: 'Кол-во', format: v => Number(v) || 0 },
        { key: 'unit', header: 'Ед.' },
        { key: 'price', header: 'Цена', format: v => Number(v) || 0 },
        { key: 'cost', header: 'Сумма', format: v => Number(v) || 0 },
        { key: 'reason', header: 'Причина' },
        { key: 'issuedTo', header: 'Кому' },
        { key: 'createdBy', header: 'Кто выдал' },
        { key: 'note', header: 'Примечание' },
      ],
      `supply-expenses_${new Date().toISOString().slice(0, 10)}`,
    )
  }

  if (!canDo('inventory.manage')) {
    return <div className="p-6 flex items-center justify-center h-64"><p className="text-muted-foreground">Нет доступа</p></div>
  }
  if (loading) {
    return <div className="p-6 flex items-center justify-center h-64"><Loader2 className="size-8 animate-spin text-primary" /></div>
  }

  // ─── UI ──────────────────────────────────────────────────────────────────────
  return (
    <div className="p-4 md:p-6 space-y-5 max-w-6xl">
      {/* Header */}
      <div>
        <h1 className="text-xl font-bold text-foreground flex items-center gap-2">
          <PackageMinus className="size-6 text-primary" />Хозтовары
        </h1>
        <p className="text-muted-foreground text-sm mt-0.5">Выдача и учёт непищевых материалов</p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-muted/50 p-1 rounded-xl w-fit">
        {([
          { key: 'issue', label: 'Выдать', icon: PackageMinus },
          { key: 'report', label: 'Отчёт', icon: BarChart3 },
          { key: 'history', label: 'История', icon: Clock },
        ] as const).map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              tab === t.key ? 'bg-card shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <t.icon className="size-4" />
            {t.label}
          </button>
        ))}
      </div>

      {/* ═══ TAB: Issue ═══ */}
      {tab === 'issue' && (
        <div className="space-y-4">
          {/* Form card */}
          <div className="bg-card rounded-xl border border-border p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-foreground">Новый расход</h3>
              {!allowNegative && (
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200 font-medium">
                  Минус запрещён
                </span>
              )}
            </div>

            {/* Supply combobox */}
            <div className="space-y-1.5" ref={comboRef}>
              <label className="text-xs font-medium text-muted-foreground">Хозтовар</label>
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setComboOpen(o => !o)}
                  className="w-full flex items-center justify-between gap-2 px-3 py-2.5 bg-background border border-border rounded-lg text-sm hover:border-primary/50 transition-colors"
                >
                  <span className={`truncate ${!selectedSupply ? 'text-muted-foreground' : 'text-foreground'}`}>
                    {selectedSupply
                      ? `${selectedSupply.name} · остаток ${formatNum(selectedSupply.qty)} ${selectedSupply.unit}`
                      : 'Выберите хозтовар или начните вводить название'}
                  </span>
                  {selectedSupply ? (
                    <button type="button" onClick={(e) => { e.stopPropagation(); setSelectedId(''); setComboSearch('') }}
                      className="shrink-0 text-muted-foreground hover:text-foreground">
                      <X className="size-4" />
                    </button>
                  ) : (
                    <ChevronDown className={`size-4 text-muted-foreground shrink-0 transition-transform ${comboOpen ? 'rotate-180' : ''}`} />
                  )}
                </button>

                {comboOpen && (
                  <div className="absolute z-20 top-full left-0 right-0 mt-1 bg-card border border-border rounded-lg shadow-lg overflow-hidden">
                    <div className="relative border-b border-border">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
                      <input
                        autoFocus
                        type="text"
                        value={comboSearch}
                        onChange={e => setComboSearch(e.target.value)}
                        placeholder="Поиск по названию или категории..."
                        className="w-full pl-9 pr-3 py-2.5 text-sm bg-transparent focus:outline-none"
                      />
                    </div>
                    <div className="max-h-64 overflow-y-auto">
                      {filteredSupplies.length === 0 ? (
                        <p className="px-3 py-6 text-xs text-muted-foreground text-center">Ничего не найдено</p>
                      ) : filteredSupplies.map(s => {
                        const isLow = s.qty <= s.minQty
                        const isNegative = s.qty < 0
                        return (
                          <button
                            key={s.id}
                            type="button"
                            onClick={() => { setSelectedId(s.id); setComboOpen(false); setComboSearch('') }}
                            className="w-full flex items-center justify-between gap-3 px-3 py-2 hover:bg-muted/50 transition-colors text-left"
                          >
                            <div className="min-w-0 flex-1">
                              <p className="text-sm font-medium text-foreground truncate">{s.name}</p>
                              {s.category && <p className="text-[10px] text-muted-foreground truncate">{s.category}</p>}
                            </div>
                            <div className={`text-xs font-medium shrink-0 ${
                              isNegative ? 'text-red-600' : isLow ? 'text-amber-600' : 'text-muted-foreground'
                            }`}>
                              {formatNum(s.qty)} {s.unit}
                            </div>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )}
              </div>
              {supplies.length === 0 && (
                <p className="text-[10px] text-amber-600">Нет хозтоваров на складе. Добавьте в разделе Остатки → Хозтовары</p>
              )}
            </div>

            {/* Qty + Reason + Receiver */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">Количество</label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={0}
                    step="any"
                    value={qty || ''}
                    onChange={e => setQty(Number(e.target.value) || 0)}
                    placeholder="0"
                    className="flex-1 px-3 py-2 text-sm bg-background border border-border rounded-lg"
                  />
                  {selectedSupply && (
                    <span className="text-xs text-muted-foreground whitespace-nowrap">{selectedSupply.unit}</span>
                  )}
                </div>
                {exceedsStock && (
                  <p className={`text-[10px] flex items-center gap-1 ${blockedByLimit ? 'text-red-600' : 'text-amber-600'}`}>
                    <AlertTriangle className="size-3" />
                    {blockedByLimit
                      ? `Нельзя — на складе ${formatNum(selectedSupply.qty)} ${selectedSupply.unit}`
                      : `Остаток уйдёт в минус: ${formatNum(selectedSupply!.qty - qty)} ${selectedSupply!.unit}`}
                  </p>
                )}
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">Причина</label>
                <select
                  value={reason}
                  onChange={e => setReason(e.target.value)}
                  className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg"
                >
                  {SUPPLY_EXPENSE_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
                </select>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">Кому выдано</label>
                <select
                  value={issuedTo}
                  onChange={e => setIssuedTo(e.target.value)}
                  className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg"
                >
                  <option value="">—</option>
                  {staff.map(u => <option key={u.id} value={u.name}>{u.name} ({u.role})</option>)}
                </select>
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Примечание</label>
              <input
                type="text"
                value={note}
                onChange={e => setNote(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleSubmit() }}
                placeholder="Необязательно (Enter — списать)"
                className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg"
              />
            </div>

            <button
              onClick={handleSubmit}
              disabled={!selectedId || qty <= 0 || submitting || blockedByLimit}
              className="w-full px-4 py-2.5 text-sm font-medium text-primary-foreground bg-primary rounded-xl hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {submitting ? <Loader2 className="size-4 animate-spin" /> : <PackageMinus className="size-4" />}
              Списать
            </button>
          </div>

          {/* Stock summary */}
          {supplies.length > 0 && (
            <div className="bg-card rounded-xl border border-border p-5 space-y-3">
              <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                <Package className="size-4 text-muted-foreground" />Остатки хозтоваров
              </h3>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
                {supplies.map(s => {
                  const isLow = s.qty <= s.minQty
                  const isNeg = s.qty < 0
                  return (
                    <button
                      key={s.id}
                      onClick={() => { setSelectedId(s.id); setComboOpen(false) }}
                      className={`px-3 py-2 rounded-lg border text-xs text-left transition-colors ${
                        isNeg ? 'border-red-300 bg-red-50 hover:bg-red-100'
                        : isLow ? 'border-amber-200 bg-amber-50 hover:bg-amber-100'
                        : 'border-border bg-muted/30 hover:bg-muted/50'
                      }`}
                    >
                      <p className="font-medium text-foreground truncate">{s.name}</p>
                      <p className={`text-sm font-bold ${isNeg ? 'text-red-700' : isLow ? 'text-amber-700' : 'text-foreground'}`}>
                        {formatNum(s.qty)} {s.unit}
                      </p>
                      {isNeg && <p className="text-[10px] text-red-600">Минус — ждёт приёмки</p>}
                      {!isNeg && isLow && <p className="text-[10px] text-amber-700">Мало</p>}
                    </button>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ═══ TAB: Report ═══ */}
      {tab === 'report' && (
        <div className="space-y-4">
          {/* Filters */}
          <div className="bg-card rounded-xl border border-border p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <DatePeriodFilter
                period={period}
                onPeriodChange={setPeriod}
                customFrom={customFrom}
                customTo={customTo}
                onCustomFromChange={setCustomFrom}
                onCustomToChange={setCustomTo}
              />
              <button
                onClick={handleExportXlsx}
                disabled={filteredExpenses.length === 0}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                <FileSpreadsheet className="size-4" />
                Скачать Excel
              </button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <select
                value={filterSupplyId}
                onChange={e => setFilterSupplyId(e.target.value)}
                className="px-3 py-2 text-xs bg-background border border-border rounded-lg"
              >
                <option value="">Все хозтовары</option>
                {supplies.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              <select
                value={filterReason}
                onChange={e => setFilterReason(e.target.value)}
                className="px-3 py-2 text-xs bg-background border border-border rounded-lg"
              >
                <option value="">Все причины</option>
                {SUPPLY_EXPENSE_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
              <select
                value={filterIssuedTo}
                onChange={e => setFilterIssuedTo(e.target.value)}
                className="px-3 py-2 text-xs bg-background border border-border rounded-lg"
              >
                <option value="">Все получатели</option>
                {Array.from(new Set(expenses.map(e => e.issuedTo).filter(Boolean))).map(n => (
                  <option key={n as string} value={n as string}>{n as string}</option>
                ))}
              </select>
            </div>
          </div>

          {/* KPI cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
            <StatCard label="Операций" value={formatNum(reportStats.operations)} />
            <StatCard label="Хозтоваров" value={formatNum(reportStats.uniqueSupplies)} />
            <StatCard label="Суммарный расход" value={formatCurrency(reportStats.totalCost)} accent="primary" />
            <StatCard label="Кол-во позиций" value={formatNum(reportStats.totalQty)} accent="muted" />
          </div>

          {filteredExpenses.length === 0 ? (
            <div className="bg-card rounded-xl border border-border p-8 text-center">
              <p className="text-sm text-muted-foreground">Нет операций за выбранный период</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              {/* Aggregated table */}
              <div className="lg:col-span-2 bg-card rounded-xl border border-border overflow-hidden">
                <div className="px-4 py-3 border-b border-border">
                  <h3 className="text-sm font-semibold text-foreground">По хозтоварам</h3>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-muted/30 text-muted-foreground">
                        <th className="text-left px-3 py-2 font-medium">Хозтовар</th>
                        <th className="text-right px-3 py-2 font-medium">Кол-во</th>
                        <th className="text-right px-3 py-2 font-medium">Сумма</th>
                        <th className="text-right px-3 py-2 font-medium">Операций</th>
                        <th className="text-right px-3 py-2 font-medium">Последняя</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {aggBySupply.map(r => (
                        <tr key={r.ingredientId} className="hover:bg-muted/30">
                          <td className="px-3 py-2 font-medium text-foreground">{r.name}</td>
                          <td className="px-3 py-2 text-right">{formatNum(r.qty)} {r.unit}</td>
                          <td className="px-3 py-2 text-right font-semibold text-foreground">{formatCurrency(r.cost)}</td>
                          <td className="px-3 py-2 text-right text-muted-foreground">{r.operations}</td>
                          <td className="px-3 py-2 text-right text-muted-foreground">
                            {new Date(r.lastIssuedAt).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Side aggregates: by reason + by receiver */}
              <div className="space-y-4">
                <div className="bg-card rounded-xl border border-border p-4">
                  <h3 className="text-sm font-semibold text-foreground mb-3">По причинам</h3>
                  <div className="space-y-2">
                    {aggByReason.length === 0 ? (
                      <p className="text-xs text-muted-foreground">Нет данных</p>
                    ) : aggByReason.map(([r, q]) => {
                      const max = aggByReason[0][1]
                      const pct = max > 0 ? (q / max) * 100 : 0
                      return (
                        <div key={r}>
                          <div className="flex items-center justify-between text-xs mb-1">
                            <span className="text-muted-foreground truncate">{r}</span>
                            <span className="font-medium tabular-nums">{formatNum(q)}</span>
                          </div>
                          <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                            <div className="h-full bg-primary/60" style={{ width: `${pct}%` }} />
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>

                <div className="bg-card rounded-xl border border-border p-4">
                  <h3 className="text-sm font-semibold text-foreground mb-3">Топ получателей</h3>
                  <div className="space-y-2">
                    {aggByReceiver.length === 0 ? (
                      <p className="text-xs text-muted-foreground">Нет данных</p>
                    ) : aggByReceiver.map(([name, q]) => {
                      const max = aggByReceiver[0][1]
                      const pct = max > 0 ? (q / max) * 100 : 0
                      return (
                        <div key={name}>
                          <div className="flex items-center justify-between text-xs mb-1">
                            <span className="text-muted-foreground truncate">{name}</span>
                            <span className="font-medium tabular-nums">{formatNum(q)}</span>
                          </div>
                          <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                            <div className="h-full bg-emerald-500/60" style={{ width: `${pct}%` }} />
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ═══ TAB: History ═══ */}
      {tab === 'history' && (
        <div className="bg-card rounded-xl border border-border p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
              <Clock className="size-4 text-muted-foreground" />История расходов
            </h3>
            <span className="text-xs text-muted-foreground">{expenses.length} записей</span>
          </div>
          {expenses.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">Нет записей</p>
          ) : (
            <div className="space-y-1.5 max-h-[600px] overflow-y-auto">
              {expenses.map(exp => (
                <div key={exp.id} className="flex items-center justify-between px-3 py-2.5 rounded-lg bg-muted/30 text-xs">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-foreground">{exp.ingredientName}</span>
                      <span className="text-muted-foreground">× {formatNum(exp.qty)} {exp.unit}</span>
                    </div>
                    <div className="flex items-center gap-2 mt-0.5 text-muted-foreground flex-wrap">
                      <span className="px-1.5 py-0.5 bg-muted rounded text-[10px]">{exp.reason}</span>
                      {exp.issuedTo && <span>→ {exp.issuedTo}</span>}
                      {exp.note && <span className="italic">{exp.note}</span>}
                    </div>
                  </div>
                  <div className="text-right text-muted-foreground shrink-0 ml-3">
                    {exp.createdBy && <p>{exp.createdBy}</p>}
                    <p>{new Date(exp.createdAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Small helper component ──────────────────────────────────────────────────
function StatCard({ label, value, accent }: { label: string; value: string; accent?: 'primary' | 'muted' }) {
  return (
    <div className="bg-card rounded-xl border border-border p-4">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`text-xl md:text-2xl font-bold mt-1 ${accent === 'primary' ? 'text-primary' : 'text-foreground'}`}>{value}</p>
    </div>
  )
}
