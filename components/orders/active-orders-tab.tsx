'use client'

// Active-таб «Заказы» — card-grid живых заказов текущей смены.
// Используется в трёх под-табах: «Все заказы», «Зал», «С собой».
// Тип фильтруется prop'ом typeFilter; delivery исключаем всегда.
// Realtime через SSE useDataSync(['orders']).

import { useState, useEffect, useCallback, useMemo } from 'react'
import { toast } from 'sonner'
import { humanizeError } from '@/lib/errors'

import { useAuth } from '@/lib/auth-store'
import { useDataSync } from '@/hooks/use-data-sync'
import { startOfToday, endOfDay, calcLineCogs } from '@/lib/helpers'
import {
  type Order, type OrderStatus, type OrderVoid, type Table, type User, type Zone,
} from '@/lib/types'
import {
  fetchOrders, fetchTables, fetchZones, fetchUsers, fetchActiveShift, fetchVoidsForOrders,
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
  const [zonesData, setZonesData] = useState<Zone[]>([])
  const [usersData, setUsersData] = useState<User[]>([])
  const [loading, setLoading] = useState(true)
  // Фильтр по зоне — активен только в под-табе «Зал». 'all' = все зоны.
  const [zoneFilter, setZoneFilter] = useState<string>('all')

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

    const [o, t, z, u] = await Promise.all([
      fetchOrders({ from, to: endOfDay(new Date()), shiftId, slim: true }),
      fetchTables(),
      fetchZones().catch(() => [] as Zone[]),
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
    setZonesData(prev => (prev.length === z.length && prev.every((p, i) => p.id === z[i].id && p.name === z[i].name)) ? prev : z)
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

  useDataSync(['orders', 'order_items', 'order_splits', 'order_voids', 'tables', 'zones', 'users'], () => { refetchAll().catch(console.error) })

  // Если выбранную зону удалили — сбрасываемся на «Все зоны».
  useEffect(() => {
    if (zoneFilter !== 'all' && zonesData.length > 0 && !zonesData.some(z => z.id === zoneFilter)) {
      setZoneFilter('all')
    }
  }, [zoneFilter, zonesData])

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

  // Активные = всё, кроме done/cancelled.
  // v3.16.109: фильтр `type !== 'delivery'` убран. Он стоял с тех пор, когда
  // доставка не использовалась; с её включением (052) заказы-доставки просто
  // пропадали бы из активных — оплачены, но кассир их не видит.
  // v2.1.2: дополнительно скрываем zombie-заказы (active-status, но все
  // позиции отменены). Backend-invariant + миграция 016 их чистят, UI-фильтр
  // — финальная страховка.
  const visibleOrders = useMemo(
    () => (canViewOthers ? orders : orders.filter(o => o.waiterId === user?.id))
      .filter(o => o.status !== 'done' && o.status !== 'cancelled')
      .filter(o => {
        const alive = o.aliveItemsCount ?? o.items.filter(i => !i.cancelledAt).length
        return alive > 0
      }),
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
        if (typeFilter === 'hall' && zoneFilter !== 'all') {
          const table = o.tableId ? tablesById.get(o.tableId) : null
          if (table?.zone !== zoneFilter) return false
        }
        if (q) {
          const table = o.tableId ? tablesById.get(o.tableId) : null
          const numStr = String(o.orderNumber ?? '')
          if (!(o.id.includes(q) || numStr.includes(q) || (table?.name ?? '').toLowerCase().includes(q))) return false
        }
        return true
      })
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
  }, [visibleOrders, typeFilter, zoneFilter, search, tablesById])

  // Счётчики заказов по зонам — для chips-фильтра в под-табе «Зал».
  const zoneCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const o of visibleOrders) {
      if (o.type !== 'hall' || !o.tableId) continue
      const zoneId = tablesById.get(o.tableId)?.zone
      if (zoneId) m.set(zoneId, (m.get(zoneId) ?? 0) + 1)
    }
    return m
  }, [visibleOrders, tablesById])

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

  // ВАЖНО: renderCard объявлен ЗДЕСЬ (до всех early-return ниже), иначе
  // при skeleton-state / empty-state count хуков отличается между рендерами
  // → React error #310 «Rendered fewer hooks than expected».
  const renderCard = useCallback((order: Order) => (
    <ActiveOrderCard
      order={order}
      tablesData={tablesData}
      zonesData={zonesData}
      usersData={usersData}
      voids={voidsByOrderId.get(order.id)}
      servicePercent={servicePercent}
      onOpen={handleOpenOrder}
      onPay={handleOpenOrder}
      onCancel={handleOpenOrder}
    />
  ), [tablesData, zonesData, usersData, voidsByOrderId, servicePercent, handleOpenOrder])

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
        data?.skipReceipt,
      )
        .then(() => toast.success(data?.skipReceipt ? 'Заказ закрыт без печати' : 'Заказ оплачен · чек на печать'))
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
        .catch(e => toast.error(humanizeError(e, 'Ошибка reopen')))
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

  // Chips-фильтр по зонам — только в под-табе «Зал». Рендерится и при пустом
  // списке, иначе из зоны без заказов нельзя переключиться обратно.
  const zoneChips = typeFilter === 'hall' && zonesData.length > 0 && (
    <div className="flex items-center gap-2 flex-wrap">
      {[{ id: 'all', name: 'Все зоны' }, ...zonesData].map((z) => {
        const count = z.id === 'all' ? undefined : zoneCounts.get(z.id)
        return (
          <button
            key={z.id}
            onClick={() => setZoneFilter(z.id)}
            className={`px-3.5 py-1.5 rounded-full text-sm font-medium transition-colors border ${
              zoneFilter === z.id
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-card border-border text-muted-foreground hover:bg-muted'
            }`}
          >
            {z.name}
            {count ? <span className="ml-1.5 text-xs opacity-70 tabular-nums">{count}</span> : null}
          </button>
        )
      })}
    </div>
  )

  if (filtered.length === 0) {
    return (
      <>
        {zoneChips}
        <div className="text-center py-16 text-muted-foreground text-sm">
          Активных заказов нет
        </div>
      </>
    )
  }

  return (
    <>
      {zoneChips}
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
              zonesData={zonesData}
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

