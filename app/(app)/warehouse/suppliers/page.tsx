'use client'

import { useState, useEffect, useMemo, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '@/lib/auth-store'
import { formatCurrency } from '@/lib/helpers'
import { type Supplier, type FinancialAccount } from '@/lib/types'
import { fetchSuppliers, paySupplierDebt, fetchFinancialAccounts, recomputeSupplierDebts } from '@/lib/queries'
import { selectableAccounts } from '@/lib/queries/finance'
import { useDataSync } from '@/hooks/use-data-sync'
import { AlertTriangle, Plus, Search, ChevronRight, Banknote, Package, TrendingDown, ShieldAlert, CheckCircle2, Users, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { DecimalInput } from '@/components/ui/decimal-input'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'

type DebtFilter = 'all' | 'with_debt' | 'no_debt' | 'over_limit'

export default function SuppliersPage() {
  const { canDo } = useAuth()
  const isManager = canDo('suppliers.manage')
  const navigate = useNavigate()
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [debtFilter, setDebtFilter] = useState<DebtFilter>('all')

  // Pay debt
  const [payingId, setPayingId] = useState<string | null>(null)
  const [payAmount, setPayAmount] = useState(0)
  const [accounts, setAccounts] = useState<FinancialAccount[]>([])
  const [payAccountId, setPayAccountId] = useState<string>('')
  const [recomputing, setRecomputing] = useState(false)

  const reload = useCallback(async () => {
    const data = await fetchSuppliers()
    setSuppliers(data)
  }, [])

  async function handleRecompute() {
    if (recomputing) return
    setRecomputing(true)
    try {
      await recomputeSupplierDebts()
      await reload()
      toast.success('Долги пересчитаны из накладных')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка пересчёта')
    } finally {
      setRecomputing(false)
    }
  }

  useEffect(() => {
    fetchSuppliers()
      .then(data => { setSuppliers(data); setLoading(false) })
      .catch(() => setLoading(false))
    fetchFinancialAccounts().then(selectableAccounts)
      .then(accs => {
        setAccounts(accs)
        const cash = accs.find(a => a.type === 'cash') ?? accs[0]
        if (cash) setPayAccountId(cash.id)
      })
      .catch(() => {})
  }, [])

  // Real-time: приёмка в долг / возврат / оплата обновляют долги без перезахода.
  useDataSync(['suppliers', 'stock_receipts', 'stock_returns'], reload)

  // Stats
  const totalDebt = suppliers.reduce((s, sup) => s + sup.currentDebt, 0)
  const totalCreditLimit = suppliers.reduce((s, sup) => s + sup.creditLimit, 0)
  const withDebt = suppliers.filter(s => s.currentDebt > 0)
  const noDebt = suppliers.filter(s => s.currentDebt === 0)
  const overLimit = suppliers.filter(s => s.creditLimit > 0 && s.currentDebt > s.creditLimit)
  const avgDebt = withDebt.length > 0 ? totalDebt / withDebt.length : 0

  // Filtering
  const filtered = useMemo(() => {
    let list = suppliers

    // Debt filter
    switch (debtFilter) {
      case 'with_debt': list = list.filter(s => s.currentDebt > 0); break
      case 'no_debt': list = list.filter(s => s.currentDebt === 0); break
      case 'over_limit': list = list.filter(s => s.creditLimit > 0 && s.currentDebt > s.creditLimit); break
    }

    // Search
    if (search.trim()) {
      const q = search.toLowerCase()
      list = list.filter(s =>
        s.name.toLowerCase().includes(q) ||
        s.contactPerson.toLowerCase().includes(q) ||
        s.phone.includes(q) ||
        s.categories.some(c => c.toLowerCase().includes(q))
      )
    }

    return list
  }, [suppliers, search, debtFilter])

  // Category stats
  const categoryStats = useMemo(() => {
    const map = new Map<string, { count: number; debt: number }>()
    for (const s of suppliers) {
      for (const cat of s.categories) {
        const prev = map.get(cat) || { count: 0, debt: 0 }
        map.set(cat, { count: prev.count + 1, debt: prev.debt + s.currentDebt })
      }
    }
    return Array.from(map.entries()).sort((a, b) => b[1].count - a[1].count)
  }, [suppliers])



  async function handlePayDebt() {
    if (!payingId || payAmount <= 0) return
    const sup = suppliers.find(s => s.id === payingId)
    if (!sup) return
    if (!payAccountId) { toast.error('Выберите счёт для оплаты'); return }
    try {
      // Атомарно на бэке: списание со счёта + уменьшение долга + финоп.
      // Раньше слался current_debt в updateSupplier — молча игнорировался (no-op),
      // деньги со счёта не списывались.
      await paySupplierDebt(payingId, payAmount, payAccountId)
      toast.success(`Оплачено ${formatCurrency(payAmount)} · ${sup.name}`)
      setPayingId(null)
      setPayAmount(0)
      await reload()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка оплаты')
    }
  }

  const filterTabs: { key: DebtFilter; label: string; count: number; icon: React.ReactNode; color: string }[] = [
    { key: 'all', label: 'Все', count: suppliers.length, icon: <Users className="size-4" />, color: 'text-foreground' },
    { key: 'with_debt', label: 'Мы должны', count: withDebt.length, icon: <TrendingDown className="size-4" />, color: 'text-amber-600' },
    { key: 'no_debt', label: 'Оплачены', count: noDebt.length, icon: <CheckCircle2 className="size-4" />, color: 'text-emerald-600' },
    { key: 'over_limit', label: 'Превышен лимит', count: overLimit.length, icon: <ShieldAlert className="size-4" />, color: 'text-destructive' },
  ]

  if (loading) return <div className="p-6 flex items-center justify-center h-64"><div className="size-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" /></div>

  return (
    <div className="p-4 md:p-6 space-y-5">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-foreground">Поставщики</h1>
          <p className="text-muted-foreground text-sm mt-0.5">
            {suppliers.length} поставщик{suppliers.length === 1 ? '' : suppliers.length < 5 ? 'а' : 'ов'}
          </p>
        </div>
        {isManager && (
          <div className="flex items-center gap-2 w-full sm:w-auto">
            <button
              onClick={handleRecompute}
              disabled={recomputing}
              title="Пересчитать долги поставщикам из накладных (если в отчёте 0, а по накладным долг есть)"
              className="flex items-center gap-2 bg-card border border-border text-foreground px-3 py-2.5 rounded-xl text-sm font-medium hover:bg-muted disabled:opacity-60 transition-colors justify-center"
            >
              <RefreshCw className={`size-4 ${recomputing ? 'animate-spin' : ''}`} />
              {recomputing ? 'Считаем…' : 'Пересчитать долги'}
            </button>
            <button
              onClick={() => navigate('/warehouse/suppliers/new')}
              className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2.5 rounded-xl text-sm font-medium hover:bg-primary/90 transition-colors flex-1 sm:flex-none justify-center"
            >
              <Plus className="size-4" />
              Добавить
            </button>
          </div>
        )}
      </div>

      {/* Statistics */}
      {suppliers.length > 0 && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="bg-card rounded-xl border border-border p-4">
            <p className="text-xs text-muted-foreground mb-1">Мы должны</p>
            <p className={`text-2xl font-bold ${totalDebt > 0 ? 'text-destructive' : 'text-emerald-600'}`}>
              {formatCurrency(totalDebt)}
            </p>
            {totalCreditLimit > 0 && (
              <p className="text-xs text-muted-foreground mt-1">
                Лимит: {formatCurrency(totalCreditLimit)}
              </p>
            )}
          </div>
          <div className="bg-card rounded-xl border border-border p-4">
            <p className="text-xs text-muted-foreground mb-1">В среднем должны</p>
            <p className="text-2xl font-bold text-foreground">
              {formatCurrency(avgDebt)}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              на поставщика ({withDebt.length} из {suppliers.length})
            </p>
          </div>
          <div className="bg-card rounded-xl border border-border p-4">
            <p className="text-xs text-muted-foreground mb-1">Больше всего должны</p>
            {withDebt.length > 0 ? (
              <>
                <p className="text-lg font-bold text-foreground truncate">
                  {[...withDebt].sort((a, b) => b.currentDebt - a.currentDebt)[0].name}
                </p>
                <p className="text-xs text-destructive font-medium mt-1">
                  {formatCurrency([...withDebt].sort((a, b) => b.currentDebt - a.currentDebt)[0].currentDebt)}
                </p>
              </>
            ) : (
              <p className="text-lg font-bold text-emerald-600">Всё оплачено</p>
            )}
          </div>
          <div className="bg-card rounded-xl border border-border p-4">
            <p className="text-xs text-muted-foreground mb-1">Категории</p>
            <p className="text-2xl font-bold text-foreground">{categoryStats.length}</p>
            <p className="text-xs text-muted-foreground mt-1 truncate">
              {categoryStats.slice(0, 2).map(([c]) => c).join(', ')}
            </p>
          </div>
        </div>
      )}

      {/* Category breakdown */}
      {categoryStats.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {categoryStats.map(([cat, { count, debt }]) => (
            <button
              key={cat}
              onClick={() => setSearch(search === cat ? '' : cat)}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs border transition-colors ${
                search === cat
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-card border-border text-foreground hover:bg-muted'
              }`}
            >
              <span className="font-medium">{cat}</span>
              <span className="opacity-60">{count}</span>
              {debt > 0 && (
                <span className={`${search === cat ? 'text-primary-foreground/80' : 'text-destructive'} font-medium`}>
                  {formatCurrency(debt)}
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      {/* Filter tabs + search */}
      {suppliers.length > 0 && (
        <div className="space-y-3">
          {/* Debt filter tabs */}
          <div className="flex gap-1 bg-muted/50 p-1 rounded-xl overflow-x-auto">
            {filterTabs.map(tab => (
              <button
                key={tab.key}
                onClick={() => setDebtFilter(tab.key)}
                className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
                  debtFilter === tab.key
                    ? 'bg-card shadow-sm text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <span className={debtFilter === tab.key ? tab.color : ''}>{tab.icon}</span>
                {tab.label}
                <span className={`min-w-[20px] text-center px-1.5 py-0.5 rounded-md text-[10px] font-bold ${
                  debtFilter === tab.key ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'
                }`}>
                  {tab.count}
                </span>
              </button>
            ))}
          </div>

          {/* Search */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Поиск по имени, контакту, телефону, категории..."
              className="w-full pl-10 pr-4 py-2.5 bg-card border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>
        </div>
      )}

      {/* Empty state */}
      {suppliers.length === 0 && (
        <div className="bg-card rounded-xl border border-border p-12 text-center">
          <Package className="size-10 text-muted-foreground/30 mx-auto mb-3" />
          <p className="font-medium text-foreground">Нет поставщиков</p>
          <p className="text-sm text-muted-foreground mt-1">Добавьте первого поставщика чтобы начать работу</p>
        </div>
      )}

      {/* No results */}
      {suppliers.length > 0 && filtered.length === 0 && (
        <div className="bg-card rounded-xl border border-border p-8 text-center">
          <p className="text-sm text-muted-foreground">
            {search ? `Ничего не найдено по запросу "${search}"` : 'Нет поставщиков с таким статусом'}
          </p>
          <button
            onClick={() => { setSearch(''); setDebtFilter('all') }}
            className="text-xs text-primary hover:underline mt-2"
          >
            Сбросить фильтры
          </button>
        </div>
      )}

      {/* Active filter indicator */}
      {(debtFilter !== 'all' || search) && filtered.length > 0 && (
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            Показано {filtered.length} из {suppliers.length}
          </p>
          <button
            onClick={() => { setSearch(''); setDebtFilter('all') }}
            className="text-xs text-primary hover:underline"
          >
            Сбросить
          </button>
        </div>
      )}

      {/* Supplier list — компактные строки-карточки; тап открывает детали.
          Оплата и удаление — без раздувания строки (диалог / детальная страница). */}
      {filtered.length > 0 && (
        <div className="bg-card rounded-xl border border-border overflow-hidden divide-y divide-border">
          {filtered.map((sup) => {
            const isOverLimit = sup.creditLimit > 0 && sup.currentDebt > sup.creditLimit
            const subtitle = sup.categories.length > 0
              ? sup.categories.join(', ')
              : (sup.contactPerson?.trim() || sup.phone?.trim() || 'без категорий')
            return (
              <div
                key={sup.id}
                onClick={() => navigate('/warehouse/suppliers/' + sup.id)}
                className="flex items-center gap-3 px-4 py-3 hover:bg-muted/40 cursor-pointer transition-colors"
              >
                <div className={`size-9 rounded-full flex items-center justify-center text-sm font-bold shrink-0 ${sup.currentDebt > 0 ? 'bg-destructive/10 text-destructive' : 'bg-primary/10 text-primary'}`}>
                  {sup.name.charAt(0).toUpperCase() || '?'}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-semibold text-foreground truncate">{sup.name}</p>
                    {isOverLimit && (
                      <span className="shrink-0 flex items-center gap-0.5 text-[10px] font-medium px-1.5 py-0.5 rounded bg-destructive/10 text-destructive">
                        <AlertTriangle className="size-2.5" /> лимит
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground truncate">
                    {subtitle}{sup.paymentTermsDays > 0 ? ` · отсрочка ${sup.paymentTermsDays} дн.` : ''}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className={`text-sm font-bold tabular-nums ${sup.currentDebt > 0 ? 'text-destructive' : 'text-emerald-600'}`}>
                    {sup.currentDebt > 0 ? formatCurrency(sup.currentDebt) : 'оплачен'}
                  </span>
                  {isManager && sup.currentDebt > 0 && (
                    <button
                      onClick={(e) => { e.stopPropagation(); setPayingId(sup.id); setPayAmount(sup.currentDebt) }}
                      className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-primary/10 text-primary hover:bg-primary/15 transition-colors"
                    >
                      <Banknote className="size-3.5" />
                      <span className="hidden sm:inline">Оплатить</span>
                    </button>
                  )}
                  <ChevronRight className="size-4 text-muted-foreground" />
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Оплата долга поставщику — компактный диалог вместо inline-формы */}
      <Dialog open={!!payingId} onOpenChange={(v) => { if (!v) setPayingId(null) }}>
        <DialogContent className="sm:max-w-md rounded-xl">
          {(() => {
            const sup = suppliers.find(s => s.id === payingId)
            if (!sup) return null
            return (
              <>
                <DialogHeader>
                  <DialogTitle className="flex items-center gap-2">
                    <Banknote className="size-4" />
                    Оплата · {sup.name}
                  </DialogTitle>
                </DialogHeader>
                <div className="space-y-3 py-1">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Наш долг</span>
                    <span className="font-bold text-destructive tabular-nums">{formatCurrency(sup.currentDebt)}</span>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-muted-foreground">Счёт списания</label>
                    <select
                      value={payAccountId}
                      onChange={e => setPayAccountId(e.target.value)}
                      className="w-full px-3 py-2 bg-card border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                    >
                      {accounts.length === 0 && <option value="">Нет счетов</option>}
                      {accounts.map(a => (
                        <option key={a.id} value={a.id}>
                          {a.name} · {formatCurrency(a.balance)}{a.type === 'cash' ? '' : a.type === 'bank' ? ' (банк)' : ` (${a.type})`}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-muted-foreground">Сумма</label>
                    <div className="flex items-center gap-2">
                      <DecimalInput
                        min={0}
                        max={sup.currentDebt}
                        value={payAmount}
                        onChange={v => setPayAmount(v)}
                        className="flex-1 px-3 py-2 bg-card border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                      />
                      <button
                        onClick={() => setPayAmount(sup.currentDebt)}
                        className="px-3 py-2 text-xs font-medium text-primary border border-primary/30 rounded-lg hover:bg-primary/5 transition-colors whitespace-nowrap"
                      >
                        Всё
                      </button>
                    </div>
                    {payAmount > 0 && payAmount < sup.currentDebt && (
                      <p className="text-xs text-muted-foreground">Останется долг: {formatCurrency(sup.currentDebt - payAmount)}</p>
                    )}
                  </div>
                </div>
                <DialogFooter>
                  <button
                    onClick={() => setPayingId(null)}
                    className="px-4 py-2 text-sm font-medium bg-card border border-border rounded-lg hover:bg-muted"
                  >
                    Отмена
                  </button>
                  <button
                    onClick={handlePayDebt}
                    disabled={payAmount <= 0 || payAmount > sup.currentDebt || !payAccountId}
                    className="px-4 py-2 bg-primary text-primary-foreground text-sm font-medium rounded-lg hover:bg-primary/90 disabled:opacity-50 flex items-center gap-2"
                  >
                    <Banknote className="size-4" />
                    Оплатить {formatCurrency(payAmount)}
                  </button>
                </DialogFooter>
              </>
            )
          })()}
        </DialogContent>
      </Dialog>


    </div>
  )
}
