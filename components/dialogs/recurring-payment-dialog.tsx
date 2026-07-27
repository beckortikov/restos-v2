'use client'

import { useState, useEffect } from 'react'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import {
  createRecurringPayment, updateRecurringPayment, fetchFinancialAccounts,
} from '@/lib/queries'
import { selectableAccounts } from '@/lib/queries/finance'
import { type RecurringPayment, type FinancialAccount } from '@/lib/types'
import { CalendarClock } from 'lucide-react'
import { toast } from 'sonner'
import { humanizeError } from '@/lib/errors'

const CATEGORY_SUGGESTIONS = ['Аренда', 'Коммуналка', 'Интернет', 'Зарплата', 'Налоги', 'Подписка', 'Прочее']

// RecurringPaymentDialog — создание/редактирование шаблона регулярного платежа.
export function RecurringPaymentDialog({ payment, open, onOpenChange, onSuccess }: {
  payment: RecurringPayment | null // null → создание
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess: () => void
}) {
  const editing = !!payment
  const [accounts, setAccounts] = useState<FinancialAccount[]>([])
  const [name, setName] = useState('')
  const [amount, setAmount] = useState('')
  const [dayOfMonth, setDayOfMonth] = useState('1')
  const [accountId, setAccountId] = useState('')
  const [category, setCategory] = useState('')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    fetchFinancialAccounts().then(selectableAccounts)
      .then(accs => {
        setAccounts(accs)
        setAccountId(payment?.accountId || accs.find(a => a.type === 'cash')?.id || accs[0]?.id || '')
      })
      .catch(() => toast.error('Не удалось загрузить счета'))
    setName(payment?.name ?? '')
    setAmount(payment ? String(payment.amount) : '')
    setDayOfMonth(String(payment?.dayOfMonth ?? 1))
    setCategory(payment?.category ?? '')
    setNote(payment?.note ?? '')
  }, [open, payment?.id])

  const amountNum = Number(amount.replace(',', '.')) || 0
  const domNum = Math.min(31, Math.max(1, Number(dayOfMonth) || 1))
  const canSubmit = !saving && name.trim().length > 0 && amountNum >= 0

  async function submit() {
    if (!canSubmit) return
    setSaving(true)
    try {
      const draft = {
        name: name.trim(), amount: amountNum, dayOfMonth: domNum,
        accountId: accountId || undefined, category: category.trim() || undefined,
        note: note.trim() || undefined,
      }
      if (editing) await updateRecurringPayment(payment!.id, draft)
      else await createRecurringPayment(draft)
      toast.success(editing ? 'Платёж обновлён' : 'Платёж добавлен')
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
            <CalendarClock className="size-5 text-primary" />
            {editing ? 'Изменить платёж' : 'Новый регулярный платёж'}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">Название</label>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Аренда помещения"
              className="w-full px-3 py-2.5 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">Сумма</label>
              <input
                inputMode="decimal"
                value={amount}
                onChange={e => setAmount(e.target.value)}
                placeholder="0"
                className="w-full px-3 py-2.5 text-sm bg-card border border-border rounded-lg tabular-nums focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">День оплаты</label>
              <input
                inputMode="numeric"
                value={dayOfMonth}
                onChange={e => setDayOfMonth(e.target.value)}
                className="w-full px-3 py-2.5 text-sm bg-card border border-border rounded-lg tabular-nums focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">Счёт по умолчанию</label>
            <select
              value={accountId}
              onChange={e => setAccountId(e.target.value)}
              className="w-full px-3 py-2.5 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
            >
              {accounts.map(a => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">Категория</label>
            <input
              value={category}
              onChange={e => setCategory(e.target.value)}
              placeholder="Аренда"
              list="recurring-cat-suggestions"
              className="w-full px-3 py-2.5 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
            <datalist id="recurring-cat-suggestions">
              {CATEGORY_SUGGESTIONS.map(c => <option key={c} value={c} />)}
            </datalist>
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">Комментарий</label>
            <input
              value={note}
              onChange={e => setNote(e.target.value)}
              placeholder="Необязательно"
              className="w-full px-3 py-2 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>
        </div>

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
            className="bg-primary text-primary-foreground px-4 py-2 rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {saving ? 'Сохранение…' : editing ? 'Сохранить' : 'Добавить'}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
