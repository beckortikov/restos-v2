'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'

import { formatCurrency, getTimeSince, startOfToday } from '@/lib/helpers'
import {
  type Order,
  type OrderStatus,
  type Table,
  type MenuItem,
  type MenuStation,
  ALL_STATIONS,
  STATION_LABELS,
  STATION_ICONS,
} from '@/lib/types'
import {
  fetchOrders,
  fetchTables,
  fetchMenuItems,
  updateOrderStatus,
  deductStockForOrder,
} from '@/lib/queries'
import { ChevronRight, CheckCircle2, Circle, Flame, FlaskConical } from 'lucide-react'
import { toast } from 'sonner'

const COLUMNS: { status: OrderStatus; label: string; color: string; headerBg: string }[] = [
  { status: 'new', label: 'Новые', color: 'bg-blue-500', headerBg: 'bg-blue-50 border-blue-200' },
  { status: 'cooking', label: 'Готовится', color: 'bg-amber-500', headerBg: 'bg-amber-50 border-amber-200' },
  { status: 'ready', label: 'К выдаче', color: 'bg-emerald-500', headerBg: 'bg-emerald-50 border-emerald-200' },
]

function KitchenCard({ order, tablesData, menuItems, onMove, activeStation }: { order: Order; tablesData: Table[]; menuItems: MenuItem[]; onMove: (id: string, status: OrderStatus) => void; activeStation: MenuStation | 'all' }) {
  const table = order.tableId ? tablesData.find((t) => t.id === order.tableId) : null
  const KITCHEN_STATIONS_LIST = ['hot_kitchen', 'cold_kitchen', 'grill', 'kitchen']
  const isMyItem = (station: string) => {
    if (activeStation === 'all') return KITCHEN_STATIONS_LIST.includes(station)
    return station === activeStation
  }
  const timeSince = getTimeSince(order.createdAt)
  const isUrgent = (Date.now() - new Date(order.createdAt).getTime()) > 20 * 60000
  const [showTechCard, setShowTechCard] = useState(false)

  const nextStatus: Record<OrderStatus, OrderStatus | null> = {
    new: 'cooking',
    cooking: 'ready',
    ready: null,
    served: null,
    bill_requested: null,
    done: null,
    cancelled: null,
  }
  const next = nextStatus[order.status]

  const nextLabel: Record<string, string> = {
    cooking: 'В готовку',
    ready: 'Готово!',
  }

  // Aggregate tech card ingredients for all items in the order
  const techCardLines: { name: string; qty: number; unit: string }[] = []
  for (const item of order.items) {
    const menuItem = menuItems.find((m) => m.id === item.menuItemId)
    if (menuItem?.techCard) {
      for (const line of menuItem.techCard) {
        const existing = techCardLines.find((l) => l.name === line.name && l.unit === line.unit)
        if (existing) {
          existing.qty += line.qty * item.qty
        } else {
          techCardLines.push({ name: line.name, qty: line.qty * item.qty, unit: line.unit })
        }
      }
    }
  }

  return (
    <div className={`bg-card rounded-xl border-2 p-4 space-y-3 transition-shadow hover:shadow-md ${isUrgent ? 'border-destructive/40' : 'border-border'}`}>
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs font-mono text-muted-foreground">#{order.id}</p>
          <p className="font-semibold text-foreground mt-0.5">
            {table ? table.name : order.type === 'delivery' ? 'Доставка' : 'Самовывоз'}
          </p>
        </div>
        <div className={`flex items-center gap-1 text-xs ${isUrgent ? 'text-destructive font-semibold' : 'text-muted-foreground'}`}>
          {isUrgent && <Flame className="size-3.5" />}
          {timeSince}
        </div>
      </div>

      {/* Station items — what this station needs to prepare */}
      {(() => {
        const kitchenItems = order.items.filter(item => {
          if (item.cancelledAt) return false
          const mi = menuItems.find(m => m.id === item.menuItemId)
          return !mi || isMyItem(mi.station)
        })
        const otherItems = order.items.filter(item => {
          if (item.cancelledAt) return false
          const mi = menuItems.find(m => m.id === item.menuItemId)
          return mi && !isMyItem(mi.station)
        })

        return (
          <>
            <div className="space-y-1.5">
              {kitchenItems.map((item) => {
                const mi = menuItems.find((m) => m.id === item.menuItemId)
                return (
                  <div key={item.menuItemId} className="flex items-center gap-2">
                    <Circle className="size-3.5 text-muted-foreground/40 shrink-0" />
                    <span className="text-sm text-foreground flex-1">{item.name}</span>
                    {mi?.cookTimeMin && (
                      <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">⏱ {mi.cookTimeMin} мин</span>
                    )}
                    <span className="text-xs font-semibold text-foreground bg-muted px-1.5 py-0.5 rounded">x{item.qty}</span>
                  </div>
                )
              })}
            </div>

            {/* Bar / Showcase items — info only, not cook's responsibility */}
            {otherItems.length > 0 && (
              <div className="space-y-1 bg-muted/20 rounded-lg p-2.5">
                <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
                  {activeStation === 'all' ? 'Другие станции' : 'Другие станции'}
                </p>
                {otherItems.map((item) => {
                  const mi = menuItems.find((m) => m.id === item.menuItemId)
                  return (
                    <div key={item.menuItemId} className="flex items-center gap-2 text-muted-foreground">
                      <span className="text-xs">{STATION_ICONS[mi?.station ?? 'hot_kitchen']}</span>
                      <span className="text-xs flex-1 line-through opacity-60">{item.name}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 font-medium">
                        {STATION_LABELS[mi?.station ?? 'hot_kitchen']}
                      </span>
                      <span className="text-[10px] font-semibold">x{item.qty}</span>
                    </div>
                  )
                })}
              </div>
            )}
          </>
        )
      })()}

      {/* Tech card ingredients */}
      {techCardLines.length > 0 && (
        <div>
          <button
            onClick={() => setShowTechCard(!showTechCard)}
            className="flex items-center gap-1 text-xs text-primary font-medium"
          >
            <FlaskConical className="size-3" />
            {showTechCard ? 'Скрыть ингредиенты' : 'Ингредиенты'}
          </button>
          {showTechCard && (
            <div className="mt-2 space-y-1 bg-muted/30 rounded-lg p-2.5">
              {techCardLines.map((line, i) => (
                <div key={i} className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">{line.name}</span>
                  <span className="font-medium text-foreground">{line.qty.toFixed(2)} {line.unit}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Total & Action */}
      <div className="flex items-center justify-between pt-2 border-t border-border">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{formatCurrency(order.total)}</span>
          {(() => {
            const maxCook = Math.max(0, ...order.items.filter(item => {
              const mi = menuItems.find(m => m.id === item.menuItemId)
              return !mi || isMyItem(mi.station)
            }).map((item) => {
              const mi = menuItems.find((m) => m.id === item.menuItemId)
              return mi?.cookTimeMin ?? 0
            }))
            return maxCook > 0 ? <span className="text-[10px] font-medium text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded">⏱ ~{maxCook} мин</span> : null
          })()}
        </div>
        {next && (
          <button
            onClick={() => onMove(order.id, next)}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold transition-colors ${
              next === 'ready'
                ? 'bg-emerald-500 text-white hover:bg-emerald-600'
                : 'bg-amber-500 text-white hover:bg-amber-600'
            }`}
          >
            {next === 'ready' && <CheckCircle2 className="size-3.5" />}
            {nextLabel[next]}
            <ChevronRight className="size-3.5" />
          </button>
        )}
      </div>
    </div>
  )
}

export default function KitchenPage() {
  const [searchParams] = useSearchParams()
  const stationParam = searchParams.get('station') as MenuStation | null

  const [orders, setOrders] = useState<Order[]>([])
  const [tablesData, setTablesData] = useState<Table[]>([])
  const [menuItems, setMenuItems] = useState<MenuItem[]>([])
  const [loading, setLoading] = useState(true)
  const [mobileTab, setMobileTab] = useState<OrderStatus>('new')
  const [stationFilter, setStationFilter] = useState<MenuStation | 'all'>(stationParam || 'all')

  const KITCHEN_STATIONS: MenuStation[] = ['hot_kitchen', 'cold_kitchen', 'grill']

  const refetchAll = useCallback(() => {
    return Promise.all([fetchOrders({ from: startOfToday() }), fetchTables(), fetchMenuItems()])
      .then(([o, t, m]) => {
        setOrders(o.filter((order) => order.status !== 'done' && order.status !== 'served' && order.status !== 'cancelled'))
        setTablesData(t)
        setMenuItems(m)
      })
  }, [])

  useEffect(() => {
    refetchAll().finally(() => setLoading(false))
  }, [refetchAll])

  // Poll every 10s ONLY in local mode (Desktop app / Local DB)
  useEffect(() => {
    let isLocal = false
    try { isLocal = localStorage.getItem('restos-sync-mode') === 'local' } catch {}
    
    if (!isLocal) return
    const tick = () => { if (!document.hidden) refetchAll().catch(console.error) }
    const interval = setInterval(tick, 8000)
    const onVisible = () => { if (!document.hidden) refetchAll().catch(console.error) }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [refetchAll])

  // Filter orders by station — only show orders that have items for this station
  const filteredOrders = useMemo(() => {
    if (stationFilter === 'all') return orders
    return orders.filter(order =>
      order.items.some(item => {
        const mi = menuItems.find(m => m.id === item.menuItemId)
        return mi?.station === stationFilter
      })
    )
  }, [orders, menuItems, stationFilter])

  if (loading) return <div className="p-6 flex items-center justify-center h-64"><div className="size-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" /></div>

  function moveOrder(id: string, newStatus: OrderStatus) {
    const extra: Record<string, string> = {}
    if (newStatus === 'ready') extra.ready_at = new Date().toISOString()
    updateOrderStatus(id, newStatus, extra)
      .then(() => {
        if (newStatus === 'ready') {
          deductStockForOrder(id)
            .then(() => toast.success('Заказ готов, ингредиенты списаны'))
            .catch(() => toast.error('Ошибка списания ингредиентов'))
        } else {
          toast.success('Заказ отправлен в готовку')
        }
      })
      .catch(() => toast.error('Ошибка обновления заказа'))
    setOrders((prev) => prev.map((o) => (o.id === id ? { ...o, status: newStatus } : o)))
  }

  const cols = COLUMNS.map((col) => ({
    ...col,
    orders: filteredOrders.filter((o) => o.status === col.status),
  }))

  return (
    <div className="p-4 md:p-6 h-full flex flex-col">
      <div className="mb-4 md:mb-5 space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div>
            <h1 className="text-xl font-bold text-foreground">
              {stationFilter !== 'all' ? `${STATION_ICONS[stationFilter]} ${STATION_LABELS[stationFilter]}` : 'Кухня'}
            </h1>
            <p className="text-muted-foreground text-sm mt-0.5">{filteredOrders.length} заказов · автообновление 5 сек</p>
          </div>
        </div>

        {/* Station filter */}
        <div className="flex gap-1.5 overflow-x-auto pb-1">
          <button
            onClick={() => setStationFilter('all')}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
              stationFilter === 'all' ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground hover:bg-muted/80'
            }`}
          >
            Все станции
            <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${stationFilter === 'all' ? 'bg-white/20' : 'bg-background'}`}>
              {orders.length}
            </span>
          </button>
          {ALL_STATIONS.filter(s => s !== 'showcase').map(s => {
            const count = orders.filter(o => o.items.some(item => menuItems.find(m => m.id === item.menuItemId)?.station === s)).length
            return (
              <button
                key={s}
                onClick={() => setStationFilter(s)}
                className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
                  stationFilter === s ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground hover:bg-muted/80'
                }`}
              >
                <span>{STATION_ICONS[s]}</span>
                {STATION_LABELS[s]}
                {count > 0 && (
                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${stationFilter === s ? 'bg-white/20' : 'bg-background'}`}>
                    {count}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      </div>

      {/* Mobile: Tab selector */}
      <div className="md:hidden flex gap-2 mb-4">
        {COLUMNS.map((col) => {
          const count = orders.filter(o => o.status === col.status).length
          return (
            <button
              key={col.status}
              onClick={() => setMobileTab(col.status)}
              className={`flex-1 flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl border text-sm font-medium transition-colors ${
                mobileTab === col.status ? col.headerBg + ' font-semibold' : 'bg-card border-border text-muted-foreground'
              }`}
            >
              <div className={`size-2 rounded-full ${col.color}`} />
              {col.label}
              <span className="text-xs font-bold bg-white/60 px-1.5 py-0.5 rounded-full">{count}</span>
            </button>
          )
        })}
      </div>

      {/* Mobile: Show only active tab */}
      <div className="md:hidden flex-1 overflow-y-auto space-y-3">
        {cols.find(c => c.status === mobileTab)?.orders.length === 0 ? (
          <div className="flex items-center justify-center h-32 border-2 border-dashed border-border rounded-xl">
            <p className="text-muted-foreground text-sm">Пусто</p>
          </div>
        ) : (
          cols.find(c => c.status === mobileTab)?.orders.map((order) => (
            <KitchenCard key={order.id} order={order} tablesData={tablesData} menuItems={menuItems} onMove={moveOrder} activeStation={stationFilter} />
          ))
        )}
      </div>

      {/* Desktop: 3-column kanban */}
      <div className="hidden md:grid grid-cols-3 gap-4 flex-1 min-h-0">
        {cols.map((col) => (
          <div key={col.status} className="flex flex-col gap-3 min-h-0">
            {/* Column header */}
            <div className={`flex items-center justify-between px-4 py-3 rounded-xl border ${col.headerBg}`}>
              <div className="flex items-center gap-2">
                <div className={`size-2.5 rounded-full ${col.color}`} />
                <span className="font-semibold text-sm text-foreground">{col.label}</span>
              </div>
              <span className="text-xs font-bold text-foreground bg-white/60 px-2 py-0.5 rounded-full border">
                {col.orders.length}
              </span>
            </div>

            {/* Cards */}
            <div className="flex-1 overflow-y-auto space-y-3 pr-1">
              {col.orders.length === 0 ? (
                <div className="flex items-center justify-center h-32 border-2 border-dashed border-border rounded-xl">
                  <p className="text-muted-foreground text-sm">Пусто</p>
                </div>
              ) : (
                col.orders.map((order) => (
                  <KitchenCard key={order.id} order={order} tablesData={tablesData} menuItems={menuItems} onMove={moveOrder} activeStation={stationFilter} />
                ))
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
