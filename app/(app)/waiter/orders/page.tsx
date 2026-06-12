'use client'

import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ClipboardList, Loader2, Plus } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { useAuth } from '@/lib/auth-store'
import { fetchOrders } from '@/lib/queries'
import type { Order } from '@/lib/types'
import { ORDER_STATUS_LABELS } from '@/lib/types'
import { queryKeys } from '@/lib/query-client'
import { useTables } from '@/hooks/queries'
import { formatCurrency, getTimeSince, startOfToday } from '@/lib/helpers'
import { useWaiterViewMode } from '@/lib/waiter/view-mode'

type Filter = 'mine' | 'all'

export default function WaiterOrdersPage() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const [viewMode] = useWaiterViewMode()
  const [filter, setFilter] = useState<Filter>('mine')

  // v3.9.21: data-слой на React Query. SSE инвалидирует через
  // useQuerySseBridge. refetchInterval 8с — страховка для Android Capacitor
  // WebView, где SSE может «замёрзнуть» в фоне (refetchOnWindowFocus off).
  const ordersQuery = useQuery({
    queryKey: [...queryKeys.orders.list('waiter'), 'slim'],
    queryFn: () => fetchOrders({ from: startOfToday(), slim: true }),
    refetchInterval: 8_000,
  })
  const orders = useMemo(() => ordersQuery.data ?? [], [ordersQuery.data])
  const { data: tables = [] } = useTables({ refetchInterval: 8_000 })
  const loading = ordersQuery.isLoading

  const list = useMemo(() => {
    // v2.1.2: дополнительно скрываем zombie-заказы (status=active, но все
    // позиции отменены). Backend invariant из v2.1.1 + миграция 016 их чистит,
    // но UI-фильтр — последняя линия обороны на случай рейс/race.
    const active = orders.filter(o => {
      if (o.status === 'done' || o.status === 'cancelled') return false
      const alive = o.aliveItemsCount ?? o.items.filter(i => !i.cancelledAt).length
      return alive > 0
    })
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
