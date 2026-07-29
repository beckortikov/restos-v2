'use client'

import { useState, useEffect, useMemo, useCallback } from 'react'
import { formatCurrency, formatNum } from '@/lib/helpers'
import { dMul, dSum } from '@/lib/decimal'
import { type StockReturn, type StockReceipt, RETURN_REASON_LABELS } from '@/lib/types'
import { fetchStockReturns, cancelStockReturn, fetchReceipts } from '@/lib/queries'
import { useAuth } from '@/lib/auth-store'
import { useDataSync } from '@/hooks/use-data-sync'
import { CreateReturnDialog } from '@/components/dialogs/create-return-dialog'
import {
  Undo2, Wallet, Receipt, RotateCcw, Plus, Search, ChevronRight, X,
} from 'lucide-react'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import { toast } from 'sonner'
import { humanizeError } from '@/lib/errors'

// Возвраты поставщикам (редизайн, Фаза 3). Тач-карточки + action-sheet вместо
// десктопной таблицы с раскрытием строк. Главное — возврат теперь оформляется
// ПРЯМО ОТСЮДА: кнопка «Оформить возврат» → выбор накладной → тот же money-
// critical CreateReturnDialog (не тронут). Раньше был тупик «только чтение»:
// приходилось идти в Накладные, разворачивать строку и искать кнопку.

const REFUND_LABELS: Record<string, { label: string; color: string }> = {
  debt: { label: 'Уменьшен долг', color: 'bg-amber-100 dark:bg-amber-500/15 text-amber-700 dark:text-amber-500' },
  money: { label: 'Деньги на счёт', color: 'bg-emerald-100 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-500' },
}

export default function ReturnsPage() {
  const { canDo } = useAuth()
  const canManage = canDo('inventory.manage')

  const [returns, setReturns] = useState<StockReturn[]>([])
  const [receipts, setReceipts] = useState<StockReceipt[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')

  const [actionItem, setActionItem] = useState<StockReturn | null>(null) // карточка → детали
  const [confirmFor, setConfirmFor] = useState<StockReturn | null>(null) // финальное подтверждение отмены
  const [cancelling, setCancelling] = useState<string | null>(null)

  const [pickerOpen, setPickerOpen] = useState(false)     // выбор накладной для нового возврата
  const [pickerSearch, setPickerSearch] = useState('')
  const [returnFor, setReturnFor] = useState<StockReceipt | null>(null) // накладная → CreateReturnDialog

  const reload = useCallback(async () => {
    const [r, rc] = await Promise.all([fetchStockReturns(), fetchReceipts()])
    setReturns(r)
    setReceipts(rc)
  }, [])

  useEffect(() => {
    reload().finally(() => setLoading(false))
  }, [reload])

  // Real-time: возврат/накладная/движение на другом терминале → перезагрузка.
  useDataSync(['stock_returns', 'stock_receipts', 'ingredients'], reload)

  // Отмена возврата: товар назад на склад, деньги/долг откатываются. Документ
  // остаётся в истории зачёркнутым — так видно и ошибку, и её исправление.
  async function handleCancel(r: StockReturn) {
    setCancelling(r.id)
    setConfirmFor(null)
    try {
      await cancelStockReturn(r.id)
      await reload()
      toast.success(
        r.refundType === 'debt'
          ? `Возврат отменён. Товар вернулся на склад, долг вырос на ${formatCurrency(r.totalAmount)}`
          : `Возврат отменён. Товар вернулся на склад, ${formatCurrency(r.totalAmount)} списаны со счёта`,
      )
    } catch (e) {
      toast.error(humanizeError(e))
    } finally {
      setCancelling(null)
    }
  }

  // Итоги — только по действующим: у отменённых товар и деньги вернулись назад.
  const active = returns.filter(r => !r.cancelledAt)
  const total = dSum(active.map(r => r.totalAmount))
  const byMoney = dSum(active.filter(r => r.refundType === 'money').map(r => r.totalAmount))
  const byDebt = dSum(active.filter(r => r.refundType === 'debt').map(r => r.totalAmount))

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return returns
    return returns.filter(r =>
      (r.supplierName ?? '').toLowerCase().includes(q) ||
      (r.date ?? '').toLowerCase().includes(q))
  }, [returns, search])

  // Накладные для выбора: свежие сверху. Полностью возвращённые не прячем, но
  // помечаем — доступность по строкам всё равно проверит сам CreateReturnDialog.
  const pickerRows = useMemo(() => {
    const q = pickerSearch.trim().toLowerCase()
    return [...receipts]
      .filter(r => !q || (r.supplierName ?? '').toLowerCase().includes(q) || (r.date ?? '').toLowerCase().includes(q))
      .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
  }, [receipts, pickerSearch])

  if (loading) {
    return (
      <div className="p-6 flex items-center justify-center h-64">
        <div className="size-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" />
      </div>
    )
  }

  return (
    <div className="p-4 md:p-6 space-y-4 md:space-y-5 max-w-4xl mx-auto">
      {/* ── Header ── */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-foreground">Возвраты поставщикам</h1>
          <p className="text-muted-foreground text-sm mt-0.5">
            Испорченный и битый товар: со склада списан, деньги или долг возвращены.
          </p>
        </div>
        {canManage && (
          <button
            type="button"
            onClick={() => { setPickerSearch(''); setPickerOpen(true) }}
            className="shrink-0 flex items-center gap-1.5 bg-primary text-primary-foreground px-3.5 py-2 rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors"
          >
            <Plus className="size-4" />
            <span className="hidden sm:inline">Оформить возврат</span>
            <span className="sm:hidden">Возврат</span>
          </button>
        )}
      </div>

      {/* ── KPI ── */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {[
          { label: 'Всего возвратов', value: String(active.length), icon: Undo2, color: 'text-primary', bg: 'bg-primary/10' },
          { label: 'Вернули деньгами', value: formatCurrency(byMoney), icon: Wallet, color: 'text-emerald-600', bg: 'bg-emerald-100 dark:bg-emerald-500/15' },
          { label: 'Уменьшили долг', value: formatCurrency(byDebt), icon: Receipt, color: 'text-amber-600', bg: 'bg-amber-100 dark:bg-amber-500/15' },
        ].map((stat) => (
          <div key={stat.label} className="bg-card rounded-xl border border-border p-4 flex items-center gap-3">
            <div className={`size-10 rounded-lg flex items-center justify-center shrink-0 ${stat.bg}`}>
              <stat.icon className={`size-5 ${stat.color}`} />
            </div>
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">{stat.label}</p>
              <p className="text-base font-bold text-foreground tabular-nums truncate">{stat.value}</p>
            </div>
          </div>
        ))}
      </div>

      {/* ── Search ── */}
      {returns.length > 0 && (
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Поиск по поставщику или дате…"
            className="w-full pl-10 pr-3 py-2.5 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
        </div>
      )}

      {/* ── List ── */}
      {returns.length === 0 ? (
        <div className="bg-card rounded-xl border border-border p-10 text-center">
          <Undo2 className="size-8 text-muted-foreground/40 mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">Возвратов пока не было</p>
          {canManage && (
            <button
              type="button"
              onClick={() => { setPickerSearch(''); setPickerOpen(true) }}
              className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
            >
              <Plus className="size-4" />
              Оформить первый возврат
            </button>
          )}
        </div>
      ) : filtered.length === 0 ? (
        <div className="bg-card rounded-xl border border-border p-8 text-center text-sm text-muted-foreground">
          По запросу «{search}» ничего не найдено
        </div>
      ) : (
        <div className="bg-card rounded-xl border border-border overflow-hidden divide-y divide-border">
          {filtered.map((r) => {
            const rt = REFUND_LABELS[r.refundType]
            const cancelled = !!r.cancelledAt
            return (
              <button
                key={r.id}
                type="button"
                onClick={() => setActionItem(r)}
                className={`w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-muted/40 transition-colors ${cancelled ? 'opacity-55' : ''}`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className={`text-sm font-semibold text-foreground truncate ${cancelled ? 'line-through' : ''}`}>
                      {r.supplierName || '—'}
                    </p>
                    {cancelled && (
                      <span className="shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded bg-muted text-muted-foreground">Отменён</span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {r.date} · {RETURN_REASON_LABELS[r.reason]} · {r.lines.length} поз.
                  </p>
                </div>
                <div className="flex flex-col items-end gap-1 shrink-0">
                  <span className={`text-sm font-bold text-foreground tabular-nums ${cancelled ? 'line-through' : ''}`}>
                    {formatCurrency(r.totalAmount)}
                  </span>
                  {!cancelled && (
                    <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${rt.color}`}>{rt.label}</span>
                  )}
                </div>
                <ChevronRight className="size-4 text-muted-foreground shrink-0" />
              </button>
            )
          })}
          {/* Итог по действующим */}
          <div className="flex items-center justify-between px-4 py-3 bg-muted/20">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Итого действующих</span>
            <span className="font-bold text-foreground tabular-nums">{formatCurrency(total)}</span>
          </div>
        </div>
      )}

      {/* ── Детали возврата (action-sheet) ── */}
      <Dialog open={!!actionItem} onOpenChange={(v) => { if (!v) setActionItem(null) }}>
        <DialogContent className="sm:max-w-lg rounded-xl max-h-[85vh] overflow-y-auto">
          {actionItem && (() => {
            const rt = REFUND_LABELS[actionItem.refundType]
            const cancelled = !!actionItem.cancelledAt
            return (
              <>
                <DialogHeader>
                  <DialogTitle className="flex items-center gap-2">
                    <Undo2 className="size-4" />
                    {actionItem.supplierName || 'Возврат'}
                  </DialogTitle>
                </DialogHeader>
                <div className="space-y-3 py-1">
                  <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                    <span>{actionItem.date}</span>
                    <span>·</span>
                    <span>{RETURN_REASON_LABELS[actionItem.reason]}</span>
                    <span className={`text-[11px] px-1.5 py-0.5 rounded font-medium ${rt.color}`}>{rt.label}</span>
                    {cancelled && (
                      <span className="text-[11px] px-1.5 py-0.5 rounded font-medium bg-muted text-muted-foreground">
                        Отменён
                      </span>
                    )}
                  </div>

                  {actionItem.note && (
                    <p className="text-xs text-muted-foreground">Комментарий: {actionItem.note}</p>
                  )}

                  {/* Позиции */}
                  <div className="rounded-lg border border-border overflow-hidden divide-y divide-border">
                    {actionItem.lines.map((line) => (
                      <div key={line.id} className="flex items-center gap-3 px-3 py-2">
                        <span className="text-sm text-foreground flex-1 truncate">{line.name}</span>
                        <span className="text-xs text-muted-foreground tabular-nums whitespace-nowrap">
                          {formatNum(line.qty)} {line.unit} × {formatCurrency(line.pricePerUnit)}
                        </span>
                        <span className="text-sm font-semibold text-foreground tabular-nums w-24 text-right">
                          {formatCurrency(dMul(line.qty, line.pricePerUnit))}
                        </span>
                      </div>
                    ))}
                    <div className="flex items-center justify-between px-3 py-2 bg-muted/30">
                      <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Итого</span>
                      <span className="text-sm font-bold text-foreground tabular-nums">{formatCurrency(actionItem.totalAmount)}</span>
                    </div>
                  </div>
                </div>
                <DialogFooter>
                  <button
                    type="button"
                    onClick={() => setActionItem(null)}
                    className="px-4 py-2 text-sm font-medium bg-card border border-border rounded-lg hover:bg-muted"
                  >
                    Закрыть
                  </button>
                  {!cancelled && canManage && (
                    <button
                      type="button"
                      onClick={() => { setConfirmFor(actionItem); setActionItem(null) }}
                      disabled={cancelling === actionItem.id}
                      className="px-4 py-2 text-sm font-medium text-destructive bg-destructive/10 hover:bg-destructive/15 rounded-lg flex items-center gap-2 disabled:opacity-50"
                    >
                      <RotateCcw className="size-4" />
                      Отменить возврат
                    </button>
                  )}
                </DialogFooter>
              </>
            )
          })()}
        </DialogContent>
      </Dialog>

      {/* ── Подтверждение отмены: механику словами, а не термином «сторно» ── */}
      <Dialog open={!!confirmFor} onOpenChange={(v) => { if (!v) setConfirmFor(null) }}>
        <DialogContent className="sm:max-w-md rounded-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <RotateCcw className="size-4" />
              Отменить возврат?
            </DialogTitle>
          </DialogHeader>
          {confirmFor && (
            <div className="space-y-3 py-1 text-sm">
              <p className="text-muted-foreground">
                Возврат поставщику <strong className="text-foreground">{confirmFor.supplierName || '—'}</strong>
                {' '}от {confirmFor.date} на{' '}
                <strong className="text-foreground">{formatCurrency(confirmFor.totalAmount)}</strong>.
              </p>
              <div className="rounded-lg border border-border bg-muted/40 p-3 space-y-1.5 text-xs">
                <p className="flex items-start gap-2">
                  <span className="text-muted-foreground shrink-0">Товар:</span>
                  <span className="text-foreground">вернётся на склад</span>
                </p>
                <p className="flex items-start gap-2">
                  <span className="text-muted-foreground shrink-0">Деньги:</span>
                  <span className="text-foreground">
                    {confirmFor.refundType === 'debt'
                      ? <>долг поставщику вырастет обратно на {formatCurrency(confirmFor.totalAmount)}</>
                      : <>{formatCurrency(confirmFor.totalAmount)} спишутся со счёта обратно поставщику</>}
                  </span>
                </p>
                <p className="flex items-start gap-2">
                  <span className="text-muted-foreground shrink-0">Документ:</span>
                  <span className="text-foreground">останется в истории отменённым</span>
                </p>
              </div>
            </div>
          )}
          <DialogFooter>
            <button
              onClick={() => setConfirmFor(null)}
              className="px-4 py-2 text-sm font-medium bg-card border border-border rounded-lg hover:bg-muted"
            >
              Не отменять
            </button>
            <button
              onClick={() => confirmFor && handleCancel(confirmFor)}
              className="px-4 py-2 text-sm font-medium text-white bg-destructive rounded-lg hover:bg-destructive/90 flex items-center gap-2"
            >
              <RotateCcw className="size-4" />
              Отменить возврат
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Выбор накладной для нового возврата ── */}
      <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
        <DialogContent className="sm:max-w-lg rounded-xl max-h-[85vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Undo2 className="size-4" />
              Возврат по накладной
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground -mt-1">
            Возврат оформляется по конкретной накладной — поставщик вернёт ровно ту сумму, что взял.
          </p>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <input
              value={pickerSearch}
              onChange={(e) => setPickerSearch(e.target.value)}
              placeholder="Поиск накладной по поставщику…"
              className="w-full pl-10 pr-3 py-2.5 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>
          <div className="flex-1 overflow-y-auto -mx-1 px-1">
            {pickerRows.length === 0 ? (
              <div className="py-10 text-center text-sm text-muted-foreground">
                {receipts.length === 0 ? 'Накладных пока нет' : 'Ничего не найдено'}
              </div>
            ) : (
              <div className="rounded-lg border border-border overflow-hidden divide-y divide-border">
                {pickerRows.map((rc) => {
                  const fullyReturned = (rc.returnedTotal ?? 0) >= rc.totalAmount - 0.01 && (rc.returnedTotal ?? 0) > 0
                  const hasDebt = rc.debtAmount > 0
                  return (
                    <button
                      key={rc.id}
                      type="button"
                      onClick={() => { setReturnFor(rc); setPickerOpen(false) }}
                      className="w-full flex items-center gap-3 px-3 py-3 text-left hover:bg-muted/40 transition-colors"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-foreground truncate">{rc.supplierName || '—'}</p>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {rc.date} · {formatCurrency(rc.totalAmount)}
                        </p>
                      </div>
                      {fullyReturned ? (
                        <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded font-medium bg-muted text-muted-foreground">возвращено</span>
                      ) : hasDebt ? (
                        <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded font-medium bg-red-100 dark:bg-red-500/15 text-destructive">долг {formatCurrency(rc.debtAmount)}</span>
                      ) : null}
                      <ChevronRight className="size-4 text-muted-foreground shrink-0" />
                    </button>
                  )
                })}
              </div>
            )}
          </div>
          <DialogFooter>
            <button
              type="button"
              onClick={() => setPickerOpen(false)}
              className="px-4 py-2 text-sm font-medium bg-card border border-border rounded-lg hover:bg-muted flex items-center gap-1.5"
            >
              <X className="size-4" />
              Закрыть
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Оформление возврата — money-critical диалог, переиспользуем как есть ── */}
      <CreateReturnDialog
        receipt={returnFor}
        open={!!returnFor}
        onOpenChange={(v) => { if (!v) setReturnFor(null) }}
        onSuccess={() => { setReturnFor(null); void reload() }}
      />
    </div>
  )
}
