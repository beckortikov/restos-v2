'use client'

import { useState, useEffect, useCallback, useMemo, memo, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useAuth } from '@/lib/auth-store'
import { usePersistedState } from '@/hooks/use-persisted-state'

import { formatCurrency, getTimeSince, calcLineTotal, calcLineCogs, calcOrderDisplayTotal, formatQty, startOfToday, endOfDay, voidedItemFlags } from '@/lib/helpers'
import {
  ORDER_STATUS_LABELS,
  type Order,
  type OrderStatus,
  type OrderVoid,
  type PaymentMethod,
  type Table,
  type User,
} from '@/lib/types'
import {
  fetchOrders,
  fetchTables,
  fetchUsers,
  updateOrderStatus,
  deleteOrder,
  closeOrderWithPayment,
  cleanupOrphanOrders,
  reopenOrder,
  fetchVoidsForOrders,
} from '@/lib/queries'
import { Plus, Search, Clock, MapPin, ChevronDown, ChevronUp, FileDown } from 'lucide-react'
import { exportOrdersToXlsx } from '@/lib/orders-export'
import { useDataSync } from '@/hooks/use-data-sync'
import { CreateOrderDialog } from '@/components/dialogs/create-order-dialog'
import { OrderActionsDialog, type OrderActionData } from '@/components/dialogs/order-actions-dialog'
import { AddItemsDialog } from '@/components/dialogs/add-items-dialog'
import { ExportOrdersDialog } from '@/components/dialogs/export-orders-dialog'
import { toast } from 'sonner'

const STATUS_FILTER: { value: string; label: string }[] = [
  { value: 'all', label: 'Все' },
  { value: 'new', label: 'Новые' },
  { value: 'cooking', label: 'Готовится' },
  { value: 'ready', label: 'К выдаче' },
  { value: 'served', label: 'Подано' },
  { value: 'done', label: 'Оплачены' },
  { value: 'cancelled', label: 'Отменены' },
]

const STATUS_STYLE: Record<OrderStatus, string> = {
  new: 'bg-blue-100 text-blue-700',
  cooking: 'bg-amber-100 text-amber-700',
  ready: 'bg-emerald-100 text-emerald-700',
  served: 'bg-teal-100 text-teal-700',
  bill_requested: 'bg-amber-100 text-amber-700',
  done: 'bg-muted text-muted-foreground',
  cancelled: 'bg-zinc-200 text-zinc-700',
}

const TYPE_LABELS: Record<string, string> = {
  hall: 'Зал',
  delivery: 'Доставка',
  takeaway: 'Самовывоз',
}

// Цветовое выделение типа заказа в таблице/карточке.
// Зал (или legacy без type) — без подсветки. Самовывоз/доставка — оранжевый/синий чип.
const TYPE_BADGE_STYLE: Record<string, string> = {
  takeaway: 'bg-orange-100 text-orange-700 border border-orange-200',
  delivery: 'bg-sky-100 text-sky-700 border border-sky-200',
}

const TYPE_FILTER: { value: 'all' | 'hall' | 'togo'; label: string }[] = [
  { value: 'all', label: 'Все' },
  { value: 'hall', label: 'Зал' },
  { value: 'togo', label: 'С собой' },
]

const isTogo = (t?: string) => t === 'delivery' || t === 'takeaway'

const PAYMENT_LABELS: Record<string, string> = {
  cash: 'Наличные',
  card: 'Карта',
  transfer: 'Перевод',
}

// ─── Mobile order card ────────────────────────────────────────────────────────

function OrderCardInner({ order, tablesData, usersData, voids, servicePercent, onOpen }: { order: Order; tablesData: Table[]; usersData: User[]; voids?: OrderVoid[]; servicePercent?: number; onOpen?: (order: Order) => void }) {
  const table = order.tableId ? tablesData.find((t) => t.id === order.tableId) : null
  const waiter = order.waiterId ? usersData.find((u) => u.id === order.waiterId) : null
  const [expanded, setExpanded] = useState(false)
  const voidedFlags = voidedItemFlags(order.items, voids)
  const liveCount = order.items.reduce((s, it, idx) => s + (!it.cancelledAt && !voidedFlags[idx] ? 1 : 0), 0)
  const cancelledCount = order.items.reduce((s, it) => s + (it.cancelledAt ? 1 : 0), 0)
  const voidedCount = voidedFlags.reduce((s, f, idx) => s + (f && !order.items[idx].cancelledAt ? 1 : 0), 0)

  return (
    <div className="bg-card rounded-xl border border-border p-4 space-y-3 cursor-pointer" onClick={() => onOpen?.(order)}>
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2.5">
          <span className={`inline-flex items-center px-2 py-1 rounded-md text-xs font-medium ${STATUS_STYLE[order.status]}`}>
            {ORDER_STATUS_LABELS[order.status]}
          </span>
          <span className="text-xs font-mono text-muted-foreground">#{order.orderNumber ?? order.id.slice(0, 8)}</span>
        </div>
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <Clock className="size-3.5" />{getTimeSince(order.createdAt, order.status === 'done' ? order.closedAt : null)}
        </div>
      </div>

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-sm">
          {table ? (
            <><MapPin className="size-3.5 text-muted-foreground" /><span className="font-medium">{table.name}</span></>
          ) : (
            <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium ${TYPE_BADGE_STYLE[order.type] ?? 'text-muted-foreground'}`}>
              {TYPE_LABELS[order.type]}
            </span>
          )}
        </div>
        <span className="text-sm font-bold text-foreground">{formatCurrency(calcOrderDisplayTotal(order, servicePercent))}</span>
      </div>

      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          {liveCount} позиций
          {cancelledCount > 0 && (
            <span className="ml-1 text-zinc-500">· отм. {cancelledCount}</span>
          )}
          {voidedCount > 0 && (
            <span className="ml-1 text-rose-500">· списано {voidedCount}</span>
          )}
        </span>
        <span>{waiter?.name.split(' ')[0] ?? '—'} {order.paymentMethod ? `· ${PAYMENT_LABELS[order.paymentMethod]}` : ''}</span>
      </div>

      {order.cancelReason && (
        <div className="text-[11px] text-zinc-600 italic">Причина: {order.cancelReason}</div>
      )}

      <button
        onClick={(e) => { e.stopPropagation(); setExpanded(!expanded) }}
        className="flex items-center gap-1 text-xs text-primary font-medium"
      >
        {expanded ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
        {expanded ? 'Скрыть состав' : 'Показать состав'}
      </button>

      {expanded && (
        <div className="pt-2 border-t border-border space-y-1.5">
          {order.items.map((item, idx) => {
            const isCancelled = !!item.cancelledAt
            const isVoided = !isCancelled && voidedFlags[idx]
            const muted = isCancelled || isVoided
            return (
              <div key={item.id ?? `${item.menuItemId}-${idx}`} className={`flex items-center justify-between text-sm ${muted ? 'opacity-50' : ''}`}>
                <span className={`text-foreground ${muted ? 'line-through' : ''}`}>
                  {item.name}
                  {isVoided && <span className="ml-1.5 text-[10px] font-medium px-1.5 py-0.5 rounded bg-red-50 text-red-600 no-underline">Списано</span>}
                </span>
                <span className={`text-muted-foreground ${muted ? 'line-through' : ''}`}>{item.unit && item.unit !== 'piece' ? formatQty(item.qty, item.unit) : `x${item.qty}`} · {formatCurrency(calcLineTotal(item.price, item.qty, item.unit, item.unitSize))}</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// Сравниваем заказы по полям, реально отображаемым на карточке/строке. Любое
// изменение этих полей → ререндер; всё остальное — пропуск.
function ordersEqualShallow(prev: Order, next: Order): boolean {
  return (
    prev.id === next.id &&
    prev.status === next.status &&
    prev.total === next.total &&
    prev.totalWithService === next.totalWithService &&
    prev.servicePercent === next.servicePercent &&
    prev.paymentMethod === next.paymentMethod &&
    prev.closedAt === next.closedAt &&
    prev.waiterId === next.waiterId &&
    prev.tableId === next.tableId &&
    prev.type === next.type &&
    prev.items.length === next.items.length &&
    prev.items.filter(i => i.cancelledAt).length === next.items.filter(i => i.cancelledAt).length
  )
}

const OrderCard = memo(OrderCardInner, (prev, next) => {
  if (prev.tablesData !== next.tablesData) return false
  if (prev.usersData !== next.usersData) return false
  if (prev.servicePercent !== next.servicePercent) return false
  if (prev.onOpen !== next.onOpen) return false
  if (prev.voids !== next.voids) return false
  return ordersEqualShallow(prev.order, next.order)
})

// ─── Desktop table row ────────────────────────────────────────────────────────

function OrderRowInner({ order, tablesData, usersData, voids, servicePercent, onOpen }: { order: Order; tablesData: Table[]; usersData: User[]; voids?: OrderVoid[]; servicePercent?: number; onOpen?: (order: Order) => void }) {
  const table = order.tableId ? tablesData.find((t) => t.id === order.tableId) : null
  const waiter = order.waiterId ? usersData.find((u) => u.id === order.waiterId) : null
  const [expanded, setExpanded] = useState(false)
  const voidedFlags = voidedItemFlags(order.items, voids)
  const liveCount = order.items.reduce((s, it, idx) => s + (!it.cancelledAt && !voidedFlags[idx] ? 1 : 0), 0)
  const cancelledCount = order.items.reduce((s, it) => s + (it.cancelledAt ? 1 : 0), 0)
  const voidedCount = voidedFlags.reduce((s, f, idx) => s + (f && !order.items[idx].cancelledAt ? 1 : 0), 0)

  return (
    <>
      <tr
        className="border-b border-border hover:bg-muted/50 cursor-pointer transition-colors"
        onClick={() => onOpen?.(order)}
      >
        <td className="px-4 py-3">
          <span className="text-xs font-mono text-muted-foreground">#{order.orderNumber ?? order.id.slice(0, 8)}</span>
        </td>
        <td className="px-4 py-3">
          <span className={`inline-flex items-center px-2.5 py-1 rounded-md text-xs font-medium ${STATUS_STYLE[order.status]}`}>
            {ORDER_STATUS_LABELS[order.status]}
          </span>
        </td>
        <td className="px-4 py-3">
          <div className="flex items-center gap-1.5">
            {table
              ? <><MapPin className="size-3.5 text-muted-foreground" />{table.name}</>
              : (
                <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium ${TYPE_BADGE_STYLE[order.type] ?? 'text-muted-foreground'}`}>
                  {TYPE_LABELS[order.type]}
                </span>
              )}
          </div>
        </td>
        <td className="px-4 py-3 text-sm text-foreground">
          {liveCount} поз.
          {cancelledCount > 0 && (
            <span className="ml-1 text-xs text-zinc-500">· отм. {cancelledCount}</span>
          )}
          {voidedCount > 0 && (
            <span className="ml-1 text-xs text-rose-500">· сп. {voidedCount}</span>
          )}
        </td>
        <td className="px-4 py-3 text-sm font-semibold text-foreground">{formatCurrency(calcOrderDisplayTotal(order, servicePercent))}</td>
        <td className="px-4 py-3">
          <span className="text-xs text-muted-foreground">{waiter?.name.split(' ')[0] ?? '—'}</span>
        </td>
        <td className="px-4 py-3">
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <Clock className="size-3.5" />{getTimeSince(order.createdAt, order.status === 'done' ? order.closedAt : null)}
          </div>
        </td>
        <td className="px-4 py-3">
          <span className="text-xs text-muted-foreground">{order.paymentMethod ? PAYMENT_LABELS[order.paymentMethod] : '—'}</span>
        </td>
      </tr>
      {expanded && (
        <tr className="bg-muted/30">
          <td colSpan={8} className="px-6 py-4">
            <div className="space-y-1">
              <p className="text-xs font-semibold text-muted-foreground mb-2">Состав заказа:</p>
              {order.items.map((item, idx) => {
                const isCancelled = !!item.cancelledAt
                const isVoided = !isCancelled && voidedFlags[idx]
                const muted = isCancelled || isVoided
                return (
                  <div key={item.id ?? `${item.menuItemId}-${idx}`} className={`flex items-center justify-between text-sm max-w-md ${muted ? 'opacity-50' : ''}`}>
                    <span className={`text-foreground ${muted ? 'line-through' : ''}`}>
                      {item.name}
                      {isCancelled && item.cancelReason && (
                        <span className="ml-2 text-[11px] text-zinc-500 italic no-underline">· {item.cancelReason}</span>
                      )}
                      {isVoided && (
                        <span className="ml-2 text-[10px] font-medium px-1.5 py-0.5 rounded bg-red-50 text-red-600 no-underline">Списано</span>
                      )}
                    </span>
                    <span className={`text-muted-foreground ${muted ? 'line-through' : ''}`}>{item.unit && item.unit !== 'piece' ? formatQty(item.qty, item.unit) : `x ${item.qty}`} · {formatCurrency(calcLineTotal(item.price, item.qty, item.unit, item.unitSize))}</span>
                  </div>
                )
              })}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

const OrderRow = memo(OrderRowInner, (prev, next) => {
  if (prev.tablesData !== next.tablesData) return false
  if (prev.usersData !== next.usersData) return false
  if (prev.servicePercent !== next.servicePercent) return false
  if (prev.onOpen !== next.onOpen) return false
  if (prev.voids !== next.voids) return false
  return ordersEqualShallow(prev.order, next.order)
})

// Virtualized list for mobile order cards. Used when filtered.length > 50.
function VirtualOrderCards({ orders, tablesData, usersData, voidsByOrderId, servicePercent, onOpen }: {
  orders: Order[]
  tablesData: Table[]
  usersData: User[]
  voidsByOrderId: Map<string, OrderVoid[]>
  servicePercent?: number
  onOpen: (order: Order) => void
}) {
  const parentRef = useRef<HTMLDivElement>(null)
  const rowVirtualizer = useVirtualizer({
    count: orders.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 180,
    overscan: 5,
  })
  return (
    <div ref={parentRef} className="overflow-auto h-[calc(100vh-220px)]">
      <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
        {rowVirtualizer.getVirtualItems().map(v => {
          const order = orders[v.index]
          return (
            <div
              key={order.id}
              style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${v.start}px)`, paddingBottom: 12 }}
            >
              <OrderCard order={order} tablesData={tablesData} usersData={usersData} voids={voidsByOrderId.get(order.id)} servicePercent={servicePercent} onOpen={onOpen} />
            </div>
          )
        })}
      </div>
    </div>
  )
}

// Virtualized desktop rows. Replaces the <table> tbody when filtered.length > 50,
// using a CSS grid layout that mirrors the table columns.
function VirtualOrderRows({ orders, tablesData, usersData, voidsByOrderId, servicePercent, onOpen }: {
  orders: Order[]
  tablesData: Table[]
  usersData: User[]
  voidsByOrderId: Map<string, OrderVoid[]>
  servicePercent?: number
  onOpen: (order: Order) => void
}) {
  const parentRef = useRef<HTMLDivElement>(null)
  const rowVirtualizer = useVirtualizer({
    count: orders.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 52,
    overscan: 8,
  })
  const cols = 'grid-cols-[80px_140px_minmax(120px,1fr)_120px_120px_120px_120px_120px]'
  return (
    <div className="bg-card rounded-xl border border-border overflow-hidden">
      <div className={`grid ${cols} bg-muted/40 border-b border-border`}>
        {['#', 'Статус', 'Стол/Тип', 'Позиций', 'Сумма', 'Официант', 'Время', 'Оплата'].map((h) => (
          <div key={h} className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wide whitespace-nowrap">{h}</div>
        ))}
      </div>
      <div ref={parentRef} className="overflow-auto h-[calc(100vh-280px)]">
        <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
          {rowVirtualizer.getVirtualItems().map(v => {
            const order = orders[v.index]
            const table = order.tableId ? tablesData.find((t) => t.id === order.tableId) : null
            const waiter = order.waiterId ? usersData.find((u) => u.id === order.waiterId) : null
            const voids = voidsByOrderId.get(order.id)
            const voidedFlags = voidedItemFlags(order.items, voids)
            const liveCount = order.items.reduce((s, it, idx) => s + (!it.cancelledAt && !voidedFlags[idx] ? 1 : 0), 0)
            const cancelledCount = order.items.reduce((s, it) => s + (it.cancelledAt ? 1 : 0), 0)
            const voidedCount = voidedFlags.reduce((s, f, idx) => s + (f && !order.items[idx].cancelledAt ? 1 : 0), 0)
            return (
              <div
                key={order.id}
                onClick={() => onOpen(order)}
                style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${v.start}px)` }}
                className={`grid ${cols} border-b border-border hover:bg-muted/50 cursor-pointer transition-colors items-center`}
              >
                <div className="px-4 py-3"><span className="text-xs font-mono text-muted-foreground">#{order.orderNumber ?? order.id.slice(0, 8)}</span></div>
                <div className="px-4 py-3">
                  <span className={`inline-flex items-center px-2.5 py-1 rounded-md text-xs font-medium ${STATUS_STYLE[order.status]}`}>{ORDER_STATUS_LABELS[order.status]}</span>
                </div>
                <div className="px-4 py-3">
                  <div className="flex items-center gap-1.5">
                    {table
                      ? <><MapPin className="size-3.5 text-muted-foreground" />{table.name}</>
                      : <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium ${TYPE_BADGE_STYLE[order.type] ?? 'text-muted-foreground'}`}>{TYPE_LABELS[order.type]}</span>}
                  </div>
                </div>
                <div className="px-4 py-3 text-sm text-foreground">
                  {liveCount} поз.
                  {cancelledCount > 0 && <span className="ml-1 text-xs text-zinc-500">· отм. {cancelledCount}</span>}
                  {voidedCount > 0 && <span className="ml-1 text-xs text-rose-500">· сп. {voidedCount}</span>}
                </div>
                <div className="px-4 py-3 text-sm font-semibold text-foreground">{formatCurrency(calcOrderDisplayTotal(order, servicePercent))}</div>
                <div className="px-4 py-3"><span className="text-xs text-muted-foreground">{waiter?.name.split(' ')[0] ?? '—'}</span></div>
                <div className="px-4 py-3">
                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Clock className="size-3.5" />{getTimeSince(order.createdAt, order.status === 'done' ? order.closedAt : null)}
                  </div>
                </div>
                <div className="px-4 py-3"><span className="text-xs text-muted-foreground">{order.paymentMethod ? PAYMENT_LABELS[order.paymentMethod] : '—'}</span></div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function OrdersPage() {
  const { canAccessRoles, canDo, user, restaurant } = useAuth()
  const servicePercent = restaurant?.servicePercent
  const [orders, setOrders] = useState<Order[]>([])
  // Карта order_id → voids — нужна, чтобы счётчик «Позиций» в карточке/строке
  // не включал воиднутые блюда (они не помечены cancelledAt). Грузим одним
  // батчем после fetchOrders, чтобы не плодить N+1 запросов.
  const [voidsByOrderId, setVoidsByOrderId] = useState<Map<string, OrderVoid[]>>(() => new Map())
  const [tablesData, setTablesData] = useState<Table[]>([])
  const [usersData, setUsersData] = useState<User[]>([])
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = usePersistedState<string>('restos.orders.statusFilter', 'all')
  const [typeFilter, setTypeFilter] = usePersistedState<'all' | 'hall' | 'togo'>('restos.orders.typeFilter', 'all')
  // Список «Заказы» — всегда только за сегодня. Исторические периоды (вчера, неделя,
  // месяц) доступны через диалог экспорта в Excel — для owner/manager. Это убирает
  // тяжёлые исторические запросы из основного потока и держит страницу лёгкой.
  const canExportHistory = canAccessRoles(['owner', 'manager'])
  const [exportDialogOpen, setExportDialogOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [orderDialogOpen, setOrderDialogOpen] = useState(false)
  const [actionsDialogOpen, setActionsDialogOpen] = useState(false)
  const [addItemsOrderId, setAddItemsOrderId] = useState<string | null>(null)
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null)

  const refetchAll = useCallback(async () => {
    const [o, t, u] = await Promise.all([
      fetchOrders({ from: startOfToday(), to: endOfDay(new Date()), slim: true }),
      fetchTables(),
      fetchUsers(),
    ])
    setOrders(o)
    setTablesData(t)
    setUsersData(u)
    // Voids — отдельным батчем после фактической загрузки заказов.
    const ids = o.map(x => x.id)
    if (ids.length > 0) {
      fetchVoidsForOrders(ids).then(setVoidsByOrderId).catch(() => setVoidsByOrderId(new Map()))
    } else {
      setVoidsByOrderId(new Map())
    }
  }, [])

  useEffect(() => {
    // First clean up any orphan served orders, then refetch
    setLoading(true)
    cleanupOrphanOrders()
      .then((n) => { if (n > 0) console.log(`Auto-closed ${n} orphan orders`) })
      .catch(() => {})
      .finally(() => refetchAll().finally(() => setLoading(false)))
  }, [refetchAll])

  // Список — всегда «сегодня», поэтому realtime/sync и polling работают безусловно.
  useDataSync(['orders', 'tables', 'users'], () => { refetchAll().catch(console.error) })

  // Polling каждые 8с только в local-mode. Пауза при скрытой вкладке.
  // Возврат во вкладку → один немедленный refetch.
  useEffect(() => {
    let isLocal = false
    try { isLocal = localStorage.getItem('restos-sync-mode') === 'local' } catch {}
    if (!isLocal) return
    const tick = () => { if (!document.hidden) refetchAll().catch(console.error) }
    const interval = setInterval(tick, 20000)
    const onVisible = () => { if (!document.hidden) refetchAll().catch(console.error) }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [refetchAll])

  // Gated by orders.view_others. Default for waiter role is OFF (sees own
  // orders only), can be flipped on in Settings → Users → permissions matrix.
  // Manager/owner/cashier have it on by default.
  const canViewOthers = canDo('orders.view_others')
  const visibleOrders = useMemo(
    () => canViewOthers ? orders : orders.filter(o => o.waiterId === user?.id),
    [orders, canViewOthers, user?.id],
  )

  // Карта столов для быстрого lookup по id (нужна в сортировке и фильтрации).
  const tablesById = useMemo(() => {
    const m = new Map<string, Table>()
    for (const t of tablesData) m.set(t.id, t)
    return m
  }, [tablesData])

  const filtered = useMemo(() => {
    const q = search.toLowerCase()
    return visibleOrders
      .filter((o) => {
        // «Все» = только активные. Закрытые и отменённые заказы видны на своих вкладках.
        if (statusFilter === 'all') {
          if (o.status === 'done' || o.status === 'cancelled') return false
        } else if (o.status !== statusFilter) return false
        if (typeFilter === 'hall' && isTogo(o.type)) return false
        if (typeFilter === 'togo' && !isTogo(o.type)) return false
        if (search) {
          const table = o.tableId ? tablesById.get(o.tableId) : null
          if (!(o.id.includes(search) || (table?.name ?? '').toLowerCase().includes(q))) return false
        }
        return true
      })
      // Сортируем строго по времени создания — самые свежие сверху.
      // Раньше тут была многоуровневая сортировка (status priority → table
      // number → createdAt) для kitchen-display порядка, но на странице
      // списка заказов это путало кассира — фильтр по статусу уже отделяет
      // активные от закрытых.
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
  }, [visibleOrders, statusFilter, typeFilter, search])

  const counts = useMemo(() => ({
    all: visibleOrders.filter(o => o.status !== 'done' && o.status !== 'cancelled').length,
    new: visibleOrders.filter(o => o.status === 'new').length,
    cooking: visibleOrders.filter(o => o.status === 'cooking').length,
    ready: visibleOrders.filter(o => o.status === 'ready').length,
    served: visibleOrders.filter(o => o.status === 'served').length,
    done: visibleOrders.filter(o => o.status === 'done').length,
    cancelled: visibleOrders.filter(o => o.status === 'cancelled').length,
  }), [visibleOrders])

  const typeCounts = useMemo(() => ({
    all: visibleOrders.length,
    hall: visibleOrders.filter(o => !isTogo(o.type)).length,
    togo: visibleOrders.filter(o => isTogo(o.type)).length,
  }), [visibleOrders])

  // Скрываем таб «Подано» для owner и cashier — они не управляют этим статусом.
  // Waiter и manager видят его как раньше (это их рабочий сигнал).
  const visibleStatusFilter = useMemo(() => {
    const hideServed = user?.role === 'owner' || user?.role === 'cashier'
    return hideServed ? STATUS_FILTER.filter(s => s.value !== 'served') : STATUS_FILTER
  }, [user?.role])

  // Если ранее persisted statusFilter был 'served' и роль теперь без него — спадаем на 'all'.
  useEffect(() => {
    if (statusFilter === 'served' && !visibleStatusFilter.some(s => s.value === 'served')) {
      setStatusFilter('all')
    }
  }, [statusFilter, visibleStatusFilter, setStatusFilter])

  // useCallback — стабильная ссылка для memo() OrderRow/OrderCard.
  const handleOpenOrder = useCallback((order: Order) => {
    setSelectedOrder(order)
    setActionsDialogOpen(true)
  }, [])

  function handleOrderAction(action: string, data?: OrderActionData) {
    if (!selectedOrder) return
    const orderId = selectedOrder.id

    if (action === 'add_items') {
      // Keep selectedOrder so we know which order to add items to
      setAddItemsOrderId(orderId)
      setActionsDialogOpen(false)
      return
    }

    if (action === 'start_cooking') {
      updateOrderStatus(orderId, 'cooking')
        .then(() => toast.success('Заказ отправлен на кухню'))
        .catch(() => toast.error('Ошибка обновления заказа'))
      setOrders((prev) =>
        prev.map((o) => (o.id === orderId ? { ...o, status: 'cooking' as OrderStatus } : o))
      )
      setActionsDialogOpen(false)
      setSelectedOrder(null)
    } else if (action === 'mark_ready') {
      const readyAt = new Date().toISOString()
      updateOrderStatus(orderId, 'ready', { ready_at: readyAt })
        .then(() => toast.success('Заказ готов к выдаче'))
        .catch(() => toast.error('Ошибка обновления заказа'))
      setOrders((prev) =>
        prev.map((o) => (o.id === orderId ? { ...o, status: 'ready' as OrderStatus, readyAt } : o))
      )
      setActionsDialogOpen(false)
      setSelectedOrder(null)
    } else if (action === 'close_and_pay') {
      const totalAmount = data?.totalWithService ?? selectedOrder.total
      const cogs = data?.cogs ?? selectedOrder.items.reduce((s, i) => s + calcLineCogs(i.cogs || 0, i.qty, i.unit, i.unitSize), 0)
      closeOrderWithPayment(
        orderId,
        data?.paymentMethod ?? 'cash',
        selectedOrder.tableId ?? null,
        selectedOrder.total,
        cogs,
        user?.id,
        data?.accountId,
        data?.accountName,
        data?.servicePercent,
        data?.serviceAmount,
        data?.totalWithService,
        data?.tipAmount,
        data?.discountAmount,
        data?.discountType,
        data?.discountValue,
        data?.discountReason,
        data?.payments,
      )
        .then(() => toast.success('Заказ оплачен и закрыт'))
        .catch((e) => toast.error(`Ошибка закрытия заказа: ${e?.message ?? ''}`))
      const closedAt = new Date().toISOString()
      setOrders((prev) =>
        prev.map((o) =>
          o.id === orderId
            ? { ...o, status: 'done' as OrderStatus, paymentMethod: data?.paymentMethod, closedAt }
            : o
        )
      )
      // Do NOT close dialog — let receipt screen show
    } else if (action === 'cancel') {
      deleteOrder(orderId)
        .then(() => toast.success('Заказ отменён'))
        .catch(() => toast.error('Ошибка отмены заказа'))
      setOrders((prev) => prev.filter((o) => o.id !== orderId))
      setActionsDialogOpen(false)
      setSelectedOrder(null)
    } else if (action === 'reopen') {
      reopenOrder(orderId)
        .then(() => {
          toast.success('Заказ открыт для редактирования')
          return refetchAll()
        })
        .catch(e => toast.error(e instanceof Error ? e.message : 'Ошибка reopen'))
      setActionsDialogOpen(false)
      setSelectedOrder(null)
    }
  }


  return (
    <div className="p-4 md:p-6 space-y-4 md:space-y-5">
      {/* Sticky header bar (title + filters) — pinned on all viewports */}
      <div className="sticky top-0 z-20 -mx-4 -mt-4 px-4 pt-4 pb-3 md:-mx-6 md:-mt-6 md:px-6 md:pt-6 md:pb-4 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 border-b border-border space-y-3 md:space-y-4 mb-2 md:mb-3">
        {/* Header — hidden on mobile (bottom nav already shows current page) */}
        <div className="hidden sm:flex items-start sm:items-center justify-between gap-3 flex-col sm:flex-row">
          <div>
            <h1 className="text-xl font-bold text-foreground">Заказы</h1>
            <p className="text-muted-foreground text-sm mt-0.5">Все заказы за сегодня</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={async () => {
                if (canExportHistory) {
                  setExportDialogOpen(true)
                  return
                }
                if (filtered.length === 0) {
                  toast.info('Нет заказов в текущем фильтре')
                  return
                }
                try {
                  // Подгружаем voids одним батч-запросом — без них экспорт
                  // считает воиднутые позиции как живые.
                  const voidsByOrderId = await fetchVoidsForOrders(filtered.map(o => o.id)).catch(() => new Map())
                  exportOrdersToXlsx(filtered, {
                    tables: tablesData,
                    users: usersData,
                    voidsByOrderId,
                    filenameSuffix: 'today',
                  })
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : 'Ошибка экспорта')
                }
              }}
              className="hidden sm:inline-flex items-center gap-2 bg-card border border-border text-foreground px-3 py-2.5 rounded-lg text-sm font-medium hover:bg-muted transition-colors justify-center"
              title={canExportHistory ? 'Выгрузить заказы за выбранный период' : 'Экспорт текущего списка в Excel (с учётом фильтров)'}
            >
              <FileDown className="size-4" />
              Excel
            </button>
            {canAccessRoles(['manager', 'waiter', 'cashier']) && (
              <button
                onClick={() => setOrderDialogOpen(true)}
                className="hidden sm:flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2.5 rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors justify-center"
              >
                <Plus className="size-4" />
                Новый заказ
              </button>
            )}
          </div>
        </div>

        {/* Filters */}
        <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative">
          <Search className="size-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            placeholder="Поиск по стол, #заказ..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 pr-4 py-2.5 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30 w-full sm:w-56"
          />
        </div>
        <div className="flex items-center gap-1.5 bg-card border border-border rounded-lg p-1 overflow-x-auto">
          {visibleStatusFilter.map((f) => (
            <button
              key={f.value}
              onClick={() => setStatusFilter(f.value)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                statusFilter === f.value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {f.label} ({counts[f.value as keyof typeof counts]})
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1.5 bg-card border border-border rounded-lg p-1 overflow-x-auto">
          {TYPE_FILTER.map((f) => (
            <button
              key={f.value}
              onClick={() => setTypeFilter(f.value)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                typeFilter === f.value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {f.label} ({typeCounts[f.value]})
            </button>
          ))}
        </div>
        </div>
      </div>

      {/* Mobile: Card view */}
      <div className="md:hidden">
        {loading && orders.length === 0 ? (
          <div className="space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="bg-card rounded-xl border border-border p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="h-5 w-20 rounded bg-zinc-200 dark:bg-zinc-800 animate-pulse" />
                  <div className="h-3 w-12 rounded bg-zinc-200 dark:bg-zinc-800 animate-pulse" />
                </div>
                <div className="flex items-center justify-between">
                  <div className="h-4 w-24 rounded bg-zinc-200 dark:bg-zinc-800 animate-pulse" />
                  <div className="h-4 w-16 rounded bg-zinc-200 dark:bg-zinc-800 animate-pulse" />
                </div>
                <div className="h-3 w-1/2 rounded bg-zinc-200 dark:bg-zinc-800 animate-pulse" />
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <p className="text-muted-foreground text-sm text-center py-10">Заказов не найдено</p>
        ) : filtered.length > 50 ? (
          <VirtualOrderCards
            orders={filtered}
            tablesData={tablesData}
            usersData={usersData}
            voidsByOrderId={voidsByOrderId}
            servicePercent={servicePercent}
            onOpen={handleOpenOrder}
          />
        ) : (
          <div className="space-y-3">
            {filtered.map((order) => (
              <OrderCard key={order.id} order={order} tablesData={tablesData} usersData={usersData} voids={voidsByOrderId.get(order.id)} servicePercent={servicePercent} onOpen={handleOpenOrder} />
            ))}
          </div>
        )}
      </div>

      {/* Desktop: Table view (virtualized when filtered.length > 50) */}
      {filtered.length > 50 ? (
        <div className="hidden md:block">
          <VirtualOrderRows
            orders={filtered}
            tablesData={tablesData}
            usersData={usersData}
            voidsByOrderId={voidsByOrderId}
            servicePercent={servicePercent}
            onOpen={handleOpenOrder}
          />
        </div>
      ) : (
      <div className="hidden md:block bg-card rounded-xl border border-border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                {['#', 'Статус', 'Стол/Тип', 'Позиций', 'Сумма', 'Официант', 'Время', 'Оплата'].map((h) => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wide whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((order) => (
                <OrderRow key={order.id} order={order} tablesData={tablesData} usersData={usersData} voids={voidsByOrderId.get(order.id)} servicePercent={servicePercent} onOpen={handleOpenOrder} />
              ))}
              {filtered.length === 0 && (
                loading && orders.length === 0 ? (
                  Array.from({ length: 5 }).map((_, i) => (
                    <tr key={i} className="border-b border-border">
                      {Array.from({ length: 8 }).map((__, j) => (
                        <td key={j} className="px-4 py-3">
                          <div className="h-4 rounded bg-zinc-200 dark:bg-zinc-800 animate-pulse" />
                        </td>
                      ))}
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={8} className="px-4 py-10 text-center text-muted-foreground text-sm">
                      Заказов не найдено
                    </td>
                  </tr>
                )
              )}
            </tbody>
          </table>
        </div>
      </div>
      )}

      <CreateOrderDialog
        open={orderDialogOpen}
        onOpenChange={setOrderDialogOpen}
        onSubmitted={() => { refetchAll() }}
      />

      <OrderActionsDialog
        order={selectedOrder}
        open={actionsDialogOpen}
        onOpenChange={setActionsDialogOpen}
        onAction={handleOrderAction}
        onItemsChanged={() => { refetchAll().catch(console.error) }}
      />

      {addItemsOrderId && (
        <AddItemsDialog
          orderId={addItemsOrderId}
          open={!!addItemsOrderId}
          onClose={() => setAddItemsOrderId(null)}
          onDone={() => {
            setAddItemsOrderId(null)
            toast.success('Блюда добавлены к заказу')
            refetchAll().catch(() => {})
          }}
        />
      )}

      <ExportOrdersDialog
        open={exportDialogOpen}
        onOpenChange={setExportDialogOpen}
        tables={tablesData}
        users={usersData}
      />
    </div>
  )
}
