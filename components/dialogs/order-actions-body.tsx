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
 * После рефакторинга v2.0.80 тело файла — оркестратор: хуки/state + composition
 * из под-компонентов в `components/dialogs/order-actions/`. Старый файл был
 * 1373 строки.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { toast } from 'sonner'
import { formatCurrency, getTimeSince, calcLineCogs, visibleReceiptItems, voidedItemFlags, calcLineTotal } from '@/lib/helpers'
import { dAdd, dSub, dMul, dDiv, dRound, dSum } from '@/lib/decimal'
import {
  ORDER_STATUS_LABELS,
  type Order,
  type OrderStatus,
  type PaymentMethod,
  type OrderPayment,
  type Table,
  type User,
  type VoidReason,
  type Zone,
} from '@/lib/types'
import { fetchTables, fetchUsers, fetchZones, fetchFinancialAccounts, fetchMenuItems } from '@/lib/queries'
import { buildReceiptData } from '@/lib/receipt-data'
import { useAuth } from '@/lib/auth-store'
import { PrintReceipt, type ReceiptData } from '@/components/print-receipt'
import { SplitBillDialog } from '@/components/dialogs/split-bill-dialog'
import { fetchOrderSplits, paySplit, cancelSplits, fetchVoidsForOrder } from '@/lib/queries'
import { type OrderSplit, type OrderVoid } from '@/lib/types'
import { OrderItemsList } from './order-actions/OrderItemsList'
import { OrderTotalsBlock } from './order-actions/OrderTotalsBlock'
import { OrderPaymentPanel } from './order-actions/OrderPaymentPanel'
import { OrderCancelForm } from './order-actions/OrderCancelForm'
import {
  Clock,
  MapPin,
  UserCircle,
  Flame,
  XCircle,
  Scissors,
  CheckCircle2,
  CreditCard,
  Printer,
  Plus,
  FileText,
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

  const isOwnAsWaiter = role === 'waiter' && order.waiterId === user?.id
  const canDoVoid = canDo('orders.void')

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

  const showPaymentSection =
    (order.status === 'new' || order.status === 'cooking' || order.status === 'ready' || order.status === 'served' || order.status === 'bill_requested') &&
    canDo('orders.close')

  const waiterEligibleStatus = order.status === 'new' || order.status === 'cooking' || order.status === 'ready'
  const showWholeCancel =
    order.status !== 'done' &&
    order.status !== 'cancelled' &&
    (canDo('orders.cancel') || (isOwnAsWaiter && waiterEligibleStatus))

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

        {/* Order items + totals */}
        <div className="space-y-3">
          <h4 className="text-sm font-semibold">Позиции заказа</h4>
          <div className="rounded-xl border border-border overflow-hidden">
            <OrderItemsList
              order={order}
              menuItemsData={menuItemsData}
              voids={voids}
              voidedFlagsFromDb={voidedFlagsFromDb}
              voidedIndices={voidedIndices}
              setVoidedIndices={setVoidedIndices}
              voidingItemIdx={voidingItemIdx}
              setVoidingItemIdx={setVoidingItemIdx}
              voidReason={voidReason}
              setVoidReason={setVoidReason}
              voidQty={voidQty}
              setVoidQty={setVoidQty}
              setVoids={setVoids}
              canDoVoid={canDoVoid}
              isOwnAsWaiter={isOwnAsWaiter}
              onItemsChanged={onItemsChanged}
            />
            <OrderTotalsBlock
              subtotal={subtotal}
              discountAmount={discountAmount}
              includeService={includeService}
              servicePercent={servicePercent}
              serviceAmount={serviceAmount}
              tipAmount={tipAmount}
              totalWithService={totalWithService}
            />
          </div>
        </div>

        {/* Payment section — gating: orders.close, любой активный статус */}
        {showPaymentSection && (
          <OrderPaymentPanel
            isHall={isHallOrder(order.type)}
            subtotal={subtotal}
            totalWithService={totalWithService}
            serviceAmount={serviceAmount}
            remainingAmount={remainingAmount}
            discountType={discountType}
            setDiscountType={setDiscountType}
            discountValue={discountValue}
            setDiscountValue={setDiscountValue}
            discountAmount={discountAmount}
            setDiscountAmount={setDiscountAmount}
            discountReason={discountReason}
            setDiscountReason={setDiscountReason}
            showDiscountForm={showDiscountForm}
            setShowDiscountForm={setShowDiscountForm}
            includeService={includeService}
            setIncludeService={setIncludeService}
            servicePercent={servicePercent}
            setServicePercent={setServicePercent}
            accounts={accounts}
            paymentType={paymentType}
            setPaymentType={setPaymentType}
            selectedAccountId={selectedAccountId}
            setSelectedAccountId={setSelectedAccountId}
            payments={payments}
            setPayments={setPayments}
            showAddPayment={showAddPayment}
            setShowAddPayment={setShowAddPayment}
            addPaymentMethod={addPaymentMethod}
            setAddPaymentMethod={setAddPaymentMethod}
            addPaymentAccountId={addPaymentAccountId}
            setAddPaymentAccountId={setAddPaymentAccountId}
            addPaymentAmount={addPaymentAmount}
            setAddPaymentAmount={setAddPaymentAmount}
            onPreCheck={handlePreCheck}
          />
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

        {showPaymentSection && !order.isSplit && (
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
        {showWholeCancel && (
          <div className="w-full pt-2">
            <OrderCancelForm
              orderId={order.id}
              userId={user?.id}
              onCancelled={() => {
                onAction('refresh')
                onClose()
              }}
            />
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
