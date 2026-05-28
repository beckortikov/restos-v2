'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ClipboardList, Loader2, Plus } from 'lucide-react'
import { useAuth } from '@/lib/auth-store'
import { fetchOrders, fetchTables } from '@/lib/queries'
import type { Order, Table } from '@/lib/types'
import { ORDER_STATUS_LABELS } from '@/lib/types'
import { formatCurrency, getTimeSince, startOfToday } from '@/lib/helpers'
import { useWaiterViewMode } from '@/lib/waiter/view-mode'
import { useDataSync } from '@/hooks/use-data-sync'

type Filter = 'mine' | 'all'

export default function WaiterOrdersPage() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const [viewMode] = useWaiterViewMode()
  const [orders, setOrders] = useState<Order[]>([])
  const [tables, setTables] = useState<Table[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<Filter>('mine')

  const load = useCallback(async () => {
    try {
      // Slim — list cards only show order_number/status/total/createdAt/
      // tabLabel + tableId. Non-slim pulled payments/discount_*/cancel_*
      // JSON for nothing.
      const [o, t] = await Promise.all([fetchOrders({ from: startOfToday(), slim: true }), fetchTables()])
      setOrders(o); setTables(t)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    // Aligned with /waiter/tables (8s) so the two tabs stay in sync when
    // SSE drops. Previously orders polled every 60s while tables every 8s
    // — same waiter would see a stale "my order" 50s after the table
    // already updated.
    const iv = setInterval(load, 8_000)
    return () => clearInterval(iv)
  }, [load])

  useDataSync(['orders', 'order_items', 'tables'], load)

  const list = useMemo(() => {
    const active = orders.filter(o => o.status !== 'done' && o.status !== 'cancelled')
    const mine = filter === 'mine' ? active.filter(o => o.waiterId === user?.id) : active
    return mine.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
  }, [orders, filter, user?.id])

  // O(1) table lookup inside the list render. Previously `tables.find(...)`
  // ran once per row per re-render — O(orders × tables) on every SSE event.
  const tableById = useMemo(() => new Map(tables.map(t => [t.id, t])), [tables])

  return (
    <div className="px-3 py-4 space-y-4">
      <div className="flex gap-1 bg-muted/50 p-1 rounded-xl">
        <button
          onClick={() => setFilter('mine')}
          className={`flex-1 h-9 rounded-lg text-sm font-medium transition-colors ${
            filter === 'mine' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground'
          }`}
        >
          Мои
        </button>
        <button
          onClick={() => setFilter('all')}
          className={`flex-1 h-9 rounded-lg text-sm font-medium transition-colors ${
            filter === 'all' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground'
          }`}
        >
          Все
        </button>
      </div>

      {loading && list.length === 0 ? (
        <div className="flex justify-center py-10"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>
      ) : list.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <ClipboardList className="size-12 text-muted-foreground/40 mb-3" />
          <p className="text-sm text-muted-foreground">Нет активных заказов</p>
        </div>
      ) : (
        <div className={viewMode === 'grid' ? 'grid grid-cols-2 gap-3' : 'space-y-3'}>
          {list.map(o => {
            const t = o.tableId ? tableById.get(o.tableId) : undefined
            const itemsCount = o.items.filter(i => !i.cancelledAt).length
            const isReady = o.status === 'ready'
            const isBill = o.status === 'bill_requested'
            const ringClass = isBill
              ? 'ring-2 ring-purple-500 border-purple-200'
              : isReady
                ? 'ring-2 ring-amber-400 border-amber-200'
                : 'border-border'
            return (
              <button
                key={o.id}
                onClick={() => navigate(`/waiter/order/${o.id}`)}
                className={`relative w-full text-left bg-card border rounded-xl p-3 active:bg-muted/30 ${ringClass}`}
              >
                {(isReady || isBill) && (
                  <span className={`absolute top-2 right-2 inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide ${
                    isBill ? 'bg-purple-500 text-white' : 'bg-amber-400 text-amber-900'
                  }`}>
                    {isBill ? 'Счёт' : 'Готов'}
                  </span>
                )}
                {viewMode === 'grid' ? (
                  <div className="space-y-0.5">
                    <div className="text-sm font-semibold text-foreground truncate pr-12">
                      {t?.name ?? '—'}
                    </div>
                    {o.tabLabel && <div className="text-[11px] text-muted-foreground truncate">{o.tabLabel}</div>}
                    <div className="flex items-baseline justify-between gap-2 pt-1">
                      <span className="text-base font-bold text-foreground">{formatCurrency(o.total)}</span>
                      <span className="text-[11px] text-muted-foreground">{itemsCount} поз.</span>
                    </div>
                    <div className="flex items-center justify-between text-[10px] text-muted-foreground/80 pt-0.5">
                      <span className="truncate">{o.orderNumber ? `#${o.orderNumber} · ` : ''}{ORDER_STATUS_LABELS[o.status]}</span>
                      <span className="shrink-0">{getTimeSince(o.createdAt)}</span>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-start justify-between gap-3 pr-12">
                    <div className="min-w-0 flex-1">
                      <div className="text-base font-semibold text-foreground truncate">
                        {t?.name ?? '—'}
                        {o.tabLabel && <span className="text-muted-foreground font-normal text-sm"> · {o.tabLabel}</span>}
                      </div>
                      <div className="text-xs text-muted-foreground mt-0.5 truncate">
                        {o.orderNumber ? `#${o.orderNumber} · ` : ''}{ORDER_STATUS_LABELS[o.status]}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-base font-semibold text-foreground">{formatCurrency(o.total)}</div>
                      <div className="text-[11px] text-muted-foreground">{itemsCount} поз.</div>
                      <div className="text-[11px] text-muted-foreground/70 mt-0.5">{getTimeSince(o.createdAt)}</div>
                    </div>
                  </div>
                )}
              </button>
            )
          })}
        </div>
      )}

      {/* FAB — same placement / styling as on /waiter/tables so the waiter
          can start a new order from either tab without going back. Links to
          the table picker so they pick the table first. */}
      <Link
        to="/waiter/tables?selectFor=new"
        className="fixed bottom-[calc(80px+env(safe-area-inset-bottom,0px))] right-4 z-30 inline-flex items-center gap-2 px-5 py-3.5 rounded-full bg-primary text-primary-foreground shadow-lg active:bg-primary/90"
      >
        <Plus className="size-5" />
        <span className="font-medium">Новый заказ</span>
      </Link>
    </div>
  )
}
