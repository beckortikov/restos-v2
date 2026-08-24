'use client'

import { useState, useEffect } from 'react'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import { payRecurringPayment, fetchFinancialAccounts } from '@/lib/queries'
import { selectableAccounts } from '@/lib/queries/finance'
import { randomId } from '@/lib/random-id'
import { formatCurrency } from '@/lib/helpers'
import { type RecurringPayment, type FinancialAccount } from '@/lib/types'
import { CreditCard, AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'
import { humanizeError } from '@/lib/errors'

// PayRecurringDialog — провести платёж по шаблону. Сумма по умолчанию из
// шаблона, но правится (коммуналка меняется помесячно). Счёт — из шаблона либо
// выбирается. Бэк списывает со счёта и создаёт операционный расход.
export function PayRecurringDialog({ payment, open, onOpenChange, onSuccess }: {
  payment: RecurringPayment | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess: () => void
}) {
  const [accounts, setAccounts] = useState<FinancialAccount[]>([])
  const [accountId, setAccountId] = useState('')
  const [amount, setAmount] = useState('')
  const [saving, setSaving] = useState(false)
  const [idemKey, setIdemKey] = useState('')

  useEffect(() => {
    if (!open || !payment) return
    setAmount(String(payment.remainingAmount ?? payment.amount ?? 0))
    setIdemKey(randomId())
    fetchFinancialAccounts().then(selectableAccounts)
      .then(accs => {
        setAccounts(accs)
        setAccountId(payment.accountId || accs.find(a => a.type === 'cash')?.id || accs[0]?.id || '')
      })
      .catch(() => toast.error('Не удалось загрузить счета'))
  }, [open, payment?.id])

  const amountNum = Number(amount.replace(',', '.')) || 0
  const acc = accounts.find(a => a.id === accountId)
  const overBalance = !!acc && amountNum > acc.balance + 0.001
  const canSubmit = !saving && amountNum > 0 && !!accountId && !overBalance

  async function submit() {
    if (!payment || !canSubmit) return
    setSaving(true)
    try {
      await payRecurringPayment({ id: payment.id, amount: amountNum, accountId, idempotencyKey: idemKey })
      toast.success('Платёж проведён')
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
            Провести платёж
          </DialogTitle>
        </DialogHeader>

        {payment && (
          <div className="space-y-4">
            <div className="rounded-lg border border-border bg-muted/30 px-3 py-2.5">
              <p className="text-sm font-medium text-foreground">{payment.name}</p>
              {payment.category && <p className="text-xs text-muted-foreground">{payment.category}</p>}
              {payment.remainingAmount != null && (
                <p className="text-xs text-blue-700 mt-1">
                  Уже оплачено частично в этом цикле — остаток {formatCurrency(payment.remainingAmount)} из {formatCurrency(payment.amount)}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">Сумма</label>
              <input
                inputMode="decimal"
                value={amount}
                onChange={e => setAmount(e.target.value)}
                className="w-full px-3 py-2.5 text-sm bg-card border border-border rounded-lg tabular-nums focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
              {amountNum > 0 && amountNum < (payment.remainingAmount ?? payment.amount) && (
                <p className="text-xs text-muted-foreground">
                  Меньше остатка — платёж проведётся как частичный, срок не сдвинется, останется доплатить {formatCurrency((payment.remainingAmount ?? payment.amount) - amountNum)}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">Списать со счёта</label>
              <select
                value={accountId}
                onChange={e => setAccountId(e.target.value)}
                className="w-full px-3 py-2.5 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
              >
                {accounts.map(a => (
                  <option key={a.id} value={a.id}>{a.name} — {formatCurrency(a.balance)}</option>
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
