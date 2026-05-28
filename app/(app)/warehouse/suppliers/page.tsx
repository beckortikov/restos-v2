'use client'

import { useState, useEffect, useMemo } from 'react'
import { useAuth } from '@/lib/auth-store'
import { formatCurrency } from '@/lib/helpers'
import { type Supplier } from '@/lib/types'
import { fetchSuppliers, createSupplier as createSupplierDb, updateSupplier, deleteSupplier } from '@/lib/queries'
import { Phone, User, AlertTriangle, Plus, Search, Pencil, Trash2, Banknote, Package, TrendingDown, ShieldAlert, CheckCircle2, Users } from 'lucide-react'
import { CreateSupplierDialog } from '@/components/dialogs/create-supplier-dialog'
import { toast } from 'sonner'
import { DecimalInput } from '@/components/ui/decimal-input'

type DebtFilter = 'all' | 'with_debt' | 'no_debt' | 'over_limit'

export default function SuppliersPage() {
  const { canDo } = useAuth()
  const isManager = canDo('suppliers.manage')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingSupplier, setEditingSupplier] = useState<Supplier | null>(null)
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [debtFilter, setDebtFilter] = useState<DebtFilter>('all')

  // Pay debt
  const [payingId, setPayingId] = useState<string | null>(null)
  const [payAmount, setPayAmount] = useState(0)

  const reload = async () => {
    const data = await fetchSuppliers()
    setSuppliers(data)
  }

  useEffect(() => {
    fetchSuppliers()
      .then(data => { setSuppliers(data); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

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

  async function handleCreateOrUpdate(data: { name: string; contactPerson: string; phone: string; categories: string[]; paymentTermsDays: number; creditLimit: number }) {
    try {
      if (editingSupplier) {
        await updateSupplier(editingSupplier.id, {
          name: data.name,
          contact_person: data.contactPerson,
          phone: data.phone,
          categories: data.categories,
          payment_terms_days: data.paymentTermsDays,
          credit_limit: data.creditLimit,
        })
        toast.success('Поставщик обновлён')
      } else {
        await createSupplierDb({ ...data, currentDebt: 0 })
        toast.success('Поставщик добавлен')
      }
      await reload()
    } catch (e) {
      console.error(e)
      toast.error(editingSupplier ? 'Ошибка обновления' : 'Ошибка создания')
    }
    setEditingSupplier(null)
  }

  async function handleDelete(sup: Supplier) {
    if (!confirm(`Удалить поставщика "${sup.name}"? Это действие необратимо.`)) return
    try {
      await deleteSupplier(sup.id)
      toast.success('Поставщик удалён')
      await reload()
    } catch {
      toast.error('Ошибка удаления. Возможно, есть связанные накладные.')
    }
  }

  async function handlePayDebt() {
    if (!payingId || payAmount <= 0) return
    const sup = suppliers.find(s => s.id === payingId)
    if (!sup) return
    const newDebt = Math.max(0, sup.currentDebt - payAmount)
    try {
      await updateSupplier(payingId, { current_debt: newDebt })
      toast.success(`Оплачено ${formatCurrency(payAmount)}`)
      setPayingId(null)
      setPayAmount(0)
      await reload()
    } catch {
      toast.error('Ошибка оплаты')
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
          <button
            onClick={() => { setEditingSupplier(null); setDialogOpen(true) }}
            className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2.5 rounded-xl text-sm font-medium hover:bg-primary/90 transition-colors w-full sm:w-auto justify-center"
          >
            <Plus className="size-4" />
            Добавить
          </button>
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

      {/* Supplier list */}
      <div className="space-y-3">
        {filtered.map((sup) => {
          const debtPct = sup.creditLimit > 0 ? Math.min(100, (sup.currentDebt / sup.creditLimit) * 100) : 0
          const isOverLimit = sup.creditLimit > 0 && sup.currentDebt > sup.creditLimit
          const isPaying = payingId === sup.id

          return (
            <div key={sup.id} className={`bg-card rounded-xl border-2 transition-colors ${isOverLimit ? 'border-destructive/30' : 'border-border'}`}>
              {/* Main row */}
              <div className="p-4 md:p-5">
                <div className="flex flex-col md:flex-row md:items-start gap-4">
                  {/* Left: info */}
                  <div className="flex-1 min-w-0 space-y-2.5">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <h3 className="font-semibold text-foreground text-base">{sup.name}</h3>
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-1.5">
                          <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
                            <User className="size-3.5 shrink-0" />
                            {sup.contactPerson}
                          </span>
                          <a href={`tel:${sup.phone}`} className="flex items-center gap-1.5 text-sm text-primary hover:underline">
                            <Phone className="size-3.5 shrink-0" />
                            {sup.phone}
                          </a>
                        </div>
                      </div>
                      {isOverLimit && (
                        <span className="flex items-center gap-1 text-xs text-destructive font-medium bg-destructive/10 px-2 py-1 rounded-lg shrink-0">
                          <AlertTriangle className="size-3" />
                          Сверх лимита
                        </span>
                      )}
                    </div>

                    {/* Categories + terms */}
                    <div className="flex flex-wrap gap-1.5">
                      {sup.categories.map((c) => (
                        <span key={c} className="text-xs bg-primary/10 text-primary px-2 py-0.5 rounded-md font-medium">{c}</span>
                      ))}
                      <span className="text-xs bg-muted text-muted-foreground px-2 py-0.5 rounded-md">
                        {sup.paymentTermsDays === 0 ? 'Без отсрочки' : `Отсрочка ${sup.paymentTermsDays} дн.`}
                      </span>
                    </div>
                  </div>

                  {/* Right: debt info + actions */}
                  <div className="flex flex-row md:flex-col items-end md:items-end gap-3 md:gap-2 shrink-0">
                    <div className="text-right">
                      <p className="text-xs text-muted-foreground">Наш долг</p>
                      <p className={`text-lg font-bold ${sup.currentDebt > 0 ? 'text-destructive' : 'text-emerald-600'}`}>
                        {formatCurrency(sup.currentDebt)}
                      </p>
                      {sup.creditLimit > 0 && (
                        <p className="text-xs text-muted-foreground">из {formatCurrency(sup.creditLimit)}</p>
                      )}
                    </div>

                    {/* Actions */}
                    {isManager && (
                      <div className="flex items-center gap-1">
                        {sup.currentDebt > 0 && (
                          <button
                            onClick={() => { setPayingId(isPaying ? null : sup.id); setPayAmount(sup.currentDebt) }}
                            title="Оплатить долг"
                            className={`p-2 rounded-lg transition-colors ${isPaying ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
                          >
                            <Banknote className="size-4" />
                          </button>
                        )}
                        <button
                          onClick={() => { setEditingSupplier(sup); setDialogOpen(true) }}
                          title="Редактировать"
                          className="p-2 rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                        >
                          <Pencil className="size-4" />
                        </button>
                        <button
                          onClick={() => handleDelete(sup)}
                          title="Удалить"
                          className="p-2 rounded-lg text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
                        >
                          <Trash2 className="size-4" />
                        </button>
                      </div>
                    )}
                  </div>
                </div>

                {/* Debt progress bar */}
                {sup.creditLimit > 0 && sup.currentDebt > 0 && (
                  <div className="mt-3">
                    <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all ${debtPct > 90 ? 'bg-destructive' : debtPct > 60 ? 'bg-amber-500' : 'bg-emerald-500'}`}
                        style={{ width: `${debtPct}%` }}
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* Pay debt form */}
              {isPaying && (
                <div className="px-4 md:px-5 pb-4 md:pb-5">
                  <div className="bg-muted/50 rounded-xl p-4 space-y-3">
                    <p className="text-sm font-medium text-foreground">Оплата поставщику: {sup.name}</p>
                    <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                      <div className="flex-1">
                        <DecimalInput
                          min={0}
                          max={sup.currentDebt}
                          value={payAmount}
                          onChange={v => setPayAmount(v)}
                          className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                        />
                      </div>
                      <div className="flex gap-2">
                        <button
                          onClick={() => setPayAmount(sup.currentDebt)}
                          className="px-3 py-2 text-xs font-medium text-primary border border-primary/30 rounded-lg hover:bg-primary/5 transition-colors"
                        >
                          Всё ({formatCurrency(sup.currentDebt)})
                        </button>
                        <button
                          onClick={handlePayDebt}
                          disabled={payAmount <= 0 || payAmount > sup.currentDebt}
                          className="px-4 py-2 bg-primary text-primary-foreground text-sm font-medium rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50"
                        >
                          Оплатить
                        </button>
                        <button
                          onClick={() => setPayingId(null)}
                          className="px-3 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
                        >
                          Отмена
                        </button>
                      </div>
                    </div>
                    {payAmount > 0 && payAmount < sup.currentDebt && (
                      <p className="text-xs text-muted-foreground">
                        Останется долг: {formatCurrency(sup.currentDebt - payAmount)}
                      </p>
                    )}
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>

      <CreateSupplierDialog
        open={dialogOpen}
        onOpenChange={(open) => { setDialogOpen(open); if (!open) setEditingSupplier(null) }}
        onSubmit={handleCreateOrUpdate}
        editingSupplier={editingSupplier}
      />
    </div>
  )
}
