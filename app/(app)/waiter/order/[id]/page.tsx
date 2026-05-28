'use client'

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Plus, X, Loader2, Ban, ChevronLeft, CheckCircle2, Receipt, Search, MapPin, Printer } from 'lucide-react'
import { useAuth } from '@/lib/auth-store'
import { fetchOrders, fetchTables, fetchZones, fetchUsers, fetchMenuItems, addItemsToOrder, updateOrderTable, cancelOrderItem, cancelOrderItemPartial, cancelOrder, updateOrderStatus, fetchRestaurantById, markItemServed, unmarkItemServed, assignWaiter, fetchVoidsForOrder } from '@/lib/queries'
import type { Order, OrderItem, Table, Zone, User, MenuItem } from '@/lib/types'
import { formatCurrency, formatQty, calcLineTotal, getTimeSince, visibleReceiptItems } from '@/lib/helpers'
import { useDataSync } from '@/hooks/use-data-sync'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle,
} from '@/components/ui/sheet'
import { toast } from 'sonner'
import { WeightInputSheet } from '@/components/dialogs/weight-input-sheet'
import { PrintReceipt, type ReceiptData } from '@/components/print-receipt'

const CANCEL_REASONS = [
  'Клиент отменил',
  'Кухня отменила',
  'Ошибка официанта',
  'Нет ингредиента',
] as const

export default function WaiterOrderDetailPage() {
  const { id: orderId } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { user } = useAuth()

  const [orders, setOrders] = useState<Order[]>([])
  const [tables, setTables] = useState<Table[]>([])
  const [zones, setZones] = useState<Zone[]>([])
  const [users, setUsers] = useState<User[]>([])
  const [loading, setLoading] = useState(true)
  const [activeId, setActiveId] = useState<string>(orderId || '')
  const [cancelItemId, setCancelItemId] = useState<string | null>(null)
  // Когда у позиции qty>1 (или вес > unitSize), сначала спрашиваем
  // сколько отменить — pending хранит уже выбранное значение qtyDelta.
  const [cancelQtyDelta, setCancelQtyDelta] = useState<number | null>(null)
  const [portionPickerItem, setPortionPickerItem] = useState<OrderItem | null>(null)
  const [cancelOrderOpen, setCancelOrderOpen] = useState(false)
  const [transferOpen, setTransferOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  // Pre-check preview drawer — same UX as cashier's OrderActionsPanel. Build
  // ReceiptData → open the sheet → waiter shows the customer on screen → tap
  // «Печать» to actually send to the printer (toast-warns if no printer).
  // Without this drawer the waiter taps «Печать пре-чека», a printer-config
  // toast appears, and they have nothing to show the guest.
  const [receiptPreview, setReceiptPreview] = useState<ReceiptData | null>(null)
  const [receiptOpen, setReceiptOpen] = useState(false)
  const [printing, setPrinting] = useState(false)
  const receiptRef = useRef<HTMLDivElement>(null)

  // Inline-search для дозаказа: поиск по меню → тап → addItemsToOrder.
  const [menuItems, setMenuItems] = useState<MenuItem[]>([])
  const [search, setSearch] = useState('')
  const [adding, setAdding] = useState<string | null>(null)

  // Весовое блюдо в дозаказе: открываем тот же WeightInputSheet, что и в композере.
  const [weightItem, setWeightItem] = useState<MenuItem | null>(null)
  const [weightValue, setWeightValue] = useState<number>(0)

  // Смена стола заказа.
  const [moveTableOpen, setMoveTableOpen] = useState(false)
  const [movingTable, setMovingTable] = useState(false)

  // Caches the active order's tableId across reloads so SSE refetches stay
  // scoped to that table (multi-group siblings load in one query). Reset
  // when the URL's orderId changes so navigating between orders on different
  // tables doesn't carry stale state.
  const currentTableIdRef = useRef<string | null>(null)

  useEffect(() => {
    setActiveId(orderId || '')
    currentTableIdRef.current = null // reset so the next load discovers the new tableId
  }, [orderId])

  const load = useCallback(async () => {
    try {
      // Slim — order detail renders item lists + total + status; the heavy
      // JSON columns (payments, discount_*, cancel_*, comment, printed_at)
      // are unused here. At peak with 5 waiters polling + SSE refetches,
      // non-slim adds ~3-5× wire payload for no UI benefit.
      //
      // Orders query is scoped to either the active order id (no tableId
      // known yet) or the whole table (multi-group support — the tabs
      // switcher needs every live order on the same table, not just the
      // active one). currentTableIdRef caches the table across reloads so
      // SSE refetches and the 60s rescue interval stay cheap.
      const cachedTableId = currentTableIdRef.current
      const ordersPromise = cachedTableId
        ? fetchOrders({ tableId: cachedTableId, slim: true })
        : activeId
          ? fetchOrders({ ids: [activeId], slim: true })
          : fetchOrders({ slim: true })
      const [o, t, z, u] = await Promise.all([
        ordersPromise, fetchTables(), fetchZones(), fetchUsers(),
      ])
      // If we just discovered the tableId for the first time, cache it and
      // do one extra fetch to pull siblings. Without this, the very first
      // load of a multi-group table would render with just the active
      // order's tab visible until the next SSE event fires.
      let effectiveOrders = o
      if (!cachedTableId) {
        const active = o.find(x => x.id === activeId)
        if (active?.tableId) {
          currentTableIdRef.current = active.tableId
          effectiveOrders = await fetchOrders({ tableId: active.tableId, slim: true })
        }
      }
      setOrders(effectiveOrders); setTables(t); setZones(z); setUsers(u)
    } finally {
      setLoading(false)
    }
  }, [activeId])

  useEffect(() => {
    load()
    const iv = setInterval(load, 60_000)
    return () => clearInterval(iv)
  }, [load])

  useDataSync(['orders', 'order_items', 'tables', 'zones', 'users'], load)

  // Подгружаем меню для inline-поиска (cached SWR — не блокирует первый рендер).
  useEffect(() => {
    fetchMenuItems().then(setMenuItems).catch(() => {})
  }, [])

  // Service% по умолчанию заведения — нужно показывать «Итого с обслуживанием»
  // даже когда у заказа в БД ещё не записан servicePercent (старые / в ходе создания).
  const [restaurantServicePercent, setRestaurantServicePercent] = useState<number>(0)
  useEffect(() => {
    if (!user?.restaurantId) return
    fetchRestaurantById(user.restaurantId)
      .then(r => setRestaurantServicePercent(r?.servicePercent || 0))
      .catch(() => {})
  }, [user?.restaurantId])

  const order = useMemo(() => orders.find(o => o.id === activeId) || null, [orders, activeId])
  const tabs = useMemo(() => {
    if (!order?.tableId) return [order].filter(Boolean) as Order[]
    return orders
      .filter(o => o.tableId === order.tableId && o.status !== 'done' && o.status !== 'cancelled')
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
  }, [orders, order])

  // Inline-search: фильтр по названию.
  // ВАЖНО: useMemo и любые другие хуки ОБЯЗАНЫ быть ВЫШЕ ранних `return`,
  // иначе React видит разное число hooks между рендерами (loading/!order)
  // и падает с #310 «Rendered fewer hooks than expected».
  // Тяжёлая фильтрация меню откладывается через useDeferredValue: input
  // обновляет `search` мгновенно, но фильтр пересчитывается только при
  // паузе в наборе. Убирает лаг на мобильном при наборе названия блюда.
  const deferredSearch = useDeferredValue(search)
  const searchResults = useMemo(() => {
    const q = deferredSearch.trim().toLowerCase()
    if (!q || !order) return []
    return menuItems
      .filter(m => m.isAvailable !== false && (m.name?.toLowerCase().includes(q)))
      .slice(0, 8)
  }, [menuItems, deferredSearch, order])

  if (loading && !order) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="size-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!order) {
    return (
      <div className="px-4 py-12 text-center">
        <p className="text-muted-foreground mb-4">Заказ не найден</p>
        <Link to="/waiter/tables" className="inline-flex items-center gap-1 text-primary text-sm">
          <ChevronLeft className="size-4" /> К столам
        </Link>
      </div>
    )
  }

  const table = order.tableId ? tables.find(t => t.id === order.tableId) : null
  const zone = table?.zone ? zones.find(z => z.id === table.zone) : null
  const waiter = order.waiterId ? users.find(u => u.id === order.waiterId) : null
  const liveItems = order.items.filter(i => !i.cancelledAt)

  async function doCancelItem(reason: string) {
    if (!cancelItemId || !user) return
    setBusy(true)
    try {
      const result = (cancelQtyDelta && cancelQtyDelta > 0)
        ? await cancelOrderItemPartial(cancelItemId, cancelQtyDelta, reason, user.id)
        : await cancelOrderItem(cancelItemId, reason, user.id)
      toast.success(cancelQtyDelta && cancelQtyDelta > 0 ? 'Часть позиции отменена' : 'Позиция отменена')
      // Точечный refetch именно отменённого заказа — без тяги всей истории.
      const targetId = result.orderId
      const fresh = await fetchOrders({ ids: [targetId], slim: true })
      const updated = fresh[0]
      if (updated) setOrders(prev => prev.map(o => o.id === targetId ? updated : o))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка отмены')
    } finally {
      setBusy(false)
      setCancelItemId(null)
      setCancelQtyDelta(null)
    }
  }

  // Обработка тапа «×» на позиции: если qty>1 (piece) или > unitSize (g/kg),
  // открыть промежуточный диалог «сколько отменить?». Иначе сразу причину.
  function handleCancelItem(item: OrderItem) {
    if (!item.id) return
    const portion = item.unit && item.unit !== 'piece' ? (item.unitSize || 1) : 1
    const isMultiPortion = Number(item.qty) > portion + 0.0001
    if (isMultiPortion) {
      setPortionPickerItem(item)
    } else {
      // Только одна порция — сразу к причине, отменяем всю строку.
      setCancelQtyDelta(null)
      setCancelItemId(item.id)
    }
  }

  async function doCancelOrder(reason: string) {
    if (!order || !user) return
    setBusy(true)
    try {
      await cancelOrder(order.id, reason, user.id)
      toast.success('Заказ отменён')
      navigate('/waiter/tables')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка отмены')
    } finally {
      setBusy(false)
      setCancelOrderOpen(false)
    }
  }

  // Тап по найденному блюду → дозаказ + очистка поиска.
  async function handleAddItem(menuItem: MenuItem) {
    if (!order || adding) return
    // Весовое блюдо: спросить грамм/кг, как в композере.
    if (menuItem.unit && menuItem.unit !== 'piece') {
      setWeightItem(menuItem)
      setWeightValue(menuItem.saleStep && menuItem.saleStep > 0
        ? menuItem.saleStep
        : (menuItem.unitSize || 100))
      setSearch('')
      return
    }
    setAdding(menuItem.id)
    try {
      await addItemsToOrder(order.id, [{
        menuItemId: menuItem.id,
        name: menuItem.name,
        qty: 1,
        price: menuItem.price,
        cogs: menuItem.cogs ?? 0,
        unit: menuItem.unit,
        unitSize: menuItem.unitSize ?? 1,
      }])
      toast.success(`+ ${menuItem.name}`)
      setSearch('') // авто-очистка для следующего ввода
      // Не ждём перезагрузку — useDataSync (SSE) сам подтянет свежие orders
      // в фоне. Раньше пользователь тут ловил +200–800 мс ожидания на 4G.
      void load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось добавить')
    } finally {
      setAdding(null)
    }
  }

  async function confirmWeightAdd() {
    if (!order || !weightItem || weightValue <= 0) return
    setAdding(weightItem.id)
    try {
      await addItemsToOrder(order.id, [{
        menuItemId: weightItem.id,
        name: weightItem.name,
        qty: weightValue,
        price: weightItem.price,
        cogs: weightItem.cogs ?? 0,
        unit: weightItem.unit,
        unitSize: weightItem.unitSize ?? 1,
      }])
      toast.success(`+ ${weightItem.name}`)
      setWeightItem(null)
      setWeightValue(0)
      // Не ждём перезагрузку — useDataSync (SSE) сам подтянет свежие orders
      // в фоне. Раньше пользователь тут ловил +200–800 мс ожидания на 4G.
      void load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось добавить')
    } finally {
      setAdding(null)
    }
  }

  // Смена стола заказа.
  async function handleMoveTable(newTableId: string) {
    if (!order || movingTable || newTableId === order.tableId) return
    setMovingTable(true)
    try {
      await updateOrderTable(order.id, newTableId)
      toast.success('Стол изменён')
      setMoveTableOpen(false)
      // Не ждём перезагрузку — useDataSync (SSE) сам подтянет свежие orders
      // в фоне. Раньше пользователь тут ловил +200–800 мс ожидания на 4G.
      void load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось сменить стол')
    } finally {
      setMovingTable(false)
    }
  }

  async function markServed() {
    if (!order) return
    setBusy(true)
    try {
      await updateOrderStatus(order.id, 'served')
      toast.success('Отмечено как поданное')
      // Оптимистичное обновление: cachedQuery сразу отдал бы stale snapshot,
      // поэтому правим текущий список руками. Фоновое refresh всё равно
      // догонит через RealtimeCacheBridge.
      setOrders(prev => prev.map(o => o.id === order.id ? { ...o, status: 'served' } : o))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка')
    } finally {
      setBusy(false)
    }
  }

  // Build the pre-check ReceiptData and open the preview drawer. The actual
  // print happens from inside the drawer via handlePrintPreCheck below.
  // This split lets the waiter show the bill to the customer on screen even
  // when no printer is configured — the warning toast on print failure was
  // the only feedback before, leaving the waiter with no fallback.
  async function printPreCheck() {
    if (!order || !user) return
    setBusy(true)
    try {
      const restaurant = user.restaurantId ? await fetchRestaurantById(user.restaurantId).catch(() => null) : null
      // Подгружаем voids — без них списанные через void позиции попадают в тело
      // пре-чека, хотя в подытоге их уже нет (см. helpers.visibleReceiptItems).
      const voids = await fetchVoidsForOrder(order.id).catch(() => [])
      // Use restaurant default service% when the order itself has none set yet
      // (typical for pre-check on a fresh order before close).
      const servicePercent = order.servicePercent || restaurant?.servicePercent || 0
      const { buildReceiptData } = await import('@/lib/receipt-data')
      const data = buildReceiptData(
        order,
        { tables, users, zones, restaurant, currentUser: user, voids },
        { isPreCheck: true, includeService: servicePercent > 0, servicePercent },
      )
      setReceiptPreview(data)
      setReceiptOpen(true)
    } catch (e) {
      toast.error(e instanceof Error ? `Ошибка пре-чека: ${e.message}` : 'Ошибка пре-чека')
    } finally {
      setBusy(false)
    }
  }

  // Send the preview to the printer. On failure we surface the SAME specific
  // error reasons we used to surface eagerly — but only AFTER the waiter
  // requested a real print, not on every pre-check tap.
  async function handlePrintPreCheck() {
    if (!receiptPreview) return
    setPrinting(true)
    try {
      const { printReceiptDirect, getLastReceiptError } = await import('@/lib/print-service')
      const ok = await printReceiptDirect(receiptPreview)
      if (ok) {
        toast.success('Пре-чек отправлен на печать')
        setReceiptOpen(false)
      } else {
        const err = getLastReceiptError()
        if (err?.reason === 'no_printer_configured') {
          toast.warning('Принтер не настроен. Покажите чек гостю с экрана.')
        } else if (err?.reason === 'no_transport_available') {
          toast.warning(`Не удалось напечатать на ${err.printerIP ?? 'принтер'}: десктоп не отвечает или принтер недоступен.`)
        } else {
          toast.warning('Принтер недоступен. Покажите чек гостю с экрана.')
        }
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка печати')
    } finally {
      setPrinting(false)
    }
  }

  return (
    <div className="flex flex-col h-full safe-area-top safe-area-bottom">
      {/* Scrollable content */}
      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-4 space-y-4">
        {/* Header */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => navigate('/waiter/tables')}
            className="size-9 rounded-lg flex items-center justify-center active:bg-muted"
            aria-label="Назад"
          >
            <ArrowLeft className="size-5" />
          </button>
          <div className="flex-1 min-w-0">
            <div className="font-semibold text-base truncate">
              {table?.name ?? 'Заказ'} {zone?.name ? <span className="text-muted-foreground font-normal text-sm">· {zone.name}</span> : null}
            </div>
            <div className="text-xs text-muted-foreground truncate">
              {order.orderNumber ? `#${order.orderNumber} · ` : ''}{getTimeSince(order.createdAt)}
              {waiter ? ` · ${waiter.name}` : ''}
            </div>
          </div>
          {order.status !== 'done' && order.status !== 'cancelled' && (
            <button
              onClick={() => setMoveTableOpen(true)}
              className="size-9 rounded-lg flex items-center justify-center active:bg-muted text-muted-foreground hover:text-foreground"
              aria-label="Сменить стол"
              title="Сменить стол"
            >
              <MapPin className="size-4" />
            </button>
          )}
        </div>

        {/* Tab switcher (multi-group).
            Visible for ALL hall orders, not just multi-tab ones — discoverability
            matters more than the few pixels saved. The trailing "+" pill lets
            the waiter spawn a new sibling group on this table at any time
            (matches the cashier POS's "+ Новый" affordance). Hidden for
            takeaway/delivery where the multi-group concept doesn't apply. */}
        {order.tableId && (
          <div className="flex gap-1.5 overflow-x-auto -mx-3 px-3">
            {tabs.map((t, i) => (
              <button
                key={t.id}
                onClick={() => setActiveId(t.id)}
                className={`shrink-0 px-3 h-8 rounded-full text-xs font-medium transition-colors ${
                  t.id === activeId ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
                }`}
              >
                {t.tabLabel || `Группа ${i + 1}`}
              </button>
            ))}
            <button
              onClick={() => navigate(`/waiter/order/new?table=${order.tableId}`)}
              className="shrink-0 inline-flex items-center gap-1 px-3 h-8 rounded-full text-xs font-medium border border-dashed border-primary/50 text-primary bg-primary/5 active:bg-primary/10"
              title="Открыть новую группу на этом столе"
            >
              <Plus className="size-3.5" />
              Группа
            </button>
          </div>
        )}

        {/* Items */}
        {liveItems.length === 0 ? (
          <div className="py-10 text-center text-muted-foreground text-sm">Нет позиций</div>
        ) : (
          <div className="bg-card border border-border rounded-xl divide-y divide-border">
            {liveItems.map((it, idx) => (
              <ItemRow
                key={it.id || idx}
                item={it}
                onCancel={() => handleCancelItem(it)}
                onToggleServed={async () => {
                  if (!it.id || !user) return
                  try {
                    if (it.servedAt) await unmarkItemServed(it.id)
                    else await markItemServed(it.id, user.id)
                    // Refresh only the current order — toggling served on
                    // one item shouldn't pull every today-order.
                    if (activeId) {
                      const fresh = await fetchOrders({ ids: [activeId], slim: true })
                      if (fresh[0]) setOrders(prev => prev.map(o => o.id === activeId ? fresh[0] : o))
                    }
                  } catch (e) {
                    toast.error(e instanceof Error ? e.message : 'Ошибка')
                  }
                }}
                status={order.status}
              />
            ))}
          </div>
        )}

        {/* Total + service */}
        {(() => {
          const pct = order.servicePercent ?? restaurantServicePercent
          const svc = order.serviceAmount ?? (order.total * pct) / 100
          const grand = order.total + svc
          return (
            <div className="bg-muted/30 rounded-xl p-3 space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Сумма</span>
                <span className="text-base font-medium text-foreground">{formatCurrency(order.total)}</span>
              </div>
              {pct > 0 && (
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Обслуживание · {pct}%</span>
                  <span className="text-foreground">{formatCurrency(svc)}</span>
                </div>
              )}
              <div className="border-t border-border pt-1 flex items-center justify-between">
                <span className="text-sm font-semibold">Итого</span>
                <span className="text-lg font-bold">{formatCurrency(grand)}</span>
              </div>
            </div>
          )
        })()}
      </div>

      {/* Sticky action bar */}
      <div className="shrink-0 border-t border-border bg-background px-3 py-3 space-y-2 pb-[calc(12px+env(safe-area-inset-bottom,0px))]">
        {/* Inline-поиск для быстрого дозаказа. Тап по найденному блюду →
            мгновенно добавляется, поиск очищается, можно тапать следующее.
            Стоит над «Печать пре-чека», чтобы рука официанта первым делом
            попадала на дозаказ. */}
        {order.status !== 'done' && order.status !== 'cancelled' && (
        <div className="space-y-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Поиск блюда для дозаказа..."
              className="w-full pl-10 pr-3 h-11 bg-card border border-border rounded-xl text-sm focus:outline-none focus:border-primary/40"
            />
          </div>
          {searchResults.length > 0 && (
            <div className="bg-card border border-border rounded-xl divide-y divide-border max-h-72 overflow-y-auto">
              {searchResults.map(m => {
                const isLoading = adding === m.id
                return (
                  <button
                    key={m.id}
                    onClick={() => handleAddItem(m)}
                    disabled={!!adding}
                    className="w-full flex items-center justify-between gap-3 px-3 py-2.5 text-left active:bg-muted/50 disabled:opacity-50"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-foreground truncate">{m.name}</div>
                      <div className="text-xs text-muted-foreground">{formatCurrency(m.price)}{m.category ? ` · ${m.category}` : ''}</div>
                    </div>
                    {isLoading ? <Loader2 className="size-4 animate-spin shrink-0" /> : <Plus className="size-4 text-primary shrink-0" />}
                  </button>
                )
              })}
            </div>
          )}
          {search.trim() && searchResults.length === 0 && (
            <div className="text-xs text-muted-foreground text-center py-2">Ничего не найдено</div>
          )}
        </div>
        )}

        {/* "Пре-чек" — на любом активном заказе с позициями: официант
            может распечатать предварительный счёт когда захочет, не
            обязательно после смены статуса на "served". */}
        {order.status !== 'done' && order.status !== 'cancelled' && liveItems.length > 0 && (
          <button
            onClick={printPreCheck}
            disabled={busy}
            className="w-full h-12 rounded-xl bg-blue-50 text-blue-700 font-medium border-2 border-blue-200 inline-flex items-center justify-center gap-1.5 active:bg-blue-100 disabled:opacity-60"
          >
            <Receipt className="size-4" />
            Печать пре-чека
          </button>
        )}

        {/* Добавить / Новая группа — пока заказ активен (не закрыт / не отменён) */}
        {order.status !== 'done' && order.status !== 'cancelled' && (
        <div className="grid grid-cols-2 gap-2">
          <Link
            to={`/waiter/order/new?addTo=${order.id}`}
            className="inline-flex items-center justify-center gap-1.5 h-12 rounded-xl bg-primary text-primary-foreground font-medium active:bg-primary/90"
          >
            <Plus className="size-4" />
            Добавить
          </Link>
          {order.tableId && (
            <Link
              to={`/waiter/order/new?table=${order.tableId}&newGroup=1`}
              className="inline-flex items-center justify-center gap-1.5 h-12 rounded-xl border-2 border-primary/30 bg-primary/5 text-primary font-medium active:bg-primary/10"
            >
              <Plus className="size-4" />
              Новая группа
            </Link>
          )}
        </div>
        )}

        {/* Отмена заказа — пока блюда не поданы. Подано → блюда у гостя,
            отменять нельзя; нужен возврат через void. */}
        {(order.status === 'new' || order.status === 'cooking' || order.status === 'ready') && (
          <button
            onClick={() => setCancelOrderOpen(true)}
            className="w-full h-11 rounded-xl bg-red-50 text-red-600 font-medium border border-red-200 inline-flex items-center justify-center gap-1.5 active:bg-red-100"
          >
            <Ban className="size-4" />
            Отменить заказ
          </button>
        )}

        {/* Передача стола другому официанту — пока заказ активен. */}
        {order.tableId && order.status !== 'done' && order.status !== 'cancelled' && (
          <button
            onClick={() => setTransferOpen(true)}
            className="w-full h-11 rounded-xl bg-amber-50 text-amber-700 font-medium border border-amber-200 inline-flex items-center justify-center gap-1.5 active:bg-amber-100"
          >
            Передать другому официанту
          </button>
        )}
      </div>

      {/* Portion picker — qty>1 case */}
      <PortionPicker
        item={portionPickerItem}
        onClose={() => setPortionPickerItem(null)}
        onPick={(qtyDelta) => {
          if (!portionPickerItem?.id) return
          setCancelQtyDelta(qtyDelta)
          setCancelItemId(portionPickerItem.id)
          setPortionPickerItem(null)
        }}
      />
      {/* Weight input для дозаказа весового блюда */}
      <WeightInputSheet
        item={weightItem}
        value={weightValue}
        onChange={setWeightValue}
        onClose={() => { setWeightItem(null); setWeightValue(0) }}
        onConfirm={confirmWeightAdd}
      />
      {/* Pre-check preview drawer.
          Two affordances:
          - «Печать» tries to send to the configured receipt printer. Failure
            shows a soft toast suggesting the screen-fallback below.
          - «Закрыть» dismisses the drawer. The receipt was already rendered
            on screen — waiter could just turn the phone to the customer. */}
      <Sheet open={receiptOpen} onOpenChange={setReceiptOpen}>
        <SheetContent side="bottom" className="rounded-t-2xl p-0 flex flex-col max-h-[92vh]">
          <SheetHeader className="px-5 py-3 border-b border-border">
            <SheetTitle className="text-base">Пре-чек</SheetTitle>
            <SheetDescription className="text-xs">
              Покажите гостю или распечатайте.
            </SheetDescription>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto p-4 bg-muted/30 flex justify-center">
            {receiptPreview && <PrintReceipt ref={receiptRef} data={receiptPreview} />}
          </div>
          <div className="border-t border-border px-4 py-3 flex gap-2 pb-[calc(env(safe-area-inset-bottom,0px)+12px)]">
            <button
              onClick={() => setReceiptOpen(false)}
              className="flex-1 h-12 rounded-xl border border-border bg-card text-foreground font-medium active:bg-muted transition-colors"
            >
              Закрыть
            </button>
            <button
              onClick={handlePrintPreCheck}
              disabled={printing}
              className="flex-[1.5] h-12 rounded-xl bg-primary text-primary-foreground font-semibold inline-flex items-center justify-center gap-2 active:bg-primary/90 disabled:opacity-60 transition-colors"
            >
              {printing ? <Loader2 className="size-4 animate-spin" /> : <Printer className="size-4" />}
              Печать
            </button>
          </div>
        </SheetContent>
      </Sheet>

      {/* Cancel item dialog */}
      <ReasonPicker
        open={!!cancelItemId}
        title={cancelQtyDelta && cancelQtyDelta > 0 ? `Отменить ${cancelQtyDelta} порц.?` : 'Отменить позицию?'}
        onClose={() => { setCancelItemId(null); setCancelQtyDelta(null) }}
        onPick={doCancelItem}
        busy={busy}
      />
      {/* Cancel order dialog */}
      <ReasonPicker
        open={cancelOrderOpen}
        title="Отменить весь заказ?"
        onClose={() => setCancelOrderOpen(false)}
        onPick={doCancelOrder}
        busy={busy}
        destructive
      />
      {/* Transfer waiter dialog */}
      <TransferWaiterPicker
        open={transferOpen}
        currentWaiterId={order.waiterId}
        waiters={users.filter(u => u.role === 'waiter' && u.id !== order.waiterId)}
        busy={busy}
        onClose={() => setTransferOpen(false)}
        onPick={async (newWaiterId) => {
          if (!order.tableId) return
          setBusy(true)
          try {
            await assignWaiter(order.tableId, newWaiterId)
            toast.success('Стол передан')
            navigate('/waiter/tables')
          } catch (e) {
            toast.error(e instanceof Error ? e.message : 'Ошибка передачи')
          } finally {
            setBusy(false)
            setTransferOpen(false)
          }
        }}
      />

      {/* Сменить стол — picker свободных столов в тех же зонах */}
      <MoveTablePicker
        open={moveTableOpen}
        currentTableId={order.tableId ?? null}
        tables={tables}
        zones={zones}
        busy={movingTable}
        onClose={() => setMoveTableOpen(false)}
        onPick={handleMoveTable}
      />
    </div>
  )
}

function PortionPicker({ item, onClose, onPick }: {
  item: OrderItem | null
  onClose: () => void
  onPick: (qtyDelta: number) => void
}) {
  const open = !!item
  if (!item) {
    return (
      <AlertDialog open={false} onOpenChange={() => {}}>
        <AlertDialogContent />
      </AlertDialog>
    )
  }
  const isWeight = item.unit && item.unit !== 'piece'
  const portionQty = isWeight ? (item.unitSize || 1) : 1
  const totalQty = Number(item.qty)
  const portions = isWeight ? Math.max(1, Math.round(totalQty / portionQty)) : totalQty
  const portionLabel = isWeight ? `${portionQty}${item.unit === 'kg' ? 'кг' : 'г'}` : '1 шт'
  const allLabel = isWeight ? `${totalQty}${item.unit === 'kg' ? 'кг' : 'г'}` : `${totalQty} шт`
  return (
    <AlertDialog open={open} onOpenChange={v => !v && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Отменить «{item.name}»</AlertDialogTitle>
          <AlertDialogDescription>
            Выбрана позиция на {allLabel}. Сколько отменить?
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-2">
          <button
            onClick={() => onPick(portionQty)}
            className="w-full text-left px-4 py-3 rounded-lg border border-border text-sm font-medium active:bg-muted"
          >
            Одну порцию ({portionLabel}) — останется {portions - 1} порц.
          </button>
          <button
            onClick={() => onPick(totalQty)}
            className="w-full text-left px-4 py-3 rounded-lg border border-rose-200 text-rose-700 text-sm font-medium active:bg-rose-50"
          >
            Всё ({allLabel})
          </button>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onClose}>Отмена</AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function TransferWaiterPicker({ open, waiters, currentWaiterId, busy, onClose, onPick }: {
  open: boolean
  waiters: User[]
  currentWaiterId?: string
  busy: boolean
  onClose: () => void
  onPick: (waiterId: string) => void
}) {
  return (
    <AlertDialog open={open} onOpenChange={v => !v && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Передать стол другому официанту</AlertDialogTitle>
          <AlertDialogDescription>
            Выберите официанта — он сразу увидит стол у себя.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-2 max-h-[50vh] overflow-y-auto">
          {waiters.length === 0 ? (
            <div className="text-center text-sm text-muted-foreground py-4">Нет других официантов</div>
          ) : (
            waiters.map(w => (
              <button
                key={w.id}
                disabled={busy || w.id === currentWaiterId}
                onClick={() => onPick(w.id)}
                className="w-full text-left px-3 py-3 rounded-lg border border-border text-sm active:bg-muted disabled:opacity-60"
              >
                {w.name}
              </button>
            ))
          )}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onClose}>Отмена</AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function ItemRow({ item, onCancel, onToggleServed, status }: { item: OrderItem; onCancel: () => void; onToggleServed: () => void; status: Order['status'] }) {
  const lineTotal = calcLineTotal(item.price, item.qty, item.unit, item.unitSize)
  const allowCancel = status !== 'done' && status !== 'cancelled' && !!item.id
  const allowToggleServed = status !== 'done' && status !== 'cancelled' && !!item.id
  const served = !!item.servedAt
  return (
    <div className={`flex items-center gap-3 px-4 py-3 transition-colors ${served ? 'bg-muted/40' : ''}`}>
      <button
        onClick={allowToggleServed ? onToggleServed : undefined}
        disabled={!allowToggleServed}
        className="flex-1 min-w-0 text-left disabled:cursor-default"
        aria-label={served ? 'Снять отметку «подано»' : 'Отметить «подано»'}
      >
        <div className={`font-medium text-sm truncate ${served ? 'text-muted-foreground line-through' : 'text-foreground'}`}>{item.name}</div>
        <div className="text-xs text-muted-foreground">
          {item.unit && item.unit !== 'piece' ? formatQty(item.qty, item.unit) : `× ${item.qty}`}
          <span className="mx-1">·</span>
          {formatCurrency(item.price)}
          {served && <span className="ml-2 text-emerald-600">✓ подано</span>}
        </div>
      </button>
      <div className={`text-right ${served ? 'text-muted-foreground' : ''}`}>
        <div className={`text-sm font-semibold ${served ? 'line-through' : ''}`}>{formatCurrency(lineTotal)}</div>
      </div>
      {allowCancel && (
        <button
          onClick={(e) => { e.stopPropagation(); onCancel() }}
          className="size-8 rounded-lg text-red-600 active:bg-red-50 flex items-center justify-center"
          aria-label="Отменить позицию"
        >
          <X className="size-4" />
        </button>
      )}
    </div>
  )
}

function ReasonPicker({
  open, title, onClose, onPick, busy, destructive,
}: {
  open: boolean
  title: string
  onClose: () => void
  onPick: (reason: string) => void
  busy?: boolean
  destructive?: boolean
}) {
  const [custom, setCustom] = useState('')
  useEffect(() => { if (!open) setCustom('') }, [open])

  return (
    <AlertDialog open={open} onOpenChange={v => !v && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>Выберите причину</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-2">
          {CANCEL_REASONS.map(r => (
            <button
              key={r}
              disabled={busy}
              onClick={() => onPick(r)}
              className="w-full text-left px-3 py-2.5 rounded-lg border border-border text-sm active:bg-muted disabled:opacity-60"
            >
              {r}
            </button>
          ))}
          <input
            value={custom}
            onChange={e => setCustom(e.target.value)}
            placeholder="Своя причина"
            className="w-full px-3 py-2.5 rounded-lg border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Отмена</AlertDialogCancel>
          <AlertDialogAction
            disabled={busy || (!custom.trim())}
            onClick={() => onPick(custom.trim())}
            className={destructive ? 'bg-destructive text-destructive-foreground' : ''}
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : 'Подтвердить'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function MoveTablePicker({ open, currentTableId, tables, zones, busy, onClose, onPick }: {
  open: boolean
  currentTableId: string | null
  tables: Table[]
  zones: Zone[]
  busy: boolean
  onClose: () => void
  onPick: (tableId: string) => void
}) {
  // Группируем столы по зонам, скрываем текущий и занятые (status !== 'free')
  // НЕ скрываем — официант может перевести и на занятый, если кассир ошибся.
  const grouped = useMemo(() => {
    const byZone = new Map<string, Table[]>()
    for (const t of tables) {
      if (t.id === currentTableId) continue
      const z = t.zone || ''
      if (!byZone.has(z)) byZone.set(z, [])
      byZone.get(z)!.push(t)
    }
    return Array.from(byZone.entries()).map(([zoneId, ts]) => ({
      zone: zones.find(z => z.id === zoneId),
      tables: ts.sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? ''))),
    }))
  }, [tables, zones, currentTableId])

  return (
    <AlertDialog open={open} onOpenChange={(v) => !v && onClose()}>
      <AlertDialogContent className="max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>Сменить стол</AlertDialogTitle>
          <AlertDialogDescription>
            Если ошибочно пробили заказ на другой стол — выберите правильный.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="max-h-[60vh] overflow-y-auto space-y-3 -mx-1 px-1">
          {grouped.map((group, gi) => (
            <div key={group.zone?.id || gi}>
              {group.zone?.name && (
                <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">{group.zone.name}</div>
              )}
              <div className="grid grid-cols-3 gap-1.5">
                {group.tables.map(t => {
                  const isOccupied = t.status !== 'free'
                  return (
                    <button
                      key={t.id}
                      disabled={busy}
                      onClick={() => onPick(t.id)}
                      className={`px-2 py-2.5 rounded-lg border text-sm font-medium active:scale-95 transition-all disabled:opacity-50 ${
                        isOccupied
                          ? 'border-amber-300 bg-amber-50 text-amber-700'
                          : 'border-border bg-card text-foreground hover:border-primary/40'
                      }`}
                      title={isOccupied ? 'Стол занят — будет добавлено к нему' : undefined}
                    >
                      {t.name}
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Отмена</AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
