'use client'

import React, { useState, useEffect } from 'react'
import { formatCurrency, formatNum } from '@/lib/helpers'
import { dMul, dSum } from '@/lib/decimal'
import { type StockReturn, RETURN_REASON_LABELS } from '@/lib/types'
import { fetchStockReturns, cancelStockReturn } from '@/lib/queries'
import { useAuth } from '@/lib/auth-store'
import { Undo2, Wallet, Receipt, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import { humanizeError } from '@/lib/errors'

const REFUND_LABELS: Record<string, { label: string; color: string }> = {
  debt: { label: 'Уменьшен долг', color: 'bg-amber-100 text-amber-700' },
  money: { label: 'Деньги на счёт', color: 'bg-emerald-100 text-emerald-700' },
}

export default function ReturnsPage() {
  const { canDo } = useAuth()
  const [expanded, setExpanded] = useState<string | null>(null)
  const [returns, setReturns] = useState<StockReturn[]>([])
  const [loading, setLoading] = useState(true)
  const [cancelling, setCancelling] = useState<string | null>(null)

  // Сторно: товар назад на склад, деньги/долг откатываются. Документ остаётся в
  // истории зачёркнутым — так видно и ошибку, и её исправление.
  async function handleCancel(r: StockReturn) {
    setCancelling(r.id)
    try {
      await cancelStockReturn(r.id)
      setReturns(await fetchStockReturns())
      toast.success(
        r.refundType === 'debt'
          ? `Возврат отменён. Долг восстановлен на ${formatCurrency(r.totalAmount)}`
          : `Возврат отменён. ${formatCurrency(r.totalAmount)} списаны обратно поставщику`,
      )
    } catch (e) {
      toast.error(humanizeError(e))
    } finally {
      setCancelling(null)
    }
  }

  useEffect(() => {
    fetchStockReturns()
      .then(r => { setReturns(r); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  if (loading) {
    return (
      <div className="p-6 flex items-center justify-center h-64">
        <div className="size-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" />
      </div>
    )
  }

  // Итоги — только по действующим: у отменённых товар и деньги вернулись назад.
  const active = returns.filter(r => !r.cancelledAt)
  const total = dSum(active.map(r => r.totalAmount))
  const byMoney = dSum(active.filter(r => r.refundType === 'money').map(r => r.totalAmount))
  const byDebt = dSum(active.filter(r => r.refundType === 'debt').map(r => r.totalAmount))

  return (
    <div className="p-4 md:p-6 space-y-4 md:space-y-5">
      <div>
        <h1 className="text-xl font-bold text-foreground">Возвраты поставщикам</h1>
        <p className="text-muted-foreground text-sm mt-0.5">
          Испорченный и битый товар: со склада списан, деньги или долг возвращены.
          Оформляется из накладной — раздел «Накладные (Приход)».
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {[
          { label: 'Всего возвратов', value: String(active.length), icon: Undo2, color: 'text-primary' },
          { label: 'Вернули деньгами', value: formatCurrency(byMoney), icon: Wallet, color: 'text-emerald-600' },
          { label: 'Уменьшили долг', value: formatCurrency(byDebt), icon: Receipt, color: 'text-amber-600' },
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

      {returns.length === 0 ? (
        <div className="bg-card rounded-xl border border-border p-10 text-center">
          <Undo2 className="size-8 text-muted-foreground/40 mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">Возвратов пока не было</p>
          <p className="text-xs text-muted-foreground/70 mt-1">
            Возврат оформляется из накладной: разверните её и нажмите «Возврат»
          </p>
        </div>
      ) : (
        <div className="bg-card rounded-xl border border-border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[600px]">
              <thead>
                <tr className="border-b border-border bg-muted/40">
                  {['Дата', 'Поставщик', 'Причина', 'Куда деньги', 'Позиций', 'Сумма', ''].map((h) => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wide">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {returns.map((r) => {
                  const rt = REFUND_LABELS[r.refundType]
                  return (
                    <React.Fragment key={r.id}>
                      <tr
                        onClick={() => setExpanded(expanded === r.id ? null : r.id)}
                        className={`border-b border-border hover:bg-muted/30 cursor-pointer transition-colors ${
                          r.cancelledAt ? 'opacity-50 line-through' : ''
                        }`}
                      >
                        <td className="px-4 py-3 text-foreground">{r.date}</td>
                        <td className="px-4 py-3 font-medium text-foreground">{r.supplierName || '—'}</td>
                        <td className="px-4 py-3 text-muted-foreground">{RETURN_REASON_LABELS[r.reason]}</td>
                        <td className="px-4 py-3">
                          <span className={`text-xs px-2 py-0.5 rounded font-medium ${rt.color}`}>{rt.label}</span>
                        </td>
                        <td className="px-4 py-3 tabular-nums text-muted-foreground">{r.lines.length}</td>
                        <td className="px-4 py-3 font-semibold text-foreground tabular-nums">{formatCurrency(r.totalAmount)}</td>
                        <td className="px-4 py-3">
                          {r.cancelledAt ? (
                            <span className="text-xs text-muted-foreground">Отменён</span>
                          ) : canDo('inventory.manage') ? (
                            <button
                              onClick={(e) => { e.stopPropagation(); handleCancel(r) }}
                              disabled={cancelling === r.id}
                              className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-destructive disabled:opacity-50 whitespace-nowrap transition-colors"
                            >
                              <RotateCcw className="size-3.5" />
                              {cancelling === r.id ? 'Отмена…' : 'Сторно'}
                            </button>
                          ) : null}
                        </td>
                      </tr>
                      {expanded === r.id && (
                        <tr className="bg-muted/20">
                          <td colSpan={7} className="px-6 py-4">
                            {r.note && <p className="text-xs text-muted-foreground mb-2">Комментарий: {r.note}</p>}
                            <div className="overflow-hidden rounded-lg border border-border bg-card max-w-3xl">
                              <table className="w-full text-sm">
                                <thead>
                                  <tr className="bg-muted/40 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                                    <th className="px-3 py-2 text-left">Наименование</th>
                                    <th className="w-24 px-3 py-2 text-right">Кол-во</th>
                                    <th className="w-12 px-2 py-2 text-left">Ед.</th>
                                    <th className="w-32 px-3 py-2 text-right">Цена накладной</th>
                                    <th className="w-32 px-3 py-2 text-right">Сумма</th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-border">
                                  {r.lines.map((line) => (
                                    <tr key={line.id}>
                                      <td className="px-3 py-2 text-foreground">{line.name}</td>
                                      <td className="px-3 py-2 text-right tabular-nums">{formatNum(line.qty)}</td>
                                      <td className="px-2 py-2 text-muted-foreground">{line.unit}</td>
                                      <td className="px-3 py-2 text-right text-muted-foreground tabular-nums">{formatCurrency(line.pricePerUnit)}</td>
                                      <td className="px-3 py-2 text-right font-semibold text-foreground tabular-nums">{formatCurrency(dMul(line.qty, line.pricePerUnit))}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  )
                })}
              </tbody>
              <tfoot>
                <tr className="bg-muted/20 border-t border-border">
                  <td colSpan={5} className="px-4 py-3 text-right text-xs font-semibold text-muted-foreground uppercase tracking-wider">Итого</td>
                  <td className="px-4 py-3 font-bold text-foreground tabular-nums">{formatCurrency(total)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
