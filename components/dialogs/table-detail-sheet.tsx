'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { useAuth } from '@/lib/auth-store'
import {
  BottomSheet as Sheet,
  BottomSheetContent as SheetContent,
  BottomSheetHeader as SheetHeader,
  BottomSheetTitle as SheetTitle,
  BottomSheetDescription as SheetDescription,
  BottomSheetFooter as SheetFooter,
} from '@/components/ui/bottom-sheet'
import { formatCurrency, getTimeSince, calcLineTotal, formatQty, startOfToday, visibleReceiptItems, voidedItemFlags } from '@/lib/helpers'
import { dAdd, dRound, dMul, dDiv, dSum } from '@/lib/decimal'
import {
  STATUS_LABELS,
  ORDER_STATUS_LABELS,
  type Table,
  type TableStatus,
  type PaymentMethod,
  type OrderPayment,
  type Order,
  type User,
  type Zone,
} from '@/lib/types'
import { fetchOrders, fetchUsers, fetchZones, fetchFinancialAccounts, fetchMenuItems, fetchReservationForTable, updateReservationStatus, fetchTables, quickUpdateCapacity, mergeTables, unmergeTables, cancelOrderItem, cancelOrder, fetchVoidsForOrder } from '@/lib/queries'
import { buildReceiptData } from '@/lib/receipt-data'
import { toast } from 'sonner'
import type { MenuItem, Reservation, OrderVoid } from '@/lib/types'
import { ReservationDialog } from '@/components/dialogs/reservation-dialog'
import {
  Users,
  User as UserIcon,
  Clock,
  MapPin,
  UtensilsCrossed,
  Receipt,
  CreditCard,
  Banknote,
  ArrowRightLeft,
  UserCircle,
  X,
  Pencil,
  UserPlus,
  Building2,
  Wallet,
  CheckCircle2,
  Percent,
  Minus,
  Plus,
  Printer,
  CalendarClock,
  PhoneCall,
  UserX,
  FileText,
  Ban,
} from 'lucide-react'

const CANCEL_QUICK_REASONS = [
  { label: 'Клиент отменил', value: 'Отменено клиентом' },
  { label: 'Кухня отменила', value: 'Отменено кухней' },
  { label: 'Ошибка официанта', value: 'Ошибка официанта' },
  { label: 'Нет ингредиента', value: 'Нет ингредиента' },
] as const
import { PrintReceipt, type ReceiptData } from '@/components/print-receipt'
import { AddItemsDialog } from '@/components/dialogs/add-items-dialog'

interface FinancialAccount {
  id: string
  name: string
  type: string
  balance: number
}

interface TableDetailSheetProps {
  table: Table | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onAction: (action: string, tableId: string, data?: { orderId?: string; paymentMethod?: PaymentMethod; editTable?: boolean; assignWaiterId?: string; accountId?: string; accountName?: string; servicePercent?: number; serviceAmount?: number; totalWithService?: number; payments?: OrderPayment[]; discountAmount?: number; discountType?: string; discountValue?: number; discountReason?: string }) => void
  hasMergedChildren?: boolean // true if other tables are merged into this one
  // Optional: orders fed from parent (used when the page already manages
  // ordersData with mock-tab injection — avoids the sheet doing its own fetch).
  externalOrders?: Order[]
}

const CAN_PAY = ['owner', 'manager', 'cashier']

const STATUS_STYLE: Record<TableStatus, { bg: string; text: string; dot: string }> = {
  free: { bg: 'bg-emerald-50', text: 'text-emerald-700', dot: 'bg-emerald-500' },
  occupied: { bg: 'bg-red-50', text: 'text-red-700', dot: 'bg-red-500' },
  reserved: { bg: 'bg-blue-50', text: 'text-blue-700', dot: 'bg-blue-500' },
  bill_requested: { bg: 'bg-amber-50', text: 'text-amber-700', dot: 'bg-amber-500' },
}

type PaymentType = 'cash' | 'noncash'
const PAYMENT_OPTIONS: { value: PaymentType; label: string; icon: React.ReactNode }[] = [
  { value: 'cash', label: 'Наличные', icon: <Banknote className="size-5" /> },
  { value: 'noncash', label: 'Безналичные', icon: <CreditCard className="size-5" /> },
]

export function TableDetailSheet({ table, open, onOpenChange, onAction, hasMergedChildren, externalOrders }: TableDetailSheetProps) {
  const { canAccessRoles, user, canDo, restaurant } = useAuth()
  const canPay = CAN_PAY.includes(user?.role ?? '')
  const [paymentType, setPaymentType] = useState<PaymentType>('cash')
  const [selectedAccountId, setSelectedAccountId] = useState<string>('')
  const [orders, setOrders] = useState<Order[]>([])
  const [users, setUsers] = useState<User[]>([])
  const [zones, setZones] = useState<Zone[]>([])
  const [accounts, setAccounts] = useState<FinancialAccount[]>([])
  const [menuItemsData, setMenuItemsData] = useState<MenuItem[]>([])
  const [dataLoaded, setDataLoaded] = useState(false)
  const [showWaiterPicker, setShowWaiterPicker] = useState(false)
  const [servicePercent, setServicePercent] = useState(10)
  const [includeService, setIncludeService] = useState(true)

  // Подтягиваем процент обслуживания из настроек ресторана (а не хардкод 10).
  useEffect(() => {
    if (restaurant?.servicePercent !== undefined && restaurant.servicePercent >= 0) {
      setServicePercent(restaurant.servicePercent)
    }
  }, [restaurant?.servicePercent])

  // Автовыбор единственного счёта по типу оплаты — иначе кнопка «Оплатить» disabled навсегда.
  useEffect(() => {
    const targetType = paymentType === 'cash' ? 'cash' : 'bank'
    const filtered = accounts.filter(a => a.type === targetType)
    if (filtered.length === 0) {
      if (selectedAccountId) setSelectedAccountId('')
      return
    }
    if (!filtered.some(a => a.id === selectedAccountId)) {
      setSelectedAccountId(filtered[0].id)
    }
  }, [accounts, paymentType, selectedAccountId])
  const [showReceipt, setShowReceipt] = useState(false)
  const [receiptData, setReceiptData] = useState<ReceiptData | null>(null)
  const receiptRef = useRef<HTMLDivElement>(null)
  const [showReservation, setShowReservation] = useState(false)
  const [localCapacity, setLocalCapacity] = useState(table?.capacity ?? 0)
  const [localGuests, setLocalGuests] = useState(0)
  const [reservation, setReservation] = useState<Reservation | null>(null)
  const [showAddItems, setShowAddItems] = useState(false)
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null)
  // Voids активного заказа — нужны, чтобы списанные через void позиции не попадали
  // в тело пре-чека/гостевого чека. См. helpers.visibleReceiptItems.
  const [voids, setVoids] = useState<OrderVoid[]>([])
  const [cancellingItemId, setCancellingItemId] = useState<string | null>(null)
  const [cancellingOrder, setCancellingOrder] = useState(false)
  const [cancelInFlight, setCancelInFlight] = useState(false)

  // Action-based: anyone with explicit `tables.edit` (incl. cashier when granted)
  // can edit/merge/unmerge/assign-waiter on tables.
  const canEditTables = canDo('tables.edit') || canAccessRoles(['manager', 'owner'])
  const canReserve = canAccessRoles(['manager', 'waiter', 'cashier'])
  const role = user?.role ?? ''

  useEffect(() => {
    if (open && !dataLoaded) {
      Promise.all([fetchOrders({ from: startOfToday() }), fetchUsers(), fetchZones(), fetchFinancialAccounts(), fetchMenuItems()])
        .then(async ([o, u, z, a, mi]) => {
          // Заказ открытого стола может быть старше «сегодня» (зависший заказ,
          // bill_requested 4 дня и т.п.). Без fallback на table.currentOrderId
          // owner видит шит без позиций и без кнопок оплаты.
          let merged = o
          if (table?.currentOrderId && !o.some(x => x.id === table.currentOrderId)) {
            try {
              const extra = await fetchOrders({ ids: [table.currentOrderId] })
              if (extra.length > 0) merged = [...o, ...extra]
            } catch (e) { console.error('[table-detail-sheet] догрузка заказа стола:', e) }
          }
          setOrders(merged); setUsers(u); setZones(z)
          setAccounts(a); setMenuItemsData(mi)
          if (a.length > 0) setSelectedAccountId(a[0].id)
          setDataLoaded(true)
        })
    }
  }, [open, dataLoaded, table?.currentOrderId])

  // Prefer parent-provided orders when given (parent already mock-injects).
  useEffect(() => {
    if (externalOrders) setOrders(externalOrders)
  }, [externalOrders])

  // Reset on close, reload on open
  useEffect(() => {
    if (!open) {
      setShowReceipt(false); setReceiptData(null); setReservation(null)
      setDataLoaded(false)
    } else if (table) {
      setLocalCapacity(table.capacity)
    }
  }, [open, table])

  // Open orders for this table (multi-tab: more than one possible).
  const openOrders = !table
    ? []
    : orders
        .filter(o => o.tableId === table.id && o.status !== 'done' && o.status !== 'cancelled')
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())

  // Pick / re-pick the active tab when openOrders changes.
  useEffect(() => {
    if (!open) return
    if (openOrders.length === 0) { setSelectedOrderId(null); return }
    if (!selectedOrderId || !openOrders.some(o => o.id === selectedOrderId)) {
      setSelectedOrderId(openOrders[0].id)
    }
  }, [open, openOrders, selectedOrderId])

  // Set localGuests from selected order when data loaded
  useEffect(() => {
    if (open && dataLoaded && selectedOrderId) {
      const o = orders.find(ord => ord.id === selectedOrderId)
      if (o) setLocalGuests(o.guestsCount ?? table?.capacity ?? 1)
    }
  }, [open, dataLoaded, orders, selectedOrderId, table])

  // Load voids for selected order
  useEffect(() => {
    if (open && selectedOrderId) {
      fetchVoidsForOrder(selectedOrderId).then(setVoids).catch(() => setVoids([]))
    } else {
      setVoids([])
    }
  }, [open, selectedOrderId])

  // Load reservation for reserved tables
  useEffect(() => {
    if (open && table?.status === 'reserved') {
      fetchReservationForTable(table.id).then(setReservation).catch(() => {})
    }
  }, [open, table?.id, table?.status])

  const handlePrint = useCallback(async () => {
    // Pre-check — через backend job, не client ESC/POS.
    if (receiptData?.isPreCheck && selectedOrderId) {
      try {
        const { printPreBill } = await import('@/lib/queries')
        const { jobId } = await printPreBill(selectedOrderId)
        toast.success(jobId ? `Пре-чек отправлен (${jobId.slice(0, 8)}…)` : 'Пре-чек отправлен на печать')
        return
      } catch (e) {
        toast.error(e instanceof Error ? `Ошибка печати: ${e.message}` : 'Ошибка печати')
        return
      }
    }
    // Try ESC/POS direct first (sharper output via print-server → thermal printer)
    if (receiptData) {
      const { printReceiptDirect } = await import('@/lib/print-service')
      const ok = await printReceiptDirect(receiptData)
      if (ok) return
      // На десктопе термопринтер — единственный канал. HTML-fallback
      // отправил бы на дефолтный системный принтер (обычно офисный A4).
      const isDesktop = !!(window as unknown as { restosDesktop?: { isDesktop?: boolean } }).restosDesktop?.isDesktop
      if (isDesktop) {
        toast.error('Принтер недоступен. Проверьте подключение и настройки.')
        return
      }
    }
    // Fallback: HTML print
    if (!receiptRef.current) return
    const printWindow = window.open('', '_blank', 'width=320,height=600')
    if (!printWindow) return
    printWindow.document.write(`<html><head><title>Чек</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:monospace}@media print{@page{margin:5mm;size:80mm auto}}</style></head><body>${receiptRef.current.outerHTML}<script>window.onload=function(){window.print();window.close()}<\/script></body></html>`)
    printWindow.document.close()
  }, [receiptData])

  const handlePreCheck = useCallback(() => {
    if (!table) return
    const ord = selectedOrderId ? orders.find((o) => o.id === selectedOrderId) : null
    if (!ord) return
    const receipt = buildReceiptData(
      ord,
      { tables: [table], users, zones, restaurant, currentUser: user, voids },
      { isPreCheck: true, includeService, servicePercent },
    )
    setReceiptData(receipt)
    setShowReceipt(true)
  }, [table, orders, users, zones, restaurant, includeService, servicePercent, user, selectedOrderId, voids])

  const handlePay = useCallback(() => {
    if (!table) return
    const ord = selectedOrderId ? orders.find((o) => o.id === selectedOrderId) : null
    if (!ord) return
    const acc = accounts.find(a => a.id === selectedAccountId)
    const pm: PaymentMethod = paymentType === 'cash' ? 'cash' : 'card'

    const receipt = buildReceiptData(
      ord,
      { tables: [table], users, zones, restaurant, currentUser: user, voids },
      {
        isPreCheck: false,
        includeService,
        servicePercent,
        paymentMethod: pm,
        accountName: acc?.name,
      },
    )
    setReceiptData(receipt)
    setShowReceipt(true)

    onAction('close_and_pay', table.id, {
      orderId: ord.id,
      paymentMethod: pm,
      accountId: selectedAccountId,
      accountName: acc?.name,
      servicePercent: includeService ? servicePercent : 0,
      serviceAmount: receipt.serviceAmount,
      totalWithService: receipt.total,
    })
  }, [table, orders, users, zones, restaurant, includeService, servicePercent, user, accounts, selectedAccountId, paymentType, onAction, selectedOrderId, voids])

  if (!table) return null

  // Show receipt after payment
  if (showReceipt && receiptData) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent className="md:h-full h-[90vh] flex flex-col">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              {receiptData.isPreCheck ? (
                <>
                  <FileText className="size-5 text-blue-500" />
                  Предварительный счёт
                </>
              ) : (
                <>
                  <CheckCircle2 className="size-5 text-emerald-500" />
                  Оплата проведена
                </>
              )}
            </SheetTitle>
            <SheetDescription>{table.name}</SheetDescription>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-4 flex flex-col items-center py-4">
            <div className="bg-white rounded-lg shadow-lg border border-border p-2">
              <PrintReceipt ref={receiptRef} data={receiptData} />
            </div>
          </div>
          <SheetFooter className="px-4 gap-2">
            <button onClick={handlePrint} className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-5 py-4 text-base font-medium md:py-3 md:text-sm text-primary-foreground hover:bg-primary/90 transition-colors">
              <Printer className="size-4" />
              Печать чека
            </button>
            <button onClick={() => onOpenChange(false)} className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl border-2 border-border px-5 py-4 text-base font-medium md:py-3 md:text-sm hover:bg-muted transition-colors">
              Закрыть
            </button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    )
  }

  const style = STATUS_STYLE[table.status] ?? STATUS_STYLE.free
  const zone = zones.find((z) => z.id === table.zone)
  const order = openOrders.find(o => o.id === selectedOrderId) ?? openOrders[0] ?? null
  const waiter = table.waiterId ? users.find((u) => u.id === table.waiterId) : null
  const waiters = users.filter((u) => u.role === 'waiter')
  const tabLabel = (o: Order, idx: number) => o.tabLabel || `Группа ${idx + 1}`

  return (
    <>
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="md:h-full h-[90vh] flex flex-col">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-3">
            <span>{table.name}</span>
            <span
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium ${style.bg} ${style.text}`}
            >
              <span className={`size-2 rounded-full ${style.dot}`} />
              {STATUS_LABELS[table.status]}
            </span>
            {canEditTables && (
              <button
                onClick={() => onAction('edit_table', table.id)}
                className="ml-auto mr-12 p-1.5 rounded-lg text-muted-foreground hover:bg-muted transition-colors"
                title="Редактировать"
              >
                <Pencil className="size-4" />
              </button>
            )}
          </SheetTitle>
          <SheetDescription className="sr-only">Информация о столе</SheetDescription>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground mt-1">
            <span className="inline-flex items-center gap-1 min-w-0">
              <MapPin className="size-3 shrink-0" />
              <span className="truncate">{zone?.name ?? '—'}</span>
            </span>
            {table.openedAt && (
              <span className="inline-flex items-center gap-1 min-w-0">
                <Clock className="size-3 shrink-0" />
                <span className="truncate">{getTimeSince(table.openedAt)}</span>
              </span>
            )}
            <span className="inline-flex items-center gap-1 min-w-0">
              <UserCircle className="size-3 shrink-0" />
              <span className="truncate">{waiter?.name ?? '—'}</span>
              {canEditTables && (
                <button
                  onClick={() => setShowWaiterPicker(!showWaiterPicker)}
                  className="ml-1 p-0.5 rounded text-primary hover:bg-primary/10"
                  title="Назначить официанта"
                >
                  <UserPlus className="size-3" />
                </button>
              )}
            </span>
          </div>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-4 space-y-5">
          {/* Unmerge button — if other tables are merged into this one */}
          {canEditTables && hasMergedChildren && (
            <button
              onClick={() => { onAction('unmerge_table', table.id); onOpenChange(false) }}
              className="w-full inline-flex items-center justify-center gap-2 rounded-xl border-2 border-amber-200 bg-amber-50 px-4 py-2.5 text-sm font-medium text-amber-700 hover:bg-amber-100 transition-colors"
            >
              ↔ Разъединить столы
            </button>
          )}

          {/* Table info — capacity + guests (only steppers live here; the rest is in the header) */}
          <div className="rounded-xl border border-border p-3 space-y-2">
            <div className={`grid ${order ? 'grid-cols-2' : 'grid-cols-1'} gap-3 text-xs`}>
              {/* Мест */}
              <div className="flex items-center gap-1.5 min-w-0">
                <Users className="size-3.5 text-muted-foreground shrink-0" />
                <span className="text-muted-foreground">Мест:</span>
                {canAccessRoles(['manager', 'waiter', 'cashier']) ? (
                  <div className="flex items-center gap-1 ml-auto">
                    <button
                      onClick={async (e) => {
                        e.stopPropagation()
                        if (localCapacity <= 1) return
                        const newCap = localCapacity - 1
                        setLocalCapacity(newCap)
                        quickUpdateCapacity(table.id, newCap).catch(() => setLocalCapacity(localCapacity))
                      }}
                      className="size-6 rounded-md border border-border flex items-center justify-center text-muted-foreground hover:bg-muted transition-colors"
                    >
                      <Minus className="size-3" />
                    </button>
                    <span className="font-bold text-sm text-foreground w-5 text-center tabular-nums">{localCapacity}</span>
                    <button
                      onClick={async (e) => {
                        e.stopPropagation()
                        const newCap = localCapacity + 1
                        setLocalCapacity(newCap)
                        quickUpdateCapacity(table.id, newCap).catch(() => setLocalCapacity(localCapacity))
                      }}
                      className="size-6 rounded-md border border-border flex items-center justify-center text-muted-foreground hover:bg-muted transition-colors"
                    >
                      <Plus className="size-3" />
                    </button>
                  </div>
                ) : (
                  <span className="font-bold text-sm text-foreground ml-auto">{localCapacity}</span>
                )}
              </div>

              {/* Гостей (only when occupied) */}
              {order && (
                <div className="flex items-center gap-1.5 min-w-0">
                  <UserIcon className="size-3.5 text-muted-foreground shrink-0" />
                  <span className="text-muted-foreground">Гостей:</span>
                  {canAccessRoles(['manager', 'waiter', 'cashier']) ? (
                    <div className="flex items-center gap-1 ml-auto">
                      <button
                        onClick={async (e) => {
                          e.stopPropagation()
                          if (localGuests <= 1) return
                          const newVal = localGuests - 1
                          setLocalGuests(newVal)
                          try {
                            const { patchOrder } = await import('@/lib/queries/orders')
                            await patchOrder(order.id, { guestsCount: newVal })
                          } catch { /* optimistic — server will reconcile on reload */ }
                        }}
                        className="size-6 rounded-md border border-border flex items-center justify-center text-muted-foreground hover:bg-muted transition-colors"
                      >
                        <Minus className="size-3" />
                      </button>
                      <span className="font-bold text-sm text-foreground w-5 text-center tabular-nums">{localGuests}</span>
                      <button
                        onClick={async (e) => {
                          e.stopPropagation()
                          const newVal = localGuests + 1
                          setLocalGuests(newVal)
                          try {
                            const { patchOrder } = await import('@/lib/queries/orders')
                            await patchOrder(order.id, { guestsCount: newVal })
                          } catch { /* optimistic — server will reconcile on reload */ }
                        }}
                        className="size-6 rounded-md border border-border flex items-center justify-center text-muted-foreground hover:bg-muted transition-colors"
                      >
                        <Plus className="size-3" />
                      </button>
                    </div>
                  ) : (
                    <span className="font-bold text-sm text-foreground ml-auto">{localGuests}</span>
                  )}
                </div>
              )}
            </div>

            {/* Merged tables indicator */}
            {table.mergedWith && (
              <div className="flex items-center gap-2 text-xs text-amber-600 bg-amber-50 px-2.5 py-1 rounded-md">
                <span>Объединён с другим столом</span>
              </div>
            )}

            {/* Waiter picker dropdown — opened from the header avatar button */}
            {showWaiterPicker && canEditTables && (
              <div className="space-y-1 p-2 bg-muted/30 rounded-lg">
                <p className="text-xs font-medium text-muted-foreground mb-1">Назначить официанта:</p>
                <button
                  onClick={() => {
                    onAction('assign_waiter', table.id, { assignWaiterId: '' })
                    setShowWaiterPicker(false)
                  }}
                  className="w-full text-left text-xs px-2.5 py-1.5 rounded-md hover:bg-muted transition-colors text-muted-foreground"
                >
                  Снять назначение
                </button>
                {waiters.map((w) => (
                  <button
                    key={w.id}
                    onClick={() => {
                      onAction('assign_waiter', table.id, { assignWaiterId: w.id })
                      setShowWaiterPicker(false)
                    }}
                    className={`w-full text-left text-xs px-2.5 py-1.5 rounded-md hover:bg-muted transition-colors ${
                      table.waiterId === w.id ? 'bg-primary/10 text-primary font-medium' : 'text-foreground'
                    }`}
                  >
                    {w.name}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Tab picker — visible whenever the table has at least one open order.
              Multi-tab UX: lets staff switch between concurrent customer tabs and open new ones. */}
          {openOrders.length >= 1 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-semibold">Группы за столом</h4>
                {openOrders.length >= 2 && (
                  <span className="text-xs text-muted-foreground">{openOrders.length} активных</span>
                )}
              </div>
              <div className="flex items-center gap-2 overflow-x-auto pb-1 -mx-1 px-1">
                {openOrders.map((o, i) => {
                  const active = o.id === selectedOrderId
                  const ready = o.status === 'ready'
                  const bill = o.status === 'bill_requested'
                  return (
                    <button
                      key={o.id}
                      onClick={() => setSelectedOrderId(o.id)}
                      className={`shrink-0 inline-flex flex-col items-start gap-0.5 rounded-xl border-2 px-3 py-2 text-left transition-all ${
                        active
                          ? 'border-primary bg-primary/5'
                          : ready
                            ? 'border-emerald-200 bg-emerald-50 hover:border-emerald-300'
                            : bill
                              ? 'border-amber-200 bg-amber-50 hover:border-amber-300'
                              : 'border-border hover:border-muted-foreground/30'
                      }`}
                    >
                      <span className={`text-xs font-semibold ${active ? 'text-primary' : 'text-foreground'}`}>{tabLabel(o, i)}</span>
                      <span className="text-[11px] text-muted-foreground">{ORDER_STATUS_LABELS[o.status]}</span>
                      <span className="text-xs font-bold">{formatCurrency(o.total)}</span>
                    </button>
                  )
                })}
                {canAccessRoles(['manager', 'waiter', 'cashier']) && (
                  <button
                    onClick={() => onAction('new_tab', table.id)}
                    className="shrink-0 inline-flex flex-col items-center justify-center gap-0.5 rounded-xl border-2 border-dashed border-primary/40 px-4 py-2 text-primary hover:bg-primary/5 transition-colors min-h-[68px]"
                  >
                    <Plus className="size-4" />
                    <span className="text-[11px] font-medium">Новая группа</span>
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Current order details */}
          {order && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-semibold">
                  {openOrders.length > 1
                    ? `Заказ · ${order.tabLabel || `Группа ${openOrders.findIndex(o => o.id === order.id) + 1}`}`
                    : 'Текущий заказ'}
                </h4>
                <span
                  className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium ${
                    order.status === 'new'
                      ? 'bg-blue-100 text-blue-700'
                      : order.status === 'cooking'
                        ? 'bg-amber-100 text-amber-700'
                        : order.status === 'ready'
                          ? 'bg-emerald-100 text-emerald-700'
                          : 'bg-muted text-muted-foreground'
                  }`}
                >
                  {ORDER_STATUS_LABELS[order.status]}
                </span>
              </div>
              {(() => {
                const voidedFlags = voidedItemFlags(order.items, voids)
                return (
              <div className="rounded-xl border border-border divide-y divide-border">
                {order.items.map((item, i) => {
                  const mi = menuItemsData.find(m => m.id === item.menuItemId)
                  const isCancelled = !!item.cancelledAt
                  const isVoided = !isCancelled && voidedFlags[i]
                  const visuallyMuted = isCancelled || isVoided
                  const isOwnAsWaiter = role === 'waiter' && order.waiterId === user?.id
                  const inActiveStatus = order.status === 'new' || order.status === 'cooking' || order.status === 'ready'
                  const canCancelLine = !!item.id && !isCancelled && !isVoided && inActiveStatus && (canDo('orders.void') || isOwnAsWaiter)
                  const isCancellingThis = cancellingItemId === item.id
                  const submitItemCancel = async (reason: string) => {
                    if (!item.id || !reason) return
                    setCancelInFlight(true)
                    try {
                      await cancelOrderItem(item.id, reason, user?.id)
                      toast.success('Позиция отменена')
                      setCancellingItemId(null)
                      onAction('refresh', table.id)
                      setDataLoaded(false)
                    } catch (e) {
                      const msg = e instanceof Error ? e.message : 'Ошибка отмены'
                      toast.error(msg)
                    } finally {
                      setCancelInFlight(false)
                    }
                  }
                  return (
                    <div key={i} className={`px-4 py-2.5 ${visuallyMuted ? 'opacity-50' : ''}`}>
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-sm flex items-center flex-wrap gap-x-1 gap-y-0.5 min-w-0">
                          <span className={`font-medium ${visuallyMuted ? 'line-through' : ''}`}>{item.name}</span>
                          <span className={`text-muted-foreground ${visuallyMuted ? 'line-through' : ''}`}>{item.unit && item.unit !== 'piece' ? formatQty(item.qty, item.unit) : `x${item.qty}`}</span>
                          {isCancelled ? (
                            <span className="ml-1 text-[10px] font-medium px-1.5 py-0.5 rounded bg-rose-50 text-rose-700">отменено{item.cancelReason ? ` · ${item.cancelReason}` : ''}</span>
                          ) : isVoided ? (
                            <span className="ml-1 text-[10px] font-medium px-1.5 py-0.5 rounded bg-red-50 text-red-600">Списано</span>
                          ) : (
                            <>
                              {mi?.cookTimeMin && (
                                <span className="ml-1 text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">⏱ {mi.cookTimeMin} мин</span>
                              )}
                              {mi && mi.station === 'bar' && (
                                <span className="ml-1 text-[10px] font-medium px-1.5 py-0.5 rounded bg-blue-50 text-blue-700">☕ Бар</span>
                              )}
                              {mi && mi.station === 'showcase' && (
                                <span className="ml-1 text-[10px] font-medium px-1.5 py-0.5 rounded bg-amber-50 text-amber-700">🥟 Витрина</span>
                              )}
                            </>
                          )}
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <span className={`text-sm font-medium ${visuallyMuted ? 'line-through' : ''}`}>
                            {formatCurrency(calcLineTotal(item.price, item.qty, item.unit, item.unitSize))}
                          </span>
                          {canCancelLine && (
                            <button
                              onClick={() => setCancellingItemId(isCancellingThis ? null : item.id ?? null)}
                              className="text-rose-400 hover:text-rose-600 transition-colors p-0.5"
                              title="Отменить позицию"
                              aria-label="Отменить позицию"
                            >
                              <X className="size-4" />
                            </button>
                          )}
                        </div>
                      </div>
                      {isCancellingThis && (
                        <div className="mt-2 p-2.5 rounded-lg bg-rose-50 border border-rose-200 space-y-2">
                          <div className="text-[11px] font-semibold text-rose-700">Причина отмены позиции</div>
                          <div className="grid grid-cols-2 gap-1.5">
                            {CANCEL_QUICK_REASONS.map(q => (
                              <button
                                key={q.value}
                                disabled={cancelInFlight}
                                onClick={() => submitItemCancel(q.value)}
                                className="text-xs font-medium px-2 py-1.5 rounded-md bg-rose-600 text-white hover:bg-rose-700 transition-colors disabled:opacity-50"
                              >
                                {q.label}
                              </button>
                            ))}
                          </div>
                          <button
                            onClick={() => setCancellingItemId(null)}
                            className="w-full text-[11px] text-rose-700 hover:underline"
                          >
                            Отмена
                          </button>
                        </div>
                      )}
                    </div>
                  )
                })}
                <div className="flex items-center justify-between px-4 py-3 bg-muted/30">
                  <span className="text-sm font-semibold">Итого</span>
                  <span className="text-sm font-bold">{formatCurrency(dRound(dSum(visibleReceiptItems(order.items, voids).map(i => calcLineTotal(i.price, i.qty, i.unit, i.unitSize)))))}</span>
                </div>
                {/* Service preview — только пока счёт ещё не запрошен.
                    При bill_requested ниже рендерится полноценный блок со
                    слайдером, дубликата не будет. */}
                {order.total > 0 && servicePercent > 0 && table.status !== 'bill_requested' && (
                  <div className="px-4 py-3 bg-primary/5 border-t border-primary/20 space-y-1.5">
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>Обслуживание ({servicePercent}%)</span>
                      <span>+{formatCurrency((order.total * servicePercent) / 100)}</span>
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <span className="font-semibold">К оплате</span>
                      <span className="text-base font-bold text-primary">
                        {formatCurrency(order.total + (order.total * servicePercent) / 100)}
                      </span>
                    </div>
                  </div>
                )}
              </div>
                )
              })()}
            </div>
          )}

          {/* Payment section for bill_requested — only for cashier/manager/owner */}
          {table.status === 'bill_requested' && canPay && (() => {
            const subtotal = order?.total ?? 0
            const serviceAmount = includeService ? dRound(dDiv(dMul(subtotal, servicePercent), 100)) : 0
            const totalWithService = dAdd(subtotal, serviceAmount)

            return (
              <div className="space-y-4">
                {/* Service charge */}
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
                        <button onClick={() => setServicePercent(Math.max(0, servicePercent - 5))} disabled={servicePercent <= 0} className="size-9 rounded-lg border border-border flex items-center justify-center hover:bg-muted active:bg-muted/80 transition-colors disabled:opacity-30"><Minus className="size-4" /></button>
                        <span className="text-lg font-bold w-12 text-center">{servicePercent}%</span>
                        <button onClick={() => setServicePercent(Math.min(30, servicePercent + 5))} disabled={servicePercent >= 30} className="size-9 rounded-lg border border-border flex items-center justify-center hover:bg-muted active:bg-muted/80 transition-colors disabled:opacity-30"><Plus className="size-4" /></button>
                      </div>
                      <span className="text-sm font-medium text-muted-foreground">+{formatCurrency(serviceAmount)}</span>
                    </div>
                  )}

                  <div className="flex items-center justify-between rounded-xl bg-primary/5 border-2 border-primary/20 px-4 py-3">
                    <span className="text-sm font-bold">К оплате</span>
                    <span className="text-xl font-bold text-primary">{formatCurrency(totalWithService)}</span>
                  </div>
                </div>

                {/* Payment type */}
                <div className="space-y-3">
                  <h4 className="text-sm font-semibold">Способ оплаты</h4>
                  <div className="grid grid-cols-2 gap-2">
                    {PAYMENT_OPTIONS.map((opt) => (
                      <button
                        key={opt.value}
                        onClick={() => {
                          setPaymentType(opt.value)
                          const targetType = opt.value === 'cash' ? 'cash' : 'bank'
                          const filtered = accounts.filter(a => a.type === targetType)
                          if (filtered.length > 0) setSelectedAccountId(filtered[0].id)
                        }}
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
                </div>

                {/* Account selection — filtered */}
                {(() => {
                  const targetType = paymentType === 'cash' ? 'cash' : 'bank'
                  const filtered = accounts.filter(a => a.type === targetType)
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
                      <h4 className="text-sm font-semibold">{paymentType === 'cash' ? 'Касса' : 'Банковский счёт'}</h4>
                      <div className="space-y-1.5">
                        {filtered.map((acc) => (
                          <button key={acc.id} onClick={() => setSelectedAccountId(acc.id)} className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl border-2 transition-all text-left ${selectedAccountId === acc.id ? 'border-primary bg-primary/5' : 'border-border hover:border-muted-foreground/30'}`}>
                            {acc.type === 'cash' ? <Wallet className="size-4 text-muted-foreground shrink-0" /> : <Building2 className="size-4 text-muted-foreground shrink-0" />}
                            <div className="flex-1 min-w-0"><p className="text-sm font-medium truncate">{acc.name}</p></div>
                            {selectedAccountId === acc.id && <CheckCircle2 className="size-4 text-primary shrink-0" />}
                          </button>
                        ))}
                      </div>
                    </div>
                  )
                })()}
              </div>
            )
          })()}

          {/* Waiter sees "bill requested" status without payment controls */}
          {table.status === 'bill_requested' && !canPay && (
            <div className="rounded-xl bg-amber-50 border border-amber-200 p-4 text-center space-y-1.5">
              <Receipt className="size-6 text-amber-600 mx-auto" />
              <p className="text-sm font-semibold text-amber-800">Счёт запрошен</p>
              <p className="text-xs text-amber-600">Ожидайте — кассир обработает оплату</p>
            </div>
          )}
        </div>

        {/* Action buttons */}
        <SheetFooter className="px-4">
          {table.status === 'free' && canAccessRoles(['manager', 'waiter', 'cashier']) && (
            <div className="space-y-2 w-full">
              <button
                onClick={() => onAction('create_order', table.id)}
                className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-5 py-4 text-base font-medium md:py-3 md:text-sm text-primary-foreground hover:bg-primary/90 transition-colors"
              >
                <UtensilsCrossed className="size-4" />
                Создать заказ
              </button>
              {canReserve && (
                <button
                  onClick={() => setShowReservation(true)}
                  className="w-full inline-flex items-center justify-center gap-2 rounded-xl border-2 border-blue-200 bg-blue-50 px-5 py-3.5 text-base font-medium md:py-2.5 md:text-sm text-blue-700 hover:bg-blue-100 transition-colors"
                >
                  <CalendarClock className="size-4" />
                  Забронировать
                </button>
              )}
            </div>
          )}

          {table.status === 'occupied' && order?.status === 'ready' && canAccessRoles(['manager', 'waiter']) && (
            <div className="space-y-2 w-full">
              <button
                onClick={() => { onAction('mark_served', table.id, { orderId: order?.id }); onOpenChange(false) }}
                className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-600 px-5 py-4 text-base font-medium md:py-3 md:text-sm text-white hover:bg-emerald-700 transition-colors animate-pulse"
              >
                <CheckCircle2 className="size-4" />
                Подано — забрал с кухни
              </button>
              <button
                onClick={() => { setShowAddItems(true); onOpenChange(false) }}
                className="w-full inline-flex items-center justify-center gap-2 rounded-xl border-2 border-primary/30 bg-primary/5 px-5 py-3.5 text-base font-medium md:py-2.5 md:text-sm text-primary hover:bg-primary/10 transition-colors"
              >
                <Plus className="size-4" />
                Дозаказ
              </button>
              <button
                onClick={handlePreCheck}
                className="w-full inline-flex items-center justify-center gap-2 rounded-xl border-2 border-border px-5 py-3.5 text-base font-medium md:py-2.5 md:text-sm text-foreground hover:bg-muted transition-colors"
              >
                <FileText className="size-4" />
                Пре-чек
              </button>
              <button
                onClick={() => onAction('request_bill', table.id, { orderId: order?.id })}
                className="w-full inline-flex items-center justify-center gap-2 rounded-xl border-2 border-amber-200 bg-amber-50 px-5 py-3.5 text-base font-medium md:py-2.5 md:text-sm text-amber-700 hover:bg-amber-100 transition-colors"
              >
                <Receipt className="size-4" />
                Запросить счёт
              </button>
            </div>
          )}

          {table.status === 'occupied' && order?.status !== 'ready' && canAccessRoles(['manager', 'waiter', 'cashier']) && (
            <div className="space-y-2 w-full">
              <button
                onClick={() => { setShowAddItems(true); onOpenChange(false) }}
                className="w-full inline-flex items-center justify-center gap-2 rounded-xl border-2 border-primary/30 bg-primary/5 px-5 py-3.5 text-base font-medium md:py-2.5 md:text-sm text-primary hover:bg-primary/10 transition-colors"
              >
                <Plus className="size-4" />
                Дозаказ
              </button>
              {order?.status === 'served' && (
                <>
                  <button
                    onClick={handlePreCheck}
                    className="w-full inline-flex items-center justify-center gap-2 rounded-xl border-2 border-border px-5 py-3.5 text-base font-medium md:py-2.5 md:text-sm text-foreground hover:bg-muted transition-colors"
                  >
                    <FileText className="size-4" />
                    Пре-чек
                  </button>
                  <button
                    onClick={() => onAction('request_bill', table.id, { orderId: order?.id })}
                    className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-amber-500 px-5 py-4 text-base font-medium md:py-3 md:text-sm text-white hover:bg-amber-600 transition-colors"
                  >
                    <Receipt className="size-4" />
                    Запросить счёт
                  </button>
                </>
              )}
            </div>
          )}

          {/* Whole-order cancel — visible while the order is still active.
              Cashier/manager always; waiter only on their own pre-served order. */}
          {table.status === 'occupied' && order && order.status !== 'done' && order.status !== 'cancelled' && (() => {
            const isOwnAsWaiter = role === 'waiter' && order.waiterId === user?.id
            const waiterEligibleStatus = order.status === 'new' || order.status === 'cooking' || order.status === 'ready'
            const showWholeCancel = canDo('orders.cancel') || (isOwnAsWaiter && waiterEligibleStatus)
            if (!showWholeCancel) return null

            const submitOrderCancel = async (reason: string) => {
              if (!reason) return
              setCancelInFlight(true)
              try {
                await cancelOrder(order.id, reason, user?.id)
                toast.success('Заказ отменён')
                setCancellingOrder(false)
                onAction('refresh', table.id)
                onOpenChange(false)
              } catch (e) {
                const msg = e instanceof Error ? e.message : 'Ошибка отмены'
                toast.error(msg)
              } finally {
                setCancelInFlight(false)
              }
            }

            return !cancellingOrder ? (
              <button
                onClick={() => setCancellingOrder(true)}
                className="w-full inline-flex items-center justify-center gap-2 rounded-xl border-2 border-zinc-300 px-5 py-3 text-sm font-medium text-zinc-700 hover:bg-zinc-50 transition-colors"
              >
                <Ban className="size-4" />
                Отменить заказ
              </button>
            ) : (
              <div className="rounded-xl border-2 border-zinc-300 bg-zinc-50 p-3 space-y-2 w-full">
                <div className="text-xs font-semibold text-zinc-700">Отменить весь заказ?</div>
                <div className="grid grid-cols-2 gap-1.5">
                  {CANCEL_QUICK_REASONS.map(q => (
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
                <button
                  onClick={() => setCancellingOrder(false)}
                  className="w-full text-xs text-zinc-700 hover:underline"
                >
                  Отмена
                </button>
              </div>
            )
          })()}

          {/* Merge button removed from footer — moved to info section */}

          {table.status === 'bill_requested' && canPay && (() => {
            const subtotal = order?.total ?? 0
            const svcAmt = includeService ? Math.round(subtotal * servicePercent) / 100 : 0
            const totalWS = subtotal + svcAmt

            return (
              <div className="space-y-2 w-full">
              <button
                onClick={handlePay}
                disabled={!selectedAccountId}
                className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-600 px-5 py-4 text-base font-medium md:py-3 md:text-sm text-white hover:bg-emerald-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <CreditCard className="size-4" />
                Оплатить · {formatCurrency(totalWS)}
              </button>
              <button
                onClick={() => setShowAddItems(true)}
                className="w-full inline-flex items-center justify-center gap-2 rounded-xl border-2 border-primary/30 bg-primary/5 px-5 py-3.5 text-base font-medium md:py-2.5 md:text-sm text-primary hover:bg-primary/10 transition-colors"
              >
                <Plus className="size-4" />
                Дозаказ
              </button>
              </div>
            )
          })()}

          {table.status === 'reserved' && (
            <div className="space-y-3 w-full">
              {/* Reservation details */}
              {reservation && (
                <div className="bg-blue-50 rounded-xl p-4 border border-blue-200 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-blue-900">Бронь</span>
                    <span className="text-xs text-blue-600">
                      {new Date(reservation.reservedAt).toLocaleDateString('ru', { day: 'numeric', month: 'short' })}
                      {' '}
                      {new Date(reservation.reservedAt).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                  <div className="space-y-1 text-sm">
                    <div className="flex items-center gap-2 text-blue-800">
                      <UserIcon className="size-3.5 shrink-0" />
                      <span className="font-medium">{reservation.guestName}</span>
                    </div>
                    {reservation.guestPhone && (
                      <div className="flex items-center gap-2">
                        <PhoneCall className="size-3.5 shrink-0 text-blue-600" />
                        <a href={`tel:${reservation.guestPhone}`} className="text-blue-600 hover:underline">{reservation.guestPhone}</a>
                      </div>
                    )}
                    <div className="flex items-center gap-2 text-blue-700">
                      <Users className="size-3.5 shrink-0" />
                      <span>{reservation.guestsCount} гост{reservation.guestsCount === 1 ? 'ь' : reservation.guestsCount < 5 ? 'я' : 'ей'}</span>
                      <span className="text-blue-500">· {reservation.durationMin >= 60 ? `${reservation.durationMin / 60}ч` : `${reservation.durationMin}м`}</span>
                    </div>
                    {reservation.note && (
                      <p className="text-xs text-blue-600 italic">{reservation.note}</p>
                    )}
                  </div>
                </div>
              )}

              {/* Fallback: reservation record missing but table is reserved */}
              {canAccessRoles(['manager', 'waiter', 'cashier']) && !reservation && (
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">Запись о брони не найдена</p>
                  <button
                    onClick={() => { onAction('cancel_reservation', table.id); onOpenChange(false) }}
                    className="w-full inline-flex items-center justify-center gap-1.5 rounded-xl border-2 border-red-200 bg-red-50 px-4 py-2.5 text-sm font-medium text-red-700 hover:bg-red-100 transition-colors"
                  >
                    <X className="size-4" />
                    Снять резерв
                  </button>
                </div>
              )}

              {/* Actions for reserved table */}
              {canAccessRoles(['manager', 'waiter', 'cashier']) && reservation && (
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={async () => {
                      await updateReservationStatus(reservation.id, 'seated', table.id)
                      onAction('seat_guest', table.id)
                    }}
                    className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-emerald-700 transition-colors"
                  >
                    <CheckCircle2 className="size-4" />
                    Гость пришёл
                  </button>
                  <button
                    onClick={async () => {
                      await updateReservationStatus(reservation.id, 'cancelled', table.id)
                      onAction('cancel_reservation', table.id)
                    }}
                    className="inline-flex items-center justify-center gap-1.5 rounded-xl border-2 border-red-200 bg-red-50 px-4 py-2.5 text-sm font-medium text-red-700 hover:bg-red-100 transition-colors"
                  >
                    <X className="size-4" />
                    Отменить
                  </button>
                  <button
                    onClick={async () => {
                      await updateReservationStatus(reservation.id, 'no_show', table.id)
                      onAction('cancel_reservation', table.id)
                    }}
                    className="col-span-2 inline-flex items-center justify-center gap-1.5 rounded-xl border border-border px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-muted transition-colors"
                  >
                    <UserX className="size-4" />
                    Не пришёл
                  </button>
                </div>
              )}
            </div>
          )}
        </SheetFooter>
      </SheetContent>

      {table && (
        <ReservationDialog
          open={showReservation}
          onOpenChange={setShowReservation}
          tableId={table.id}
          tableName={table.name}
          tableCapacity={table.capacity}
          onSuccess={() => {
            setShowReservation(false)
            onAction('refresh', table.id)
          }}
        />
      )}

    </Sheet>

    {order && (
      <AddItemsDialog
        orderId={order.id}
        open={showAddItems}
        onClose={() => setShowAddItems(false)}
        onDone={() => {
          setShowAddItems(false)
          setDataLoaded(false)
          if (table) onAction('refresh', table.id)
        }}
      />
    )}
    </>
  )
}
