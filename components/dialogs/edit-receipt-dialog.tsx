'use client'

import { useState, useEffect } from 'react'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import { updateReceipt, fetchFinancialAccounts } from '@/lib/queries'
import { selectableAccounts } from '@/lib/queries/finance'
import { formatCurrency } from '@/lib/helpers'
import { type StockReceipt, type FinancialAccount, type ReceiptPaymentType } from '@/lib/types'
import { Pencil, AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'
import { humanizeError } from '@/lib/errors'

const PAYMENT_LABELS: Record<ReceiptPaymentType, string> = {
  paid: 'Оплачено полностью', partial: 'Частично', credit: 'В кредит',
}

interface LineForm {
  lineId: string
  name: string
  unit: string
  originalQty: number
  qty: string
  pricePerUnit: string
  // minQty — сколько нельзя опуститься ниже (уже возвращено поставщику +
  // недостающее физически на складе). Считает бэк (availableToReturn),
  // клиенту это точно не посчитать — не знает про отменённые возвраты.
  minQty: number
}

// EditReceiptDialog — правка уже созданной накладной ВЛАДЕЛЬЦЕМ задним числом.
// По образцу PayReceiptDialog/CreateReturnDialog — та же модалка, тот же
// паттерн. Смена поставщика в форму не вынесена (бэк это поддерживает, но
// только пока debt_amount=0 — узкий кейс, не первичная причина правки).
export function EditReceiptDialog({ receipt, open, onOpenChange, onSuccess }: {
  receipt: StockReceipt | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess: () => void
}) {
  const [note, setNote] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [date, setDate] = useState('')
  const [paymentType, setPaymentType] = useState<ReceiptPaymentType>('paid')
  const [paidAmount, setPaidAmount] = useState('')
  const [accountId, setAccountId] = useState('')
  const [accounts, setAccounts] = useState<FinancialAccount[]>([])
  const [lines, setLines] = useState<LineForm[]>([])
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open || !receipt) return
    setNote(receipt.note ?? '')
    setDueDate(receipt.dueDate ?? '')
    setDate(receipt.date)
    setPaymentType(receipt.paymentType)
    setPaidAmount(String(receipt.paidAmount ?? 0))
    setAccountId(receipt.accountId ?? '')
    setLines((receipt.lines ?? []).map(l => ({
      lineId: l.id ?? '', name: l.name, unit: l.unit, originalQty: l.qty,
      qty: String(l.qty), pricePerUnit: String(l.pricePerUnit),
      minQty: Math.max(0, l.qty - (l.availableToReturn ?? l.qty)),
    })))
    setLoading(true)
    fetchFinancialAccounts().then(selectableAccounts)
      .then(setAccounts)
      .catch(() => toast.error('Не удалось загрузить счета'))
      .finally(() => setLoading(false))
  }, [open, receipt?.id])

  if (!receipt) return null

  // total пересчитывается на лету из строк — то же, что увидит бэк.
  const total = lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.pricePerUnit) || 0), 0)
  const paidNum = paymentType === 'paid' ? total : (Number(paidAmount.replace(',', '.')) || 0)
  const acc = accounts.find(a => a.id === accountId)
  const paidDelta = paidNum - (receipt.paidAmount ?? 0)
  const overBalance = paidDelta > 0 && !!acc && paidDelta > acc.balance + 0.001
  const overTotal = paidNum > total + 0.001
  const needsAccount = paidDelta !== 0 && !accountId
  const anyLineBelowMin = lines.some(l => (Number(l.qty) || 0) < l.minQty - 0.001)
  const canSubmit = !saving && !loading && total > 0 && !overBalance && !overTotal && !needsAccount && !anyLineBelowMin

  async function submit() {
    if (!receipt || !canSubmit) return
    setSaving(true)
    try {
      const changedLines = lines
        .filter(l => Number(l.qty) !== l.originalQty || Number(l.pricePerUnit) !== (receipt!.lines.find(rl => rl.id === l.lineId)?.pricePerUnit ?? 0))
        .map(l => ({ lineId: l.lineId, qty: Number(l.qty), pricePerUnit: Number(l.pricePerUnit) }))
      await updateReceipt(receipt.id, {
        note: note || undefined,
        dueDate: dueDate || undefined,
        date: date || undefined,
        paymentType,
        paidAmount: paidNum,
        accountId: accountId || undefined,
        lines: changedLines.length > 0 ? changedLines : undefined,
      })
      toast.success('Накладная изменена')
      onSuccess()
      onOpenChange(false)
    } catch (e) {
      toast.error(humanizeError(e, 'Ошибка изменения накладной'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[88vh] flex flex-col rounded-xl">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <Pencil className="size-5 text-primary" />
            Изменить накладную
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 overflow-y-auto flex-1 min-h-0">
          <div className="rounded-lg border border-border bg-muted/30 px-3 py-2.5">
            <p className="text-sm font-medium text-foreground">{receipt.supplierName || 'Без поставщика'}</p>
            <p className="text-xs text-muted-foreground">Поставщика можно сменить только когда долг по накладной погашен — здесь не редактируется</p>
          </div>

          {/* Строки */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">Позиции</label>
            <div className="rounded-lg border border-border divide-y divide-border overflow-hidden">
              {lines.map((l, i) => {
                const belowMin = (Number(l.qty) || 0) < l.minQty - 0.001
                return (
                  <div key={l.lineId} className="p-2.5 space-y-1.5">
                    <p className="text-sm text-foreground truncate">{l.name}</p>
                    <div className="flex items-center gap-2">
                      <input
                        inputMode="decimal"
                        value={l.qty}
                        onChange={(e) => setLines(prev => prev.map((x, j) => j === i ? { ...x, qty: e.target.value } : x))}
                        className={`w-24 px-2 py-1.5 text-sm bg-card border rounded-lg tabular-nums focus:outline-none focus:ring-2 focus:ring-primary/30 ${belowMin ? 'border-destructive' : 'border-border'}`}
                      />
                      <span className="text-xs text-muted-foreground">{l.unit} ×</span>
                      <input
                        inputMode="decimal"
                        value={l.pricePerUnit}
                        onChange={(e) => setLines(prev => prev.map((x, j) => j === i ? { ...x, pricePerUnit: e.target.value } : x))}
                        className="w-24 px-2 py-1.5 text-sm bg-card border border-border rounded-lg tabular-nums focus:outline-none focus:ring-2 focus:ring-primary/30"
                      />
                      <span className="text-xs text-muted-foreground flex-1 text-right tabular-nums">
                        {formatCurrency((Number(l.qty) || 0) * (Number(l.pricePerUnit) || 0))}
                      </span>
                    </div>
                    {belowMin && (
                      <p className="flex items-center gap-1.5 text-xs text-destructive">
                        <AlertTriangle className="size-3.5 shrink-0" />
                        Нельзя меньше {l.minQty} {l.unit} — уже возвращено поставщику или расходовано со склада.
                      </p>
                    )}
                  </div>
                )
              })}
            </div>
            <div className="flex items-center justify-between px-1">
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Итого</span>
              <span className="text-sm font-bold text-foreground tabular-nums">{formatCurrency(total)}</span>
            </div>
          </div>

          {/* Оплата */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">Оплата</label>
            <div className="flex gap-2">
              {(['paid', 'partial', 'credit'] as ReceiptPaymentType[]).map(pt => (
                <button
                  key={pt}
                  type="button"
                  onClick={() => setPaymentType(pt)}
                  className={`flex-1 px-2.5 py-2 rounded-lg text-xs font-medium border transition-colors ${
                    paymentType === pt ? 'bg-primary text-primary-foreground border-primary' : 'bg-card border-border text-foreground hover:bg-muted'
                  }`}
                >
                  {PAYMENT_LABELS[pt]}
                </button>
              ))}
            </div>
            {paymentType !== 'paid' && (
              <input
                inputMode="decimal"
                value={paidAmount}
                onChange={(e) => setPaidAmount(e.target.value)}
                placeholder="Оплачено"
                className="w-full px-3 py-2 text-sm bg-card border border-border rounded-lg tabular-nums focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            )}
            {overTotal && (
              <p className="flex items-center gap-1.5 text-xs text-destructive">
                <AlertTriangle className="size-3.5 shrink-0" />
                Оплачено не может быть больше суммы накладной ({formatCurrency(total)}).
              </p>
            )}
          </div>

          {paidDelta !== 0 && (
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">
                {paidDelta > 0 ? 'Списать доплату со счёта' : 'Вернуть переплату на счёт'}
              </label>
              <select
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
                className="w-full px-3 py-2 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
              >
                <option value="">Выберите счёт</option>
                {accounts.map(a => (
                  <option key={a.id} value={a.id}>{a.name} — {formatCurrency(a.balance)}</option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                {paidDelta > 0 ? `Спишется ещё ${formatCurrency(paidDelta)}` : `Вернётся ${formatCurrency(-paidDelta)}`}
              </p>
              {overBalance && (
                <p className="flex items-center gap-1.5 text-xs text-destructive">
                  <AlertTriangle className="size-3.5 shrink-0" />
                  На счёте недостаточно денег ({formatCurrency(acc?.balance ?? 0)}).
                </p>
              )}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">Дата</label>
              <input
                type="date" value={date} onChange={(e) => setDate(e.target.value)}
                className="w-full px-3 py-2 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">Срок оплаты</label>
              <input
                type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)}
                className="w-full px-3 py-2 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">Примечание</label>
            <textarea
              value={note} onChange={(e) => setNote(e.target.value)} rows={2}
              className="w-full px-3 py-2 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30 resize-none"
            />
          </div>
        </div>

        <DialogFooter className="shrink-0">
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
            {saving ? 'Сохранение…' : 'Сохранить'}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
