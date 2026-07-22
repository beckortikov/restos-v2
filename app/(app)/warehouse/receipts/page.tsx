'use client'

import React, { useState, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '@/lib/auth-store'
import { formatCurrency, formatNum } from '@/lib/helpers'
import { dMul } from '@/lib/decimal'
import { type StockReceipt, type Supplier } from '@/lib/types'
import { fetchReceipts, fetchSuppliers } from '@/lib/queries'
import { Plus, CheckCircle, Clock, CreditCard, Undo2, Search } from 'lucide-react'
import { CreateReturnDialog } from '@/components/dialogs/create-return-dialog'

// Статус-фильтры списка накладных. 'debt' — есть непогашенный долг; 'returns' —
// был возврат поставщику (полный/частичный). Счётчики считаются от всех накладных.
type ReceiptFilter = 'all' | 'debt' | 'paid' | 'returns'

const PAYMENT_LABELS: Record<string, { label: string; color: string }> = {
  paid: { label: 'Оплачено', color: 'bg-emerald-100 text-emerald-700' },
  credit: { label: 'В кредит', color: 'bg-red-100 text-red-700' },
  partial: { label: 'Частично', color: 'bg-amber-100 text-amber-700' },
}

export default function ReceiptsPage() {
  const { canDo } = useAuth()
  const navigate = useNavigate()
  const [expanded, setExpanded] = useState<string | null>(null)
  const [receipts, setReceipts] = useState<StockReceipt[]>([])
  const [, setSuppliers] = useState<Supplier[]>([])
  const [loading, setLoading] = useState(true)
  const [returnFor, setReturnFor] = useState<StockReceipt | null>(null)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<ReceiptFilter>('all')

  useEffect(() => {
    Promise.all([fetchReceipts(), fetchSuppliers()])
      .then(([r, s]) => { setReceipts(r); setSuppliers(s); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

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
          { label: 'Итого по приходу', value: formatCurrency(receipts.reduce((s, r) => s + r.totalAmount, 0)), icon: CreditCard, color: 'text-blue-600' },
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

      {/* Table */}
      {filtered.length > 0 && (
      <div className="bg-card rounded-xl border border-border overflow-hidden">
        <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[600px]">
          <thead>
            <tr className="border-b border-border bg-muted/40">
              {['Дата', 'Поставщик', 'Оплата', 'Сумма', 'Оплачено', 'Долг', 'Срок'].map((h) => (
                <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wide">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => {
              const pt = PAYMENT_LABELS[r.paymentType]
              // Возврат поставщику перекрывает статус оплаты: полный → «Возвращено»,
              // частичный → «Возврат части». Иначе показываем статус оплаты.
              const returned = r.returnedTotal ?? 0
              const fullyReturned = returned > 0 && returned >= r.totalAmount - 0.01
              const badge = returned > 0
                ? (fullyReturned
                    ? { label: 'Возвращено', color: 'bg-rose-100 text-rose-700' }
                    : { label: 'Возврат части', color: 'bg-orange-100 text-orange-700' })
                : pt
              const isOverdue = r.dueDate && new Date(r.dueDate).getTime() < Date.now() && r.debtAmount > 0
              return (
                <React.Fragment key={r.id}>
                  <tr
                    onClick={() => setExpanded(expanded === r.id ? null : r.id)}
                    className="border-b border-border hover:bg-muted/30 cursor-pointer transition-colors"
                  >
                    <td className="px-4 py-3 text-sm text-foreground">{r.date}</td>
                    <td className="px-4 py-3 font-medium text-foreground">{r.supplierName}</td>
                    <td className="px-4 py-3">
                      <span
                        className={`text-xs px-2 py-0.5 rounded font-medium ${badge.color}`}
                        title={returned > 0 ? `Возвращено ${formatCurrency(returned)} из ${formatCurrency(r.totalAmount)}` : undefined}
                      >{badge.label}</span>
                    </td>
                    <td className="px-4 py-3 font-semibold text-foreground">{formatCurrency(r.totalAmount)}</td>
                    <td className="px-4 py-3 text-emerald-600 font-medium">{formatCurrency(r.paidAmount)}</td>
                    <td className="px-4 py-3">
                      <span className={r.debtAmount > 0 ? 'text-destructive font-medium' : 'text-muted-foreground'}>
                        {formatCurrency(r.debtAmount)}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {r.dueDate ? (
                        <span className={isOverdue ? 'text-destructive font-semibold' : 'text-foreground'}>{r.dueDate}</span>
                      ) : <span className="text-muted-foreground">—</span>}
                    </td>
                  </tr>
                  {expanded === r.id && (
                    <tr key={`${r.id}-exp`} className="bg-muted/20">
                      <td colSpan={7} className="px-6 py-4">
                        <div className="flex items-center justify-between gap-3 mb-2 max-w-3xl">
                          <p className="text-xs font-semibold text-muted-foreground">Позиции накладной ({r.lines.length}):</p>
                          {canDo('inventory.manage') && (
                            <button
                              onClick={() => setReturnFor(r)}
                              className="flex items-center gap-1.5 text-xs font-medium text-foreground bg-card border border-border px-2.5 py-1.5 rounded-lg hover:bg-muted transition-colors"
                            >
                              <Undo2 className="size-3.5" />
                              Возврат
                            </button>
                          )}
                        </div>
                        <div className="overflow-hidden rounded-lg border border-border bg-card max-w-3xl">
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="bg-muted/40 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                                <th className="w-8 px-3 py-2 text-left">№</th>
                                <th className="px-3 py-2 text-left">Наименование</th>
                                <th className="w-24 px-3 py-2 text-right">Кол-во</th>
                                <th className="w-12 px-2 py-2 text-left">Ед.</th>
                                <th className="w-32 px-3 py-2 text-right">Цена</th>
                                <th className="w-32 px-3 py-2 text-right">Сумма</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-border">
                              {r.lines.map((line, idx) => (
                                <tr key={line.ingredientId} className="hover:bg-muted/30 transition-colors">
                                  <td className="px-3 py-2 text-muted-foreground tabular-nums">{idx + 1}</td>
                                  <td className="px-3 py-2 text-foreground">{line.name}</td>
                                  <td className="px-3 py-2 text-right tabular-nums">{formatNum(line.qty)}</td>
                                  <td className="px-2 py-2 text-muted-foreground">{line.unit}</td>
                                  <td className="px-3 py-2 text-right text-muted-foreground tabular-nums">{formatCurrency(line.pricePerUnit)}</td>
                                  <td className="px-3 py-2 text-right font-semibold text-foreground tabular-nums">{formatCurrency(dMul(line.qty, line.pricePerUnit))}</td>
                                </tr>
                              ))}
                            </tbody>
                            <tfoot>
                              <tr className="bg-muted/20 border-t border-border">
                                <td colSpan={5} className="px-3 py-2 text-right text-xs font-semibold text-muted-foreground uppercase tracking-wider">Итого</td>
                                <td className="px-3 py-2 text-right font-bold text-foreground tabular-nums">{formatCurrency(r.totalAmount)}</td>
                              </tr>
                            </tfoot>
                          </table>
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              )
            })}
          </tbody>
        </table>
        </div>
      </div>
      )}


      {/* Возврат поставщику — склад и деньги/долг назад */}
      <CreateReturnDialog
        receipt={returnFor}
        open={!!returnFor}
        onOpenChange={(v) => { if (!v) setReturnFor(null) }}
        onSuccess={() => { fetchReceipts().then(setReceipts).catch(() => {}) }}
      />
    </div>
  )
}
