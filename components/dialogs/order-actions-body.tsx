'use client'

/**
 * OrderActionsBody — содержимое sidebar'а с действиями над заказом, извлечённое
 * из OrderActionsDialog. Используется в:
 *  • OrderActionsDialog (на /operations/orders) — обёрнут в Sheet.
 *  • TableDetailSheet (на /operations/table-map) — также внутри Sheet карты зала,
 *    но без дублирования логики платежей/скидок/voids.
 *
 * Контракт:
 *  • Никаких внешних Sheet header'ов/footer'ов — здесь и содержимое, и footer.
 *  • onClose() — родитель должен закрыть свой Sheet (используется внутри для
 *    «Дозаказ» / «Refresh» / receipt-печати).
 *
 * Раньше: 1100+ строк в OrderActionsDialog. Раскопировано в табличный
 * sheet (1127 строк), кнопка «Закрыть и оплатить» там гейтилась только на
 * bill_requested — кассир не мог оплатить заказы на других статусах.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { toast } from 'sonner'
import { formatCurrency, getTimeSince, calcLineTotal, calcLineCogs, formatQty, visibleReceiptItems, voidedItemFlags } from '@/lib/helpers'
import { dAdd, dSub, dMul, dDiv, dRound, dSum } from '@/lib/decimal'
import {
  ORDER_STATUS_LABELS,
  VOID_REASON_LABELS,
  type Order,
  type OrderStatus,
  type PaymentMethod,
  type OrderPayment,
  type Table,
  type User,
  type VoidReason,
  type Zone,
} from '@/lib/types'
import { fetchTables, fetchUsers, fetchZones, fetchFinancialAccounts, fetchMenuItems, createVoid, cancelOrder } from '@/lib/queries'
import { buildReceiptData } from '@/lib/receipt-data'
import { useAuth } from '@/lib/auth-store'
import { PrintReceipt, type ReceiptData } from '@/components/print-receipt'
import { SplitBillDialog } from '@/components/dialogs/split-bill-dialog'
import { fetchOrderSplits, paySplit, cancelSplits, fetchVoidsForOrder } from '@/lib/queries'
import { type OrderSplit, type OrderVoid } from '@/lib/types'
import {
  Clock,
  MapPin,
  UserCircle,
  Flame,
  XCircle,
  Scissors,
  CheckCircle2,
  CreditCard,
  Banknote,
  ArrowRightLeft,
  Wallet,
  Building2,
  Printer,
  Percent,
  Minus,
  Plus,
  FileText,
  Tag,
  Trash2,
  AlertTriangle,
  Ban,
  RotateCcw,
} from 'lucide-react'

interface FinancialAccount {
  id: string
  name: string
  type: string
  balance: number
}

export interface OrderActionData {
  paymentMethod?: PaymentMethod
  cogs?: number
  accountId?: string
  accountName?: string
  servicePercent?: number
  serviceAmount?: number
  totalWithService?: number
  tipAmount?: number
  payments?: OrderPayment[]
  discountAmount?: number
  discountType?: string
  discountValue?: number
  discountReason?: string
}

export interface OrderActionsBodyProps {
  order: Order
  /** Вызывается на любую end-of-flow операцию (close_and_pay, cancel, reopen,
   *  start_cooking, mark_ready, refresh). Родитель решает что обновить и
   *  стоит ли закрыть Sheet. */
  onAction: (action: string, data?: OrderActionData) => void
  /** Cброс/закрытие текущего Sheet (например, когда внутри понадобилось
   *  открыть «Дозаказ» — Sheet нужно закрыть, чтобы AddItemsDialog не
   *  оказался под ним). */
  onClose: () => void
  /** Сигнал родителю освежить список заказов (после void/discount изменений,
   *  которые не идут через onAction). */
  onItemsChanged?: () => void
  /** Скрыть мета-блок (Стол/Официант/Время) — родитель сам показывает
   *  заголовок стола и переключатель групп. */
  hideMeta?: boolean
}

const CANCEL_QUICK_REASONS = [
  { label: 'Клиент отменил', value: 'Отменено клиентом' },
  { label: 'Кухня отменила', value: 'Отменено кухней' },
] as const

const CANCEL_REASON_PRESETS = [
  'Ошибка официанта',
  'Нет ингредиента',
  'Другое',
]

const DEFAULT_SERVICE_PERCENT = 10

// Любой заказ, не помеченный как доставка/самовывоз, считается зальным.
const isHallOrder = (t?: string | null) =>
  t !== 'delivery' && t !== 'takeaway'

const STATUS_STYLE: Record<OrderStatus, { bg: string; text: string }> = {
  new: { bg: 'bg-blue-100', text: 'text-blue-700' },
  cooking: { bg: 'bg-amber-100', text: 'text-amber-700' },
  ready: { bg: 'bg-emerald-100', text: 'text-emerald-700' },
  served: { bg: 'bg-teal-100', text: 'text-teal-700' },
  bill_requested: { bg: 'bg-rose-100', text: 'text-rose-700' },
  done: { bg: 'bg-muted', text: 'text-muted-foreground' },
  cancelled: { bg: 'bg-zinc-200', text: 'text-zinc-700' },
}

const TYPE_LABELS: Record<string, string> = {
  hall: 'Зал',
  delivery: 'Доставка',
  takeaway: 'Самовывоз',
}

type PaymentType = 'cash' | 'noncash'

const PAYMENT_OPTIONS: { value: PaymentType; label: string; icon: React.ReactNode }[] = [
  { value: 'cash', label: 'Наличные', icon: <Banknote className="size-5" /> },
  { value: 'noncash', label: 'Безналичные', icon: <CreditCard className="size-5" /> },
]

export function OrderActionsBody({
  order,
  onAction,
  onClose,
  onItemsChanged,
  hideMeta,
}: OrderActionsBodyProps) {
  const { user, restaurant, canDo } = useAuth()
  const role = user?.role || ''
  const [paymentType, setPaymentType] = useState<PaymentType>('cash')
  const [selectedAccountId, setSelectedAccountId] = useState<string>('')
  const [servicePercent, setServicePercent] = useState(DEFAULT_SERVICE_PERCENT)
  const [includeService, setIncludeService] = useState(true)
  const [tipAmount, setTipAmount] = useState(0)
  const [tables, setTables] = useState<Table[]>([])
  const [zones, setZones] = useState<Zone[]>([])
  const [users, setUsers] = useState<User[]>([])
  const [accounts, setAccounts] = useState<FinancialAccount[]>([])
  const [menuItemsData, setMenuItemsData] = useState<{ id: string; cookTimeMin?: number | null; station?: string }[]>([])
  const [dataLoaded, setDataLoaded] = useState(false)
  const [showReceipt, setShowReceipt] = useState(false)
  const [receiptData, setReceiptData] = useState<ReceiptData | null>(null)
  const receiptRef = useRef<HTMLDivElement>(null)

  // Split bill
  const [showSplitDialog, setShowSplitDialog] = useState(false)
  const [splits, setSplits] = useState<OrderSplit[]>([])

  // Discount
  const [discountType, setDiscountType] = useState<'percent' | 'fixed' | null>(null)
  const [discountValue, setDiscountValue] = useState(0)
  const [discountAmount, setDiscountAmount] = useState(0)
  const [discountReason, setDiscountReason] = useState('')
  const [showDiscountForm, setShowDiscountForm] = useState(false)

  // Void items
  const [voidingItemIdx, setVoidingItemIdx] = useState<number | null>(null)
  const [voidReason, setVoidReason] = useState<VoidReason>('guest_changed_mind')
  const [voidQty, setVoidQty] = useState(0)
  const [voidedIndices, setVoidedIndices] = useState<Set<number>>(new Set())
  const [voids, setVoids] = useState<OrderVoid[]>([])

  // Cancel order
  const [cancelOrderConfirmOpen, setCancelOrderConfirmOpen] = useState(false)
  const [cancelOrderReasonChoice, setCancelOrderReasonChoice] = useState<string>('Ошибка официанта')
  const [cancelOrderReasonCustom, setCancelOrderReasonCustom] = useState('')
  const [cancelOrderMore, setCancelOrderMore] = useState(false)
  const [cancelInFlight, setCancelInFlight] = useState(false)

  // Mixed payments
  const [payments, setPayments] = useState<OrderPayment[]>([])
  const [showAddPayment, setShowAddPayment] = useState(false)
  const [addPaymentMethod, setAddPaymentMethod] = useState<PaymentType>('cash')
  const [addPaymentAccountId, setAddPaymentAccountId] = useState<string>('')
  const [addPaymentAmount, setAddPaymentAmount] = useState('')

  // Initial data load (one-shot). При смене order.id перезагружаем voids/splits ниже.
  useEffect(() => {
    fetchFinancialAccounts().then(a => {
      setAccounts(a)
      const cash = a.find(acc => acc.type === 'cash')
      if (cash) setSelectedAccountId(cash.id)
      else if (a.length > 0) setSelectedAccountId(a[0].id)
    }).catch(() => {})
    if (!dataLoaded) {
      fetchTables().then(t => setTables(t)).catch(() => {})
      fetchZones().then(z => setZones(z)).catch(() => {})
      fetchUsers().then(u => setUsers(u)).catch(() => {})
      fetchMenuItems().then(mi => setMenuItemsData(mi)).catch(() => {})
      setDataLoaded(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (order.isSplit) {
      fetchOrderSplits(order.id).then(setSplits)
    } else {
      setSplits([])
    }
  }, [order.id, order.isSplit])

  useEffect(() => {
    if (order.id) {
      fetchVoidsForOrder(order.id).then(setVoids).catch(() => setVoids([]))
    } else {
      setVoids([])
    }
  }, [order.id])

  // service default — OFF для takeaway/delivery; восстанавливаем процент из настроек.
  useEffect(() => {
    setIncludeService(isHallOrder(order.type))
    if (order.servicePercent && order.servicePercent > 0) {
      setServicePercent(order.servicePercent)
    } else if (restaurant?.servicePercent !== undefined && restaurant.servicePercent >= 0) {
      setServicePercent(restaurant.servicePercent)
    }
  }, [order.id, order.type, order.servicePercent, restaurant?.servicePercent])

  useEffect(() => {
    if (accounts.length === 0) return
    if (paymentType === 'cash') {
      const cash = accounts.find(a => a.type === 'cash')
      if (cash) setSelectedAccountId(cash.id)
    } else {
      const banks = accounts.filter(a => a.type === 'bank')
      if (banks.length > 0) setSelectedAccountId(banks[0].id)
    }
  }, [paymentType, accounts])

  // Reset receipt-overlay при смене заказа.
  useEffect(() => {
    setShowReceipt(false)
    setReceiptData(null)
    setTipAmount(0)
    setDiscountType(null)
    setDiscountValue(0)
    setDiscountAmount(0)
    setDiscountReason('')
    setShowDiscountForm(false)
    setPayments([])
    setShowAddPayment(false)
    setAddPaymentAmount('')
    setVoidingItemIdx(null)
    setVoidReason('guest_changed_mind')
    setVoidedIndices(new Set())
    setCancelOrderConfirmOpen(false)
    setCancelOrderReasonChoice('Ошибка официанта')
    setCancelOrderReasonCustom('')
    setCancelOrderMore(false)
  }, [order.id])

  const handlePrint = useCallback(async () => {
    if (!order?.id) return
    if (receiptData?.isPreCheck) {
      try {
        const { printPreBill } = await import('@/lib/queries')
        const { jobId } = await printPreBill(order.id)
        toast.success(jobId ? `Пре-чек отправлен (${jobId.slice(0, 8)}…)` : 'Пре-чек отправлен на печать')
      } catch (e) {
        toast.error(e instanceof Error ? `Ошибка печати: ${e.message}` : 'Ошибка печати')
      }
      return
    }
    toast.info('Чек уже отправлен на печать бэкендом при закрытии заказа')
  }, [receiptData, order])

  const voidedFlagsFromDb = voidedItemFlags(order.items, voids)
  const visibleItemsForTotals = visibleReceiptItems(order.items, voids)
  const subtotal = dRound(dSum(visibleItemsForTotals.map(i => calcLineTotal(i.price, i.qty, i.unit, i.unitSize))))
  const discountedSubtotal = dSub(subtotal, discountAmount)
  const serviceAmount = includeService ? dRound(dDiv(dMul(discountedSubtotal, servicePercent), 100)) : 0
  const totalWithService = dAdd(dAdd(discountedSubtotal, serviceAmount), tipAmount)
  const paymentsTotal = dSum(payments.map(p => p.amount))
  const remainingAmount = Math.max(0, dSub(totalWithService, paymentsTotal))

  const handlePreCheck = useCallback(() => {
    const receipt = buildReceiptData(
      order,
      { tables, users, zones, restaurant, currentUser: user, voids },
      {
        isPreCheck: true,
        includeService,
        servicePercent,
        discountAmount,
        discountReason,
      },
    )
    setReceiptData(receipt)
    setShowReceipt(true)
  }, [order, tables, users, zones, includeService, servicePercent, restaurant, user, discountAmount, discountReason, voids])

  const table = order.tableId ? tables.find((t) => t.id === order.tableId) : null
  const waiter = order.waiterId ? users.find((u) => u.id === order.waiterId) : null
  const style = STATUS_STYLE[order.status] ?? STATUS_STYLE.new

  const handleCloseAndPay = () => {
    const cogs = dSum(visibleItemsForTotals.map(i => calcLineCogs(i.cogs || 0, i.qty, i.unit, i.unitSize)))

    const finalPayments = payments.length > 0 ? payments : (() => {
      const acc = accounts.find(a => a.id === selectedAccountId)
      const pm: PaymentMethod = paymentType === 'cash' ? 'cash' : 'card'
      return [{ method: pm, amount: totalWithService, accountId: selectedAccountId, accountName: acc?.name }] as OrderPayment[]
    })()

    const primaryPm = finalPayments[0]?.method ?? (paymentType === 'cash' ? 'cash' : 'card') as PaymentMethod
    const primaryAcc = finalPayments[0]?.accountName

    const receipt = buildReceiptData(
      order,
      { tables, users, zones, restaurant, currentUser: user, voids },
      {
        isPreCheck: false,
        includeService,
        servicePercent,
        discountAmount,
        discountReason,
        tipAmount,
        paymentMethod: primaryPm,
        accountName: primaryAcc,
      },
    )

    setReceiptData(receipt)
    setShowReceipt(true)

    onAction('close_and_pay', {
      paymentMethod: primaryPm,
      cogs,
      accountId: finalPayments[0]?.accountId ?? selectedAccountId,
      accountName: primaryAcc,
      servicePercent: includeService ? servicePercent : 0,
      serviceAmount,
      totalWithService,
      tipAmount,
      payments: finalPayments,
      discountAmount: discountAmount > 0 ? discountAmount : undefined,
      discountType: discountType ?? undefined,
      discountValue: discountValue > 0 ? discountValue : undefined,
      discountReason: discountReason || undefined,
    })
  }

  // ─── Receipt view after payment ──────────────────────────────────────────
  if (showReceipt && receiptData) {
    return (
      <div className="flex flex-col flex-1 min-h-0">
        <div className="px-4 py-3 border-b flex items-center gap-2 text-sm font-semibold">
          {receiptData.isPreCheck ? (
            <>
              <FileText className="size-5 text-blue-500" />
              Предварительный счёт
            </>
          ) : (
            <>
              <CheckCircle2 className="size-5 text-emerald-500" />
              Заказ оплачен
            </>
          )}
          <span className="ml-auto text-xs text-muted-foreground font-normal">
            {receiptData.isPreCheck
              ? `Заказ #${receiptData.orderId.slice(0, 8).toUpperCase()}`
              : `${receiptData.paymentMethod === 'cash' ? 'Наличные' : 'Безналичные'} · ${receiptData.accountName}`}
          </span>
        </div>
        <div className="flex-1 overflow-y-auto px-4 flex flex-col items-center py-4">
          <div className="bg-white rounded-lg shadow-lg border border-border p-2">
            <PrintReceipt ref={receiptRef} data={receiptData} />
          </div>
        </div>
        <div className="px-4 py-3 border-t flex gap-2">
          <button
            onClick={handlePrint}
            className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-5 py-4 text-base font-medium md:py-3 md:text-sm text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            <Printer className="size-4" />
            Печать чека
          </button>
          <button
            onClick={onClose}
            className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl border-2 border-border px-5 py-4 text-base font-medium md:py-3 md:text-sm hover:bg-muted transition-colors"
          >
            Закрыть
          </button>
        </div>
      </div>
    )
  }

  // ─── Normal order view ───────────────────────────────────────────────────
  return (
    <div className="flex flex-col flex-1 min-h-0">
      {!hideMeta && (
        <div className="px-4 py-3 border-b">
          <div className="flex items-center gap-3">
            <span className="font-semibold text-sm">Заказ #{order.orderNumber ?? order.id.slice(0, 8)}</span>
            <span
              className={`inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-medium ${style.bg} ${style.text}`}
            >
              {ORDER_STATUS_LABELS[order.status]}
            </span>
          </div>
          <div className="text-xs text-muted-foreground mt-0.5">
            {TYPE_LABELS[order.type]}
            {table ? ` · ${table.name}` : ''}
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {!hideMeta && (
          <div className="rounded-xl border border-border px-3 py-2.5 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm">
            <div className="flex items-center gap-1.5">
              <Clock className="size-4 text-muted-foreground shrink-0" />
              <span className="text-muted-foreground">Время:</span>
              <span className="font-medium">{getTimeSince(order.createdAt)}</span>
            </div>
            {table && (
              <div className="flex items-center gap-1.5">
                <MapPin className="size-4 text-muted-foreground shrink-0" />
                <span className="text-muted-foreground">Стол:</span>
                <span className="font-medium">{table.name}</span>
              </div>
            )}
            {waiter && (
              <div className="flex items-center gap-1.5">
                <UserCircle className="size-4 text-muted-foreground shrink-0" />
                <span className="text-muted-foreground">Официант:</span>
                <span className="font-medium">{waiter.name}</span>
              </div>
            )}
          </div>
        )}

        {/* Order items */}
        <div className="space-y-3">
          <h4 className="text-sm font-semibold">Позиции заказа</h4>
          <div className="rounded-xl border border-border divide-y divide-border">
            {order.items.map((item, i) => {
              const mi = menuItemsData.find(m => m.id === item.menuItemId)
              const isVoided = voidedIndices.has(i) || voidedFlagsFromDb[i] || false
              const isVoiding = voidingItemIdx === i
              const isCancelled = !!item.cancelledAt
              const isOwnAsWaiter = role === 'waiter' && order.waiterId === user?.id
              const inActiveStatus = order.status === 'new' || order.status === 'cooking' || order.status === 'ready'
              const canVoidItem = !isCancelled && !isVoided && inActiveStatus && (canDo('orders.void') || isOwnAsWaiter)
              const isWeight = item.unit === 'g' || item.unit === 'kg'
              const lineTotal = calcLineTotal(item.price, item.qty, item.unit, item.unitSize)
              const qtyLabel = isWeight ? formatQty(item.qty, item.unit) : `x${item.qty}`
              const visuallyMuted = isVoided || isCancelled
              return (
                <div key={i} className={`px-4 py-2.5 ${visuallyMuted ? 'opacity-50 bg-muted/30' : ''}`}>
                  <div className="flex items-center justify-between">
                    <div className="text-sm flex items-center gap-1 flex-wrap">
                      <span className={`font-medium ${visuallyMuted ? 'line-through' : ''}`}>{item.name}</span>
                      <span className="text-muted-foreground"> {qtyLabel}</span>
                      {mi?.cookTimeMin && (
                        <span className="ml-1.5 text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">⏱ {mi.cookTimeMin} мин</span>
                      )}
                      {mi && mi.station === 'bar' && (
                        <span className="ml-1.5 text-[10px] font-medium px-1.5 py-0.5 rounded bg-blue-50 text-blue-700">☕ Бар</span>
                      )}
                      {mi && mi.station === 'showcase' && (
                        <span className="ml-1.5 text-[10px] font-medium px-1.5 py-0.5 rounded bg-amber-50 text-amber-700">🥟 Витрина</span>
                      )}
                      {isVoided && (
                        <span className="ml-1.5 text-[10px] font-medium px-1.5 py-0.5 rounded bg-red-50 text-red-600">Списано</span>
                      )}
                      {isCancelled && (
                        <span className="ml-1.5 text-[10px] font-medium px-1.5 py-0.5 rounded bg-zinc-100 text-zinc-700">Отменено</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={`text-sm font-medium ${visuallyMuted ? 'line-through' : ''}`}>
                        {formatCurrency(lineTotal)}
                      </span>
                      {canVoidItem && (
                        <button
                          onClick={() => { setVoidingItemIdx(isVoiding ? null : i); setVoidQty(item.qty) }}
                          className="text-red-400 hover:text-red-600 transition-colors p-0.5"
                          title="Списать позицию (для отчётности)"
                        >
                          <XCircle className="size-4" />
                        </button>
                      )}
                    </div>
                  </div>
                  {isCancelled && item.cancelReason && (
                    <div className="mt-1 text-[11px] text-muted-foreground italic">
                      Причина: {item.cancelReason}
                    </div>
                  )}
                  {isVoiding && (
                    <div className="mt-2 p-2.5 rounded-lg bg-red-50 border border-red-200 space-y-2">
                      <div className="flex items-center gap-2">
                        <div className="flex-1">
                          <label className="text-[10px] text-red-600 font-medium">Кол-во для отмены</label>
                          <div className="flex items-center gap-1 mt-0.5">
                            <button onClick={() => setVoidQty(Math.max(1, voidQty - 1))}
                              className="size-6 rounded bg-white border border-red-200 text-red-600 text-xs font-bold flex items-center justify-center">−</button>
                            <span className="w-6 text-center text-sm font-bold text-red-700">{voidQty}</span>
                            <button onClick={() => setVoidQty(Math.min(item.qty, voidQty + 1))}
                              className="size-6 rounded bg-white border border-red-200 text-red-600 text-xs font-bold flex items-center justify-center">+</button>
                            <span className="text-[10px] text-red-500 ml-1">из {item.qty}</span>
                          </div>
                        </div>
                        <div className="flex-1">
                          <label className="text-[10px] text-red-600 font-medium">Причина</label>
                          <select
                            value={voidReason}
                            onChange={(e) => setVoidReason(e.target.value as VoidReason)}
                            className="w-full text-xs rounded-md border border-red-200 bg-white px-2 py-1.5 mt-0.5 focus:outline-none focus:ring-1 focus:ring-red-300"
                          >
                            {(Object.entries(VOID_REASON_LABELS) as [VoidReason, string][]).map(([val, label]) => (
                              <option key={val} value={val}>{label}</option>
                            ))}
                          </select>
                        </div>
                      </div>
                      <button
                        onClick={async () => {
                          try {
                            await createVoid({
                              orderId: order.id,
                              itemName: item.name,
                              itemQty: voidQty,
                              itemPrice: item.price,
                              reason: voidReason,
                              menuItemId: item.menuItemId,
                            })
                            if (voidQty >= item.qty) {
                              setVoidedIndices(prev => new Set(prev).add(i))
                            }
                            setVoidingItemIdx(null)
                            setVoidReason('guest_changed_mind')
                            setVoidQty(0)
                            toast.success(`Отменено: ${item.name} × ${voidQty}`)
                            try {
                              const fresh = await fetchVoidsForOrder(order.id)
                              setVoids(fresh)
                            } catch {}
                            onItemsChanged?.()
                          } catch {
                            toast.error('Ошибка отмены')
                          }
                        }}
                        className="w-full text-xs font-medium bg-red-600 text-white rounded-md py-1.5 hover:bg-red-700 transition-colors"
                      >
                        Отменить {voidQty} из {item.qty}
                      </button>
                    </div>
                  )}
                </div>
              )
            })}
            <div className="bg-muted/30">
              <div className="flex items-center justify-between px-4 py-3">
                <span className="text-sm font-semibold">Подытог</span>
                <span className="text-base font-bold">{formatCurrency(subtotal)}</span>
              </div>
              {discountAmount > 0 && (
                <div className="flex items-center justify-between px-4 py-1 text-xs text-muted-foreground">
                  <span>Скидка</span>
                  <span>−{formatCurrency(discountAmount)}</span>
                </div>
              )}
              {includeService && servicePercent > 0 && serviceAmount > 0 && (
                <div className="flex items-center justify-between px-4 py-1 text-xs text-muted-foreground">
                  <span>Обслуживание ({servicePercent}%)</span>
                  <span>+{formatCurrency(serviceAmount)}</span>
                </div>
              )}
              {tipAmount > 0 && (
                <div className="flex items-center justify-between px-4 py-1 text-xs text-muted-foreground">
                  <span>Чаевые</span>
                  <span>+{formatCurrency(tipAmount)}</span>
                </div>
              )}
              {(discountAmount > 0 || (includeService && serviceAmount > 0) || tipAmount > 0) && (
                <div className="flex items-center justify-between px-4 py-2 border-t border-border/60">
                  <span className="text-sm font-bold">Итого</span>
                  <span className="text-sm font-bold">{formatCurrency(totalWithService)}</span>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Payment section — gating: orders.close, любой активный статус */}
        {(order.status === 'new' || order.status === 'cooking' || order.status === 'ready' || order.status === 'served' || order.status === 'bill_requested') && canDo('orders.close') && (
          <div className="space-y-3">
            {/* Pre-check + Discount */}
            <div className="space-y-2">
              {discountAmount > 0 && !showDiscountForm ? null : showDiscountForm ? null : (
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={handlePreCheck}
                    className="inline-flex items-center justify-center gap-2 rounded-xl border-2 border-border px-3 py-2.5 text-sm font-medium text-foreground hover:bg-muted transition-colors"
                  >
                    <FileText className="size-4" />
                    Пре-чек
                  </button>
                  <button
                    onClick={() => {
                      setShowDiscountForm(true)
                      setDiscountType('percent')
                    }}
                    className="inline-flex items-center justify-center gap-1.5 rounded-xl border-2 border-dashed border-border px-3 py-2.5 text-sm font-medium text-muted-foreground hover:border-muted-foreground/30 hover:text-foreground transition-colors"
                  >
                    <Tag className="size-4" />
                    Скидка
                  </button>
                </div>
              )}

              {discountAmount > 0 && !showDiscountForm ? (
                <div className="flex items-center justify-between rounded-xl border border-border p-3">
                  <div className="text-sm">
                    <span className="font-medium text-red-600">
                      Скидка: -{formatCurrency(discountAmount)}
                    </span>
                    {discountType === 'percent' && (
                      <span className="text-muted-foreground ml-1">({discountValue}%)</span>
                    )}
                    {discountReason && (
                      <span className="text-xs text-muted-foreground block">{discountReason}</span>
                    )}
                  </div>
                  <button
                    onClick={() => {
                      setDiscountType(null)
                      setDiscountValue(0)
                      setDiscountAmount(0)
                      setDiscountReason('')
                    }}
                    className="p-1 rounded-lg text-muted-foreground hover:bg-muted hover:text-red-500 transition-colors"
                  >
                    <Trash2 className="size-4" />
                  </button>
                </div>
              ) : showDiscountForm ? (
                <div className="rounded-xl border border-border p-3 space-y-3">
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      onClick={() => {
                        setDiscountType('percent')
                        setDiscountValue(0)
                        setDiscountAmount(0)
                      }}
                      className={`py-2 rounded-lg text-sm font-medium border-2 transition-all ${
                        discountType === 'percent' ? 'border-primary bg-primary/5 text-primary' : 'border-border hover:border-muted-foreground/30'
                      }`}
                    >
                      %
                    </button>
                    <button
                      onClick={() => {
                        setDiscountType('fixed')
                        setDiscountValue(0)
                        setDiscountAmount(0)
                      }}
                      className={`py-2 rounded-lg text-sm font-medium border-2 transition-all ${
                        discountType === 'fixed' ? 'border-primary bg-primary/5 text-primary' : 'border-border hover:border-muted-foreground/30'
                      }`}
                    >
                      TJS
                    </button>
                  </div>

                  <input
                    type="number"
                    placeholder={discountType === 'percent' ? 'Процент (0-100)' : 'Сумма скидки'}
                    value={discountValue || ''}
                    onChange={e => {
                      const v = Math.max(0, Number(e.target.value))
                      if (discountType === 'percent') {
                        const clamped = Math.min(100, v)
                        setDiscountValue(clamped)
                        setDiscountAmount(dRound(dDiv(dMul(subtotal, clamped), 100)))
                      } else {
                        const clamped = Math.min(subtotal, v)
                        setDiscountValue(clamped)
                        setDiscountAmount(clamped)
                      }
                    }}
                    className="w-full py-2 px-3 rounded-lg border-2 border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary"
                  />

                  <input
                    type="text"
                    placeholder="Причина (необязательно)"
                    value={discountReason}
                    onChange={e => setDiscountReason(e.target.value)}
                    className="w-full py-2 px-3 rounded-lg border-2 border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary"
                  />

                  {discountType === 'percent' && discountValue > 10 && (
                    <div className="flex items-center gap-2 text-xs text-amber-600 bg-amber-50 rounded-lg px-3 py-2">
                      <AlertTriangle className="size-3.5 shrink-0" />
                      Требует одобрения менеджера
                    </div>
                  )}
                  {discountType === 'fixed' && subtotal > 0 && (discountValue / subtotal) * 100 > 10 && (
                    <div className="flex items-center gap-2 text-xs text-amber-600 bg-amber-50 rounded-lg px-3 py-2">
                      <AlertTriangle className="size-3.5 shrink-0" />
                      Требует одобрения менеджера
                    </div>
                  )}

                  <div className="flex gap-2">
                    <button
                      onClick={() => setShowDiscountForm(false)}
                      className="flex-1 py-2 rounded-lg border-2 border-border text-sm font-medium hover:bg-muted transition-colors"
                    >
                      Отмена
                    </button>
                    <button
                      onClick={() => {
                        if (discountValue > 0 && discountType) {
                          setShowDiscountForm(false)
                        }
                      }}
                      disabled={!discountValue || !discountType}
                      className="flex-1 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
                    >
                      Применить
                    </button>
                  </div>
                </div>
              ) : null}
            </div>

            {/* Service */}
            {isHallOrder(order.type) && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="text-sm font-semibold flex items-center gap-1.5">
                    <Percent className="size-3.5" />
                    Обслуживание
                  </h4>
                  <button
                    onClick={() => setIncludeService(!includeService)}
                    className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                      includeService ? 'bg-primary' : 'bg-muted'
                    }`}
                  >
                    <span className={`inline-block size-3.5 transform rounded-full bg-white transition-transform ${
                      includeService ? 'translate-x-[18px]' : 'translate-x-[3px]'
                    }`} />
                  </button>
                </div>

                {includeService && (
                  <div className="flex items-center justify-between rounded-xl border border-border p-3">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setServicePercent(Math.max(0, servicePercent - 5))}
                        disabled={servicePercent <= 0}
                        className="size-9 rounded-lg border border-border flex items-center justify-center hover:bg-muted active:bg-muted/80 transition-colors disabled:opacity-30"
                      >
                        <Minus className="size-4" />
                      </button>
                      <span className="text-lg font-bold w-12 text-center">{servicePercent}%</span>
                      <button
                        onClick={() => setServicePercent(Math.min(30, servicePercent + 5))}
                        disabled={servicePercent >= 30}
                        className="size-9 rounded-lg border border-border flex items-center justify-center hover:bg-muted active:bg-muted/80 transition-colors disabled:opacity-30"
                      >
                        <Plus className="size-4" />
                      </button>
                    </div>
                    <span className="text-sm font-medium text-muted-foreground">
                      +{formatCurrency(serviceAmount)}
                    </span>
                  </div>
                )}
              </div>
            )}

            {/* Total */}
            <div className="rounded-xl bg-primary/5 border-2 border-primary/20 px-4 py-3 space-y-1">
              {discountAmount > 0 && (
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Подытог</span>
                  <span className="font-medium">{formatCurrency(subtotal)}</span>
                </div>
              )}
              {discountAmount > 0 && (
                <div className="flex items-center justify-between text-sm text-red-600">
                  <span>Скидка</span>
                  <span className="font-medium">-{formatCurrency(discountAmount)}</span>
                </div>
              )}
              <div className="flex items-center justify-between">
                <span className="text-sm font-bold">К оплате</span>
                <span className="text-xl font-bold text-primary">{formatCurrency(totalWithService)}</span>
              </div>
            </div>

            {/* Mixed payment section */}
            <div className="space-y-3">
              <h4 className="text-sm font-semibold">Оплата</h4>

              {payments.length > 0 && (
                <div className="space-y-1.5">
                  {payments.map((p, idx) => (
                    <div key={idx} className="flex items-center justify-between rounded-xl border border-border px-3 py-2.5">
                      <div className="flex items-center gap-2 text-sm">
                        {p.method === 'cash' ? <Banknote className="size-4 text-muted-foreground" /> : <CreditCard className="size-4 text-muted-foreground" />}
                        <span className="font-medium">{p.method === 'cash' ? 'Наличные' : 'Безналичные'}</span>
                        {p.accountName && <span className="text-xs text-muted-foreground">({p.accountName})</span>}
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-bold">{formatCurrency(p.amount)}</span>
                        <button
                          onClick={() => setPayments(payments.filter((_, i) => i !== idx))}
                          className="p-1 rounded text-muted-foreground hover:text-red-500 transition-colors"
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                  {remainingAmount > 0 && (
                    <div className="text-sm text-amber-600 font-medium px-1">
                      Оставшаяся сумма: {formatCurrency(remainingAmount)}
                    </div>
                  )}
                  {remainingAmount <= 0 && (
                    <div className="text-sm text-emerald-600 font-medium px-1">
                      Оплата покрыта полностью
                    </div>
                  )}
                </div>
              )}

              {showAddPayment ? (
                <div className="rounded-xl border border-border p-3 space-y-3">
                  <div className="grid grid-cols-2 gap-2">
                    {PAYMENT_OPTIONS.map((opt) => (
                      <button
                        key={opt.value}
                        onClick={() => {
                          setAddPaymentMethod(opt.value)
                          const targetType = opt.value === 'cash' ? 'cash' : 'bank'
                          const filtered = accounts.filter(a => a.type === targetType)
                          if (filtered.length > 0) setAddPaymentAccountId(filtered[0].id)
                        }}
                        className={`flex items-center justify-center gap-2 rounded-xl border-2 p-2.5 transition-all ${
                          addPaymentMethod === opt.value
                            ? 'border-primary bg-primary/5 text-primary'
                            : 'border-border hover:border-muted-foreground/30'
                        }`}
                      >
                        {opt.icon}
                        <span className="text-xs font-medium">{opt.label}</span>
                      </button>
                    ))}
                  </div>

                  {(() => {
                    const targetType = addPaymentMethod === 'cash' ? 'cash' : 'bank'
                    const filtered = accounts.filter(a => a.type === targetType)
                    if (filtered.length <= 1) {
                      return filtered.length === 1 ? (
                        <div className="flex items-center gap-2 rounded-xl border border-border px-3 py-2 text-sm">
                          {targetType === 'cash' ? <Wallet className="size-4 text-muted-foreground" /> : <Building2 className="size-4 text-muted-foreground" />}
                          <span className="font-medium">{filtered[0].name}</span>
                          <CheckCircle2 className="size-4 text-primary ml-auto" />
                        </div>
                      ) : null
                    }
                    return (
                      <div className="space-y-1.5">
                        {filtered.map((acc) => (
                          <button
                            key={acc.id}
                            onClick={() => setAddPaymentAccountId(acc.id)}
                            className={`w-full flex items-center gap-2 px-3 py-2 rounded-xl border-2 transition-all text-left text-sm ${
                              addPaymentAccountId === acc.id
                                ? 'border-primary bg-primary/5'
                                : 'border-border hover:border-muted-foreground/30'
                            }`}
                          >
                            {acc.type === 'cash' ? <Wallet className="size-3.5 text-muted-foreground" /> : <Building2 className="size-3.5 text-muted-foreground" />}
                            <span className="font-medium truncate">{acc.name}</span>
                            {addPaymentAccountId === acc.id && <CheckCircle2 className="size-3.5 text-primary ml-auto" />}
                          </button>
                        ))}
                      </div>
                    )
                  })()}

                  <input
                    type="number"
                    placeholder={`Сумма (макс. ${formatCurrency(remainingAmount)})`}
                    value={addPaymentAmount}
                    onChange={e => setAddPaymentAmount(e.target.value)}
                    className="w-full py-2 px-3 rounded-lg border-2 border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary"
                  />

                  <div className="flex gap-2">
                    <button
                      onClick={() => {
                        setShowAddPayment(false)
                        setAddPaymentAmount('')
                      }}
                      className="flex-1 py-2 rounded-lg border-2 border-border text-sm font-medium hover:bg-muted transition-colors"
                    >
                      Отмена
                    </button>
                    <button
                      onClick={() => {
                        const amt = addPaymentAmount ? Number(addPaymentAmount) : remainingAmount
                        if (amt <= 0) return
                        const accId = addPaymentAccountId || (() => {
                          const targetType = addPaymentMethod === 'cash' ? 'cash' : 'bank'
                          const filtered = accounts.filter(a => a.type === targetType)
                          return filtered[0]?.id ?? ''
                        })()
                        const acc = accounts.find(a => a.id === accId)
                        const pm: PaymentMethod = addPaymentMethod === 'cash' ? 'cash' : 'card'
                        setPayments([...payments, { method: pm, amount: amt, accountId: accId, accountName: acc?.name }])
                        setShowAddPayment(false)
                        setAddPaymentAmount('')
                      }}
                      disabled={!addPaymentAccountId && accounts.filter(a => a.type === (addPaymentMethod === 'cash' ? 'cash' : 'bank')).length === 0}
                      className="flex-1 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
                    >
                      Добавить
                    </button>
                  </div>
                </div>
              ) : (
                payments.length === 0 ? (
                  <>
                    <div className="grid grid-cols-2 gap-2">
                      {PAYMENT_OPTIONS.map((opt) => (
                        <button
                          key={opt.value}
                          onClick={() => setPaymentType(opt.value)}
                          className={`flex items-center justify-center gap-2 rounded-xl border-2 p-3.5 transition-all ${
                            paymentType === opt.value
                              ? 'border-primary bg-primary/5 text-primary'
                              : 'border-border hover:border-muted-foreground/30'
                          }`}
                        >
                          {opt.icon}
                          <span className="text-sm font-medium">{opt.label}</span>
                        </button>
                      ))}
                    </div>

                    {(() => {
                      const targetType = paymentType === 'cash' ? 'cash' : 'bank'
                      const filtered = accounts.filter(a => a.type === targetType)
                      if (filtered.length === 1 && selectedAccountId !== filtered[0].id) {
                        setTimeout(() => setSelectedAccountId(filtered[0].id), 0)
                      }
                      if (filtered.length <= 1) {
                        return filtered.length === 1 ? (
                          <div className="flex items-center gap-2 rounded-xl border border-border px-3 py-2.5 text-sm">
                            {targetType === 'cash' ? <Wallet className="size-4 text-muted-foreground" /> : <Building2 className="size-4 text-muted-foreground" />}
                            <span className="font-medium">{filtered[0].name}</span>
                            <CheckCircle2 className="size-4 text-primary ml-auto" />
                          </div>
                        ) : null
                      }
                      return (
                        <div className="space-y-3">
                          <h4 className="text-sm font-semibold">
                            {paymentType === 'cash' ? 'Касса' : 'Банковский счёт'}
                          </h4>
                          <div className="space-y-1.5">
                            {filtered.map((acc) => (
                              <button
                                key={acc.id}
                                onClick={() => setSelectedAccountId(acc.id)}
                                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl border-2 transition-all text-left ${
                                  selectedAccountId === acc.id
                                    ? 'border-primary bg-primary/5'
                                    : 'border-border hover:border-muted-foreground/30'
                                }`}
                              >
                                {acc.type === 'cash' ? (
                                  <Wallet className="size-4 text-muted-foreground shrink-0" />
                                ) : (
                                  <Building2 className="size-4 text-muted-foreground shrink-0" />
                                )}
                                <div className="flex-1 min-w-0">
                                  <p className="text-sm font-medium truncate">{acc.name}</p>
                                </div>
                                {selectedAccountId === acc.id && (
                                  <CheckCircle2 className="size-4 text-primary shrink-0" />
                                )}
                              </button>
                            ))}
                          </div>
                        </div>
                      )
                    })()}

                    <button
                      onClick={() => {
                        setShowAddPayment(true)
                        setAddPaymentMethod('cash')
                        const cashAcc = accounts.find(a => a.type === 'cash')
                        if (cashAcc) setAddPaymentAccountId(cashAcc.id)
                        setAddPaymentAmount(String(totalWithService))
                      }}
                      className="w-full py-2 rounded-xl border-2 border-dashed border-border text-xs font-medium text-muted-foreground hover:border-muted-foreground/30 hover:text-foreground transition-colors flex items-center justify-center gap-1.5"
                    >
                      <ArrowRightLeft className="size-3.5" />
                      Разделить оплату (нал + безнал)
                    </button>
                  </>
                ) : (
                  <button
                    onClick={() => {
                      setShowAddPayment(true)
                      setAddPaymentMethod('cash')
                      const cashAcc = accounts.find(a => a.type === 'cash')
                      if (cashAcc) setAddPaymentAccountId(cashAcc.id)
                      setAddPaymentAmount(String(remainingAmount))
                    }}
                    className="w-full py-2.5 rounded-xl border-2 border-dashed border-border text-sm font-medium text-muted-foreground hover:border-muted-foreground/30 hover:text-foreground transition-colors"
                  >
                    + Добавить оплату
                  </button>
                )
              )}
            </div>
          </div>
        )}

        {order.status === 'done' && order.closedAt && (
          <div className="rounded-xl bg-emerald-50 border border-emerald-200 p-4 text-sm text-emerald-700 text-center flex items-center justify-center gap-2">
            <CheckCircle2 className="size-4" />
            Заказ оплачен и закрыт
          </div>
        )}

        {order.status === 'done' && canDo('orders.cancel') && !order.isSplit && (
          <button
            onClick={() => {
              const total = order.totalWithService ?? order.total
              const ok = window.confirm(
                `Открыть заказ #${order.orderNumber ?? order.id.slice(0, 8)} (${formatCurrency(total)}) для редактирования?\n\n` +
                `• Будут удалены связанные финансовые операции (выручка и себестоимость).\n` +
                `• Заказ выйдет из текущей/прошлой смены.\n` +
                `• Стол вернётся в «Занят», статус — «Счёт».\n\n` +
                `Сумму, скидку и обслуживание можно будет изменить и провести оплату заново.`
              )
              if (!ok) return
              onAction('reopen')
              onClose()
            }}
            className="w-full inline-flex items-center justify-center gap-2 rounded-xl border-2 border-amber-300 bg-amber-50 px-5 py-3.5 text-sm font-medium text-amber-700 hover:bg-amber-100 transition-colors"
          >
            <RotateCcw className="size-4" />
            Открыть для редактирования
          </button>
        )}
        {order.status === 'done' && canDo('orders.cancel') && order.isSplit && (
          <p className="text-xs text-muted-foreground italic text-center">
            Reopen split-заказа недоступен. Используйте отмену split-заказа отдельно.
          </p>
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-3 border-t space-y-2">
        {order.status === 'new' && (
          <div className="space-y-2 w-full">
            <div className="flex gap-2 w-full">
              {canDo('orders.cancel') && (
                <button
                  onClick={() => onAction('cancel')}
                  className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-xl border-2 border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700 hover:bg-red-100 transition-colors"
                >
                  <XCircle className="size-4" />
                  Отменить
                </button>
              )}
              {(canDo('kitchen.cooking') || canDo('orders.cancel')) && (
                <button
                  onClick={() => onAction('start_cooking')}
                  className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-xl bg-amber-500 px-5 py-4 text-base font-medium md:py-3 md:text-sm text-white hover:bg-amber-600 transition-colors"
                >
                  <Flame className="size-4" />
                  В готовку
                </button>
              )}
            </div>
            <button
              onClick={() => { onAction('add_items'); onClose() }}
              className="w-full inline-flex items-center justify-center gap-1.5 rounded-xl border-2 border-primary/30 bg-primary/5 px-5 py-3.5 text-base font-medium md:py-2.5 md:text-sm text-primary hover:bg-primary/10 transition-colors"
            >
              <Plus className="size-4" />
              Дозаказ
            </button>
          </div>
        )}

        {order.status === 'cooking' && (
          <div className="space-y-2 w-full">
            {canDo('kitchen.cooking') && (
              <button
                onClick={() => onAction('mark_ready')}
                className="w-full inline-flex items-center justify-center gap-1.5 rounded-xl bg-emerald-600 px-5 py-4 text-base font-medium md:py-3 md:text-sm text-white hover:bg-emerald-700 transition-colors"
              >
                <CheckCircle2 className="size-4" />
                Готово!
              </button>
            )}
            <button
              onClick={() => { onAction('add_items'); onClose() }}
              className="w-full inline-flex items-center justify-center gap-1.5 rounded-xl border-2 border-primary/30 bg-primary/5 px-5 py-3.5 text-base font-medium md:py-2.5 md:text-sm text-primary hover:bg-primary/10 transition-colors"
            >
              <Plus className="size-4" />
              Дозаказ
            </button>
          </div>
        )}

        {(order.status === 'new' || order.status === 'cooking' || order.status === 'ready' || order.status === 'served' || order.status === 'bill_requested') && canDo('orders.close') && !order.isSplit && (
          <div className="space-y-2">
            <button
              onClick={handleCloseAndPay}
              disabled={payments.length > 0 ? paymentsTotal < totalWithService : !selectedAccountId}
              className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-5 py-4 text-base font-medium md:py-3 md:text-sm text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <CreditCard className="size-4" />
              Закрыть и оплатить · {formatCurrency(totalWithService)}
            </button>
            {(order.status === 'ready' || order.status === 'served' || order.status === 'bill_requested') && (
              <button
                onClick={() => { onAction('add_items'); onClose() }}
                className="w-full inline-flex items-center justify-center gap-2 rounded-xl border-2 border-primary/30 bg-primary/5 px-5 py-3.5 text-base font-medium md:py-2.5 md:text-sm text-primary hover:bg-primary/10 transition-colors"
              >
                <Plus className="size-4" />
                Дозаказ
              </button>
            )}
            <button
              onClick={() => setShowSplitDialog(true)}
              className="w-full inline-flex items-center justify-center gap-2 rounded-xl border-2 border-border px-5 py-3.5 text-base font-medium md:py-2.5 md:text-sm text-foreground hover:bg-muted transition-colors"
            >
              <Scissors className="size-4" />
              Разделить счёт
            </button>
          </div>
        )}

        {order.status === 'ready' && order.isSplit && canDo('orders.close') && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-semibold text-foreground">Разделённый счёт ({splits.length} частей)</h4>
              {splits.every(s => s.status === 'pending') && (
                <button
                  onClick={async () => {
                    try {
                      await cancelSplits(order.id)
                      setSplits([])
                      toast.success('Разделение отменено')
                      onAction('refresh')
                      onClose()
                    } catch (e: any) {
                      toast.error(e?.message ?? 'Не удалось отменить разделение')
                    }
                  }}
                  className="text-xs text-destructive hover:underline"
                >
                  Отменить разделение
                </button>
              )}
            </div>
            {splits.map(split => (
              <div key={split.id} className={`rounded-xl border-2 p-3 ${split.status === 'paid' ? 'border-emerald-200 bg-emerald-50' : 'border-border'}`}>
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-sm font-medium text-foreground">Гость {split.splitNumber}</span>
                    <span className="text-sm font-bold text-foreground ml-2">{formatCurrency(split.total)}</span>
                  </div>
                  {split.status === 'paid' ? (
                    <span className="text-xs bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded font-medium">Оплачено</span>
                  ) : (
                    <button
                      onClick={async () => {
                        if (!selectedAccountId) return
                        const acc = accounts.find(a => a.id === selectedAccountId)
                        const pm = paymentType === 'cash' ? 'cash' as const : 'card' as const
                        try {
                          await paySplit(split.id, pm, selectedAccountId, acc?.name || '', user?.id)
                          const updated = await fetchOrderSplits(order.id)
                          setSplits(updated)
                          if (updated.every(s => s.status === 'paid')) {
                            onAction('refresh')
                            onClose()
                          }
                        } catch {
                          // error
                        }
                      }}
                      disabled={!selectedAccountId}
                      className="px-3 py-1.5 bg-primary text-primary-foreground rounded-lg text-xs font-medium hover:bg-primary/90 disabled:opacity-50"
                    >
                      Оплатить
                    </button>
                  )}
                </div>
              </div>
            ))}
            <p className="text-xs text-muted-foreground text-center">
              Оплачено: {splits.filter(s => s.status === 'paid').length} из {splits.length}
            </p>
          </div>
        )}

        {/* Cancel whole order */}
        {(() => {
          const isOwnAsWaiter = role === 'waiter' && order.waiterId === user?.id
          const waiterEligibleStatus = order.status === 'new' || order.status === 'cooking' || order.status === 'ready'
          const showWholeCancel =
            order.status !== 'done' &&
            order.status !== 'cancelled' &&
            (canDo('orders.cancel') || (isOwnAsWaiter && waiterEligibleStatus))
          return showWholeCancel
        })() && (
          <div className="w-full pt-2">
            {!cancelOrderConfirmOpen ? (
              <button
                onClick={() => setCancelOrderConfirmOpen(true)}
                className="w-full inline-flex items-center justify-center gap-1.5 rounded-xl border-2 border-zinc-300 px-4 py-2.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 transition-colors"
              >
                <Ban className="size-4" />
                Отменить весь заказ
              </button>
            ) : (() => {
              const submitOrderCancel = async (reason: string) => {
                if (!reason) return
                setCancelInFlight(true)
                try {
                  await cancelOrder(order.id, reason, user?.id)
                  toast.success('Заказ отменён')
                  setCancelOrderConfirmOpen(false)
                  setCancelOrderMore(false)
                  onAction('refresh')
                  onClose()
                } catch (e: any) {
                  toast.error(e?.message ?? 'Ошибка отмены')
                } finally {
                  setCancelInFlight(false)
                }
              }
              return (
                <div className="rounded-xl border-2 border-zinc-300 bg-zinc-50 p-3 space-y-2">
                  <div className="text-xs font-semibold text-zinc-700">Отменить весь заказ?</div>
                  <div className="grid grid-cols-2 gap-1.5">
                    {CANCEL_QUICK_REASONS.map((q) => (
                      <button
                        key={q.value}
                        disabled={cancelInFlight}
                        onClick={() => submitOrderCancel(q.value)}
                        className="text-xs font-medium px-2 py-2 rounded-md bg-zinc-700 text-white hover:bg-zinc-800 transition-colors disabled:opacity-50"
                      >
                        {q.label}
                      </button>
                    ))}
                  </div>
                  {!cancelOrderMore ? (
                    <button
                      onClick={() => setCancelOrderMore(true)}
                      className="w-full text-[11px] text-zinc-500 hover:text-zinc-700 underline transition-colors"
                    >
                      Другая причина…
                    </button>
                  ) : (
                    <>
                      <div className="grid grid-cols-2 gap-1.5">
                        {CANCEL_REASON_PRESETS.map((r) => (
                          <button
                            key={r}
                            onClick={() => setCancelOrderReasonChoice(r)}
                            className={`text-xs px-2 py-1.5 rounded-md border transition-colors ${
                              cancelOrderReasonChoice === r
                                ? 'border-primary bg-primary/5 text-primary'
                                : 'border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300'
                            }`}
                          >
                            {r}
                          </button>
                        ))}
                      </div>
                      {cancelOrderReasonChoice === 'Другое' && (
                        <input
                          type="text"
                          placeholder="Опишите причину"
                          value={cancelOrderReasonCustom}
                          onChange={e => setCancelOrderReasonCustom(e.target.value)}
                          className="w-full text-xs rounded-md border border-zinc-200 bg-white px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary/30"
                        />
                      )}
                      <button
                        disabled={cancelInFlight || (cancelOrderReasonChoice === 'Другое' && !cancelOrderReasonCustom.trim())}
                        onClick={() => submitOrderCancel(cancelOrderReasonChoice === 'Другое' ? cancelOrderReasonCustom.trim() : cancelOrderReasonChoice)}
                        className="w-full text-xs font-medium bg-zinc-700 text-white rounded-md py-1.5 hover:bg-zinc-800 transition-colors disabled:opacity-50"
                      >
                        Подтвердить отмену заказа
                      </button>
                    </>
                  )}
                  <button
                    onClick={() => { setCancelOrderConfirmOpen(false); setCancelOrderMore(false) }}
                    className="w-full text-[11px] text-zinc-500 hover:text-zinc-700 transition-colors"
                  >
                    Закрыть
                  </button>
                </div>
              )
            })()}
          </div>
        )}

        {order.status !== 'done' && order.status !== 'cancelled' && !canDo('kitchen.cooking') && !canDo('orders.close') && !canDo('orders.cancel') && (
          <div className="w-full text-center text-sm text-muted-foreground py-2">
            Вы можете только просматривать заказ
          </div>
        )}
      </div>

      {order && (
        <SplitBillDialog
          open={showSplitDialog}
          onOpenChange={setShowSplitDialog}
          order={order}
          onSuccess={() => {
            onAction('refresh')
          }}
        />
      )}
    </div>
  )
}
