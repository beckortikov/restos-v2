'use client'

import { useState, useEffect } from 'react'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import { payReceipt, fetchFinancialAccounts } from '@/lib/queries'
import { randomId } from '@/lib/random-id'
import { formatCurrency } from '@/lib/helpers'
import { type StockReceipt, type FinancialAccount } from '@/lib/types'
import { CreditCard, AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'
import { humanizeError } from '@/lib/errors'

// PayReceiptDialog — оплата долга по конкретной накладной. Сумма по умолчанию —
// весь остаток долга (обычный случай — гасят целиком), но можно оплатить часть.
// Бэк клампит сумму к остатку долга накладной, так что переплатить нельзя.
export function PayReceiptDialog({ receipt, open, onOpenChange, onSuccess }: {
  receipt: StockReceipt | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess: () => void
}) {
  const [accounts, setAccounts] = useState<FinancialAccount[]>([])
  const [accountId, setAccountId] = useState('')
  const [amount, setAmount] = useState('')
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(false)
  // Один ключ на сессию диалога — второй клик уйдёт с ним же, и бэк вернёт
  // кэшированный ответ первой оплаты вместо второго списания.
  const [idemKey, setIdemKey] = useState('')

  const debt = receipt?.debtAmount ?? 0

  useEffect(() => {
    if (!open || !receipt) return
    setAmount(String(receipt.debtAmount ?? 0))
    setIdemKey(randomId())
    setLoading(true)
    fetchFinancialAccounts()
      .then(accs => {
        setAccounts(accs)
        // Какой счёт оплачивал накладную изначально — неизвестно (у stock_receipts
        // нет account_id). Берём наличный по умолчанию.
        setAccountId(accs.find(a => a.type === 'cash')?.id || accs[0]?.id || '')
      })
      .catch(() => toast.error('Не удалось загрузить счета'))
      .finally(() => setLoading(false))
  }, [open, receipt?.id])

  const amountNum = Number(amount.replace(',', '.')) || 0
  const acc = accounts.find(a => a.id === accountId)
  const overBalance = !!acc && amountNum > acc.balance + 0.001
  const overDebt = amountNum > debt + 0.001
  const canSubmit = !saving && !loading && amountNum > 0 && !!accountId && !overBalance && !overDebt

  async function submit() {
    if (!receipt || !canSubmit) return
    setSaving(true)
    try {
      await payReceipt({ receiptId: receipt.id, amount: amountNum, accountId, idempotencyKey: idemKey })
      toast.success('Оплата проведена')
      onSuccess()
      onOpenChange(false)
    } catch (e) {
      toast.error(humanizeError(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CreditCard className="size-5 text-primary" />
            Оплата накладной
          </DialogTitle>
        </DialogHeader>

        {receipt && (
          <div className="space-y-4">
            <div className="flex items-center justify-between rounded-lg border border-border bg-muted/30 px-3 py-2.5">
              <div>
                <p className="text-sm font-medium text-foreground">{receipt.supplierName || 'Без поставщика'}</p>
                <p className="text-xs text-muted-foreground">Накладная от {receipt.date}</p>
              </div>
              <div className="text-right">
                <p className="text-xs text-muted-foreground">Долг</p>
                <p className="text-sm font-bold text-destructive tabular-nums">{formatCurrency(debt)}</p>
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">Сумма оплаты</label>
              <input
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="w-full px-3 py-2.5 text-sm bg-card border border-border rounded-lg tabular-nums focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
              {debt > 0 && amountNum !== debt && !overDebt && (
                <button
                  type="button"
                  onClick={() => setAmount(String(debt))}
                  className="text-xs text-primary hover:underline"
                >
                  Оплатить весь долг — {formatCurrency(debt)}
                </button>
              )}
              {overDebt && (
                <p className="flex items-center gap-1.5 text-xs text-destructive">
                  <AlertTriangle className="size-3.5 shrink-0" />
                  Больше остатка долга ({formatCurrency(debt)}).
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">Списать со счёта</label>
              <select
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
                className="w-full px-3 py-2.5 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
              >
                {accounts.map(a => (
                  <option key={a.id} value={a.id}>
                    {a.name} — {formatCurrency(a.balance)}
                  </option>
                ))}
              </select>
              {overBalance && (
                <p className="flex items-center gap-1.5 text-xs text-destructive">
                  <AlertTriangle className="size-3.5 shrink-0" />
                  На счёте недостаточно денег ({formatCurrency(acc?.balance ?? 0)}).
                </p>
              )}
            </div>
          </div>
        )}

        <DialogFooter>
          <button
            onClick={() => onOpenChange(false)}
            className="px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
          >
            Отмена
          </button>
          <button
            onClick={submit}
            disabled={!canSubmit}
            className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <CreditCard className="size-4" />
            {saving ? 'Проведение…' : 'Оплатить'}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
