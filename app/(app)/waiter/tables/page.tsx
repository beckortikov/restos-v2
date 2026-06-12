'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Plus, Users, FileEdit, ClipboardList, Trash2, ArrowLeft } from 'lucide-react'
import { useAuth } from '@/lib/auth-store'
import { fetchTables, fetchOrders, fetchZones, fetchUsers } from '@/lib/queries'
import type { Order, Table, Zone, User } from '@/lib/types'
import { listDrafts, onDraftsChange, deleteDraft, type WaiterDraft } from '@/lib/waiter/drafts'
import { formatCurrency, getTimeSince, startOfToday } from '@/lib/helpers'
import { dSum } from '@/lib/decimal'
import { useWaiterViewMode } from '@/lib/waiter/view-mode'
import { useDataSync } from '@/hooks/use-data-sync'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet'

type Tab = 'mine' | 'all'

export default function WaiterTablesPage() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  // selectFor=new — пришли по «Новому заказу»: показываем ВСЕ столы по зонам,
  // тап = перейти на OrderComposer для этого стола (а не на детали заказа).
  const selectForNew = params.get('selectFor') === 'new'
  const [viewMode] = useWaiterViewMode()
  const [tab, setTab] = useState<Tab>('mine')
  const [tables, setTables] = useState<Table[]>([])
  const [orders, setOrders] = useState<Order[]>([])
  const [zones, setZones] = useState<Zone[]>([])
  const [users, setUsers] = useState<User[]>([])
  const [drafts, setDrafts] = useState<WaiterDraft[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      const [t, o, z, u] = await Promise.all([
        fetchTables(),
        // Slim — page only renders order_number/status/total/createdAt and
        // table-related fields. Non-slim pulls payments/discount/comment/
        // tip/cancel_*/printed_at JSON which the cards never use, and at
        // peak with 5 waiters refetching on every NOTIFY this dominates
        // wire + PGlite time.
        fetchOrders({ from: startOfToday(), slim: true }),
        fetchZones(),
        fetchUsers(),
      ])
      // Догружаем заказы открытых столов вне окна «сегодня» (стол открыт более суток).
      const haveIds = new Set(o.map(x => x.id))
      const missingIds = Array.from(new Set(
        t.map(tb => tb.currentOrderId).filter((id): id is string => !!id && !haveIds.has(id))
      ))
      let merged = o
      if (missingIds.length > 0) {
        try {
          const extra = await fetchOrders({ ids: missingIds })
          merged = [...o, ...extra]
        } catch (e) { console.error('[waiter-tables] догрузка:', e) }
      }
      setTables(t); setOrders(merged); setZones(z); setUsers(u)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    // Резервный поллинг на случай если SSE отвалился. Пауза при скрытой вкладке.
    const iv = setInterval(() => { if (!document.hidden) load() }, 8_000)
    // На Android Capacitor WebView SSE может «замирать» когда приложение
    // уходит в фон. При возврате в фронт принудительно подгружаем свежие
    // данные — даже если SSE сам не среагировал.
    const onVisible = () => {
      if (document.visibilityState === 'visible') load()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    return () => {
      clearInterval(iv)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }, [load])

  // RealtimeCacheBridge → invalidateCache → fires 'restos-data-updated' AFTER
  // фоновый refresh догружает свежие данные. useDataSync ловит этот момент и
  // вызывает load() повторно — на этот раз cachedQuery возвращает уже свежий
  // снимок, не stale.
  useDataSync(['tables', 'orders', 'order_items', 'zones', 'users'], load)

  // Drafts (localStorage)
  useEffect(() => {
    const refresh = () => setDrafts(listDrafts(user?.id))
    refresh()
    return onDraftsChange(refresh)
  }, [user?.id])

  // Auto-prune drafts: если стол в БД уже free (кассир закрыл/оплатил
  // заказ), но в localStorage остался черновик с прошлой сессии — удаляем.
  // Без этого карточка стола после закрытия кассиром продолжает висеть как
  // «черновик» до ручной чистки.
  useEffect(() => {
    if (drafts.length === 0 || tables.length === 0) return
    const freeIds = new Set(tables.filter(t => t.status === 'free').map(t => t.id))
    let pruned = false
    for (const d of drafts) {
      if (freeIds.has(d.tableId)) {
        deleteDraft(d.tableId)
        pruned = true
      }
    }
    // onDraftsChange listener сам обновит state.
    void pruned
  }, [drafts, tables])

  // Activity-only view: tables that have open orders OR a local draft.
  // O(1) lookups for the map below — previously `zones.find(...)` and
  // `users.find(...)` ran per table per re-render. With 20 tables × 10 zones
  // × 20 users = 200+ linear scans on every SSE invalidation. Maps reduce it
  // to O(1) per row.
  const zoneById = useMemo(() => new Map(zones.map(z => [z.id, z])), [zones])
  const userById = useMemo(() => new Map(users.map(u => [u.id, u])), [users])

  const cards = useMemo(() => {
    const draftByTable = new Map(drafts.map(d => [d.tableId, d]))
    const ordersByTable = new Map<string, Order[]>()
    for (const o of orders) {
      if (!o.tableId) continue
      if (o.status === 'done' || o.status === 'cancelled') continue
      if (!ordersByTable.has(o.tableId)) ordersByTable.set(o.tableId, [])
      ordersByTable.get(o.tableId)!.push(o)
    }

    const result = tables
      .filter(t => ordersByTable.has(t.id) || draftByTable.has(t.id))
      .map(t => ({
        table: t,
        orders: (ordersByTable.get(t.id) || []).sort(
          (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
        ),
        draft: draftByTable.get(t.id) ?? null,
        zone: t.zone ? zoneById.get(t.zone) : undefined,
        waiter: (() => {
          const myDraft = draftByTable.get(t.id)
          if (myDraft && myDraft.waiterId === user?.id) {
            return userById.get(user?.id || '') ?? null
          }
          const ordersHere = ordersByTable.get(t.id) || []
          const lastOrder = ordersHere[ordersHere.length - 1]
          if (lastOrder?.waiterId) {
            return userById.get(lastOrder.waiterId) ?? null
          }
          return t.waiterId ? userById.get(t.waiterId) ?? null : null
        })(),
      }))
      .sort((a, b) => {
        // Sort by table number ascending, fall back to name when numbers tie.
        const an = Number(a.table.number) || 0
        const bn = Number(b.table.number) || 0
        if (an !== bn) return an - bn
        return String(a.table.name ?? '').localeCompare(String(b.table.name ?? ''))
      })

    if (tab === 'mine') {
      return result.filter(c =>
        (c.draft && c.draft.waiterId === user?.id) ||
        c.orders.some(o => o.waiterId === user?.id)
      )
    }
    return result
  }, [tables, orders, drafts, zoneById, userById, tab, user?.id])

  // Centralised tap dispatcher — shared by both the regular table grid and
  // the "Выберите стол" picker. Single source of truth for "which screen do
  // we navigate to when the waiter taps a table".
  //   • empty table → fresh composer
  //   • single live group → open it directly (no extra tap)
  //   • multiple live groups OR coming from "Новый заказ" with existing
  //     groups → open the GroupPicker sheet so the waiter chooses
  //     (existing group / + new group). Avoids the silent "auto-open first"
  //     bug where Группа 2 was unreachable from /waiter/tables.
  const [groupPicker, setGroupPicker] = useState<{
    tableId: string
    tableName: string
    orders: Order[]
  } | null>(null)

  const handleTableTap = useCallback((tableId: string, opts?: { forceNew?: boolean }) => {
    const ordersOnTable = orders.filter(
      o => o.tableId === tableId && o.status !== 'done' && o.status !== 'cancelled'
    )
    const tableName = tables.find(t => t.id === tableId)?.name ?? 'Стол'
    // "Forced new" flow ("+ Новый заказ" → table picker): even when the
    // table is empty, we want to land on the composer. When the table is
    // busy, the picker lets the waiter choose existing-or-new instead of
    // silently creating a sibling group they may not have wanted.
    if (opts?.forceNew) {
      if (ordersOnTable.length === 0) {
        navigate(`/waiter/order/new?table=${tableId}`)
      } else {
        setGroupPicker({ tableId, tableName, orders: ordersOnTable })
      }
      return
    }
    // Regular tap on a table from the main grid.
    if (ordersOnTable.length === 0) {
      // Empty + may have a draft. Draft handling is the caller's job —
      // keep the existing onClick logic for that.
      return
    }
    if (ordersOnTable.length === 1) {
      navigate(`/waiter/order/${ordersOnTable[0].id}`)
      return
    }
    // 2+ groups → picker.
    setGroupPicker({ tableId, tableName, orders: ordersOnTable })
  }, [navigate, orders, tables])

  // ─── selectFor=new: «Выберите стол» — все столы по зонам, тап = composer ──
  if (selectForNew) {
    return (
      <>
        <SelectTableForNewOrder
          tables={tables}
          zones={zones}
          orders={orders}
          myUserId={user?.id}
          loading={loading}
          onPick={(tableId) => handleTableTap(tableId, { forceNew: true })}
          onClose={() => navigate('/waiter/tables', { replace: true })}
        />
        <TableGroupPickerSheet
          state={groupPicker}
          onClose={() => setGroupPicker(null)}
          onPickExisting={(orderId) => { setGroupPicker(null); navigate(`/waiter/order/${orderId}`) }}
          onPickNew={(tableId) => { setGroupPicker(null); navigate(`/waiter/order/new?table=${tableId}`) }}
        />
      </>
    )
  }

  return (
    <div className="px-3 py-4 space-y-4">
      {/* Tabs */}
      <div className="flex gap-1 bg-muted/50 p-1 rounded-xl">
        <TabButton active={tab === 'mine'} onClick={() => setTab('mine')} label="Мои столы" />
        <TabButton active={tab === 'all'} onClick={() => setTab('all')} label="Все столы" />
      </div>

      {loading && cards.length === 0 ? (
        <div className="space-y-3">
          {[0, 1, 2].map(i => (
            <div key={i} className="h-24 rounded-xl bg-muted/40 animate-pulse" />
          ))}
        </div>
      ) : cards.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <ClipboardList className="size-12 text-muted-foreground/40 mb-3" />
          <p className="text-sm text-muted-foreground">Нет активных столов</p>
          <p className="text-xs text-muted-foreground/70 mt-1">Откройте новый заказ кнопкой ниже</p>
        </div>
      ) : (
        <div className={viewMode === 'grid' ? 'grid grid-cols-2 gap-3' : 'space-y-3'}>
          {cards.map(c => (
            <TableCard
              key={c.table.id}
              tableName={c.table.name}
              zoneName={c.zone?.name}
              waiterName={c.waiter?.name}
              orders={c.orders}
              draft={c.draft}
              compact={viewMode === 'grid'}
              onDeleteDraft={c.draft ? () => {
                import('@/lib/waiter/drafts').then(m => m.deleteDraft(c.table.id))
              } : undefined}
              onClick={() => {
                if (c.draft && c.orders.length === 0) {
                  navigate(`/waiter/order/new?table=${c.table.id}&resume=1`)
                } else if (c.orders.length === 1) {
                  navigate(`/waiter/order/${c.orders[0].id}`)
                } else if (c.orders.length > 1) {
                  // Picker for multi-group tables — was silently opening
                  // the first order, hiding sibling groups from the waiter.
                  handleTableTap(c.table.id)
                }
              }}
            />
          ))}
        </div>
      )}

      {/* FAB — new order: ведёт на «Выберите стол» (все столы по зонам). */}
      <Link
        to="/waiter/tables?selectFor=new"
        className="fixed bottom-[calc(80px+env(safe-area-inset-bottom,0px))] right-4 z-30 inline-flex items-center gap-2 px-5 py-3.5 rounded-full bg-primary text-primary-foreground shadow-lg active:bg-primary/90"
      >
        <Plus className="size-5" />
        <span className="font-medium">Новый заказ</span>
      </Link>

      <TableGroupPickerSheet
        state={groupPicker}
        onClose={() => setGroupPicker(null)}
        onPickExisting={(orderId) => { setGroupPicker(null); navigate(`/waiter/order/${orderId}`) }}
        onPickNew={(tableId) => { setGroupPicker(null); navigate(`/waiter/order/new?table=${tableId}`) }}
      />
    </div>
  )
}

function TabButton({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 h-9 rounded-lg text-sm font-medium transition-colors ${
        active ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground'
      }`}
    >
      {label}
    </button>
  )
}

function TableCard({
  tableName, zoneName, waiterName, orders, draft, compact, onClick, onDeleteDraft,
}: {
  tableName: string
  zoneName?: string
  waiterName?: string
  orders: Order[]
  draft: WaiterDraft | null
  compact?: boolean
  onClick: () => void
  onDeleteDraft?: () => void
}) {
  const isDraftOnly = !!draft && orders.length === 0
  const totalOpen = isDraftOnly
    ? dSum((draft?.lines ?? []).map(l => l.price * (l.unit === 'piece' ? l.qty : (l.qty / (l.unitSize || 1)))))
    : dSum(orders.map(o => o.total))
  const itemsCount = isDraftOnly
    ? (draft?.lines.length ?? 0)
    : orders.reduce((s, o) => s + o.items.filter(i => !i.cancelledAt).length, 0)
  const oldest = isDraftOnly
    ? (draft ? new Date(draft.updatedAt).toISOString() : null)
    : orders.reduce<string | null>((acc, o) => acc && acc < o.createdAt ? acc : o.createdAt, null)
  const hasReady = orders.some(o => o.status === 'ready')
  const hasBillRequested = orders.some(o => o.status === 'bill_requested')
  // Цветовая выделка: жёлтое кольцо когда хоть одна группа готова к выдаче,
  // фиолетовое — когда гость попросил счёт.
  const ringClass = hasBillRequested
    ? 'ring-2 ring-purple-500 border-purple-200'
    : hasReady
      ? 'ring-2 ring-amber-400 border-amber-200'
      : 'border-border'

  // Swipe-to-reveal delete (only for draft-only cards)
  const startX = useRef<number | null>(null)
  const [translateX, setTranslateX] = useState(0)
  const swipable = isDraftOnly && !!onDeleteDraft

  const onTouchStart = (e: React.TouchEvent) => { if (swipable) startX.current = e.touches[0].clientX }
  const onTouchMove = (e: React.TouchEvent) => {
    if (!swipable || startX.current == null) return
    const dx = e.touches[0].clientX - startX.current
    setTranslateX(Math.max(-96, Math.min(0, dx)))
  }
  const onTouchEnd = () => {
    if (!swipable) return
    setTranslateX(translateX < -48 ? -88 : 0)
    startX.current = null
  }

  return (
    <div className="relative">
      {swipable && (
        <button
          onClick={(e) => { e.stopPropagation(); onDeleteDraft?.() }}
          className="absolute right-0 top-0 bottom-0 w-20 rounded-r-xl bg-red-500 text-white flex flex-col items-center justify-center text-xs font-medium active:bg-red-600"
          aria-label="Удалить черновик"
        >
          <Trash2 className="size-5 mb-1" />
          Удалить
        </button>
      )}
      <button
        onClick={onClick}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        style={swipable ? { transform: `translateX(${translateX}px)`, transition: startX.current == null ? 'transform 0.2s' : 'none' } : undefined}
        className={`relative w-full text-left bg-card border rounded-xl p-3 active:bg-muted/30 transition-colors ${ringClass}`}
      >
        {/* Status pill (ready / bill_requested) — corner badge */}
        {(hasReady || hasBillRequested) && (
          <span className={`absolute top-2 right-2 inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide ${
            hasBillRequested ? 'bg-purple-500 text-white' : 'bg-amber-400 text-amber-900'
          }`}>
            {hasBillRequested ? 'Счёт' : 'Готов'}
          </span>
        )}

        {compact ? (
          // Grid-вид: компактная вертикальная раскладка с маленьким fontом для названия
          <div className="space-y-0.5">
            <div className="text-sm font-semibold text-foreground truncate pr-12 flex items-center gap-1.5">
              <span className="truncate">{tableName}</span>
              {orders.length > 1 && (
                // Multi-group badge — surfaces that this table has multiple
                // active groups before tapping. The /waiter/order/[id] tab
                // switcher shows them all once opened, but seeing the count
                // up front saves the waiter a "wait, which group?" round trip.
                <span className="shrink-0 inline-flex items-center px-1.5 py-0.5 rounded-full bg-primary/10 text-primary text-[10px] font-bold tabular-nums">
                  ×{orders.length}
                </span>
              )}
            </div>
            {zoneName && <div className="text-[11px] text-muted-foreground truncate">{zoneName}</div>}
            <div className="flex items-baseline justify-between gap-2 pt-1">
              <span className="text-base font-bold text-foreground">{formatCurrency(totalOpen)}</span>
              <span className="text-[11px] text-muted-foreground">{itemsCount} поз.</span>
            </div>
            <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground/80 pt-0.5">
              {isDraftOnly ? (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 font-medium">
                  <FileEdit className="size-3" />
                  Черновик
                </span>
              ) : waiterName ? (
                <span className="inline-flex items-center gap-1 min-w-0">
                  <Users className="size-2.5 shrink-0" />
                  <span className="truncate">{waiterName}</span>
                </span>
              ) : <span />}
              {oldest && <span className="shrink-0">{getTimeSince(oldest)}</span>}
            </div>
          </div>
        ) : (
          // List-вид: горизонтальная раскладка с приоритетом названия стола
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1 pr-2">
              <div className="text-base font-semibold text-foreground truncate flex items-center gap-1.5">
                <span className="truncate">{tableName}</span>
                {orders.length > 1 && (
                  <span className="shrink-0 inline-flex items-center px-1.5 py-0.5 rounded-full bg-primary/10 text-primary text-[10px] font-bold tabular-nums">
                    ×{orders.length}
                  </span>
                )}
              </div>
              {zoneName && <div className="text-xs text-muted-foreground truncate mt-0.5">{zoneName}</div>}
              {isDraftOnly ? (
                <div className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 text-[11px] font-medium mt-1">
                  <FileEdit className="size-3" />
                  Черновик
                </div>
              ) : waiterName && (
                <div className="text-xs text-muted-foreground flex items-center gap-1 mt-1">
                  <Users className="size-3" />
                  <span className="truncate">{waiterName}</span>
                </div>
              )}
            </div>
            <div className="text-right shrink-0">
              <div className="text-base font-semibold text-foreground">{formatCurrency(totalOpen)}</div>
              <div className="text-[11px] text-muted-foreground">
                {!isDraftOnly && orders.length > 1 ? `${orders.length} гр. · ` : ''}
                {itemsCount} поз.
              </div>
              {oldest && (
                <div className="text-[11px] text-muted-foreground/70 mt-0.5">{getTimeSince(oldest)}</div>
              )}
            </div>
          </div>
        )}
      </button>
    </div>
  )
}

// ─── «Выберите стол» — entry-point для нового заказа ────────────────────────
// Показывает все столы по зонам (включая свободные/занятые) — официант
// тапает любой → /waiter/order/new?table=X. Используются те же данные что
// и в основном /waiter/tables (fetchTables/fetchZones из useOrderData).
function SelectTableForNewOrder({ tables, zones, orders, myUserId, loading, onPick, onClose }: {
  tables: Table[]
  zones: Zone[]
  orders: Order[]
  myUserId: string | undefined
  loading: boolean
  onPick: (tableId: string) => void
  onClose: () => void
}) {
  // Группировка: «Мои столы» (waiter_id = me, статус не free) → топ.
  // «Зал» — обычные столы с zone_id. «С собой» — столы без зоны (или со
  // специальной zone='takeaway') — показываем отдельной секцией внизу.
  // Pre-existing zone-filtering и takeaway tables: пока упрощённо берём
  // все таблицы и группируем по zone.id; столы без зоны идут в «С собой».
  const groups = useMemo(() => {
    const byZone = new Map<string, Table[]>()
    const noZone: Table[] = []
    for (const t of tables) {
      if (!t.zone) noZone.push(t)
      else {
        if (!byZone.has(t.zone)) byZone.set(t.zone, [])
        byZone.get(t.zone)!.push(t)
      }
    }
    const sorted = Array.from(byZone.entries()).map(([zoneId, ts]) => ({
      zone: zones.find(z => z.id === zoneId),
      tables: ts.sort((a, b) => Number(a.number) - Number(b.number) || String(a.name ?? '').localeCompare(String(b.name ?? ''))),
    }))
    sorted.sort((a, b) => String(a.zone?.name ?? '').localeCompare(String(b.zone?.name ?? '')))
    return { byZone: sorted, noZone: noZone.sort((a, b) => Number(a.number) - Number(b.number) || String(a.name ?? '').localeCompare(String(b.name ?? ''))) }
  }, [tables, zones])

  const myTables = useMemo(() => {
    if (!myUserId) return []
    const myIds = new Set<string>()
    for (const o of orders) {
      if (o.waiterId === myUserId && o.status !== 'done' && o.status !== 'cancelled' && o.tableId) {
        myIds.add(o.tableId)
      }
    }
    return tables.filter(t => myIds.has(t.id) || t.waiterId === myUserId)
      .sort((a, b) => Number(a.number) - Number(b.number) || String(a.name ?? '').localeCompare(String(b.name ?? '')))
  }, [tables, orders, myUserId])

  return (
    <div className="px-3 py-4 space-y-5">
      {/* Header */}
      <div className="flex items-center gap-2">
        <button
          onClick={onClose}
          className="size-9 rounded-lg flex items-center justify-center active:bg-muted"
          aria-label="Назад"
        >
          <ArrowLeft className="size-5" />
        </button>
        <div className="flex-1 font-semibold text-base">Выберите стол</div>
      </div>

      {loading && tables.length === 0 ? (
        <div className="space-y-3">
          {[0, 1, 2].map(i => <div key={i} className="h-20 rounded-xl bg-muted/40 animate-pulse" />)}
        </div>
      ) : (
        <>
          {myTables.length > 0 && (
            <section>
              <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2 px-1">Мои столы</div>
              <div className="grid grid-cols-3 gap-3">
                {myTables.map(t => (
                  <TablePickButton key={t.id} table={t} highlight onClick={() => onPick(t.id)} />
                ))}
              </div>
            </section>
          )}

          {groups.byZone.map((g, gi) => (
            <section key={g.zone?.id || gi}>
              <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2 px-1">
                {g.zone?.name || 'Зал'}
              </div>
              <div className="grid grid-cols-3 gap-3">
                {g.tables.map(t => (
                  <TablePickButton key={t.id} table={t} onClick={() => onPick(t.id)} />
                ))}
              </div>
            </section>
          ))}

          {groups.noZone.length > 0 && (
            <section>
              <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2 px-1">С собой</div>
              <div className="grid grid-cols-3 gap-3">
                {groups.noZone.map(t => (
                  <TablePickButton key={t.id} table={t} onClick={() => onPick(t.id)} />
                ))}
              </div>
            </section>
          )}

          {tables.length === 0 && (
            <div className="py-12 text-center text-sm text-muted-foreground">
              Нет доступных столов. Создайте столы и зоны на десктопе.
            </div>
          )}
        </>
      )}
    </div>
  )
}

function TablePickButton({ table, onClick, highlight }: { table: Table; onClick: () => void; highlight?: boolean }) {
  const isFree = table.status === 'free'
  return (
    <button
      onClick={onClick}
      className={`aspect-square rounded-2xl border-2 flex items-center justify-center text-xl font-bold active:scale-95 transition-all shadow-sm ${
        highlight
          ? 'bg-primary text-primary-foreground border-primary'
          : isFree
            ? 'bg-card border-border text-foreground'
            : 'bg-amber-50 border-amber-300 text-amber-700'
      }`}
    >
      {table.name || table.number}
    </button>
  )
}

// ─── TableGroupPicker bottom-sheet ────────────────────────────────────────
//
// Surfaces when a waiter taps a multi-group table OR picks a busy table
// from the "new order" flow. Lists every live group on the table with key
// metadata (total, items, time) plus a primary "+ Новая группа" CTA so the
// same sheet covers both paths: switch to an existing tab, or start a new
// one. Auto-dismisses on either tap (state cleared by the parent).
function TableGroupPickerSheet({
  state, onClose, onPickExisting, onPickNew,
}: {
  state: { tableId: string; tableName: string; orders: Order[] } | null
  onClose: () => void
  onPickExisting: (orderId: string) => void
  onPickNew: (tableId: string) => void
}) {
  return (
    <Sheet open={!!state} onOpenChange={(o) => { if (!o) onClose() }}>
      <SheetContent side="bottom" className="rounded-t-2xl p-0 flex flex-col max-h-[80vh]">
        <SheetHeader className="px-5 py-4 border-b border-border">
          <SheetTitle className="text-base">{state?.tableName ?? 'Стол'} — выберите группу</SheetTitle>
          <SheetDescription className="text-xs">
            {state ? `${state.orders.length} активных групп(ы) на этом столе` : ''}
          </SheetDescription>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
          {state?.orders.map((o, i) => {
            const label = o.tabLabel || `Группа ${i + 1}`
            const itemsCount = o.items.filter(it => !it.cancelledAt).length
            const since = o.createdAt ? getTimeSince(o.createdAt) : ''
            const num = o.orderNumber ? `#${o.orderNumber}` : `#${o.id.slice(-4)}`
            const isReady = o.status === 'ready'
            const isBill = o.status === 'bill_requested'
            return (
              <button
                key={o.id}
                onClick={() => onPickExisting(o.id)}
                className={`w-full text-left rounded-xl border-2 px-4 py-3 active:bg-muted/30 transition-colors ${
                  isBill ? 'border-purple-300 bg-purple-50' :
                  isReady ? 'border-amber-300 bg-amber-50' :
                  'border-border bg-card'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-base font-semibold text-foreground">{label}</span>
                  {(isReady || isBill) && (
                    <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded-full ${
                      isBill ? 'bg-purple-500 text-white' : 'bg-amber-400 text-amber-900'
                    }`}>
                      {isBill ? 'Счёт' : 'Готов'}
                    </span>
                  )}
                </div>
                <div className="mt-0.5 text-xs text-muted-foreground tabular-nums">
                  {num} · {formatCurrency(o.total)} · {itemsCount} поз{since ? ` · ${since}` : ''}
                </div>
              </button>
            )
          })}
        </div>
        {/* Primary CTA pinned at bottom — equally accessible whether the
            waiter wants an existing tab or a fresh group. */}
        <div className="border-t border-border px-4 py-3 pb-[calc(env(safe-area-inset-bottom,0px)+12px)]">
          <button
            onClick={() => state && onPickNew(state.tableId)}
            className="w-full h-12 rounded-xl border-2 border-dashed border-primary/60 bg-primary/5 text-primary text-base font-semibold inline-flex items-center justify-center gap-2 active:bg-primary/10 transition-colors"
          >
            <Plus className="size-5" />
            Новая группа
          </button>
        </div>
      </SheetContent>
    </Sheet>
  )
}
