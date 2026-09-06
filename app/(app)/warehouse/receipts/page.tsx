'use client'

import React, { useState, useEffect, useMemo, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '@/lib/auth-store'
import { formatCurrency, formatNum } from '@/lib/helpers'
import { dMul } from '@/lib/decimal'
import { type StockReceipt, type Supplier, type StockReturn, RETURN_REASON_LABELS } from '@/lib/types'
import { fetchReceipts, fetchSuppliers, fetchStockReturns } from '@/lib/queries'
import { useDataSync } from '@/hooks/use-data-sync'
import { Plus, CheckCircle, Clock, CreditCard, Undo2, Search, ChevronRight, Pencil } from 'lucide-react'
import { CreateReturnDialog } from '@/components/dialogs/create-return-dialog'
import { PayReceiptDialog } from '@/components/dialogs/pay-receipt-dialog'
import { EditReceiptDialog } from '@/components/dialogs/edit-receipt-dialog'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'

// Статус-фильтры списка накладных. 'debt' — есть непогашенный долг; 'returns' —
// был возврат поставщику (полный/частичный). Счётчики считаются от всех накладных.
type ReceiptFilter = 'all' | 'debt' | 'paid' | 'returns'

const PAYMENT_LABELS: Record<string, { label: string; color: string }> = {
  paid: { label: 'Оплачено', color: 'bg-emerald-100 text-emerald-700' },
  credit: { label: 'В кредит', color: 'bg-red-100 text-red-700' },
  partial: { label: 'Частично', color: 'bg-amber-100 text-amber-700' },
}

export default function ReceiptsPage() {
  const { canDo, user } = useAuth()
  const isOwner = user?.role === 'owner'
  const navigate = useNavigate()
  const [detailFor, setDetailFor] = useState<StockReceipt | null>(null)
  const [receipts, setReceipts] = useState<StockReceipt[]>([])
  const [, setSuppliers] = useState<Supplier[]>([])
  const [loading, setLoading] = useState(true)
  const [returnFor, setReturnFor] = useState<StockReceipt | null>(null)
  const [payFor, setPayFor] = useState<StockReceipt | null>(null)
  const [editFor, setEditFor] = useState<StockReceipt | null>(null)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<ReceiptFilter>('all')
  const [returns, setReturns] = useState<StockReturn[]>([])

  const reload = useCallback(async () => {
    const [r, s, ret] = await Promise.all([fetchReceipts(), fetchSuppliers(), fetchStockReturns()])
    setReceipts(r); setSuppliers(s); setReturns(ret)
  }, [])

  // Возвраты, сгруппированные по накладной — чтобы в развёрнутой накладной было
  // видно, какие позиции и на сколько вернули (в т.ч. частичный возврат).
  const returnsByReceipt = useMemo(() => {
    const m = new Map<string, StockReturn[]>()
    for (const ret of returns) {
      const arr = m.get(ret.receiptId) ?? []
      arr.push(ret)
      m.set(ret.receiptId, arr)
    }
    return m
  }, [returns])

  useEffect(() => {
    reload().finally(() => setLoading(false))
  }, [reload])

  // Real-time: приёмка/возврат/оплата долга на другом терминале.
  useDataSync(['stock_receipts', 'stock_returns', 'suppliers'], reload)

  const isReturned = (r: StockReceipt) => (r.returnedTotal ?? 0) > 0
  const counts = useMemo(() => ({
    all: receipts.length,
    debt: receipts.filter(r => r.debtAmount > 0).length,
    paid: receipts.filter(r => r.debtAmount <= 0.01 && !isReturned(r)).length,
    returns: receipts.filter(isReturned).length,
  }), [receipts])

  const filtered = useMemo(() => {
    let rows = receipts
    if (filter === 'debt') rows = rows.filter(r => r.debtAmount > 0)
    else if (filter === 'paid') rows = rows.filter(r => r.debtAmount <= 0.01 && !isReturned(r))
    else if (filter === 'returns') rows = rows.filter(isReturned)
    const q = search.trim().toLowerCase()
    if (q) rows = rows.filter(r =>
      (r.supplierName ?? '').toLowerCase().includes(q) ||
      (r.date ?? '').toLowerCase().includes(q))
    return rows
  }, [receipts, filter, search])

  if (loading) return <div className="p-6 flex items-center justify-center h-64"><div className="size-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" /></div>

  return (
    <div className="p-4 md:p-6 space-y-4 md:space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-foreground">Накладные (Приход)</h1>
          <p className="text-muted-foreground text-sm mt-0.5">Приход товара от поставщиков</p>
        </div>
        {canDo('inventory.manage') && (
          <button
            onClick={() => navigate('/warehouse/receipts/new')}
            className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors w-full sm:w-auto justify-center"
          >
            <Plus className="size-4" />
            Создать накладную
          </button>
        )}
      </div>

      {/* Summary */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {[
          { label: 'Всего накладных', value: receipts.length, icon: CheckCircle, color: 'text-primary' },
          { label: 'Итого по приходу', value: formatCurrency(receipts.reduce((s, r) => s + r.totalAmount - (r.returnedTotal ?? 0), 0)), icon: CreditCard, color: 'text-blue-600' },
          { label: 'Задолженность', value: formatCurrency(receipts.reduce((s, r) => s + r.debtAmount, 0)), icon: Clock, color: 'text-destructive' },
        ].map((stat) => (
          <div key={stat.label} className="bg-card rounded-xl border border-border p-4 flex items-center gap-3">
            <stat.icon className={`size-5 ${stat.color}`} />
            <div>
              <p className="text-xs text-muted-foreground">{stat.label}</p>
              <p className="text-base font-bold text-foreground">{stat.value}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Filter tabs + search */}
      {receipts.length > 0 && (
        <div className="space-y-3">
          <div className="flex gap-1 bg-muted/50 p-1 rounded-xl overflow-x-auto">
            {([
              { key: 'all', label: 'Все' },
              { key: 'debt', label: 'С долгом' },
              { key: 'paid', label: 'Оплачено' },
              { key: 'returns', label: 'Возвраты' },
            ] as { key: ReceiptFilter; label: string }[]).map(tab => (
              <button
                key={tab.key}
                onClick={() => setFilter(tab.key)}
                className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
                  filter === tab.key ? 'bg-card shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {tab.label}
                <span className={`min-w-[20px] text-center px-1.5 py-0.5 rounded-md text-[10px] font-bold ${
                  filter === tab.key ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'
                }`}>
                  {counts[tab.key]}
                </span>
              </button>
            ))}
          </div>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Поиск по поставщику или дате..."
              className="w-full pl-10 pr-4 py-2.5 bg-card border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>
        </div>
      )}

      {/* No results */}
      {receipts.length > 0 && filtered.length === 0 && (
        <div className="bg-card rounded-xl border border-border p-8 text-center">
          <p className="text-sm text-muted-foreground">
            {search ? `Ничего не найдено по запросу "${search}"` : 'Нет накладных с таким статусом'}
          </p>
        </div>
      )}

      {/* Список накладных — тач-карточки, тап открывает детали */}
      {filtered.length > 0 && (
        <div className="bg-card rounded-xl border border-border overflow-hidden divide-y divide-border">
          {filtered.map((r) => {
            const pt = PAYMENT_LABELS[r.paymentType]
            const returned = r.returnedTotal ?? 0
            const fullyReturned = returned > 0 && returned >= r.totalAmount - 0.01
            const badge = returned > 0
              ? (fullyReturned
                  ? { label: 'Возвращено', color: 'bg-rose-100 dark:bg-rose-500/15 text-rose-700 dark:text-rose-400' }
                  : { label: 'Возврат части', color: 'bg-orange-100 dark:bg-orange-500/15 text-orange-700 dark:text-orange-400' })
              : pt
            const isOverdue = r.dueDate && new Date(r.dueDate).getTime() < Date.now() && r.debtAmount > 0
            return (
              <button
                key={r.id}
                type="button"
                onClick={() => setDetailFor(r)}
                className="w-full flex items-center gap-3 px-4 py-3.5 text-left hover:bg-muted/40 transition-colors"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-foreground truncate">{r.supplierName || '—'}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {r.date} · {r.lines.length} поз.
                    {isOverdue && <span className="text-destructive font-medium"> · просрочка {r.dueDate}</span>}
                  </p>
                </div>
                <div className="flex flex-col items-end gap-1 shrink-0">
                  {returned > 0.005 ? (
                    // Есть возврат — показываем сумму «по факту» (нетто), исходную зачёркиваем.
                    <div className="flex items-baseline gap-1.5">
                      <span className="text-xs text-muted-foreground line-through tabular-nums">{formatCurrency(r.totalAmount)}</span>
                      <span className="text-sm font-bold text-foreground tabular-nums">{formatCurrency(r.totalAmount - returned)}</span>
                    </div>
                  ) : (
                    <span className="text-sm font-bold text-foreground tabular-nums">{formatCurrency(r.totalAmount)}</span>
                  )}
                  {/* Остаток долга — «напротив», нетто: если возврат уменьшил долг,
                      исходный (сумма − оплачено) зачёркнут, остаток жирным. */}
                  {r.debtAmount > 0.005 && (() => {
                    const origDebt = r.totalAmount - r.paidAmount
                    const reduced = origDebt > r.debtAmount + 0.005
                    return (
                      <div className="flex items-baseline gap-1 text-destructive">
                        <span className="text-[11px] font-medium">долг</span>
                        {reduced && <span className="text-[11px] line-through opacity-60 tabular-nums">{formatCurrency(origDebt)}</span>}
                        <span className="text-sm font-bold tabular-nums">{formatCurrency(r.debtAmount)}</span>
                      </div>
                    )
                  })()}
                  <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${badge.color}`}>{badge.label}</span>
                </div>
                <ChevronRight className="size-4 text-muted-foreground shrink-0" />
              </button>
            )
          })}
        </div>
      )}

      {/* Детали накладной — позиции, возвраты, действия (тап по карточке) */}
      <Dialog open={!!detailFor} onOpenChange={(v) => { if (!v) setDetailFor(null) }}>
        <DialogContent className="sm:max-w-2xl rounded-xl max-h-[88vh] overflow-y-auto">
          {detailFor && (() => {
            const r = detailFor
            const pt = PAYMENT_LABELS[r.paymentType]
            const returned = r.returnedTotal ?? 0
            const fullyReturned = returned > 0 && returned >= r.totalAmount - 0.01
            const badge = returned > 0
              ? (fullyReturned
                  ? { label: 'Возвращено', color: 'bg-rose-100 dark:bg-rose-500/15 text-rose-700 dark:text-rose-400' }
                  : { label: 'Возврат части', color: 'bg-orange-100 dark:bg-orange-500/15 text-orange-700 dark:text-orange-400' })
              : pt
            const rets = returnsByReceipt.get(r.id) ?? []
            const isOverdue = r.dueDate && new Date(r.dueDate).getTime() < Date.now() && r.debtAmount > 0
            return (
              <>
                <DialogHeader>
                  <DialogTitle>{r.supplierName || 'Накладная'}</DialogTitle>
                </DialogHeader>
                <div className="space-y-3 py-1">
                  <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                    <span>{r.date}</span>
                    <span className={`text-[11px] px-1.5 py-0.5 rounded font-medium ${badge.color}`}>{badge.label}</span>
                    {r.debtAmount > 0.005 && (() => {
                      const origDebt = r.totalAmount - r.paidAmount
                      const reduced = origDebt > r.debtAmount + 0.005
                      return (
                        <span className="text-[11px] px-1.5 py-0.5 rounded font-medium bg-destructive/10 text-destructive inline-flex items-baseline gap-1">
                          долг
                          {reduced && <span className="line-through opacity-60 tabular-nums">{formatCurrency(origDebt)}</span>}
                          <span className="font-bold tabular-nums">{formatCurrency(r.debtAmount)}</span>
                        </span>
                      )
                    })()}
                    {isOverdue && <span className="text-[11px] text-destructive font-medium">просрочка {r.dueDate}</span>}
                  </div>
                  {r.note && <p className="text-xs text-muted-foreground">Примечание: {r.note}</p>}

                  {/* Позиции */}
                  <div className="rounded-lg border border-border overflow-hidden divide-y divide-border">
                    {r.lines.map((line, idx) => (
                      <div key={line.ingredientId || idx} className="flex items-center gap-3 px-3 py-2">
                        <span className="text-sm text-foreground flex-1 truncate">{line.name}</span>
                        <span className="text-xs text-muted-foreground tabular-nums whitespace-nowrap">
                          {formatNum(line.qty)} {line.unit} × {formatCurrency(line.pricePerUnit)}
                        </span>
                        <span className="text-sm font-semibold text-foreground tabular-nums w-24 text-right">{formatCurrency(dMul(line.qty, line.pricePerUnit))}</span>
                      </div>
                    ))}
                    <div className="flex items-center justify-between px-3 py-2 bg-muted/30">
                      <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Итого</span>
                      <span className="text-sm font-bold text-foreground tabular-nums">{formatCurrency(r.totalAmount)}</span>
                    </div>
                  </div>

                  {/* Возвраты по накладной — что и на сколько вернули (в т.ч. частичный) */}
                  {rets.length > 0 && (
                    <div className="space-y-2">
                      <p className="text-xs font-semibold text-orange-600 dark:text-orange-400 flex items-center gap-1.5">
                        <Undo2 className="size-3.5" /> Возвраты по накладной
                      </p>
                      {rets.map((ret) => {
                        const cancelled = !!ret.cancelledAt
                        return (
                          <div key={ret.id} className={`rounded-lg border border-border overflow-hidden ${cancelled ? 'opacity-55' : ''}`}>
                            <div className="flex items-center justify-between px-3 py-2 bg-orange-50 dark:bg-orange-500/10 border-b border-border">
                              <span className="text-xs font-medium text-foreground">
                                {ret.date} · {RETURN_REASON_LABELS[ret.reason]}
                                {cancelled && <span className="ml-1.5 text-muted-foreground">(отменён)</span>}
                              </span>
                              <span className={`text-xs font-bold tabular-nums ${cancelled ? 'line-through text-muted-foreground' : 'text-orange-600 dark:text-orange-400'}`}>
                                −{formatCurrency(ret.totalAmount)}
                              </span>
                            </div>
                            <div className="divide-y divide-border">
                              {ret.lines.map((l) => (
                                <div key={l.id} className="flex items-center gap-3 px-3 py-1.5 text-xs">
                                  <span className="flex-1 text-foreground truncate">{l.name}</span>
                                  <span className="text-muted-foreground tabular-nums whitespace-nowrap">{formatNum(l.qty)} {l.unit}</span>
                                  <span className="font-medium text-foreground tabular-nums w-20 text-right">{formatCurrency(dMul(l.qty, l.pricePerUnit))}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}

                  {/* Сумма по факту — счёт минус действующие возвраты */}
                  {returned > 0.005 && (
                    <div className="flex items-center justify-between rounded-lg bg-muted/40 px-3 py-2.5">
                      <span className="text-sm font-semibold text-foreground">По факту (после возвратов)</span>
                      <span className="text-base font-bold text-foreground tabular-nums">{formatCurrency(r.totalAmount - returned)}</span>
                    </div>
                  )}
                </div>
                <DialogFooter className="sm:justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => setDetailFor(null)}
                    className="px-4 py-2 text-sm font-medium bg-card border border-border rounded-lg hover:bg-muted"
                  >
                    Закрыть
                  </button>
                  <div className="flex gap-2">
                    {/* Начальный долг (067) правится только в карточке
                        поставщика: у него нет товарных строк, а этот редактор
                        выводит сумму именно из них (бэк такую правку отбивает). */}
                    {isOwner && !r.isOpeningDebt && (
                      <button
                        type="button"
                        onClick={() => { setEditFor(r); setDetailFor(null) }}
                        className="flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium bg-card border border-border rounded-lg hover:bg-muted"
                      >
                        <Pencil className="size-4" />
                        Изменить
                      </button>
                    )}
                    {canDo('inventory.manage') && (
                      <button
                        type="button"
                        onClick={() => { setReturnFor(r); setDetailFor(null) }}
                        className="flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium bg-card border border-border rounded-lg hover:bg-muted"
                      >
                        <Undo2 className="size-4" />
                        Возврат
                      </button>
                    )}
                    {canDo('inventory.manage') && r.debtAmount > 0.005 && (
                      <button
                        type="button"
                        onClick={() => { setPayFor(r); setDetailFor(null) }}
                        className="flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium text-primary-foreground bg-primary rounded-lg hover:bg-primary/90"
                      >
                        <CreditCard className="size-4" />
                        Оплатить {formatCurrency(r.debtAmount)}
                      </button>
                    )}
                  </div>
                </DialogFooter>
              </>
            )
          })()}
        </DialogContent>
      </Dialog>


      {/* Возврат поставщику — склад и деньги/долг назад */}
      <CreateReturnDialog
        receipt={returnFor}
        open={!!returnFor}
        onOpenChange={(v) => { if (!v) setReturnFor(null) }}
        onSuccess={() => { void reload() }}
      />

      {/* Оплата долга по накладной — списание со счёта, долг накладной и поставщика вниз */}
      <PayReceiptDialog
        receipt={payFor}
        open={!!payFor}
        onOpenChange={(v) => { if (!v) setPayFor(null) }}
        onSuccess={() => { void reload() }}
      />

      {/* Правка накладной владельцем задним числом — строки/оплата/дата/примечание */}
      <EditReceiptDialog
        receipt={editFor}
        open={!!editFor}
        onOpenChange={(v) => { if (!v) setEditFor(null) }}
        onSuccess={() => { void reload() }}
      />
    </div>
  )
}
