'use client'

import { useState, useEffect, useCallback, useMemo, memo } from 'react'
import { useAuth } from '@/lib/auth-store'
import { usePersistedState } from '@/hooks/use-persisted-state'

import { formatCurrency, getTimeSince, calcLineCogs, calcOrderDisplayTotal, startOfToday } from '@/lib/helpers'
import {
  STATUS_LABELS,
  ORDER_STATUS_LABELS,
  type Table,
  type TableStatus,
  type PaymentMethod,
  type Order,
  type User,
  type Zone,
  type MenuItem,
} from '@/lib/types'
import {
  fetchTables,
  fetchZones,
  fetchOrders,
  fetchUsers,
  updateTableStatus,
  createZone,
  updateZone,
  deleteZone,
  createTable,
  updateTableData,
  deleteTable,
  assignWaiter,
  updateOrderStatus,
  deleteOrder,
  closeOrderWithPayment,
  fetchMenuItems,
  mergeTables,
  unmergeTables,
} from '@/lib/queries'
import { Users, Clock, AlertCircle, Plus, Pencil } from 'lucide-react'
import { useDataSync } from '@/hooks/use-data-sync'
import { TableDetailSheet } from '@/components/dialogs/table-detail-sheet'
import { CreateOrderDialog } from '@/components/dialogs/create-order-dialog'
import { OrderActionsDialog, type OrderActionData } from '@/components/dialogs/order-actions-dialog'
import { ManageZoneDialog } from '@/components/dialogs/manage-zone-dialog'
import { ManageTableDialog } from '@/components/dialogs/manage-table-dialog'
import { toast } from 'sonner'

const STATUS_STYLE: Record<TableStatus, { bg: string; border: string; dot: string; label: string }> = {
  free: { bg: 'bg-emerald-50 hover:bg-emerald-100', border: 'border-emerald-200', dot: 'bg-emerald-500', label: 'text-emerald-700' },
  occupied: { bg: 'bg-red-50 hover:bg-red-100', border: 'border-red-200', dot: 'bg-red-500', label: 'text-red-700' },
  reserved: { bg: 'bg-blue-50 hover:bg-blue-100', border: 'border-blue-200', dot: 'bg-blue-500', label: 'text-blue-700' },
  bill_requested: { bg: 'bg-amber-50 hover:bg-amber-100', border: 'border-amber-300', dot: 'bg-amber-500', label: 'text-amber-700' },
}

interface TableCardProps {
  table: Table
  tableOrders: Order[]
  fallbackOrder: Order | null
  waiter: User | null
  servicePercent?: number
  onClick?: () => void
  isSelected?: boolean
  isMerged?: boolean
  hideReadyHighlight?: boolean
}

function TableCardInner({ table, tableOrders, fallbackOrder, waiter, servicePercent, onClick, isSelected, isMerged, hideReadyHighlight }: TableCardProps) {
  const style = STATUS_STYLE[table.status] ?? STATUS_STYLE.free
  const openOrders = tableOrders
  // Primary order shown on the card. With multiple tabs we show the first by createdAt
  // but expose the count separately so users know there's more.
  // IMPORTANT: never show stale order info on a free table — the legacy
  // current_order_id pointer may still link to a paid order, but a free
  // table card must show nothing besides «Свободен».
  const order = table.status === 'free'
    ? null
    : openOrders.length > 0
      ? openOrders[0]
      : fallbackOrder
  const tabsCount = openOrders.length
  const tabsTotal = openOrders.reduce((s, o) => s + calcOrderDisplayTotal(o, servicePercent), 0)
  const totalItems = openOrders.reduce((s, o) => s + o.items.length, 0)
  const timeSince = table.openedAt ? getTimeSince(table.openedAt) : null
  const isLongSitting = table.openedAt
    ? (Date.now() - new Date(table.openedAt).getTime()) > 2 * 60 * 60 * 1000
    : false
  const hasReadyOrder = openOrders.some(o => o.status === 'ready')
  const isReadyForPickup = hasReadyOrder && !hideReadyHighlight
  // Для owner/cashier — спокойный информационный значок «готово к подаче»: видим сигнал,
  // но без бейджа «К выдаче!», ring-pulse и подмены статуса. Управление статусом — у официанта.
  const showQuietReadyDot = hasReadyOrder && hideReadyHighlight

  return (
    <div
      onClick={onClick}
      className={`relative rounded-xl border-2 p-4 md:p-4 cursor-pointer transition-colors active:scale-[0.97] flex flex-col min-h-[140px] ${style.bg} ${style.border} ${
        isSelected ? 'ring-2 ring-amber-500 ring-offset-2 shadow-lg' :
        isReadyForPickup ? 'ring-2 ring-emerald-400 ring-offset-1' :
        table.status === 'bill_requested' ? 'ring-2 ring-amber-400 ring-offset-1' : ''
      }`}
    >
      {/* Ready badge */}
      {isReadyForPickup && (
        <div className="absolute -top-2 -right-2 bg-emerald-500 text-white text-[10px] font-bold px-2 py-0.5 rounded-full shadow-lg">
          К выдаче!
        </div>
      )}
      {/* Merged badge */}
      {isMerged && !isReadyForPickup && (
        <div className="absolute -top-2 -right-2 bg-amber-500 text-white text-[10px] font-bold px-2 py-0.5 rounded-full shadow-lg">
          ⊕
        </div>
      )}
      {/* Тихий значок «готово к подаче» — для owner/cashier вместо громкого бейджа */}
      {showQuietReadyDot && !isMerged && (
        <span
          title="Есть готовое блюдо — официант скоро заберёт"
          className="absolute -top-1 -right-1 size-2.5 rounded-full bg-emerald-500 ring-2 ring-card"
        />
      )}

      {/* Status dot */}
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center gap-2">
          <div className={`size-2.5 rounded-full ${isReadyForPickup ? 'bg-emerald-500' : style.dot}`} />
          <span className="text-sm font-semibold text-foreground">{table.name}</span>
        </div>
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <Users className="size-3" />
          {table.capacity}
        </div>
      </div>

      {/* Status label */}
      <p className={`text-sm font-semibold ${isReadyForPickup ? 'text-emerald-600' : style.label}`}>
        {isReadyForPickup ? '🍽 К выдаче!' : STATUS_LABELS[table.status]}
        {!isReadyForPickup && table.status === 'bill_requested' && ' !!'}
      </p>

      {/* Multi-tab badge — top-right corner when 2+ open tabs */}
      {tabsCount >= 2 && !isReadyForPickup && !isMerged && (
        <div className="absolute -top-2 -right-2 bg-purple-600 text-white text-[10px] font-bold px-2 py-0.5 rounded-full shadow-lg">
          {tabsCount} группы
        </div>
      )}

      {/* Order info */}
      {order && (
        <div className="mt-2 space-y-1">
          <p className="text-sm text-foreground font-bold">{formatCurrency(tabsCount >= 2 ? tabsTotal : calcOrderDisplayTotal(order, servicePercent))}</p>
          <p className="text-xs text-muted-foreground">
            {tabsCount >= 2
              ? `${tabsCount} групп · ${totalItems} поз.`
              : hideReadyHighlight && (order.status === 'ready' || order.status === 'served')
                ? `${order.items.length} поз.`
                : `${order.items.length} поз. · ${ORDER_STATUS_LABELS[order.status]}`}
          </p>
          {/* Auto-ready countdown */}
          {order.status === 'cooking' && order.expectedReadyAt && (() => {
            const diffMs = new Date(order.expectedReadyAt).getTime() - Date.now()
            const diffMin = Math.ceil(diffMs / 60000)
            if (diffMin > 0) {
              return (
                <p className="text-xs text-blue-600 font-semibold flex items-center gap-1">
                  <Clock className="size-3" />Готов через {diffMin} мин
                </p>
              )
            }
            return (
              <p className="text-xs text-emerald-600 font-bold flex items-center gap-1">
                🍽️ Можно подавать!
              </p>
            )
          })()}
        </div>
      )}

      {/* Time */}
      {timeSince && (
        <div className={`flex items-center gap-1 mt-2 text-xs ${isLongSitting ? 'text-destructive font-semibold' : 'text-muted-foreground'}`}>
          <Clock className="size-3" />
          {timeSince}
          {isLongSitting && <AlertCircle className="size-3 ml-0.5" />}
        </div>
      )}

      {/* Waiter — only when table is actually occupied (defensive: stale waiter_id may persist after free) */}
      {waiter && table.status !== 'free' && order && (
        <p className="mt-1 text-xs text-muted-foreground truncate">{waiter.name.split(' ')[0]}</p>
      )}
    </div>
  )
}

// Сигнатура заказов для мемоизации: меняется только когда меняются поля,
// которые действительно отрисовываются на карточке (статус, total, items count, expected ready).
function ordersSignature(orders: Order[]): string {
  return orders.map(o => `${o.id}:${o.status}:${o.total}:${o.items.length}:${o.expectedReadyAt ?? ''}`).join('|')
}

const EMPTY_ORDERS: Order[] = []

const TableCard = memo(TableCardInner, (prev, next) => {
  if (prev.table !== next.table) return false
  if (prev.fallbackOrder !== next.fallbackOrder) return false
  if (prev.waiter !== next.waiter) return false
  if (prev.onClick !== next.onClick) return false
  if (prev.isSelected !== next.isSelected) return false
  if (prev.isMerged !== next.isMerged) return false
  if (prev.hideReadyHighlight !== next.hideReadyHighlight) return false
  if (prev.servicePercent !== next.servicePercent) return false
  if (prev.tableOrders.length !== next.tableOrders.length) return false
  return ordersSignature(prev.tableOrders) === ordersSignature(next.tableOrders)
})

export default function TableMapPage() {
  const { canAccessRoles, canDo, user, restaurant } = useAuth()
  const servicePercent = restaurant?.servicePercent
  const [activeZone, setActiveZone] = usePersistedState<string>('restos.tableMap.activeZone', 'all')
  const [tables, setTables] = useState<Table[]>([])
  const [zonesData, setZonesData] = useState<Zone[]>([])
  const [ordersData, setOrdersData] = useState<Order[]>([])
  const [usersData, setUsersData] = useState<User[]>([])
  const [menuItemsData, setMenuItemsData] = useState<MenuItem[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedTable, setSelectedTable] = useState<Table | null>(null)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [orderDialogOpen, setOrderDialogOpen] = useState(false)

  // Zone/Table dialog state
  const [zoneDialogOpen, setZoneDialogOpen] = useState(false)
  const [editingZone, setEditingZone] = useState<Zone | undefined>(undefined)
  const [tableDialogOpen, setTableDialogOpen] = useState(false)
  const [editingTable, setEditingTable] = useState<Table | undefined>(undefined)

  // Order actions dialog
  const [orderActionsOpen, setOrderActionsOpen] = useState(false)
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null)

  // Table merge mode
  const [mergeMode, setMergeMode] = useState(false)
  const [mergePrimaryId, setMergePrimaryId] = useState<string | null>(null)

  // Режим редактирования столов (только cashier/owner, только md+).
  // ON → клик по столу открывает ManageTableDialog вместо POS-редиректа/листа.
  const [editTablesMode, setEditTablesMode] = useState(false)
  const canManageTables = canAccessRoles(['cashier', 'owner'])

  // Default label suggestion fed to CreateOrderDialog when user opens a new tab
  // on an already-occupied table (e.g. "Группа 2"). Cleared once consumed.
  const [pendingTabLabel, setPendingTabLabel] = useState<string | null>(null)

  // Action-based: any user with the explicit `tables.edit` permission can
  // create/edit tables and zones — not only the manager role.
  const canEditTables = canDo('tables.edit') || canAccessRoles(['manager', 'owner'])

  // Owner/cashier видят занятый стол как «Занят» — без зелёного бейджа «К выдаче!».
  // Этот сигнал нужен официантам, а не управлению/кассе.
  const hideReadyHighlight = user?.role === 'owner' || user?.role === 'cashier'

  // Группируем открытые заказы по столам и сортируем — один раз на refetch,
  // чтобы карточки могли мемоизироваться по референсу массива.
  const ordersByTable = useMemo(() => {
    const map = new Map<string, Order[]>()
    for (const o of ordersData) {
      if (!o.tableId || o.status === 'done' || o.status === 'cancelled') continue
      const arr = map.get(o.tableId)
      if (arr) arr.push(o)
      else map.set(o.tableId, [o])
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    }
    return map
  }, [ordersData])

  const usersById = useMemo(() => {
    const map = new Map<string, User>()
    for (const u of usersData) map.set(u.id, u)
    return map
  }, [usersData])

  const refetchAll = useCallback(async () => {
    const [t, z, o, u, mi] = await Promise.all([
      fetchTables(),
      fetchZones(),
      fetchOrders({ from: startOfToday(), slim: true }),
      fetchUsers(),
      fetchMenuItems(),
    ])
    // Добиваем заказы открытых столов, которые не попали в окно «сегодня»
    // (стол открыт более суток назад). Без этого карточка такого стола показала бы 0 заказов.
    const haveIds = new Set(o.map(x => x.id))
    const missingIds = Array.from(new Set(
      t.map(tb => tb.currentOrderId).filter((id): id is string => !!id && !haveIds.has(id))
    ))
    let merged = o
    if (missingIds.length > 0) {
      try {
        const extra = await fetchOrders({ ids: missingIds })
        merged = [...o, ...extra]
      } catch (e) {
        console.error('[table-map] догрузка заказов открытых столов:', e)
      }
    }
    setTables(t)
    setZonesData(z)
    setOrdersData(merged)
    setUsersData(u)
    setMenuItemsData(mi)
  }, [])

  useEffect(() => {
    // First sweep any stuck tables (paid but not freed because of an old enum
    // bug on the server), THEN refetch so the UI shows the corrected state.
    import('@/lib/queries').then(({ cleanupStuckTables }) =>
      cleanupStuckTables().catch(() => 0)
    ).finally(() => {
      refetchAll().finally(() => setLoading(false))
    })
  }, [refetchAll])

  useDataSync(['tables', 'zones', 'orders', 'order_items', 'users', 'menu_items', 'reservations'], () => { refetchAll().catch(console.error) })

  // Fetch on mount, and poll every 10s ONLY in local mode (Desktop app / Local DB)
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

  // If persisted zone no longer exists, fall back to 'all'
  useEffect(() => {
    if (activeZone !== 'all' && zonesData.length > 0 && !zonesData.some(z => z.id === activeZone)) {
      setActiveZone('all')
    }
  }, [activeZone, zonesData, setActiveZone])

  // Gated by orders.view_others. When OFF (default for waiter), they see only
  // free tables + tables assigned to them. When ON (manager/cashier or any
  // waiter explicitly granted in matrix) — full hall view.
  const canViewOthers = canDo('orders.view_others')
  const visibleTables = canViewOthers
    ? tables
    : tables.filter(t => t.status === 'free' || t.waiterId === user?.id)

  const zones = [{ id: 'all', name: 'Все зоны' }, ...zonesData]
  const filtered = (activeZone === 'all' ? visibleTables : visibleTables.filter((t) => t.zone === activeZone))
    .slice()
    .sort((a, b) => {
      const an = parseInt(a.name, 10)
      const bn = parseInt(b.name, 10)
      if (!isNaN(an) && !isNaN(bn) && an !== bn) return an - bn
      return a.name.localeCompare(b.name, undefined, { numeric: true })
    })

  const stats = {
    free: visibleTables.filter(t => t.status === 'free').length,
    occupied: visibleTables.filter(t => t.status === 'occupied').length,
    bill: visibleTables.filter(t => t.status === 'bill_requested').length,
    reserved: visibleTables.filter(t => t.status === 'reserved').length,
  }

  function handleTableClick(table: Table) {
    // Режим редактирования столов: открываем ManageTableDialog,
    // минуя POS-редирект и TableDetailSheet.
    if (editTablesMode && canManageTables) {
      setEditingTable(table)
      setTableDialogOpen(true)
      return
    }
    // Merge mode
    if (mergeMode) {
      if (!mergePrimaryId) {
        // First click — select primary table
        setMergePrimaryId(table.id)
        toast.info(`Стол "${table.name}" выбран. Теперь выберите второй стол`)
        return
      }
      if (table.id === mergePrimaryId) {
        // Clicked same table — deselect
        setMergePrimaryId(null)
        toast.info('Выберите первый стол')
        return
      }
      // Second click — merge!
      mergeTables(mergePrimaryId, table.id)
        .then(() => {
          toast.success(`"${tables.find(t => t.id === mergePrimaryId)?.name}" + "${table.name}" объединены`)
          setMergeMode(false)
          setMergePrimaryId(null)
          refetchAll()
        })
        .catch((e) => toast.error(e instanceof Error ? e.message : 'Ошибка объединения'))
      return
    }
    // Любой клик по столу — открываем TableDetailSheet. Раньше для
    // cashier/owner/manager на свободном столе мы делали navigate в POS
    // (?tableId=), но это уносило кассира со страницы карты зала, ломая
    // обзор остальных столов. Теперь POS-flow начинается из самого POS
    // (там есть свой table-picker). Tables page остаётся «оператив-картой».
    setSelectedTable(table)
    setSheetOpen(true)
  }

  function handleSheetAction(action: string, tableId: string, data?: { orderId?: string; paymentMethod?: PaymentMethod; editTable?: boolean; assignWaiterId?: string; accountId?: string; accountName?: string; servicePercent?: number; serviceAmount?: number; totalWithService?: number }) {
    // Resolve which order this action targets. Prefer the explicit orderId from the
    // sheet (multi-tab aware); fall back to the legacy table.currentOrderId.
    const resolveOrderId = (): string | null => {
      if (data?.orderId) return data.orderId
      const t = tables.find(x => x.id === tableId)
      return t?.currentOrderId ?? null
    }
    if (action === 'new_tab') {
      // Open the create-order dialog (uses preselectedTable even if the table
      // is already occupied) and pre-suggest a "Группа N" label.
      const idx = ordersData.filter(o => o.tableId === tableId && o.status !== 'done' && o.status !== 'cancelled').length + 1
      setPendingTabLabel(`Группа ${idx}`)
      setSheetOpen(false)
      setOrderDialogOpen(true)
    } else if (action === 'create_order') {
      setPendingTabLabel(null)
      setSheetOpen(false)
      setOrderDialogOpen(true)
    } else if (action === 'request_bill') {
      const orderId = resolveOrderId()
      if (!orderId) {
        toast.error('Нет активного заказа на этом столе')
        return
      }
      const order = ordersData.find(o => o.id === orderId)
      if (!order || order.status === 'done') {
        toast.error('Заказ уже закрыт. Освобождаем стол...')
        updateTableStatus(tableId, 'free', { current_order_id: null, waiter_id: null, opened_at: null }).catch(console.error)
        setTables((prev) => prev.map((t) => (t.id === tableId ? { ...t, status: 'free' as TableStatus, currentOrderId: undefined } : t)))
        return
      }
      // Multi-tab: flag the SPECIFIC tab (order) as bill_requested so a sibling
      // tab on the same table can keep cooking. Also flip the table-level
      // status for backwards-compatible UI (legend, badges).
      updateOrderStatus(orderId, 'bill_requested').catch(console.error)
      updateTableStatus(tableId, 'bill_requested').catch(console.error)
      setOrdersData(prev => prev.map(o => o.id === orderId ? { ...o, status: 'bill_requested' as const } : o))
      setTables((prev) =>
        prev.map((t) => (t.id === tableId ? { ...t, status: 'bill_requested' as TableStatus } : t))
      )
      setSelectedTable((prev) => (prev?.id === tableId ? { ...prev, status: 'bill_requested' as TableStatus } : prev))
      toast.success('Счёт запрошен')
    } else if (action === 'mark_served') {
      const orderId = resolveOrderId()
      if (orderId) {
        updateOrderStatus(orderId, 'served').catch(console.error)
        setOrdersData(prev => prev.map(o => o.id === orderId ? { ...o, status: 'served' as const } : o))
      }
      setSheetOpen(false)
      setSelectedTable(null)
      toast.success('Блюда поданы гостю')
    } else if (action === 'close_and_pay') {
      const orderId = resolveOrderId()
      if (!orderId) {
        toast.error('Нет активного заказа')
        return
      }
      const order = ordersData.find(o => o.id === orderId)
      if (!order) {
        toast.error('Заказ не найден')
        return
      }
      const cogs = order.items.reduce((s, i) => s + calcLineCogs(i.cogs || 0, i.qty, i.unit, i.unitSize), 0)
      closeOrderWithPayment(
        order.id,
        data?.paymentMethod || 'cash',
        tableId,
        order.total,
        cogs,
        user?.id,
        data?.accountId,
        data?.accountName,
        data?.servicePercent,
        data?.serviceAmount,
        data?.totalWithService,
      )
        .then(() => { toast.success('Заказ оплачен'); refetchAll() })
        .catch((e: any) => toast.error(`Ошибка оплаты: ${e?.message ?? ''}`))
    } else if (action === 'pay') {
      // Open full order-actions-dialog with discounts, tips, split, mixed payment
      const orderId = resolveOrderId()
      if (!orderId) {
        toast.error('Нет активного заказа. Освобождаем стол...')
        updateTableStatus(tableId, 'free', { current_order_id: null, waiter_id: null, opened_at: null }).catch(console.error)
        setTables((prev) => prev.map((t) => (t.id === tableId ? { ...t, status: 'free' as TableStatus, currentOrderId: undefined } : t)))
        setSheetOpen(false)
        return
      }
      const order = ordersData.find(o => o.id === orderId)
      if (!order) {
        toast.error('Заказ не найден. Обновите страницу.')
        return
      }
      if (order.status === 'done') {
        toast.error('Заказ уже закрыт. Освобождаем стол...')
        updateTableStatus(tableId, 'free', { current_order_id: null, waiter_id: null, opened_at: null }).catch(console.error)
        setTables((prev) => prev.map((t) => (t.id === tableId ? { ...t, status: 'free' as TableStatus, currentOrderId: undefined } : t)))
        setSheetOpen(false)
        return
      }
      setSelectedOrder(order)
      setSheetOpen(false)
      setOrderActionsOpen(true)
    } else if (action === 'cancel_reservation') {
      setTables((prev) =>
        prev.map((t) => (t.id === tableId ? { ...t, status: 'free' as TableStatus } : t))
      )
      setSheetOpen(false)
      setSelectedTable(null)
      toast.success('Бронь снята')
    } else if (action === 'seat_guest') {
      setTables((prev) =>
        prev.map((t) => (t.id === tableId ? { ...t, status: 'occupied' as TableStatus } : t))
      )
      setSheetOpen(false)
      // Open create order dialog for this table
      setOrderDialogOpen(true)
      toast.success('Гость за столом — создайте заказ')
    } else if (action === 'merge_table') {
      setMergeMode(true)
      setMergePrimaryId(tableId)
      setSheetOpen(false)
      setSelectedTable(null)
      toast.info('Выберите стол для объединения')
    } else if (action === 'unmerge_table') {
      const table = tables.find(t => t.id === tableId)
      const primaryId = table?.mergedWith || tableId
      unmergeTables(primaryId)
        .then(() => { toast.success('Столы разъединены'); refetchAll() })
        .catch(() => toast.error('Ошибка'))
      setSheetOpen(false)
      setSelectedTable(null)
    } else if (action === 'refresh') {
      // Refetch ВСЕХ связанных таблиц (orders/tables/users), иначе после
      // отмены позиции локальный ordersData остаётся со старыми items/total —
      // карточка стола показывает завышенную сумму, а PrintReceipt включает
      // отменённую позицию (visibleReceiptItems фильтрует по cancelledAt,
      // которого в устаревших items ещё нет).
      refetchAll().catch(console.error)
      setSheetOpen(false)
      setSelectedTable(null)
    } else if (action === 'edit_table') {
      const tbl = tables.find((t) => t.id === tableId)
      if (tbl) {
        setEditingTable(tbl)
        setTableDialogOpen(true)
      }
    } else if (action === 'assign_waiter') {
      const waiterId = data?.assignWaiterId ?? null
      assignWaiter(tableId, waiterId)
        .then(() => {
          setTables((prev) =>
            prev.map((t) => (t.id === tableId ? { ...t, waiterId: waiterId ?? undefined } : t))
          )
          setSelectedTable((prev) => (prev?.id === tableId ? { ...prev, waiterId: waiterId ?? undefined } : prev))
          toast.success('Официант назначен')
        })
        .catch(() => toast.error('Ошибка назначения официанта'))
    }
  }


  // ─── Zone CRUD ────────────────────────────────────────────────────────────

  function handleZoneSubmit(data: { name: string }) {
    if (editingZone) {
      updateZone(editingZone.id, data.name)
        .then(() => {
          setZonesData((prev) => prev.map((z) => (z.id === editingZone.id ? { ...z, name: data.name } : z)))
          toast.success('Зона обновлена')
        })
        .catch(() => toast.error('Ошибка обновления зоны'))
    } else {
      createZone(data.name)
        .then((res) => {
          if (res) setZonesData((prev) => [...prev, { id: res.id, name: data.name }])
          toast.success('Зона создана')
        })
        .catch(() => toast.error('Ошибка создания зоны'))
    }
  }

  function handleZoneDelete(id: string) {
    deleteZone(id)
      .then(() => {
        setZonesData((prev) => prev.filter((z) => z.id !== id))
        if (activeZone === id) setActiveZone('all')
        toast.success('Зона удалена')
      })
      .catch(() => toast.error('Ошибка удаления зоны'))
  }

  // ─── Table CRUD ───────────────────────────────────────────────────────────

  function handleTableSubmit(data: { name: string; number: number; capacity: number; zone: string; waiterId: string }) {
    if (editingTable) {
      updateTableData(editingTable.id, { name: data.name, capacity: data.capacity, zone_id: data.zone })
        .then(() => {
          setTables((prev) =>
            prev.map((t) =>
              t.id === editingTable.id
                ? { ...t, name: data.name, capacity: data.capacity, zone: data.zone }
                : t
            )
          )
          toast.success('Стол обновлён')
        })
        .catch(() => toast.error('Ошибка обновления стола'))
    } else {
      createTable({ name: data.name, number: data.number, capacity: data.capacity, zone_id: data.zone })
        .then((res) => {
          if (res) {
            setTables((prev) => [
              ...prev,
              {
                id: res.id,
                number: data.number,
                name: data.name,
                capacity: data.capacity,
                zone: data.zone,
                status: 'free' as TableStatus,
                currentOrderIds: [],
              },
            ])
          }
          toast.success('Стол создан')
        })
        .catch(() => toast.error('Ошибка создания стола'))
    }
  }

  function handleTableDelete(id: string) {
    deleteTable(id)
      .then(() => {
        setTables((prev) => prev.filter((t) => t.id !== id))
        toast.success('Стол удалён')
      })
      .catch(() => toast.error('Ошибка удаления стола'))
  }

  return (
    <div className="p-4 md:p-6 space-y-4 md:space-y-5">
      {/* Sticky header bar (title + legend + zone tabs) — pinned on all viewports */}
      <div className="sticky top-0 z-20 -mx-4 -mt-4 px-4 pt-4 pb-3 md:-mx-6 md:-mt-6 md:px-6 md:pt-6 md:pb-4 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 border-b border-border space-y-3 md:space-y-4 mb-2 md:mb-3">
      <div className="hidden sm:flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-foreground">Карта зала</h1>
          <p className="text-muted-foreground text-sm mt-0.5">
            {mergeMode ? (
              <span className="text-amber-600 font-medium animate-pulse">
                {!mergePrimaryId
                  ? '① Выберите первый стол'
                  : `① ${tables.find(t => t.id === mergePrimaryId)?.name} ✓ → ② Выберите второй стол`
                }
              </span>
            ) : 'Реальное время · автообновление'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Legend */}
          <div className="flex items-center gap-3 sm:gap-4 text-xs text-muted-foreground flex-wrap">
            <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-full bg-emerald-500 inline-block" />Свободен ({stats.free})</span>
            <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-full bg-red-500 inline-block" />Занят ({stats.occupied})</span>
            <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-full bg-amber-500 inline-block animate-pulse" />Счёт ({stats.bill})</span>
            <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-full bg-blue-500 inline-block" />Резерв ({stats.reserved})</span>
          </div>
        </div>
      </div>

      {/* Zone Tabs + Management Buttons */}
      <div className="flex items-center gap-2 flex-wrap">
        {zones.map((z) => (
          <button
            key={z.id}
            onClick={() => setActiveZone(z.id)}
            onDoubleClick={() => {
              if (canEditTables && z.id !== 'all') {
                setEditingZone(zonesData.find((zd) => zd.id === z.id))
                setZoneDialogOpen(true)
              }
            }}
            className={`px-4 py-2.5 md:py-1.5 rounded-xl md:rounded-lg text-sm font-medium transition-colors border ${
              activeZone === z.id
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-card border-border text-foreground hover:bg-muted'
            }`}
          >
            {z.name}
          </button>
        ))}

        {canEditTables && (
          <>
            <button
              onClick={() => { setEditingZone(undefined); setZoneDialogOpen(true) }}
              className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm font-medium border border-dashed border-primary/40 text-primary hover:bg-primary/5 transition-colors"
            >
              <Plus className="size-3.5" />
              Зона
            </button>
            <button
              onClick={() => { setEditingTable(undefined); setTableDialogOpen(true) }}
              className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm font-medium border border-dashed border-primary/40 text-primary hover:bg-primary/5 transition-colors"
            >
              <Plus className="size-3.5" />
              Стол
            </button>
            {!mergeMode ? (
              <button
                onClick={() => { setMergeMode(true); setMergePrimaryId(null); toast.info('Выберите первый стол') }}
                className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm font-medium border border-dashed border-amber-400 text-amber-600 hover:bg-amber-50 transition-colors"
              >
                ⊕ Объединить
              </button>
            ) : (
              <button
                onClick={() => { setMergeMode(false); setMergePrimaryId(null); toast.info('Объединение отменено') }}
                className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm font-medium bg-amber-100 border border-amber-300 text-amber-700 hover:bg-amber-200 transition-colors animate-pulse"
              >
                ✕ Отмена
              </button>
            )}
          </>
        )}

        {canManageTables && (
          <button
            onClick={() => setEditTablesMode(v => !v)}
            className={`hidden md:inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${
              editTablesMode
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-card border-border text-foreground hover:bg-muted'
            }`}
            title="Редактировать или удалять столы"
          >
            <Pencil className="size-3.5" />
            {editTablesMode ? 'Готово' : 'Редактировать столы'}
          </button>
        )}
      </div>
      </div>

      {editTablesMode && canManageTables && (
        <div className="hidden md:flex items-center justify-between gap-3 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-primary">
          <span>Режим редактирования: нажмите на стол, чтобы изменить или удалить.</span>
          <button
            onClick={() => setEditTablesMode(false)}
            className="font-medium hover:underline"
          >
            Выйти из режима
          </button>
        </div>
      )}

      {/* No free tables banner */}
      {stats.free === 0 && visibleTables.length > 1 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 flex items-center gap-2">
          <span className="text-amber-600 text-lg">⚠</span>
          <span className="text-sm font-medium text-amber-800">Все столы заняты или забронированы</span>
        </div>
      )}

      {/* Table Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3 md:gap-3 auto-rows-fr">
        {loading && tables.length === 0
          ? Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="rounded-xl bg-zinc-200 dark:bg-zinc-800 animate-pulse min-h-[140px]" />
            ))
          : filtered.filter(t => !t.mergedWith).map((table) => {
              const hasMerged = tables.some(t => t.mergedWith === table.id)
              const tableOrders = ordersByTable.get(table.id) ?? EMPTY_ORDERS
              const fallbackOrder = table.status === 'free' || tableOrders.length > 0
                ? null
                : (table.currentOrderId
                    ? ordersData.find(o => o.id === table.currentOrderId && o.status !== 'done' && o.status !== 'cancelled') ?? null
                    : null)
              const waiter = table.waiterId ? usersById.get(table.waiterId) ?? null : null
              return (
                <TableCard key={table.id} table={table}
                  tableOrders={tableOrders}
                  fallbackOrder={fallbackOrder}
                  waiter={waiter}
                  servicePercent={servicePercent}
                  onClick={() => handleTableClick(table)}
                  isSelected={mergeMode && mergePrimaryId === table.id}
                  isMerged={hasMerged}
                  hideReadyHighlight={hideReadyHighlight}
                />
              )
            })}
      </div>

      <TableDetailSheet
        table={selectedTable}
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        onAction={handleSheetAction}
        hasMergedChildren={selectedTable ? tables.some(t => t.mergedWith === selectedTable.id) : false}
        externalOrders={ordersData}
      />

      <CreateOrderDialog
        open={orderDialogOpen}
        onOpenChange={(open) => { setOrderDialogOpen(open); if (!open) setPendingTabLabel(null) }}
        preselectedTable={selectedTable ?? undefined}
        defaultTabLabel={pendingTabLabel ?? undefined}
        onSubmitted={() => { refetchAll() }}
      />

      <ManageZoneDialog
        open={zoneDialogOpen}
        onOpenChange={setZoneDialogOpen}
        zone={editingZone}
        onSubmit={handleZoneSubmit}
        onDelete={handleZoneDelete}
      />

      <ManageTableDialog
        open={tableDialogOpen}
        onOpenChange={setTableDialogOpen}
        table={editingTable}
        zones={zonesData}
        waiters={usersData}
        onSubmit={handleTableSubmit}
        onDelete={handleTableDelete}
      />

      <OrderActionsDialog
        order={selectedOrder}
        open={orderActionsOpen}
        onOpenChange={(open) => { setOrderActionsOpen(open); if (!open) setSelectedOrder(null) }}
        onAction={async (action, data) => {
          if (!selectedOrder) return
          if (action === 'start_cooking') {
            try {
              await updateOrderStatus(selectedOrder.id, 'cooking')
              toast.success('Заказ отправлен на кухню')
            } catch { toast.error('Ошибка') }
            setOrderActionsOpen(false)
            setSelectedOrder(null)
            await refetchAll()
          } else if (action === 'mark_ready') {
            try {
              await updateOrderStatus(selectedOrder.id, 'ready', { ready_at: new Date().toISOString() })
              toast.success('Заказ готов к выдаче')
            } catch { toast.error('Ошибка') }
            setOrderActionsOpen(false)
            setSelectedOrder(null)
            await refetchAll()
          } else if (action === 'cancel') {
            try {
              await deleteOrder(selectedOrder.id)
              if (selectedOrder.tableId) {
                await updateTableStatus(selectedOrder.tableId, 'free')
              }
              toast.success('Заказ отменён')
            } catch { toast.error('Ошибка отмены') }
            setOrderActionsOpen(false)
            setSelectedOrder(null)
            await refetchAll()
          } else if (action === 'reopen') {
            try {
              const { reopenOrder } = await import('@/lib/queries')
              await reopenOrder(selectedOrder.id)
              toast.success('Заказ открыт для редактирования')
            } catch (e) {
              toast.error(e instanceof Error ? e.message : 'Ошибка reopen')
            }
            setOrderActionsOpen(false)
            setSelectedOrder(null)
            await refetchAll()
          } else if (action === 'close_and_pay') {
            const tableId = selectedOrder.tableId
            try {
              await closeOrderWithPayment(
                selectedOrder.id,
                data?.paymentMethod || 'cash',
                tableId || null,
                selectedOrder.total,
                selectedOrder.items.reduce((s, i) => s + calcLineCogs(i.cogs || 0, i.qty, i.unit, i.unitSize), 0),
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
              toast.success('Заказ оплачен')
            } catch (e: any) { toast.error(`Ошибка оплаты: ${e?.message ?? ''}`) }
            setOrderActionsOpen(false)
            setSelectedOrder(null)
            await refetchAll()
          } else if (action === 'refresh') {
            await refetchAll()
          }
        }}
        onItemsChanged={() => { refetchAll().catch(console.error) }}
      />
    </div>
  )
}
