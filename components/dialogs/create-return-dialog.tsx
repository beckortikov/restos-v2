'use client'

import { useState, useEffect, useMemo } from 'react'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import { fetchStockReturns, createStockReturn, fetchFinancialAccounts } from '@/lib/queries'
import { formatCurrency, formatNum } from '@/lib/helpers'
import { dMul, dSub, dSum } from '@/lib/decimal'
import {
  type StockReceipt, type ReturnReason, type RefundType, type FinancialAccount,
  RETURN_REASON_LABELS,
} from '@/lib/types'
import { Undo2, AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'
import { humanizeError } from '@/lib/errors'

const REASONS: ReturnReason[] = ['spoilage', 'breakage', 'expired', 'other']

// CreateReturnDialog — возврат поставщику по конкретной накладной.
//
// Возврат привязан к строке накладной: цена не редактируется (её отдаёт бэк из
// накладной — поставщик вернёт ровно ту сумму, что взял), вводится только
// количество. «Доступно» = принято − уже возвращённое по этой строке.
export function CreateReturnDialog({ receipt, open, onOpenChange, onSuccess }: {
  receipt: StockReceipt | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess: () => void
}) {
  // qty по id строки накладной; 0/пусто — строка не возвращается.
  const [qtyByLine, setQtyByLine] = useState<Record<string, string>>({})
  const [returnedByLine, setReturnedByLine] = useState<Record<string, number>>({})
  const [reason, setReason] = useState<ReturnReason>('spoilage')
  const [refundType, setRefundType] = useState<RefundType>('debt')
  const [accounts, setAccounts] = useState<FinancialAccount[]>([])
  const [accountId, setAccountId] = useState('')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(false)

  const hasDebt = (receipt?.debtAmount ?? 0) > 0

  useEffect(() => {
    if (!open || !receipt) return
    setQtyByLine({})
    setNote('')
    setReason('spoilage')
    // Долг есть → по умолчанию гасим долг; накладная оплачена → деньги назад.
    setRefundType(hasDebt ? 'debt' : 'money')
    setLoading(true)
    Promise.all([
      fetchStockReturns({ receiptId: receipt.id }),
      fetchFinancialAccounts(),
    ])
      .then(([returns, accs]) => {
        const sums: Record<string, number> = {}
        for (const r of returns) {
          for (const l of r.lines) {
            sums[l.receiptLineId] = dSum([sums[l.receiptLineId] ?? 0, l.qty])
          }
        }
        setReturnedByLine(sums)
        setAccounts(accs)
        // Подставляем счёт накладной, иначе первый наличный.
        setAccountId(receipt.accountId || accs.find(a => a.type === 'cash')?.id || accs[0]?.id || '')
      })
      .catch(() => toast.error('Не удалось загрузить данные по накладной'))
      .finally(() => setLoading(false))
  }, [open, receipt?.id])

  const rows = useMemo(() => {
    if (!receipt) return []
    return receipt.lines.map(line => {
      const available = dSub(line.qty, returnedByLine[line.id ?? ''] ?? 0)
      const raw = qtyByLine[line.id ?? ''] ?? ''
      const qty = Number(raw.replace(',', '.')) || 0
      return { line, available, raw, qty, over: qty > available }
    })
  }, [receipt, returnedByLine, qtyByLine])

  const selected = rows.filter(r => r.qty > 0)
  const total = dSum(selected.map(r => dMul(r.qty, r.line.pricePerUnit)))
  const anyOver = rows.some(r => r.over)
  // Долг гасим только в пределах остатка долга по накладной — иначе бэк
  // ответит 409 (за товар уже заплачено, деньги обязаны вернуться живыми).
  const overDebt = refundType === 'debt' && total > (receipt?.debtAmount ?? 0)
  const canSubmit = selected.length > 0 && !anyOver && !overDebt && !saving &&
    (refundType === 'money' ? !!accountId : hasDebt)

  async function submit() {
    if (!receipt) return
    setSaving(true)
    try {
      await createStockReturn({
        receiptId: receipt.id,
        reason,
        refundType,
        accountId: refundType === 'money' ? accountId : undefined,
        note: note.trim() || undefined,
        lines: selected.map(r => ({ receiptLineId: r.line.id as string, qty: r.qty })),
      })
      toast.success(
        refundType === 'debt'
          ? `Возврат проведён. Долг уменьшен на ${formatCurrency(total)}`
          : `Возврат проведён. ${formatCurrency(total)} вернулись на счёт`,
      )
      onOpenChange(false)
      onSuccess()
    } catch (e) {
      toast.error(humanizeError(e))
    } finally {
      setSaving(false)
    }
  }

  if (!receipt) return null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl rounded-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Undo2 className="size-4" />
            Возврат поставщику
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-1">
          <p className="text-sm text-muted-foreground">
            Накладная от <strong className="text-foreground">{receipt.supplierName || '—'}</strong>
            {receipt.date && <> · {receipt.date}</>} · сумма{' '}
            <strong className="text-foreground">{formatCurrency(receipt.totalAmount)}</strong>
          </p>

          {loading ? (
            <div className="h-24 flex items-center justify-center">
              <div className="size-6 border-4 border-primary/30 border-t-primary rounded-full animate-spin" />
            </div>
          ) : (
            <>
              {/* Позиции: цена не редактируется — она из накладной */}
              <div className="rounded-lg border border-border overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-muted/40 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                      <th className="px-3 py-2 text-left">Наименование</th>
                      <th className="w-28 px-3 py-2 text-right">Доступно</th>
                      <th className="w-28 px-3 py-2 text-right">Вернуть</th>
                      <th className="w-24 px-3 py-2 text-right">Цена</th>
                      <th className="w-28 px-3 py-2 text-right">Сумма</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {rows.map(({ line, available, raw, qty, over }) => (
                      <tr key={line.id} className={over ? 'bg-destructive/5' : ''}>
                        <td className="px-3 py-2 text-foreground">{line.name}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                          {formatNum(available)} {line.unit}
                        </td>
                        <td className="px-3 py-2">
                          <input
                            value={raw}
                            onChange={(e) => setQtyByLine(p => ({ ...p, [line.id ?? '']: e.target.value }))}
                            inputMode="decimal"
                            placeholder="0"
                            disabled={available <= 0}
                            className={`w-full px-2 py-1.5 text-sm text-right tabular-nums bg-card border rounded-md focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-40 ${
                              over ? 'border-destructive' : 'border-border'
                            }`}
                          />
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                          {formatCurrency(line.pricePerUnit)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums font-semibold text-foreground">
                          {qty > 0 ? formatCurrency(dMul(qty, line.pricePerUnit)) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {anyOver && (
                <p className="flex items-center gap-1.5 text-xs text-destructive">
                  <AlertTriangle className="size-3.5 shrink-0" />
                  Нельзя вернуть больше, чем пришло по накладной
                </p>
              )}

              {/* Причина */}
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-foreground">Причина</label>
                <div className="flex flex-wrap gap-2">
                  {REASONS.map(r => (
                    <button
                      key={r}
                      onClick={() => setReason(r)}
                      className={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${
                        reason === r
                          ? 'bg-primary text-primary-foreground border-primary'
                          : 'bg-card border-border hover:bg-muted'
                      }`}
                    >
                      {RETURN_REASON_LABELS[r]}
                    </button>
                  ))}
                </div>
              </div>

              {/* Куда деньги */}
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-foreground">Куда деньги</label>
                <div className="space-y-2">
                  <button
                    onClick={() => setRefundType('debt')}
                    disabled={!hasDebt}
                    className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg border text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                      refundType === 'debt' ? 'border-primary bg-primary/5' : 'border-border bg-card hover:bg-muted'
                    }`}
                  >
                    <span className="font-medium text-foreground">Уменьшить долг</span>
                    <span className="text-xs text-muted-foreground">
                      {hasDebt
                        ? <>долг {formatCurrency(receipt.debtAmount)} → {formatCurrency(dSub(receipt.debtAmount, total))}</>
                        : 'долга по накладной нет'}
                    </span>
                  </button>
                  <button
                    onClick={() => setRefundType('money')}
                    className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg border text-sm transition-colors ${
                      refundType === 'money' ? 'border-primary bg-primary/5' : 'border-border bg-card hover:bg-muted'
                    }`}
                  >
                    <span className="font-medium text-foreground">Вернули деньги</span>
                    <span className="text-xs text-muted-foreground">поставщик отдал сумму назад</span>
                  </button>
                  {refundType === 'money' && (
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
                  )}
                  {overDebt && (
                    <p className="flex items-center gap-1.5 text-xs text-destructive">
                      <AlertTriangle className="size-3.5 shrink-0" />
                      Возврат больше остатка долга ({formatCurrency(receipt.debtAmount)}) — за товар уже
                      заплачено. Верните деньгами или уменьшите количество.
                    </p>
                  )}
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="text-sm font-medium text-foreground">Комментарий</label>
                <input
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Необязательно"
                  className="w-full px-3 py-2 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </div>
            </>
          )}
        </div>

        <DialogFooter className="items-center sm:justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            Итого к возврату: <strong className="text-foreground tabular-nums">{formatCurrency(total)}</strong>
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => onOpenChange(false)}
              className="px-4 py-2 text-sm font-medium bg-card border border-border rounded-lg hover:bg-muted"
            >
              Отмена
            </button>
            <button
              onClick={submit}
              disabled={!canSubmit}
              className="px-4 py-2 text-sm font-medium text-primary-foreground bg-primary rounded-lg hover:bg-primary/90 disabled:opacity-50 flex items-center gap-2"
            >
              <Undo2 className="size-4" />
              {saving ? 'Проведение...' : 'Провести возврат'}
            </button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
