'use client'

// History-таб «Заказы» — заказы за выбранный период с фильтрами по статусу,
// типу, кассиру, официанту. Без SSE-realtime (это исторические данные).
// Cursor-based pagination через next_cursor.

import { useState, useEffect, useCallback, useMemo } from 'react'
import { Search, FileDown, Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import { useAuth } from '@/lib/auth-store'
import { startOfDay, endOfDay, formatCurrency } from '@/lib/helpers'
import {
  type Order, type OrderVoid, type Table, type User,
} from '@/lib/types'
import {
  fetchOrdersWithCursor, fetchOrders, fetchTables, fetchUsers, fetchVoidsForOrders,
} from '@/lib/queries'
import { exportOrdersToXlsx } from '@/lib/orders-export'
import { DateRangePresets, getPresetRange, readStoredPreset, type RangePreset } from '@/components/finance/date-range-presets'
import { OrderActionsDialog } from '@/components/dialogs/order-actions-dialog'

import { OrderCard, OrderRow, VirtualOrderCards, VirtualOrderRows } from './order-row'

const STATUS_FILTER: { value: 'all' | 'done' | 'cancelled'; label: string }[] = [
  { value: 'all', label: 'Все' },
  { value: 'done', label: 'Закрытые' },
  { value: 'cancelled', label: 'Отменённые' },
]

const TYPE_FILTER: { value: 'all' | 'hall' | 'takeaway' | 'delivery'; label: string }[] = [
  { value: 'all', label: 'Все' },
  { value: 'hall', label: 'Зал' },
  { value: 'takeaway', label: 'С собой' },
  { value: 'delivery', label: 'Доставка' },
]

const PAGE_LIMIT = 100
const STORAGE_KEY = 'restos.orders.history.preset'

function parseYmdToDate(s: string, end = false): Date {
  // s = 'YYYY-MM-DD' (local). Use start/end of day in local TZ.
  const [y, m, d] = s.split('-').map(Number)
  const dt = new Date(y, (m ?? 1) - 1, d ?? 1)
  return end ? endOfDay(dt) : startOfDay(dt)
}

export function HistoryOrdersTab() {
  const { restaurant } = useAuth()
  const servicePercent = restaurant?.servicePercent

  const initialPreset: RangePreset = typeof window !== 'undefined' ? readStoredPreset(STORAGE_KEY, 'month') : 'month'
  const initialRange = useMemo(() => getPresetRange(initialPreset), [initialPreset])

  const [preset, setPreset] = useState<RangePreset>(initialPreset)
  const [customFrom, setCustomFrom] = useState(initialRange.from)
  const [customTo, setCustomTo] = useState(initialRange.to)
  const [range, setRange] = useState<{ from: string; to: string }>(initialRange)

  const [statusFilter, setStatusFilter] = useState<'all' | 'done' | 'cancelled'>('all')
  const [typeFilter, setTypeFilter] = useState<'all' | 'hall' | 'takeaway' | 'delivery'>('all')
  const [cashierId, setCashierId] = useState<string>('')
  const [waiterId, setWaiterId] = useState<string>('')
  const [search, setSearch] = useState('')

  const [orders, setOrders] = useState<Order[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [voidsByOrderId, setVoidsByOrderId] = useState<Map<string, OrderVoid[]>>(() => new Map())
  const [tablesData, setTablesData] = useState<Table[]>([])
  const [usersData, setUsersData] = useState<User[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [exporting, setExporting] = useState(false)

  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null)
  const [actionsDialogOpen, setActionsDialogOpen] = useState(false)

  // Initial static data
  useEffect(() => {
    Promise.all([fetchTables(), fetchUsers()])
      .then(([t, u]) => { setTablesData(t); setUsersData(u) })
      .catch(() => {})
  }, [])

  const load = useCallback(async (opts?: { append?: boolean; cursor?: string }) => {
    const from = parseYmdToDate(range.from)
    const to = parseYmdToDate(range.to, true)
    const status = statusFilter === 'all' ? undefined : statusFilter
    const type = typeFilter === 'all' ? undefined : typeFilter

    if (!opts?.append) setLoading(true); else setLoadingMore(true)
    try {
      const r = await fetchOrdersWithCursor({
        from, to,
        status, type,
        waiterId: waiterId || undefined,
        cashierId: cashierId || undefined,
        slim: true,
        limit: PAGE_LIMIT,
        cursor: opts?.cursor,
      })
      setOrders(prev => opts?.append ? [...prev, ...r.orders] : r.orders)
      setNextCursor(r.nextCursor)

      // voids — батч-загрузка по видимым заказам
      const allIds = (opts?.append ? [...orders, ...r.orders] : r.orders).map(o => o.id)
      if (allIds.length > 0) {
        fetchVoidsForOrders(allIds).then(setVoidsByOrderId).catch(() => {})
      } else {
        setVoidsByOrderId(new Map())
      }
    } catch (e) {
      console.error('[history] load failed:', e)
      toast.error(e instanceof Error ? e.message : 'Ошибка загрузки')
    } finally {
      setLoading(false)
      setLoadingMore(false)
    }
    // orders intentionally omitted from deps — мы используем его только в append-режиме
    // через freshest reference, append триггерится отдельным action'ом.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.from, range.to, statusFilter, typeFilter, waiterId, cashierId])

  useEffect(() => { load() }, [load])

  const cashiers = useMemo(
    () => usersData.filter(u => u.role === 'cashier' || u.role === 'manager' || u.role === 'owner'),
    [usersData],
  )
  const waiters = useMemo(
    () => usersData.filter(u => u.role === 'waiter' || u.role === 'manager'),
    [usersData],
  )

  const tablesById = useMemo(() => {
    const m = new Map<string, Table>()
    for (const t of tablesData) m.set(t.id, t)
    return m
  }, [tablesData])

  const filtered = useMemo(() => {
    if (!search) return orders
    const q = search.toLowerCase()
    return orders.filter(o => {
      const numStr = String(o.orderNumber ?? '')
      const table = o.tableId ? tablesById.get(o.tableId) : null
      return o.id.includes(search) || numStr.includes(search) || (table?.name ?? '').toLowerCase().includes(q)
    })
  }, [orders, search, tablesById])

  const kpi = useMemo(() => {
    let revenue = 0
    let cancelled = 0
    let closedCount = 0
    for (const o of orders) {
      if (o.status === 'done') {
        revenue += Number(o.totalWithService ?? o.total ?? 0)
        closedCount++
      } else if (o.status === 'cancelled') {
        cancelled += Number(o.total ?? 0)
      }
    }
    const avg = closedCount > 0 ? revenue / closedCount : 0
    return { total: orders.length, revenue, avg, cancelled }
  }, [orders])

  const handleOpenOrder = useCallback(async (order: Order) => {
    setSelectedOrder(order)
    setActionsDialogOpen(true)
    try {
      const full = await fetchOrders({ ids: [order.id], slim: false })
      if (full[0]) setSelectedOrder(full[0])
    } catch (e) {
      console.error('[history] load full order failed:', e)
    }
  }, [])

  const handleExport = async () => {
    if (filtered.length === 0) { toast.info('Нет заказов для экспорта'); return }
    setExporting(true)
    try {
      // Догружаем все страницы (если cursor не пуст), затем шлём в xlsx.
      let all = [...orders]
      let cursor = nextCursor
      while (cursor) {
        const from = parseYmdToDate(range.from)
        const to = parseYmdToDate(range.to, true)
        const r = await fetchOrdersWithCursor({
          from, to,
          status: statusFilter === 'all' ? undefined : statusFilter,
          type: typeFilter === 'all' ? undefined : typeFilter,
          waiterId: waiterId || undefined,
          cashierId: cashierId || undefined,
          slim: true,
          limit: PAGE_LIMIT,
          cursor,
        })
        all = [...all, ...r.orders]
        cursor = r.nextCursor
        if (all.length > 10000) break // safety bound
      }
      const voids = await fetchVoidsForOrders(all.map(o => o.id)).catch(() => new Map())
      exportOrdersToXlsx(all, {
        tables: tablesData, users: usersData, voidsByOrderId: voids,
        filenameSuffix: `${range.from}_${range.to}`,
      })
      toast.success(`Выгружено заказов: ${all.length}`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка экспорта')
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="space-y-4 md:space-y-5">
      <div className="sticky top-[52px] z-10 -mx-4 px-4 pt-3 pb-3 md:-mx-6 md:px-6 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 border-b border-border space-y-3">
        {/* Date range + actions */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <DateRangePresets
            value={preset}
            onChange={(p, r) => { setPreset(p); setRange(r); if (p === 'custom') { setCustomFrom(r.from); setCustomTo(r.to) } }}
            customFrom={customFrom}
            customTo={customTo}
            onCustomFromChange={(v) => { setCustomFrom(v); setRange(r => ({ ...r, from: v })) }}
            onCustomToChange={(v) => { setCustomTo(v); setRange(r => ({ ...r, to: v })) }}
            storageKey={STORAGE_KEY}
          />
          <button
            onClick={handleExport}
            disabled={exporting || loading}
            className="inline-flex items-center gap-2 bg-card border border-border text-foreground px-3 py-2 rounded-lg text-sm font-medium hover:bg-muted transition-colors disabled:opacity-50"
          >
            {exporting ? <Loader2 className="size-4 animate-spin" /> : <FileDown className="size-4" />}
            Excel
          </button>
        </div>

        {/* KPI line */}
        <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
          <span>Всего: <b className="text-foreground">{kpi.total}</b></span>
          <span>· Выручка: <b className="text-emerald-700">{formatCurrency(kpi.revenue)}</b></span>
          <span>· Средний чек: <b className="text-foreground">{formatCurrency(kpi.avg)}</b></span>
          <span>· Отменено: <b className="text-rose-700">{formatCurrency(kpi.cancelled)}</b></span>
        </div>

        {/* Filters row */}
        <div className="flex flex-col md:flex-row md:items-center gap-2 md:gap-3 flex-wrap">
          <div className="relative">
            <Search className="size-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              placeholder="Поиск по №..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8 pr-4 py-2 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30 w-full md:w-48"
            />
          </div>

          <div className="flex items-center gap-1 bg-card border border-border rounded-lg p-1">
            {STATUS_FILTER.map(f => (
              <button
                key={f.value}
                onClick={() => setStatusFilter(f.value)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                  statusFilter === f.value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-1 bg-card border border-border rounded-lg p-1">
            {TYPE_FILTER.map(f => (
              <button
                key={f.value}
                onClick={() => setTypeFilter(f.value)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                  typeFilter === f.value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>

          <select
            value={cashierId}
            onChange={e => setCashierId(e.target.value)}
            className="px-3 py-2 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
          >
            <option value="">Все кассиры</option>
            {cashiers.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>

          <select
            value={waiterId}
            onChange={e => setWaiterId(e.target.value)}
            className="px-3 py-2 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
          >
            <option value="">Все официанты</option>
            {waiters.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </div>
      </div>

      {/* Mobile cards */}
      <div className="md:hidden">
        {loading && orders.length === 0 ? (
          <div className="space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="bg-card rounded-xl border border-border p-4 h-24 animate-pulse" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <p className="text-muted-foreground text-sm text-center py-10">Заказов не найдено</p>
        ) : filtered.length > 50 ? (
          <VirtualOrderCards orders={filtered} tablesData={tablesData} usersData={usersData} voidsByOrderId={voidsByOrderId} servicePercent={servicePercent} onOpen={handleOpenOrder} />
        ) : (
          <div className="space-y-3">
            {filtered.map(o => (
              <OrderCard key={o.id} order={o} tablesData={tablesData} usersData={usersData} voids={voidsByOrderId.get(o.id)} servicePercent={servicePercent} onOpen={handleOpenOrder} />
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
                  {['#', 'Статус', 'Стол/Тип', 'Позиций', 'Сумма', 'Официант', 'Время', 'Оплата'].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wide whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(o => (
                  <OrderRow key={o.id} order={o} tablesData={tablesData} usersData={usersData} voids={voidsByOrderId.get(o.id)} servicePercent={servicePercent} onOpen={handleOpenOrder} />
                ))}
                {filtered.length === 0 && !loading && (
                  <tr><td colSpan={8} className="px-4 py-10 text-center text-muted-foreground text-sm">Заказов не найдено</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Pagination */}
      {nextCursor && (
        <div className="flex justify-center">
          <button
            onClick={() => load({ append: true, cursor: nextCursor })}
            disabled={loadingMore}
            className="inline-flex items-center gap-2 bg-card border border-border text-foreground px-4 py-2 rounded-lg text-sm font-medium hover:bg-muted transition-colors disabled:opacity-50"
          >
            {loadingMore ? <Loader2 className="size-4 animate-spin" /> : null}
            Показать ещё
          </button>
        </div>
      )}

      <OrderActionsDialog
        order={selectedOrder}
        open={actionsDialogOpen}
        onOpenChange={setActionsDialogOpen}
        onAction={() => { /* история — read-only; действия отключены */ }}
        onItemsChanged={() => { load().catch(console.error) }}
      />
    </div>
  )
}
