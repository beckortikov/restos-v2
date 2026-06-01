'use client'

// Active-таб «Заказы» — card-grid живых заказов текущей смены.
// Используется в трёх под-табах: «Все заказы», «Зал», «С собой».
// Тип фильтруется prop'ом typeFilter; delivery исключаем всегда.
// Realtime через SSE useDataSync(['orders']).

import { useState, useEffect, useCallback, useMemo } from 'react'
import { toast } from 'sonner'

import { useAuth } from '@/lib/auth-store'
import { useDataSync } from '@/hooks/use-data-sync'
import { startOfToday, endOfDay, calcLineCogs } from '@/lib/helpers'
import {
  type Order, type OrderStatus, type OrderVoid, type Table, type User,
} from '@/lib/types'
import {
  fetchOrders, fetchTables, fetchUsers, fetchActiveShift, fetchVoidsForOrders,
  cleanupOrphanOrders, updateOrderStatus, deleteOrder, closeOrderWithPayment, reopenOrder,
} from '@/lib/queries'

import { OrderActionsDialog, type OrderActionData } from '@/components/dialogs/order-actions-dialog'
import { AddItemsDialog } from '@/components/dialogs/add-items-dialog'

import { ActiveOrderCard } from './active-order-card'
import { VirtualOrderCardGrid, useColumnCount } from './virtual-order-card-grid'
import { ordersEqualShallow } from './order-row'

/**
 * Порог переключения на виртуализованный grid. До 30 карточек overhead
 * виртуализации (chunking + absolute-positioning + scroll-container) не
 * окупается — проще нарисовать всё в DOM. После — заметный выигрыш.
 */
const VIRTUALIZE_THRESHOLD = 30

export type ActiveTypeFilter = 'all' | 'hall' | 'takeaway'

interface ActiveOrdersTabProps {
  typeFilter: ActiveTypeFilter
  search: string
  /** Колбэк отдаёт наверх число «N заказов в очереди» — для header'а page'а. */
  onQueueCountChange?: (n: number) => void
}

export function ActiveOrdersTab({ typeFilter, search, onQueueCountChange }: ActiveOrdersTabProps) {
  const { canDo, user, restaurant } = useAuth()
  const servicePercent = restaurant?.servicePercent

  const [orders, setOrders] = useState<Order[]>([])
  const [voidsByOrderId, setVoidsByOrderId] = useState<Map<string, OrderVoid[]>>(() => new Map())
  const [tablesData, setTablesData] = useState<Table[]>([])
  const [usersData, setUsersData] = useState<User[]>([])
  const [loading, setLoading] = useState(true)

  const columnsCount = useColumnCount()

  const [actionsDialogOpen, setActionsDialogOpen] = useState(false)
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null)
  const [addItemsOrderId, setAddItemsOrderId] = useState<string | null>(null)

  const refetchAll = useCallback(async () => {
    let from: Date = startOfToday()
    let shiftId: string | undefined
    try {
      const sh = await fetchActiveShift()
      if (sh?.openedAt) from = new Date(sh.openedAt)
      if (sh?.id) shiftId = sh.id
    } catch { /* ignore */ }

    const [o, t, u] = await Promise.all([
      fetchOrders({ from, to: endOfDay(new Date()), shiftId, slim: true }),
      fetchTables(),
      fetchUsers(),
    ])
    // Skip setState если ничего значимого не изменилось — это сохраняет
    // референс массива → React.memo карточек не пересчитывается.
    setOrders((prev) => {
      if (prev.length !== o.length) return o
      for (let i = 0; i < prev.length; i++) {
        if (prev[i].id !== o[i].id || !ordersEqualShallow(prev[i], o[i])) return o
      }
      return prev
    })
    setTablesData(t)
    setUsersData(u)
    const ids = o.map(x => x.id)
    if (ids.length > 0) {
      fetchVoidsForOrders(ids).then(setVoidsByOrderId).catch(() => setVoidsByOrderId(new Map()))
    } else {
      setVoidsByOrderId(new Map())
    }
  }, [])

  useEffect(() => {
    setLoading(true)
    cleanupOrphanOrders()
      .then((n) => { if (n > 0) console.log(`Auto-closed ${n} orphan orders`) })
      .catch(() => {})
      .finally(() => refetchAll().finally(() => setLoading(false)))
  }, [refetchAll])

  useDataSync(['orders', 'order_items', 'order_splits', 'order_voids', 'tables', 'users'], () => { refetchAll().catch(console.error) })

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

  const canViewOthers = canDo('orders.view_others')

  // Активные = всё, кроме done/cancelled. Delivery исключаем повсюду
  // (не используется в нашем продукте).
  const visibleOrders = useMemo(
    () => (canViewOthers ? orders : orders.filter(o => o.waiterId === user?.id))
      .filter(o => o.status !== 'done' && o.status !== 'cancelled')
      .filter(o => o.type !== 'delivery'),
    [orders, canViewOthers, user?.id],
  )

  const tablesById = useMemo(() => {
    const m = new Map<string, Table>()
    for (const t of tablesData) m.set(t.id, t)
    return m
  }, [tablesData])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return visibleOrders
      .filter((o) => {
        if (typeFilter === 'hall' && o.type !== 'hall') return false
        if (typeFilter === 'takeaway' && o.type !== 'takeaway') return false
        if (q) {
          const table = o.tableId ? tablesById.get(o.tableId) : null
          const numStr = String(o.orderNumber ?? '')
          if (!(o.id.includes(q) || numStr.includes(q) || (table?.name ?? '').toLowerCase().includes(q))) return false
        }
        return true
      })
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
  }, [visibleOrders, typeFilter, search, tablesById])

  // Поднимаем счётчик очереди (всех видимых активных без учёта type-фильтра)
  // — header показывает «N заказов в очереди».
  useEffect(() => {
    onQueueCountChange?.(visibleOrders.length)
  }, [visibleOrders.length, onQueueCountChange])

  const handleOpenOrder = useCallback(async (order: Order) => {
    setSelectedOrder(order)
    setActionsDialogOpen(true)
    try {
      const full = await fetchOrders({ ids: [order.id], slim: false })
      if (full[0]) setSelectedOrder(full[0])
    } catch (e) {
      console.error('[orders] load full order failed:', e)
    }
  }, [])

  function handleOrderAction(action: string, data?: OrderActionData) {
    if (!selectedOrder) return
    const orderId = selectedOrder.id

    if (action === 'add_items') {
      setAddItemsOrderId(orderId)
      setActionsDialogOpen(false)
      return
    }

    if (action === 'start_cooking') {
      updateOrderStatus(orderId, 'cooking')
        .then(() => toast.success('Заказ отправлен на кухню'))
        .catch(() => toast.error('Ошибка обновления заказа'))
      setOrders((prev) => prev.map((o) => (o.id === orderId ? { ...o, status: 'cooking' as OrderStatus } : o)))
      setActionsDialogOpen(false)
      setSelectedOrder(null)
    } else if (action === 'mark_ready') {
      const readyAt = new Date().toISOString()
      updateOrderStatus(orderId, 'ready', { ready_at: readyAt })
        .then(() => toast.success('Заказ готов к выдаче'))
        .catch(() => toast.error('Ошибка обновления заказа'))
      setOrders((prev) => prev.map((o) => (o.id === orderId ? { ...o, status: 'ready' as OrderStatus, readyAt } : o)))
      setActionsDialogOpen(false)
      setSelectedOrder(null)
    } else if (action === 'close_and_pay') {
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
      setOrders((prev) => prev.map((o) => o.id === orderId ? { ...o, status: 'done' as OrderStatus, paymentMethod: data?.paymentMethod, closedAt } : o))
    } else if (action === 'cancel') {
      deleteOrder(orderId)
        .then(() => toast.success('Заказ отменён'))
        .catch(() => toast.error('Ошибка отмены заказа'))
      setOrders((prev) => prev.filter((o) => o.id !== orderId))
      setActionsDialogOpen(false)
      setSelectedOrder(null)
    } else if (action === 'reopen') {
      reopenOrder(orderId)
        .then(() => { toast.success('Заказ открыт для редактирования'); return refetchAll() })
        .catch(e => toast.error(e instanceof Error ? e.message : 'Ошибка reopen'))
      setActionsDialogOpen(false)
      setSelectedOrder(null)
    }
  }

  if (loading && orders.length === 0) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="bg-card rounded-xl border border-border h-44 animate-pulse" />
        ))}
      </div>
    )
  }

  if (filtered.length === 0) {
    return (
      <div className="text-center py-16 text-muted-foreground text-sm">
        Активных заказов нет
      </div>
    )
  }

  const renderCard = useCallback((order: Order) => (
    <ActiveOrderCard
      order={order}
      tablesData={tablesData}
      usersData={usersData}
      voids={voidsByOrderId.get(order.id)}
      servicePercent={servicePercent}
      onOpen={handleOpenOrder}
      onPay={handleOpenOrder}
      onCancel={handleOpenOrder}
    />
  ), [tablesData, usersData, voidsByOrderId, servicePercent, handleOpenOrder])

  return (
    <>
      {filtered.length > VIRTUALIZE_THRESHOLD ? (
        <VirtualOrderCardGrid
          items={filtered}
          columnsCount={columnsCount}
          renderItem={renderCard}
          getKey={(o) => o.id}
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {filtered.map((order) => (
            <ActiveOrderCard
              key={order.id}
              order={order}
              tablesData={tablesData}
              usersData={usersData}
              voids={voidsByOrderId.get(order.id)}
              servicePercent={servicePercent}
              onOpen={handleOpenOrder}
              onPay={handleOpenOrder}
              onCancel={handleOpenOrder}
            />
          ))}
        </div>
      )}

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
          onDone={() => { setAddItemsOrderId(null); toast.success('Блюда добавлены к заказу'); refetchAll().catch(() => {}) }}
        />
      )}
    </>
  )
}

