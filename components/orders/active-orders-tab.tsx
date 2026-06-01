'use client'

// Active-таб «Заказы» — только заказы текущей смены, без done/cancelled.
// Realtime через SSE, фильтры по статусу и типу, KPI-строка.
// Извлечён из app/(app)/operations/orders/page.tsx (Phase 2 рефакторинга).

import { useState, useEffect, useCallback, useMemo } from 'react'
import { Plus, Search, FileDown } from 'lucide-react'
import { toast } from 'sonner'

import { useAuth } from '@/lib/auth-store'
import { usePersistedState } from '@/hooks/use-persisted-state'
import { useDataSync } from '@/hooks/use-data-sync'
import { startOfToday, endOfDay, calcLineCogs } from '@/lib/helpers'
import {
  type Order, type OrderStatus, type OrderVoid, type Table, type User,
} from '@/lib/types'
import {
  fetchOrders, fetchTables, fetchUsers, fetchActiveShift, fetchVoidsForOrders,
  cleanupOrphanOrders, updateOrderStatus, deleteOrder, closeOrderWithPayment, reopenOrder,
} from '@/lib/queries'
import { exportOrdersToXlsx } from '@/lib/orders-export'

import { CreateOrderDialog } from '@/components/dialogs/create-order-dialog'
import { OrderActionsDialog, type OrderActionData } from '@/components/dialogs/order-actions-dialog'
import { AddItemsDialog } from '@/components/dialogs/add-items-dialog'
import { ExportOrdersDialog } from '@/components/dialogs/export-orders-dialog'

import { OrderCard, OrderRow, VirtualOrderCards, VirtualOrderRows, isTogo } from './order-row'

const STATUS_FILTER: { value: string; label: string }[] = [
  { value: 'all', label: 'Все' },
  { value: 'new', label: 'Новые' },
  { value: 'cooking', label: 'Готовится' },
  { value: 'ready', label: 'К выдаче' },
  { value: 'served', label: 'Подано' },
  { value: 'bill_requested', label: 'Пре-чек' },
]

const TYPE_FILTER: { value: 'all' | 'hall' | 'togo'; label: string }[] = [
  { value: 'all', label: 'Все' },
  { value: 'hall', label: 'Зал' },
  { value: 'togo', label: 'С собой' },
]

export function ActiveOrdersTab() {
  const { canAccessRoles, canDo, user, restaurant } = useAuth()
  const servicePercent = restaurant?.servicePercent
  const [orders, setOrders] = useState<Order[]>([])
  const [voidsByOrderId, setVoidsByOrderId] = useState<Map<string, OrderVoid[]>>(() => new Map())
  const [tablesData, setTablesData] = useState<Table[]>([])
  const [usersData, setUsersData] = useState<User[]>([])
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = usePersistedState<string>('restos.orders.statusFilter', 'all')
  const [typeFilter, setTypeFilter] = usePersistedState<'all' | 'hall' | 'togo'>('restos.orders.typeFilter', 'all')
  const canExportHistory = canAccessRoles(['owner', 'manager'])
  const [exportDialogOpen, setExportDialogOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [orderDialogOpen, setOrderDialogOpen] = useState(false)
  const [actionsDialogOpen, setActionsDialogOpen] = useState(false)
  const [addItemsOrderId, setAddItemsOrderId] = useState<string | null>(null)
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null)

  const refetchAll = useCallback(async () => {
    // Активный таб = заказы текущей смены. Если смены нет — fallback на «с начала
    // сегодняшнего дня» (бывает редко, когда пользователь зашёл до открытия смены).
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
    setOrders(o)
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
  const visibleOrders = useMemo(
    () => (canViewOthers ? orders : orders.filter(o => o.waiterId === user?.id))
      // Active-таб — только живые заказы (без done/cancelled).
      .filter(o => o.status !== 'done' && o.status !== 'cancelled'),
    [orders, canViewOthers, user?.id],
  )

  const tablesById = useMemo(() => {
    const m = new Map<string, Table>()
    for (const t of tablesData) m.set(t.id, t)
    return m
  }, [tablesData])

  const filtered = useMemo(() => {
    const q = search.toLowerCase()
    return visibleOrders
      .filter((o) => {
        if (statusFilter !== 'all' && o.status !== statusFilter) return false
        if (typeFilter === 'hall' && isTogo(o.type)) return false
        if (typeFilter === 'togo' && !isTogo(o.type)) return false
        if (search) {
          const table = o.tableId ? tablesById.get(o.tableId) : null
          const numStr = String(o.orderNumber ?? '')
          if (!(o.id.includes(search) || numStr.includes(search) || (table?.name ?? '').toLowerCase().includes(q))) return false
        }
        return true
      })
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
  }, [visibleOrders, statusFilter, typeFilter, search, tablesById])

  const counts = useMemo(() => ({
    all: visibleOrders.length,
    new: visibleOrders.filter(o => o.status === 'new').length,
    cooking: visibleOrders.filter(o => o.status === 'cooking').length,
    ready: visibleOrders.filter(o => o.status === 'ready').length,
    served: visibleOrders.filter(o => o.status === 'served').length,
    bill_requested: visibleOrders.filter(o => o.status === 'bill_requested').length,
  }), [visibleOrders])

  const typeCounts = useMemo(() => ({
    all: visibleOrders.length,
    hall: visibleOrders.filter(o => !isTogo(o.type)).length,
    togo: visibleOrders.filter(o => isTogo(o.type)).length,
  }), [visibleOrders])

  // KPI-строка для active-таба
  const kpi = useMemo(() => ({
    total: visibleOrders.length,
    ready: visibleOrders.filter(o => o.status === 'ready').length,
    served: visibleOrders.filter(o => o.status === 'served').length,
    billRequested: visibleOrders.filter(o => o.status === 'bill_requested').length,
  }), [visibleOrders])

  const visibleStatusFilter = useMemo(() => {
    const hideServed = user?.role === 'owner' || user?.role === 'cashier'
    return hideServed ? STATUS_FILTER.filter(s => s.value !== 'served') : STATUS_FILTER
  }, [user?.role])

  useEffect(() => {
    if (statusFilter === 'served' && !visibleStatusFilter.some(s => s.value === 'served')) {
      setStatusFilter('all')
    }
  }, [statusFilter, visibleStatusFilter, setStatusFilter])

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

  return (
    <div className="space-y-4 md:space-y-5">
      <div className="sticky top-[52px] z-10 -mx-4 px-4 pt-3 pb-3 md:-mx-6 md:px-6 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 border-b border-border space-y-3">
        {/* Actions row */}
        <div className="hidden sm:flex items-center justify-end gap-2">
          <button
            onClick={async () => {
              if (canExportHistory) { setExportDialogOpen(true); return }
              if (filtered.length === 0) { toast.info('Нет заказов в текущем фильтре'); return }
              try {
                const voids = await fetchVoidsForOrders(filtered.map(o => o.id)).catch(() => new Map())
                exportOrdersToXlsx(filtered, { tables: tablesData, users: usersData, voidsByOrderId: voids, filenameSuffix: 'today' })
              } catch (e) {
                toast.error(e instanceof Error ? e.message : 'Ошибка экспорта')
              }
            }}
            className="inline-flex items-center gap-2 bg-card border border-border text-foreground px-3 py-2.5 rounded-lg text-sm font-medium hover:bg-muted transition-colors"
          >
            <FileDown className="size-4" /> Excel
          </button>
          {canAccessRoles(['manager', 'waiter', 'cashier']) && (
            <button
              onClick={() => setOrderDialogOpen(true)}
              className="inline-flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2.5 rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors"
            >
              <Plus className="size-4" /> Новый заказ
            </button>
          )}
        </div>

        {/* KPI line */}
        <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
          <span>Всего активных: <b className="text-foreground">{kpi.total}</b></span>
          <span>· Готовы: <b className="text-emerald-700">{kpi.ready}</b></span>
          <span>· Поданы: <b className="text-teal-700">{kpi.served}</b></span>
          <span>· Пре-чек: <b className="text-amber-700">{kpi.billRequested}</b></span>
        </div>

        {/* Filters */}
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative">
            <Search className="size-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              placeholder="Поиск по № или столу..."
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
                {f.label} ({counts[f.value as keyof typeof counts] ?? 0})
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

      {/* Mobile cards */}
      <div className="md:hidden">
        {loading && orders.length === 0 ? (
          <div className="space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="bg-card rounded-xl border border-border p-4 space-y-3">
                <div className="h-5 w-20 rounded bg-zinc-200 dark:bg-zinc-800 animate-pulse" />
                <div className="h-4 w-24 rounded bg-zinc-200 dark:bg-zinc-800 animate-pulse" />
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <p className="text-muted-foreground text-sm text-center py-10">Заказов не найдено</p>
        ) : filtered.length > 50 ? (
          <VirtualOrderCards orders={filtered} tablesData={tablesData} usersData={usersData} voidsByOrderId={voidsByOrderId} servicePercent={servicePercent} onOpen={handleOpenOrder} />
        ) : (
          <div className="space-y-3">
            {filtered.map((order) => (
              <OrderCard key={order.id} order={order} tablesData={tablesData} usersData={usersData} voids={voidsByOrderId.get(order.id)} servicePercent={servicePercent} onOpen={handleOpenOrder} />
            ))}
          </div>
        )}
      </div>

      {/* Desktop table */}
      {filtered.length > 50 ? (
        <div className="hidden md:block">
          <VirtualOrderRows orders={filtered} tablesData={tablesData} usersData={usersData} voidsByOrderId={voidsByOrderId} servicePercent={servicePercent} onOpen={handleOpenOrder} />
        </div>
      ) : (
        <div className="hidden md:block bg-card rounded-xl border border-border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/40">
                  {['#', 'Статус', 'Стол/Тип', 'Позиций', 'Сумма', 'Официант', 'Время', 'Оплата'].map((h) => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wide whitespace-nowrap">{h}</th>
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
                          <td key={j} className="px-4 py-3"><div className="h-4 rounded bg-zinc-200 dark:bg-zinc-800 animate-pulse" /></td>
                        ))}
                      </tr>
                    ))
                  ) : (
                    <tr><td colSpan={8} className="px-4 py-10 text-center text-muted-foreground text-sm">Заказов не найдено</td></tr>
                  )
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <CreateOrderDialog open={orderDialogOpen} onOpenChange={setOrderDialogOpen} onSubmitted={() => { refetchAll() }} />

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

      <ExportOrdersDialog open={exportDialogOpen} onOpenChange={setExportDialogOpen} tables={tablesData} users={usersData} />
    </div>
  )
}
