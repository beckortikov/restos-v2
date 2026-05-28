'use client'

import React, { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '@/lib/auth-store'
import { formatCurrency, formatNum } from '@/lib/helpers'
import { dMul } from '@/lib/decimal'
import { type StockReceipt, type Supplier } from '@/lib/types'
import { fetchReceipts, fetchSuppliers, confirmReceiptFull, fetchFinancialAccounts } from '@/lib/queries'
import { Plus, CheckCircle, Clock, CreditCard } from 'lucide-react'
import { type FinancialAccount } from '@/lib/types'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import { toast } from 'sonner'

const PAYMENT_LABELS: Record<string, { label: string; color: string }> = {
  paid: { label: 'Оплачено', color: 'bg-emerald-100 text-emerald-700' },
  credit: { label: 'В кредит', color: 'bg-red-100 text-red-700' },
  partial: { label: 'Частично', color: 'bg-amber-100 text-amber-700' },
}

export default function ReceiptsPage() {
  const { user, canDo } = useAuth()
  const navigate = useNavigate()
  const [expanded, setExpanded] = useState<string | null>(null)
  const [receipts, setReceipts] = useState<StockReceipt[]>([])
  const [, setSuppliers] = useState<Supplier[]>([])
  const [loading, setLoading] = useState(true)
  const [confirmDialog, setConfirmDialog] = useState<{ open: boolean; receiptId: string; receiptTotal: number }>({ open: false, receiptId: '', receiptTotal: 0 })
  const [accounts, setAccounts] = useState<FinancialAccount[]>([])
  const [selectedAccountId, setSelectedAccountId] = useState('')
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    Promise.all([fetchReceipts(), fetchSuppliers()])
      .then(([r, s]) => { setReceipts(r); setSuppliers(s); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  async function openConfirmDialog(receiptId: string) {
    const receipt = receipts.find(r => r.id === receiptId)
    if (!receipt) return
    try {
      const accs = await fetchFinancialAccounts()
      setAccounts(accs)
      setSelectedAccountId(accs.find(a => a.type === 'cash')?.id || accs[0]?.id || '')
    } catch {}
    setConfirmDialog({ open: true, receiptId, receiptTotal: receipt.totalAmount })
  }

  async function handleConfirmReceipt() {
    setConfirming(true)
    try {
      await confirmReceiptFull(confirmDialog.receiptId, user?.id || '', selectedAccountId || undefined)
      const updated = await fetchReceipts()
      setReceipts(updated)
      setConfirmDialog({ open: false, receiptId: '', receiptTotal: 0 })
      toast.success('Накладная подтверждена. Склад обновлён.')
    } catch {
      toast.error('Ошибка при подтверждении накладной')
    } finally {
      setConfirming(false)
    }
  }

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

      {/* Table */}
      <div className="bg-card rounded-xl border border-border overflow-hidden">
        <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[600px]">
          <thead>
            <tr className="border-b border-border bg-muted/40">
              {['#', 'Дата', 'Поставщик', 'Оплата', 'Сумма', 'Оплачено', 'Долг', 'Срок', 'Статус', ''].map((h) => (
                <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wide">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {receipts.map((r) => {
              const pt = PAYMENT_LABELS[r.paymentType]
              const isOverdue = r.dueDate && new Date(r.dueDate).getTime() < Date.now() && r.debtAmount > 0
              return (
                <React.Fragment key={r.id}>
                  <tr
                    onClick={() => setExpanded(expanded === r.id ? null : r.id)}
                    className="border-b border-border hover:bg-muted/30 cursor-pointer transition-colors"
                  >
                    <td className="px-4 py-3 text-xs font-mono text-muted-foreground">{r.id}</td>
                    <td className="px-4 py-3 text-sm text-foreground">{r.date}</td>
                    <td className="px-4 py-3 font-medium text-foreground">{r.supplierName}</td>
                    <td className="px-4 py-3">
                      <span className={`text-xs px-2 py-0.5 rounded font-medium ${pt.color}`}>{pt.label}</span>
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
                    <td className="px-4 py-3">
                      {r.confirmedAt ? (
                        <span className="flex items-center gap-1 text-xs text-emerald-600">
                          <CheckCircle className="size-3.5" />Проведено
                        </span>
                      ) : (
                        <span className="text-xs text-amber-600">Черновик</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {!r.confirmedAt && canDo('inventory.manage') && (
                        <button
                          onClick={(e) => { e.stopPropagation(); openConfirmDialog(r.id) }}
                          className="text-xs text-primary hover:underline whitespace-nowrap"
                        >
                          Подтвердить
                        </button>
                      )}
                    </td>
                  </tr>
                  {expanded === r.id && (
                    <tr key={`${r.id}-exp`} className="bg-muted/20">
                      <td colSpan={10} className="px-6 py-4">
                        <p className="text-xs font-semibold text-muted-foreground mb-2">Позиции накладной ({r.lines.length}):</p>
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

      {/* Confirm receipt dialog — choose account */}
      <Dialog open={confirmDialog.open} onOpenChange={(v) => setConfirmDialog(p => ({ ...p, open: v }))}>
        <DialogContent className="sm:max-w-md rounded-xl">
          <DialogHeader>
            <DialogTitle>Подтверждение накладной</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <p className="text-sm text-muted-foreground">
              Сумма: <strong className="text-foreground">{formatCurrency(confirmDialog.receiptTotal)}</strong>
            </p>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">Списать со счёта</label>
              <select
                value={selectedAccountId}
                onChange={(e) => setSelectedAccountId(e.target.value)}
                className="w-full px-3 py-2.5 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
              >
                {accounts.map(a => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({a.type === 'cash' ? 'Наличные' : 'Банк'}) — {formatCurrency(a.balance)}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <DialogFooter>
            <button onClick={() => setConfirmDialog(p => ({ ...p, open: false }))}
              className="px-4 py-2 text-sm font-medium bg-card border border-border rounded-lg hover:bg-muted">
              Отмена
            </button>
            <button onClick={handleConfirmReceipt} disabled={!selectedAccountId || confirming}
              className="px-4 py-2 text-sm font-medium text-white bg-primary rounded-lg hover:bg-primary/90 disabled:opacity-50 flex items-center gap-2">
              <CheckCircle className="size-4" />
              {confirming ? 'Подтверждение...' : 'Подтвердить и списать'}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
