'use client'

import { useState, useEffect, useMemo } from 'react'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { fetchRecurringPaymentHistory } from '@/lib/queries'
import { formatCurrency, formatDateTime } from '@/lib/helpers'
import { type RecurringPayment, type FinancialOperation } from '@/lib/types'
import { DateFilter, inRange, type DateFilterValue } from '@/components/warehouse/date-filter'
import { History, Ban } from 'lucide-react'

// RecurringPaymentHistoryDialog — «сколько уже платил» по шаблону: список
// financial_operations с source_ref на этот платёж (владелец жаловался, что
// после частичной оплаты факт платежа нигде не виден, кроме даты/суммы на
// самой карточке — тут вся история, не только последний платёж).
export function RecurringPaymentHistoryDialog({ payment, open, onOpenChange }: {
  payment: RecurringPayment | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [rows, setRows] = useState<FinancialOperation[]>([])
  const [loading, setLoading] = useState(true)
  const [range, setRange] = useState<DateFilterValue>(null)

  useEffect(() => {
    if (!open || !payment) return
    setLoading(true)
    setRange(null)
    fetchRecurringPaymentHistory(payment.id)
      .then(setRows)
      .catch(() => setRows([]))
      .finally(() => setLoading(false))
  }, [open, payment?.id])

  const filtered = useMemo(
    () => rows.filter(r => inRange(r.date, range)),
    [rows, range],
  )
  const totalPaid = useMemo(
    () => filtered.filter(r => !r.cancelledAt).reduce((s, r) => s + r.amount, 0),
    [filtered],
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[85vh] flex flex-col rounded-xl">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <History className="size-5 text-primary" />
            История платежей
          </DialogTitle>
          {payment && <p className="text-sm text-muted-foreground -mt-1">{payment.name}</p>}
        </DialogHeader>

        <div className="space-y-3 overflow-y-auto flex-1 min-h-0">
          <DateFilter value={range} onChange={setRange} />

          <div className="flex items-center justify-between rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm">
            <span className="text-muted-foreground">Оплачено {range ? 'за период' : 'всего'}</span>
            <span className="font-semibold text-foreground tabular-nums">{formatCurrency(totalPaid)} · {filtered.length} плат.</span>
          </div>

          {loading ? (
            <div className="py-10 flex items-center justify-center"><div className="size-6 border-4 border-primary/30 border-t-primary rounded-full animate-spin" /></div>
          ) : filtered.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              {rows.length === 0 ? 'Платежей ещё не было' : 'Нет платежей за выбранный период'}
            </p>
          ) : (
            <div className="divide-y divide-border rounded-xl border border-border overflow-hidden">
              {filtered.map(r => {
                const partial = r.description?.includes('(частично)')
                return (
                  <div key={r.id} className={`flex items-center justify-between gap-3 px-3 py-2.5 ${r.cancelledAt ? 'opacity-50' : ''}`}>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-xs text-muted-foreground">{r.createdAt ? formatDateTime(r.createdAt) : r.date}</span>
                        {partial && !r.cancelledAt && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-blue-100 text-blue-700">частично</span>
                        )}
                        {r.cancelledAt && (
                          <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded font-medium bg-muted text-muted-foreground">
                            <Ban className="size-2.5" />отменён
                          </span>
                        )}
                      </div>
                      {r.accountName && <p className="text-xs text-muted-foreground/70 truncate">{r.accountName}</p>}
                    </div>
                    <span className={`font-semibold tabular-nums whitespace-nowrap ${r.cancelledAt ? 'line-through text-muted-foreground' : 'text-foreground'}`}>
                      {formatCurrency(r.amount)}
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
