'use client'

import { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Search, Plus, Minus, Trash2, ShoppingCart, UtensilsCrossed, Truck, ShoppingBag,
  CreditCard, X, Users as UsersIcon, LayoutGrid, List, ChefHat, Zap, Receipt, ArrowLeft,
} from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '@/lib/auth-store'
import { formatCurrency, formatCurrencyCompact, formatQty, formatPriceLabel, calcLineCogs, calcLineTotal, voidedItemFlags, startOfToday, getTimeSince } from '@/lib/helpers'
import { dMul, dDiv, dSum } from '@/lib/decimal'
import { usePersistedState } from '@/hooks/use-persisted-state'
import { WeightInputSheet } from '@/components/dialogs/weight-input-sheet'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  type OrderType, type OrderItem, type MenuItem, type Table, type Order,
} from '@/lib/types'
import {
  createOrder, openTableForOrder, fetchActiveShift, addItemsToOrder, fetchOrders,
  fetchReservationForTable, updateReservationStatus, closeOrderWithPayment, fetchFinancialAccounts,
  deleteOrder, updateTableStatus, reopenOrder, updateOrderStatus,
} from '@/lib/queries'
// Direct (non-cached) fetchVoidsForOrder — нужен чтобы после void'а сразу
// видеть актуальный список с зачёркиванием в «Уже заказано». Cache-обёртка
// в @/lib/queries возвращает stale до того, как фоновое обновление
// допишет новые строки в Dexie (см. cache.ts cachedQuery, stale-while-revalidate).
import { fetchVoidsForOrder } from '@/lib/queries'
import { OrderActionsDialog } from '@/components/dialogs/order-actions-dialog'
import { OrderActionsPanel } from '@/components/order/order-actions-panel'
import { FailedPrintsButton } from '@/components/order/failed-prints-button'
import { toggleFavorite, useFavorites } from '@/lib/pos-favorites'
import { toggleFrequent, useFrequent } from '@/lib/pos-frequent'
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger,
} from '@/components/ui/context-menu'
import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle,
} from '@/components/ui/sheet'
import { useOrderData } from './use-order-data'
import type { CartLine, OrderComposerProps, TabInfo } from './types'

const ORDER_TYPE_OPTIONS = [
  { value: 'hall' as const, label: 'Зал', icon: UtensilsCrossed },
  { value: 'takeaway' as const, label: 'Самовывоз', icon: ShoppingBag },
  { value: 'delivery' as const, label: 'Доставка', icon: Truck },
]

function isHidden(item: MenuItem) {
  return item.category === 'Полуфабрикаты' || item.category === 'Полуфабрикаты мясные'
}

function lineTotal(l: CartLine) {
  if (l.unit === 'piece') return dMul(l.price, l.qty)
  const size = l.unitSize > 0 ? l.unitSize : 1
  return dMul(l.price, dDiv(l.qty, size))
}

// ─── iiko-style helpers (новый редизайн POS) ─────────────────────────────────
// Используются на этапе drill-down категории→блюда и в полноэкранном picker
// столов. Авто-сетка под количество элементов: всё помещается на один экран
// без скролла. См. план в /Users/behzod/.claude/plans/adaptive-strolling-engelbart.md.

export interface GridLayout {
  cols: number
  rows: number
  /** Размер шрифта названия в плитке (px) */
  nameSize: number
  /** Размер шрифта подписи/цены в плитке (px) */
  metaSize: number
}

/** Подбирает сетку cols×rows и размер шрифта под количество плиток так,
 *  чтобы все плитки умещались на один экран без скролла. Грид строится
 *  через `style={{ gridTemplateColumns: ... }}`. */
export function pickGridLayout(count: number): GridLayout {
  if (count <= 4) return { cols: 2, rows: 2, nameSize: 32, metaSize: 16 }
  if (count <= 9) return { cols: 3, rows: 3, nameSize: 28, metaSize: 14 }
  if (count <= 12) return { cols: 4, rows: 3, nameSize: 22, metaSize: 13 }
  if (count <= 16) return { cols: 4, rows: 4, nameSize: 20, metaSize: 13 }
  if (count <= 20) return { cols: 5, rows: 4, nameSize: 18, metaSize: 12 }
  if (count <= 25) return { cols: 5, rows: 5, nameSize: 16, metaSize: 12 }
  if (count <= 30) return { cols: 6, rows: 5, nameSize: 15, metaSize: 11 }
  if (count <= 36) return { cols: 6, rows: 6, nameSize: 14, metaSize: 11 }
  return { cols: 7, rows: 6, nameSize: 13, metaSize: 11 }
}

interface DishTileProps {
  name: string
  price: number
  unitLabel?: string
  emoji?: string
  onClick?: () => void
  qtyInCart?: number
  isStopped?: boolean
}

// Sentinel в drilledCategory: «избранное». Не пересекается с настоящими
// именами категорий — реальные не начинаются с «__».
const FAVORITES_KEY = '__favorites__'

/** Плитка блюда: с emoji — имя сверху + emoji-герой по центру + цена внизу;
 *  без emoji — имя по центру (визуально балансирует пустое пространство),
 *  цена внизу. Размер плитки фиксированный (aspect-square). */
export function DishTile({ name, price, unitLabel, emoji, onClick, qtyInCart, isStopped }: DishTileProps) {
  return (
    <button
      onClick={onClick}
      style={{ WebkitTouchCallout: 'none', WebkitUserSelect: 'none', userSelect: 'none' }}
      className={`relative aspect-square rounded-xl border transition-all flex flex-col items-center ${emoji ? 'justify-between' : 'justify-end'} gap-1 p-2 text-center min-h-0 overflow-hidden w-full h-full ${
        isStopped
          ? 'bg-muted border-border'
          : qtyInCart && qtyInCart > 0
            ? 'bg-card border-primary ring-2 ring-primary/40 hover:shadow-md'
            : 'bg-card border-border hover:shadow-md hover:border-primary/40'
      }`}
    >
      {emoji ? (
        <>
          <span className={`font-bold leading-tight line-clamp-2 px-1 shrink-0 text-[15px] ${isStopped ? 'text-muted-foreground' : 'text-foreground'}`}>
            {name}
          </span>
          <span
            className={`leading-none flex-1 flex items-center justify-center min-h-0 select-none text-[44px] ${isStopped ? 'grayscale opacity-60' : ''}`}
            aria-hidden
          >
            {emoji}
          </span>
        </>
      ) : (
        <span className={`flex-1 min-h-0 flex items-center justify-center font-bold leading-tight line-clamp-3 px-2 text-[17px] ${isStopped ? 'text-muted-foreground' : 'text-foreground'}`}>
          {name}
        </span>
      )}
      <span className={`font-bold shrink-0 text-[13px] ${isStopped ? 'text-muted-foreground' : 'text-primary'}`}>
        {formatCurrencyCompact(price)}{unitLabel ? ` / ${unitLabel}` : ''}
      </span>
      {qtyInCart && qtyInCart > 0 ? (
        <span className="absolute top-1 right-1 bg-primary text-primary-foreground rounded-full min-w-[20px] h-5 px-1.5 flex items-center justify-center text-[11px] font-bold">
          {qtyInCart}
        </span>
      ) : null}
      {isStopped ? (
        <span className="absolute top-1 left-1 bg-rose-100 text-rose-700 rounded-md px-1.5 py-0.5 text-[10px] font-bold">
          Стоп
        </span>
      ) : null}
    </button>
  )
}

/** Цвета по статусу стола — для TableTile в режиме «Зал». */
const TABLE_TILE_STYLE = {
  free: { bg: 'bg-emerald-50', border: 'border-emerald-200', dot: 'bg-emerald-500', name: 'text-emerald-900', label: 'text-emerald-700' },
  occupied: { bg: 'bg-rose-50', border: 'border-rose-200', dot: 'bg-rose-500', name: 'text-rose-900', label: 'text-rose-700' },
  bill_requested: { bg: 'bg-amber-50', border: 'border-amber-300 ring-2 ring-amber-200', dot: 'bg-amber-500', name: 'text-amber-900', label: 'text-amber-700' },
  reserved: { bg: 'bg-blue-50', border: 'border-blue-200', dot: 'bg-blue-500', name: 'text-blue-900', label: 'text-blue-700' },
}

interface TableTileProps {
  name: string
  status: 'free' | 'occupied' | 'bill_requested' | 'reserved'
  capacity?: number
  amount?: number
  itemsCount?: number
  durationLabel?: string
  waiterName?: string
  layout: GridLayout
  onClick?: () => void
}

/** Плитка стола в полноэкранном picker. Цвет — по статусу. */
export function TableTile({ name, status, capacity, amount, itemsCount, durationLabel, waiterName, layout, onClick }: TableTileProps) {
  const s = TABLE_TILE_STYLE[status]
  const isOccupied = status === 'occupied' || status === 'bill_requested'
  return (
    <button
      onClick={onClick}
      className={`${s.bg} ${s.border} border-2 rounded-2xl flex flex-col items-start justify-start gap-1 p-3 text-left transition-shadow hover:shadow-md min-h-0 overflow-hidden`}
    >
      <div className="flex items-center justify-between w-full">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className={`size-2 rounded-full ${s.dot} shrink-0`} />
          <span className={`font-bold ${s.name} truncate`} style={{ fontSize: layout.nameSize }}>{name}</span>
        </div>
        {capacity ? (
          <span className="text-[10px] font-semibold text-muted-foreground shrink-0">👤 {capacity}</span>
        ) : null}
      </div>
      <span className={`font-semibold ${s.label}`} style={{ fontSize: layout.metaSize }}>
        {status === 'free' ? 'Свободен' : status === 'reserved' ? 'Резерв' : status === 'bill_requested' ? 'Счёт !!' : 'Занят'}
      </span>
      {isOccupied && amount != null ? (
        <span className="font-bold text-foreground" style={{ fontSize: layout.metaSize + 2 }}>
          {formatCurrency(amount)}
        </span>
      ) : null}
      {isOccupied && (itemsCount != null || durationLabel || waiterName) ? (
        <span className="text-[10px] font-medium text-muted-foreground truncate w-full">
          {[
            itemsCount != null ? `${itemsCount} поз.` : null,
            durationLabel,
            waiterName,
          ].filter(Boolean).join(' · ')}
        </span>
      ) : null}
    </button>
  )
}

/** Простое русское склонение по числу (1 яблоко / 2 яблока / 5 яблок). */
function pluralize(n: number, forms: [string, string, string]): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return forms[0]
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return forms[1]
  return forms[2]
}

export function OrderComposer(props: OrderComposerProps) {
  const { mode = 'new', className, onSubmitted, effectiveUser: effUserProp, compactMode, onCancel } = props as
    OrderComposerProps & { mode?: 'new' | 'add' }
  // Новый iiko-style layout активен по умолчанию для всех (cashier/owner/manager
  // на /operations/pos). compactMode=true передают waiter-страницы и диалоги —
  // там места под полноэкранную сетку нет, остаётся старый layout.
  const useNewLayout = !compactMode
  const isAddMode = mode === 'add'

  const { user: authUser, canDo, restaurant } = useAuth()
  const effectiveUser = effUserProp ?? authUser
  const canOrderStopped = canDo('orders.create_stopped')

  const { menuItems, categories, tables, zones, users, loading } = useOrderData(true)

  // POS favorites (per-device, per-restaurant). Long-press / right-click на
  // карточке добавляет/удаляет — см. DishTile.onContextAction ниже. Список
  // живёт в localStorage, без облачного sync'а.
  const navigate = useNavigate()
  const favoriteIds = useFavorites(restaurant?.id ?? '')
  // «Часто используемые» — ручной список (mirror of favorites), курируется
  // через context-menu на DishTile. Никакого автотрекинга кликов — в полосе
  // ровно то, что кассир добавил руками. Видна на любой категории.
  const frequentIds = useFrequent(restaurant?.id ?? '')

  // Destination state (only used in 'new' mode) — declared before cart so its
  // initialCart can seed useState below.
  const newProps = !isAddMode
    ? (props as Extract<OrderComposerProps, { mode?: 'new' }>)
    : null
  const lockDestination = newProps?.lockDestination ?? false
  const onCartChange = newProps?.onCartChange
  const forceNewOrder = newProps?.forceNewOrder ?? false

  // Cart + UI state ---------------------------------------------------------
  const [cart, setCart] = useState<CartLine[]>(newProps?.initialCart ?? [])
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('Все')
  // Drill-down: при iiko-style layout (compactMode=false) сначала показываем сетку
  // категорий; после тапа фиксируем выбранную категорию и показываем сетку её блюд.
  // null = «сейчас на экране категории». При compactMode=true это игнорируется
  // и работает старый поведение «горизонтальные табы + плоский grid».
  const [drilledCategory, setDrilledCategory] = useState<string | null>(null)
  const [mobileView, setMobileView] = useState<'menu' | 'cart'>('menu')
  const [mobileLayout, setMobileLayout] = usePersistedState<'grid' | 'list'>(
    'restos.composer.mobileLayout',
    'list',
  )
  const [submitting, setSubmitting] = useState(false)
  // Controlled state for the «Очистить корзину» confirmation dialog. Replaces
  // the previous bare-icon button that cleared the cart with no warning —
  // accidental taps wiped the whole order.
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false)
  const [weightItem, setWeightItem] = useState<MenuItem | null>(null)
  const [weightValue, setWeightValue] = useState<number>(0)

  const [orderType, setOrderType] = useState<OrderType>(newProps?.initialOrderType ?? 'hall')
  const [selectedTableId, setSelectedTableId] = useState<string>(newProps?.initialTableId ?? '')
  const [showTablePicker, setShowTablePicker] = useState<boolean>(!newProps?.initialTableId)
  const [guestsCount, setGuestsCount] = useState<number>(newProps?.initialGuests ?? 1)
  const [pendingTabLabel, setPendingTabLabel] = useState<string>(newProps?.initialTabLabel ?? '')

  // Multi-tab state ---------------------------------------------------------
  const [openTabs, setOpenTabs] = useState<TabInfo[]>([])
  const [selectedExistingOrderId, setSelectedExistingOrderId] = useState<string | null>(null)

  // Inline order actions: открываем существующий OrderActionsDialog поверх
  // POS, чтобы кассир мог закрыть/оплатить заказ не уходя со страницы.
  // Phase 1 интеграции «всё-в-одном POS» — диалог берёт на себя оплату,
  // скидку, обслуживание, split-bill. Phase 2 заменит диалог на инлайн-панель.
  const [orderActionsOpen, setOrderActionsOpen] = useState(false)
  const [selectedFullOrder, setSelectedFullOrder] = useState<Order | null>(null)

  // Recent-orders drawer (кнопка справа от поиска в топбаре).
  // Показывает заказы за сегодня с фильтром «Открытые / Закрытые», даёт
  // одним кликом перейти к заказу из POS — раньше за этим кассир уходил
  // на /operations/orders и терял контекст.
  const [ordersDrawerOpen, setOrdersDrawerOpen] = useState(false)
  const [ordersFilter, setOrdersFilter] = useState<'open' | 'closed'>('open')
  const [recentOrders, setRecentOrders] = useState<Order[]>([])
  const [recentOrdersLoading, setRecentOrdersLoading] = useState(false)

  // Voids существующего выбранного заказа — для отображения «Уже заказано»
  // с зачёркнутыми списанными позициями. Раньше cart фильтровал только
  // cancelledAt и пропускал voids (они в отдельной таблице order_voids), —
  // получалось расхождение: панель оплаты показывала живой состав, а cart
  // «Уже заказано» добавлял уже списанные позиции.
  const [selectedOrderVoids, setSelectedOrderVoids] = useState<import('@/lib/types').OrderVoid[]>([])
  const refreshSelectedVoids = useCallback(async () => {
    if (isAddMode || !selectedExistingOrderId) {
      setSelectedOrderVoids([])
      return
    }
    try {
      const v = await fetchVoidsForOrder(selectedExistingOrderId)
      setSelectedOrderVoids(v)
    } catch {
      setSelectedOrderVoids([])
    }
  }, [isAddMode, selectedExistingOrderId])
  useEffect(() => { void refreshSelectedVoids() }, [refreshSelectedVoids])

  // Emit cart/destination changes for autosave (waiter drafts).
  useEffect(() => {
    if (isAddMode) return
    onCartChange?.({ cart, tableId: selectedTableId, guestsCount, tabLabel: pendingTabLabel })
  }, [isAddMode, onCartChange, cart, selectedTableId, guestsCount, pendingTabLabel])

  // Refresh multi-tab info when selected table changes (only in 'new' mode)
  useEffect(() => {
    if (isAddMode) return
    let cancelled = false

    // Hall mode — открытые tabs стола.
    if (orderType === 'hall') {
      if (!selectedTableId) {
        setOpenTabs([]); setSelectedExistingOrderId(null); setPendingTabLabel('')
        return
      }
      const t = tables.find(tt => tt.id === selectedTableId)
      if (!t) return
      setGuestsCount(prev => (t.status === 'free' ? t.capacity : prev))

      const ids = (t.currentOrderIds && t.currentOrderIds.length > 0)
        ? t.currentOrderIds
        : (t.currentOrderId ? [t.currentOrderId] : [])

      if (ids.length === 0) {
        setOpenTabs([]); setSelectedExistingOrderId(null); setPendingTabLabel('')
        return
      }

      // Точечная выборка по id — не тащим весь хвост заказов ресторана.
      fetchOrders({ ids }).then(list => {
        if (cancelled) return
        const matches = list
          .filter(o => ids.includes(o.id) && o.status !== 'done' && o.status !== 'cancelled')
          .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
        const tabs: TabInfo[] = matches.map(o => ({ id: o.id, tabLabel: o.tabLabel, total: o.total, status: o.status, items: o.items, order: o }))
        setOpenTabs(tabs)
        if (forceNewOrder) {
          setSelectedExistingOrderId(null)
        } else if (tabs.length === 1) {
          setSelectedExistingOrderId(tabs[0].id)
        } else if (tabs.length === 0) {
          setSelectedExistingOrderId(null)
        }
      }).catch(() => {
        const tabs: TabInfo[] = ids.map(id => ({ id, total: 0, status: 'cooking' }))
        setOpenTabs(tabs)
        if (forceNewOrder) setSelectedExistingOrderId(null)
        else if (tabs.length === 1) setSelectedExistingOrderId(tabs[0].id)
      })
      return () => { cancelled = true }
    }

    // Takeaway / delivery — все открытые заказы этого типа за сегодня.
    // Используем тот же openTabs/selectedExistingOrderId state — UI и
    // OrderActionsPanel переиспользуются. Auto-select НЕ делаем: кассир
    // должен явно выбрать заказ или начать новый («Создать без оплаты»).
    if (orderType === 'takeaway' || orderType === 'delivery') {
      fetchOrders({ from: startOfToday() }).then(list => {
        if (cancelled) return
        const matches = list
          .filter(o => o.type === orderType && o.status !== 'done' && o.status !== 'cancelled')
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()) // свежие сверху
        const tabs: TabInfo[] = matches.map(o => ({ id: o.id, tabLabel: o.tabLabel, total: o.total, status: o.status, items: o.items, order: o }))
        setOpenTabs(tabs)
        // Если ранее выбранный заказ закрылся/исчез — снять выбор.
        setSelectedExistingOrderId(prev => prev && tabs.some(t => t.id === prev) ? prev : null)
      }).catch(() => {
        if (!cancelled) setOpenTabs([])
      })
      return () => { cancelled = true }
    }

    setOpenTabs([])
    setSelectedExistingOrderId(null)
    return () => { cancelled = true }
  }, [orderType, selectedTableId, tables, isAddMode, forceNewOrder])

  const existingOrderId = isAddMode
    ? (props as Extract<OrderComposerProps, { mode: 'add' }>).orderId
    : selectedExistingOrderId
  // Полный объект выбранного существующего заказа — нужен инлайн-панели
  // OrderActionsPanel. Берём из openTabs (заполнили в useEffect выше при
  // fetchOrders по id) — без отдельного fetch'а.
  const selectedExistingOrder = !isAddMode && selectedExistingOrderId
    ? (openTabs.find(t => t.id === selectedExistingOrderId)?.order ?? null)
    : null
  // Phase 2: правый сайдбар превращается в OrderActionsPanel когда (а)
  // выбрана существующая группа и (б) корзина пуста (нет дозаказа в
  // работе). Любой клик по блюду наполнит корзину и вернёт стандартный
  // дозаказ-флоу.
  const inlinePanelActive = !!selectedExistingOrder && cart.length === 0

  // Re-fetch the items / total for the currently-open tabs of the selected
  // table without touching tab selection. Called after «Дозаказ» so the
  // «Уже заказано» list reflects the items just appended without the user
  // re-picking the table. Fetch is keyed on openTabs ids — we don't need
  // to discover new tabs here, addItemsToOrder doesn't create a new tab.
  const refreshTabsItems = useCallback(async () => {
    if (isAddMode || !selectedTableId) return
    const ids = openTabs.map(t => t.id)
    if (ids.length === 0) return
    try {
      const list = await fetchOrders({ ids })
      setOpenTabs(prev => prev.map(t => {
        const o = list.find(x => x.id === t.id)
        return o ? { ...t, total: o.total, status: o.status, items: o.items, order: o } : t
      }))
    } catch { /* sub-second flicker is fine; next reselect will recover */ }
  }, [isAddMode, selectedTableId, openTabs])

  // Открыть полнофункциональный OrderActionsDialog по любому id —
  // оплата/скидка/split/cancel/reopen/print. Используется как из
  // OrderActionsPanel.onOpenAdvanced (текущий выбранный заказ), так и из
  // recent-orders drawer'а (произвольный заказ из истории).
  const openOrderActionsFor = useCallback(async (orderId: string) => {
    if (!orderId) return
    try {
      const list = await fetchOrders({ ids: [orderId] })
      const order = list[0]
      if (!order) {
        toast.error('Заказ не найден')
        return
      }
      setSelectedFullOrder(order)
      setOrderActionsOpen(true)
    } catch {
      toast.error('Не удалось открыть заказ')
    }
  }, [])
  const openOrderActions = useCallback(() => {
    if (existingOrderId) void openOrderActionsFor(existingOrderId)
  }, [existingOrderId, openOrderActionsFor])

  // Recent-orders fetch — refires when drawer opens or filter changes.
  // Today's orders only — recent enough to be useful, small enough to stay
  // fast. Filter (open/closed) is applied client-side.
  useEffect(() => {
    if (!ordersDrawerOpen) return
    let cancelled = false
    setRecentOrdersLoading(true)
    fetchOrders({ from: startOfToday() }).then(list => {
      if (cancelled) return
      // Сортируем свежие сверху (по createdAt desc).
      const sorted = [...list].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      setRecentOrders(sorted)
    }).catch(() => {
      if (!cancelled) setRecentOrders([])
    }).finally(() => {
      if (!cancelled) setRecentOrdersLoading(false)
    })
    return () => { cancelled = true }
  }, [ordersDrawerOpen])

  // Derived ----------------------------------------------------------------
  // Тяжёлая фильтрация и сортировка меню откладываются через useDeferredValue:
  // input обновляет `search` мгновенно (буквы видны), но availableMenu
  // пересчитывается только когда React успевает между нажатиями. На 200+ блюдах
  // это убирает лаг 300–800мс при наборе поискового запроса на мобильном.
  const deferredSearch = useDeferredValue(search)
  const availableMenu = useMemo(() => {
    const q = deferredSearch.trim().toLowerCase()
    // Category filter is bypassed when:
    //  - The item is in the cart (waiter switches category but keeps sight
    //    of what they've already added).
    //  - The user is actively searching (q non-empty). Otherwise a search
    //    like "жигар" while «Ичимликлар» is active returns zero hits even
    //    though «Жигар кабоб» lives under «Кабоб» — confusing.
    const cartIds = new Set(cart.map(l => l.menuItemId))
    const filtered = menuItems.filter(item => {
      // Stop-list items: always visible (with a «Стоп» badge + dimmed
      // styling) so the waiter knows what's out of stock instead of
      // hunting for a dish that silently disappeared from the menu.
      // addToCart() still blocks adding for users without
      // `orders.create_stopped` permission, so this is display-only.
      if (item.isBatchCooking && (item.preparedQty ?? 0) <= 0) return false
      if (isHidden(item)) return false
      if (q && !item.name.toLowerCase().includes(q)) return false
      if (!q && !cartIds.has(item.id) && category !== 'Все' && item.category !== category) return false
      return true
    })
    // Сортировка по имени A-Z (locale-aware). При активном поиске —
    // сначала те, у кого имя НАЧИНАЕТСЯ с запроса, потом остальные;
    // внутри обеих групп — alpha. Без поиска — просто alpha.
    const sorted = q
      ? filtered.slice().sort((a, b) => {
          const ar = a.name.toLowerCase().startsWith(q) ? 0 : 1
          const br = b.name.toLowerCase().startsWith(q) ? 0 : 1
          if (ar !== br) return ar - br
          return a.name.localeCompare(b.name, undefined, { numeric: true })
        })
      : filtered.slice().sort((a, b) =>
          a.name.localeCompare(b.name, undefined, { numeric: true }),
        )
    // Already-added items pinned to the top, preserving cart order.
    if (cart.length === 0) return sorted
    const cartOrder = new Map(cart.map((l, i) => [l.menuItemId, i]))
    const inCart = sorted.filter(i => cartOrder.has(i.id))
      .sort((a, b) => (cartOrder.get(a.id)! - cartOrder.get(b.id)!))
    const rest = sorted.filter(i => !cartOrder.has(i.id))
    return [...inCart, ...rest]
  }, [menuItems, category, deferredSearch, cart])

  const total = dSum(cart.map(lineTotal))
  const totalItems = cart.length
  // Индекс корзины по menuItemId — для O(1) lookup в .map() рендера плиток
  // (раньше cart.find() на каждой плитке давало O(N×M), заметный лаг при
  // большой корзине + большом меню).
  const cartByMenuId = useMemo(() => new Map(cart.map(l => [l.menuItemId, l])), [cart])
  const selectedTable = tables.find(t => t.id === selectedTableId)

  // Cart ops ----------------------------------------------------------------
  const addToCart = useCallback((item: MenuItem) => {
    // Block stop-list items unless user has permission to order them.
    if (!item.isAvailable) {
      if (!canOrderStopped) {
        toast.warning(`«${item.name}» в стопе`)
        return
      }
      // With permission: warn but allow.
      toast.info(`«${item.name}» в стопе — добавлено по разрешению`)
    }
    if (item.unit && item.unit !== 'piece') {
      setWeightItem(item)
      setWeightValue(item.saleStep && item.saleStep > 0 ? item.saleStep : (item.unitSize || 100))
      return
    }
    setCart(prev => {
      const existing = prev.find(l => l.menuItemId === item.id && l.unit === 'piece')
      if (existing) {
        return prev.map(l => l.menuItemId === item.id && l.unit === 'piece' ? { ...l, qty: l.qty + 1 } : l)
      }
      return [...prev, {
        menuItemId: item.id,
        name: item.name,
        emoji: item.emoji,
        qty: 1,
        price: item.price,
        cogs: item.cogs,
        unit: 'piece',
        unitSize: 1,
      }]
    })
    // Auto-clear search so the waiter can immediately type the next dish
    // without manually deleting the previous query.
    setSearch('')
  }, [canOrderStopped])

  const confirmWeight = useCallback(() => {
    if (!weightItem || weightValue <= 0) return
    setCart(prev => [...prev, {
      menuItemId: weightItem.id,
      name: weightItem.name,
      emoji: weightItem.emoji,
      qty: weightValue,
      price: weightItem.price,
      cogs: weightItem.cogs,
      unit: weightItem.unit ?? 'g',
      unitSize: weightItem.unitSize || 100,
    }])
    setWeightItem(null)
    setWeightValue(0)
    setSearch('')
  }, [weightItem, weightValue])

  const updateQty = useCallback((menuItemId: string, delta: number) => {
    setCart(prev => prev.map(l => {
      if (l.menuItemId !== menuItemId) return l
      if (l.unit !== 'piece') {
        const step = 50
        return { ...l, qty: Math.max(0, l.qty + delta * step) }
      }
      return { ...l, qty: l.qty + delta }
    }).filter(l => l.qty > 0))
  }, [])

  const clearCart = () => setCart([])

  // Submit -----------------------------------------------------------------
  /** Если inlinePayMethod указан и orderType === 'takeaway' — после createOrder
   *  немедленно проводим оплату через closeOrderWithPayment + печатаем чек.
   *  Логика идентична OrderActionsDialog.handleCloseAndPay, только без диалога:
   *  быстрый кейс «гость заплатил → печать → готово».
   *  Для hall и для existing-order (дозаказ) inlinePay игнорируется. */
  const handleSubmit = async (inlinePayMethod?: 'cash' | 'card') => {
    if (cart.length === 0) return
    if (!isAddMode && orderType === 'hall' && !selectedTableId) {
      toast.error('Выберите стол')
      return
    }
    // Hard-block: takeaway inline-оплата требует открытой смены. Проверяем
    // ДО createOrder, чтобы не оставить «осиротевший» неоплаченный заказ
    // если closeOrderWithPayment упадёт на server-side gate.
    if (inlinePayMethod) {
      try {
        const shift = await fetchActiveShift()
        if (!shift) {
          toast.error('Откройте кассовую смену перед оплатой', {
            action: { label: 'Открыть смену', onClick: () => navigate('/operations/shifts') },
            duration: 6000,
          })
          return
        }
      } catch { /* пускаем — server-side gate в closeOrderWithPayment ловит */ }
    }
    setSubmitting(true)
    try {
      const items: OrderItem[] = cart.map(l => ({
        menuItemId: l.menuItemId,
        name: l.name,
        qty: l.qty,
        price: l.price,
        cogs: l.cogs,
        unit: l.unit,
        unitSize: l.unitSize,
      }))

      if (existingOrderId) {
        await addItemsToOrder(existingOrderId, items)
        toast.success(`Дозаказ: +${totalItems} поз. · ${formatCurrency(total)}`)
        setCart([])
        // Обновляем «Уже заказано» без переключения стола. AutoPrintRunner
        // тем временем подхватит новые order_items (printed_at IS NULL) и
        // напечатает кухонный раннер — серверная сторона уже работает.
        void refreshTabsItems()
        onSubmitted?.({ orderId: existingOrderId, mode: 'add' })
        return
      }

      // New order ---------------------------------------------------------
      // Параллельно: auto-seat reserved-table + fetchActiveShift.
      // Раньше шли последовательно (~200-400мс лишней задержки на нажатие).
      const seatPromise = (async () => {
        if (orderType === 'hall' && selectedTableId) {
          const t = tables.find(tt => tt.id === selectedTableId)
          if (t?.status === 'reserved') {
            const res = await fetchReservationForTable(selectedTableId)
            if (res) await updateReservationStatus(res.id, 'seated', selectedTableId)
          }
        }
      })()
      const shiftPromise = fetchActiveShift()
      const [shift] = await Promise.all([shiftPromise, seatPromise])
      const isCurrentUserWaiter = effectiveUser?.role === 'waiter'
      const tableWaiter = selectedTableId ? tables.find(t => t.id === selectedTableId)?.waiterId : undefined
      // Если заказ пробивает официант — он же waiter. Иначе оставляем уже
      // назначенного на стол официанта (handoff), а если нет — текущего
      // пользователя (владелец/менеджер/кассир пробивает «за себя»).
      // Раньше тут стоял fallback на `users.find(u => u.role === 'waiter')`,
      // из-за которого случайный официант (например, Гульнора) залипал
      // на столах при заказах от владельца.
      const waiterId = isCurrentUserWaiter
        ? effectiveUser?.id
        : (tableWaiter || effectiveUser?.id)

      const autoLabel = pendingTabLabel.trim()
        ? pendingTabLabel.trim()
        : (openTabs.length > 0 ? `Группа ${openTabs.length + 1}` : '')

      const order = await createOrder({
        type: orderType,
        tableId: orderType === 'hall' ? selectedTableId : undefined,
        waiterId: waiterId ?? undefined,
        items,
        total,
        shiftId: shift?.id,
        guestsCount,
        tabLabel: autoLabel || undefined,
      })

      if (orderType === 'hall' && selectedTableId && order) {
        // Fire-and-forget: открытие стола не блокирует переход на детали.
        // Если упадёт — логируем, кухня уже видит заказ через order_items.
        openTableForOrder(selectedTableId, order.id, waiterId).catch((e) => {
          console.error('[OrderComposer] openTableForOrder failed:', e)
        })
      }

      // ─── Inline-оплата (только takeaway, только для нового заказа) ────────
      // Кассир в режиме «С СОБОЙ» нажимает Нал/Карта в корзине → создаём
      // заказ → сразу закрываем оплатой → печатаем чек. Без диалога.
      // Для зала inlinePayMethod не передаётся: там «Создать заказ» отправляет
      // на кухню, оплата происходит позже через OrderActionsDialog.
      if (inlinePayMethod && order && orderType === 'takeaway') {
        try {
          // Берём счёт оплаты: приоритет — счёт активной смены, иначе первый
          // cash-счёт ресторана.
          let accId: string | undefined = (shift as { accountId?: string } | null)?.accountId
          let accName: string | undefined = (shift as { accountName?: string } | null)?.accountName
          if (!accId) {
            const accs = await fetchFinancialAccounts().catch(() => [])
            const cash = accs.find(a => a.type === 'cash')
            accId = cash?.id
            accName = cash?.name
          }
          // Service charge применяется только для зала. Для takeaway — 0.
          const servicePercent = 0
          const serviceAmount = 0
          const totalWithService = total
          const cogs = dSum(cart.map(l => l.unit === 'piece' ? dMul(l.cogs, l.qty) : dMul(l.cogs, dDiv(l.qty, l.unitSize > 0 ? l.unitSize : 1))))
          const paymentMethod: 'cash' | 'card' = inlinePayMethod === 'card' ? 'card' : 'cash'
          await closeOrderWithPayment(
            order.id,
            paymentMethod,
            null,
            total,
            cogs,
            effectiveUser?.id,
            accId,
            accName,
            servicePercent,
            serviceAmount,
            totalWithService,
          )
          // Чек-job создаётся бэкендом внутри closeOrderWithPayment
          // (server enqueueReceipt). Worker печатает асинхронно — фронт
          // показывает только подтверждение оплаты. Раньше чек собирался
          // и слался client-side через legacy print-server (Path A) —
          // теперь весь pipeline server-side (Path B).
          toast.success(`Оплачено · ${formatCurrency(totalWithService)} · ${paymentMethod === 'cash' ? 'Наличные' : 'Карта'}`, {
            duration: 4000,
            description: 'Чек отправлен на печать',
          })
        } catch (e) {
          // Заказ создан, но закрытие/оплата упала — пусть кассир закроет
          // через OrderActionsDialog. Не выкидываем — заказ уже в БД.
          console.error('[OrderComposer] inline pay failed:', e)
          toast.error(`Заказ создан, но оплата не прошла: ${e instanceof Error ? e.message : ''}`)
        }
      } else {
        toast.success(`Заказ создан: ${formatCurrency(total)}`)
      }
      setCart([])
      setSelectedTableId('')
      setSearch('')
      setGuestsCount(1)
      setSelectedExistingOrderId(null)
      setOpenTabs([])
      setPendingTabLabel('')
      if (order?.id) onSubmitted?.({ orderId: order.id, mode: 'new' })
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Ошибка'
      if (msg.includes('Недостаточно ингредиентов')) {
        toast.error('Не хватает ингредиентов', {
          description: msg.replace('Недостаточно ингредиентов: ', '').replace(/Недостаточно ингредиентов \(\d+\): /, ''),
          duration: 6000,
        })
      } else if (
        msg.toLowerCase().includes('связи') ||
        msg.toLowerCase().includes('network') ||
        msg.toLowerCase().includes('failed to fetch') ||
        msg.toLowerCase().includes('load failed') ||
        msg.toLowerCase().includes('econn') ||
        msg.toLowerCase().includes('timeout')
      ) {
        // Сразу помечаем сервер недоступным — баннер «Нет связи» в waiter-shell
        // появится мгновенно (не ждём 15-сек probe).
        try {
          const { markLanUnreachable } = await import('@/lib/waiter/lan-guard')
          markLanUnreachable()
        } catch { /* not-waiter or import failed — toast'а ниже достаточно */ }
        toast.error('Нет связи с заведением', {
          description: 'Корзина сохранена. Подключитесь к Wi-Fi заведения и попробуйте снова.',
          duration: 6000,
        })
      } else {
        toast.error(msg || 'Не удалось создать заказ')
      }
    } finally {
      setSubmitting(false)
    }
  }

  // ─── Render ─────────────────────────────────────────────────────────────
  const visibleCategories = categories.filter(c => c && !String(c).toLowerCase().includes('полуфабрикат'))

  // Группируем меню по категориям — для drill-down рендера в новом layout.
  // Используем `availableMenu` (уже отфильтрован по stop-list/batch/поиску),
  // НО когда мы в drill-режиме (без поискового запроса) показываем все блюда
  // категории независимо от выбранной активной `category` — поэтому строим
  // от исходного `menu`, не от `availableMenu`. Скрытые позиции (Полуфабрикаты)
  // отбрасываем через isHidden.
  const dishesByCategory = useMemo(() => {
    const m = new Map<string, MenuItem[]>()
    for (const item of menuItems) {
      if (isHidden(item)) continue
      const cat = item.category || 'Без категории'
      const arr = m.get(cat)
      if (arr) arr.push(item)
      else m.set(cat, [item])
    }
    // Sort within each category alphabetically (A-Z, locale-aware).
    for (const arr of m.values()) {
      arr.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    }
    return m
  }, [menuItems])

  // Категории + количество блюд (для главного экрана drill-down).
  const categoriesWithCounts = useMemo(
    () => visibleCategories
      .map(cat => ({ name: cat, count: dishesByCategory.get(cat)?.length ?? 0 }))
      .filter(x => x.count > 0)
      .sort((a, b) => b.count - a.count),
    [visibleCategories, dishesByCategory],
  )

  // Меню по умолчанию: горизонтальная полоса категорий сверху + сетка блюд
  // активной категории снизу. Раньше дефолтным состоянием был «полный экран
  // больших плиток категорий» — кассир делал лишний клик чтобы дойти до
  // блюд. Теперь активна первая категория сразу при загрузке; клик по
  // другой меняет drilledCategory. Поиск переопределяет активную категорию
  // и показывает плоский результат (тоже через DishTile).
  const activeCategory = drilledCategory ?? categoriesWithCounts[0]?.name ?? null
  const isDrillDishesView = useNewLayout && (!!search || activeCategory !== null)
  // FAVORITES_KEY — sentinel для drilledCategory чтобы отличать «избранное»
  // от настоящих категорий блюд. Никогда не пересекается с реальной
  // категорией, поскольку префикс «__» в category-strings не используется.
  const drillDishes = isDrillDishesView
    ? search
      ? availableMenu
      : activeCategory === FAVORITES_KEY
        ? favoriteIds
            .map(id => menuItems.find(m => m.id === id))
            .filter((m): m is MenuItem => !!m && !isHidden(m))
            .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
        : activeCategory
          ? (dishesByCategory.get(activeCategory) ?? [])
          : []
    : []

  // Submit button label
  const submitLabel = isAddMode || existingOrderId
    ? `Дозаказ · ${formatCurrency(total)}`
    : `Создать заказ · ${formatCurrency(total)}`
  const submitDisabled = cart.length === 0 || submitting
    || (!isAddMode && orderType === 'hall' && !selectedTableId)

  // Mobile menu screen
  const renderMobileMenu = () => (
    <div className="flex flex-col h-full">
      <div className="p-3 bg-card border-b border-border space-y-2">
        <div className="flex items-center gap-2">
          {/* Back button — only rendered when the parent wired onCancel.
              Without this, /waiter/order/new had no in-app way to exit
              without the device back gesture; on Capacitor's hardware back
              that works but on PWA it doesn't, and on iOS Safari it leaves
              the waiter stuck. */}
          {onCancel && (
            <button
              onClick={onCancel}
              aria-label="Назад"
              className="size-11 shrink-0 flex items-center justify-center rounded-xl bg-background border border-border text-foreground active:bg-muted transition-colors"
            >
              <ArrowLeft className="size-5" />
            </button>
          )}
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-5 text-muted-foreground" />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Поиск блюда..."
              className="w-full pl-11 pr-4 py-3 bg-background border border-border rounded-xl text-base focus:outline-none focus:ring-2 focus:ring-primary/30" />
          </div>
          <div className="flex items-center bg-background border border-border rounded-xl p-1 shrink-0">
            <button onClick={() => setMobileLayout('grid')} aria-label="Сетка"
              className={`size-9 flex items-center justify-center rounded-lg ${mobileLayout === 'grid' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}>
              <LayoutGrid className="size-4" />
            </button>
            <button onClick={() => setMobileLayout('list')} aria-label="Список"
              className={`size-9 flex items-center justify-center rounded-lg ${mobileLayout === 'list' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}>
              <List className="size-4" />
            </button>
          </div>
        </div>
        <div
          className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide"
          onWheel={(e) => {
            if (e.deltaY === 0) return
            e.currentTarget.scrollLeft += e.deltaY
          }}
        >
          <button onClick={() => setCategory('Все')}
            className={`px-4 py-2 rounded-xl text-sm font-medium whitespace-nowrap ${category === 'Все' ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground'}`}>
            Все
          </button>
          {visibleCategories.map(cat => (
            <button key={cat} onClick={() => setCategory(cat)}
              className={`px-4 py-2 rounded-xl text-sm font-medium whitespace-nowrap ${category === cat ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground'}`}>
              {cat}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {mobileLayout === 'grid' ? (
          <div className="grid grid-cols-2 gap-2.5">
            {availableMenu.map(item => {
              const inCart = cartByMenuId.get(item.id)
              const isStopped = !item.isAvailable
              return (
                <div key={item.id} className="relative">
                  <button onClick={() => addToCart(item)}
                    className={`relative w-full aspect-square rounded-2xl overflow-hidden text-left bg-card border border-border active:scale-[0.96] transition-transform ${inCart ? 'ring-2 ring-primary border-transparent' : ''} ${isStopped ? 'opacity-60 grayscale-[0.5]' : ''}`}>
                    {item.imageUrl ? (
                      <>
                        <img src={item.imageUrl} alt={item.name} loading="lazy" decoding="async" className="absolute inset-0 w-full h-full object-cover" />
                        <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent" />
                        <div className="absolute bottom-0 left-0 right-0 p-3">
                          <p className="text-sm font-bold text-white leading-tight line-clamp-2">{item.name}</p>
                          <p className="text-sm font-bold text-amber-300 mt-0.5">{formatPriceLabel(item.price, item.unit, item.unitSize)}</p>
                        </div>
                      </>
                    ) : (
                      <div className="absolute inset-0 flex flex-col items-center justify-center p-3 text-center">
                        {item.emoji && <span className="text-2xl mb-1">{item.emoji}</span>}
                        <p className="text-sm font-bold text-foreground leading-snug line-clamp-2">{item.name}</p>
                        <p className="text-base font-bold text-primary mt-1">{formatPriceLabel(item.price, item.unit, item.unitSize)}</p>
                      </div>
                    )}
                    {inCart && (
                      <span className="absolute top-2 right-2 size-8 rounded-full bg-primary text-primary-foreground text-sm font-bold flex items-center justify-center shadow-lg">{inCart.qty}</span>
                    )}
                    {!item.isAvailable && (
                      <span className="absolute top-2 left-2 px-2 py-0.5 rounded-full bg-rose-500 text-white text-[10px] font-bold uppercase tracking-wide shadow-lg">Стоп</span>
                    )}
                  </button>
                  {inCart && (
                    <button onClick={(e) => { e.stopPropagation(); updateQty(item.id, -1) }}
                      className="absolute top-2 left-2 size-8 rounded-full bg-white/95 border border-destructive/40 text-destructive font-bold flex items-center justify-center shadow-lg active:scale-90"
                      aria-label="Убрать"
                    >−</button>
                  )}
                </div>
              )
            })}
          </div>
        ) : (
          <div className="divide-y divide-border bg-card border border-border rounded-xl overflow-hidden">
            {availableMenu.map(item => {
              const inCart = cartByMenuId.get(item.id)
              const isStopped = !item.isAvailable
              return (
                <div key={item.id} className={`flex items-center gap-3 px-3 py-2.5 ${inCart ? 'bg-primary/5' : ''} ${isStopped ? 'opacity-60 grayscale-[0.5]' : ''}`}>
                  <button onClick={() => addToCart(item)} className="flex-1 flex items-center gap-3 text-left min-w-0">
                    {item.imageUrl ? (
                      <img src={item.imageUrl} alt={item.name} loading="lazy" decoding="async" className="size-11 rounded-lg object-cover shrink-0" />
                    ) : (
                      <div className="size-11 rounded-lg bg-muted flex items-center justify-center text-lg shrink-0">{item.emoji || '🍽'}</div>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <p className={`text-sm font-semibold truncate ${isStopped ? 'text-muted-foreground line-through' : 'text-foreground'}`}>{item.name}</p>
                        {isStopped && (
                          <span className="px-1.5 py-0.5 rounded bg-rose-100 text-rose-700 text-[10px] font-bold uppercase shrink-0">Стоп</span>
                        )}
                      </div>
                      <p className={`text-xs font-bold ${isStopped ? 'text-muted-foreground' : 'text-primary'}`}>{formatPriceLabel(item.price, item.unit, item.unitSize)}</p>
                    </div>
                  </button>
                  {inCart ? (
                    <div className="flex items-center gap-1 shrink-0">
                      <button onClick={() => updateQty(item.id, -1)} className="size-8 rounded-lg bg-muted flex items-center justify-center active:scale-90" aria-label="Убрать">
                        <Minus className="size-4" />
                      </button>
                      <span className="min-w-7 text-center text-sm font-bold text-foreground">{inCart.qty}</span>
                      <button onClick={() => addToCart(item)} className="size-8 rounded-lg bg-primary text-primary-foreground flex items-center justify-center active:scale-90" aria-label="Добавить">
                        <Plus className="size-4" />
                      </button>
                    </div>
                  ) : (
                    <button onClick={() => addToCart(item)} className="size-8 rounded-lg bg-primary text-primary-foreground flex items-center justify-center active:scale-90 shrink-0" aria-label="Добавить">
                      <Plus className="size-4" />
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        )}
        {availableMenu.length === 0 && (
          loading ? (
            <div className="grid grid-cols-2 gap-2.5">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="aspect-square rounded-2xl bg-zinc-200 dark:bg-zinc-800 animate-pulse" />
              ))}
            </div>
          ) : (
            <div className="flex items-center justify-center h-32">
              <p className="text-base text-muted-foreground">{search ? `Ничего не найдено` : 'Нет доступных блюд'}</p>
            </div>
          )
        )}
      </div>

      {cart.length > 0 && (
        <div className="p-3 bg-card border-t border-border pb-[calc(env(safe-area-inset-bottom,0px)+0.75rem)]">
          <button onClick={() => handleSubmit()} disabled={submitDisabled}
            className="w-full flex items-center justify-center gap-3 py-4 bg-primary text-primary-foreground rounded-2xl text-base font-semibold active:scale-[0.98] shadow-lg disabled:opacity-60">
            {submitting ? (
              <>
                <span className="size-5 border-2 border-primary-foreground/40 border-t-primary-foreground rounded-full animate-spin" />
                <span>Создание заказа...</span>
              </>
            ) : (
              <>
                <CreditCard className="size-5" />
                <span>{submitLabel}</span>
                <span className="text-xs opacity-80">· {totalItems} поз.</span>
              </>
            )}
          </button>
        </div>
      )}
    </div>
  )

  // Mobile cart screen
  const renderMobileCart = () => (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between p-4 bg-card border-b border-border">
        <button onClick={() => setMobileView('menu')} className="flex items-center gap-2 text-primary text-base font-medium">
          <X className="size-5" /> Назад к меню
        </button>
        {cart.length > 0 && (
          <button onClick={clearCart} className="text-sm text-destructive font-medium">Очистить</button>
        )}
      </div>

      {!isAddMode && !lockDestination && (
        <div className="p-3 bg-card border-b border-border">
          {renderOrderTypeSelector('mobile')}
          {orderType === 'hall' && renderTablePicker('mobile')}
        </div>
      )}

      {isAddMode && (
        <DestinationLockedBanner label={(props as Extract<OrderComposerProps, { mode: 'add' }>).destinationLabel} />
      )}

      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {cart.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
            <ShoppingCart className="size-12 mb-3 opacity-30" />
            <p className="text-base">Корзина пуста</p>
            <p className="text-sm">Нажмите на блюдо чтобы добавить</p>
          </div>
        ) : cart.map((line, idx) => {
          const isWeight = line.unit !== 'piece'
          return (
            <div key={`${line.menuItemId}-${idx}`} className="flex items-center gap-3 bg-card rounded-xl p-3 border border-border">
              <div className="flex-1 min-w-0">
                <p className="text-base font-medium truncate">
                  {line.emoji} {line.name}
                  {isWeight && <span className="text-sm text-muted-foreground ml-1">{formatQty(line.qty, line.unit)}</span>}
                </p>
                <p className="text-sm text-primary font-semibold">{formatCurrency(lineTotal(line))}</p>
              </div>
              <div className="flex items-center gap-1">
                <button onClick={() => updateQty(line.menuItemId, -1)} className="size-10 rounded-xl bg-muted flex items-center justify-center active:scale-90">
                  {(!isWeight && line.qty === 1) ? <Trash2 className="size-4 text-destructive" /> : <Minus className="size-4" />}
                </button>
                <span className="w-10 text-center text-base font-bold">
                  {isWeight ? formatQty(line.qty, line.unit) : line.qty}
                </span>
                <button onClick={() => updateQty(line.menuItemId, 1)} className="size-10 rounded-xl bg-muted flex items-center justify-center active:scale-90">
                  <Plus className="size-4" />
                </button>
              </div>
            </div>
          )
        })}
      </div>

      {cart.length > 0 && (
        <div className="p-3 bg-card border-t border-border space-y-3 pb-[calc(env(safe-area-inset-bottom,0px)+0.75rem)]">
          {!isAddMode && orderType === 'hall' && (
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground flex items-center gap-1.5"><UsersIcon className="size-4" /> Гостей</span>
              <div className="flex items-center gap-1">
                <button onClick={() => setGuestsCount(Math.max(1, guestsCount - 1))} className="size-9 rounded-lg bg-muted flex items-center justify-center"><Minus className="size-4" /></button>
                <span className="w-8 text-center text-base font-bold">{guestsCount}</span>
                <button onClick={() => setGuestsCount(guestsCount + 1)} className="size-9 rounded-lg bg-muted flex items-center justify-center"><Plus className="size-4" /></button>
              </div>
            </div>
          )}
          <button onClick={() => handleSubmit()} disabled={submitDisabled}
            className="w-full flex items-center justify-center gap-2 py-4 bg-primary text-primary-foreground rounded-2xl text-lg font-bold disabled:opacity-50 active:scale-[0.98] shadow-lg">
            {submitting ? (
              <>
                <span className="size-5 border-2 border-primary-foreground/40 border-t-primary-foreground rounded-full animate-spin" />
                <span>Создание заказа...</span>
              </>
            ) : (
              <>
                <CreditCard className="size-5" />
                {submitLabel}
              </>
            )}
          </button>
        </div>
      )}
    </div>
  )

  // Order type selector (used in desktop right panel + mobile cart)
  function renderOrderTypeSelector(variant: 'mobile' | 'desktop') {
    if (lockDestination) return null
    return (
      <div className={`flex gap-1 bg-muted/50 p-1 rounded-xl ${variant === 'desktop' ? '' : ''}`}>
        {ORDER_TYPE_OPTIONS.map(opt => {
          const Icon = opt.icon
          return (
            <button key={opt.value}
              onClick={() => { setOrderType(opt.value); if (opt.value !== 'hall') setSelectedTableId('') }}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-lg text-sm font-medium ${orderType === opt.value ? 'bg-card shadow-sm text-foreground' : 'text-muted-foreground'}`}>
              <Icon className="size-4" />{opt.label}
            </button>
          )
        })}
      </div>
    )
  }

  // Picker открытых takeaway/delivery заказов в правом сайдбаре. Раньше
  // кассир после «Создать без оплаты» не мог найти заказ из POS — приходилось
  // ходить на /operations/orders. Теперь все открытые «С СОБОЙ» — список
  // карточек тут. Клик переключает на этот заказ (selectedExistingOrderId);
  // OrderActionsPanel + «Уже заказано» подтягивают остальное. «+ Новый» —
  // явно сбрасывает выбор для нового заказа.
  function renderTakeawayOrdersPicker() {
    if (isAddMode || (orderType !== 'takeaway' && orderType !== 'delivery')) return null
    const newActive = selectedExistingOrderId === null
    return (
      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground px-0.5">
          Открытые {orderType === 'takeaway' ? '«С собой»' : 'доставки'}
        </p>
        {/* Same grid + tile size as the hall-table picker — keeps the sidebar
            visually consistent across order types. The "+ Новый" tile is the
            first cell; existing open tabs follow as 2-line cards. */}
        <div className="grid grid-cols-3 gap-2">
          <button
            onClick={() => { setSelectedExistingOrderId(null); setPendingTabLabel('') }}
            className={`flex items-center justify-center gap-1.5 min-h-[3.5rem] rounded-xl text-sm font-semibold border-2 border-dashed transition-colors ${
              newActive ? 'border-primary bg-primary/5 text-primary' : 'border-primary/40 text-primary hover:bg-primary/5'
            }`}
            title="Создать новый заказ"
          >
            <Plus className="size-4" />
            <span>Новый</span>
          </button>
          {openTabs.map(t => {
            const active = selectedExistingOrderId === t.id
            const num = t.order?.orderNumber ? `#${t.order.orderNumber}` : `#${t.id.slice(-4)}`
            const itemsCount = t.items?.filter(i => !i.cancelledAt).length ?? 0
            const since = t.order?.createdAt ? getTimeSince(t.order.createdAt) : ''
            return (
              <button
                key={t.id}
                onClick={() => { setSelectedExistingOrderId(t.id); setPendingTabLabel('') }}
                className={`flex flex-col items-start justify-center gap-0.5 min-h-[3.5rem] rounded-xl border-2 px-3 py-2 text-left transition-colors ${
                  active ? 'border-amber-400 bg-amber-50' : 'border-border hover:bg-muted'
                }`}
              >
                <span className={`text-base font-bold tabular-nums leading-none ${active ? 'text-amber-900' : 'text-foreground'}`}>
                  {num}
                </span>
                <span className="text-[11px] text-muted-foreground tabular-nums leading-snug">
                  {itemsCount} поз · {formatCurrency(t.total)}{since ? ` · ${since}` : ''}
                </span>
              </button>
            )
          })}
        </div>
      </div>
    )
  }

  // Table picker (mobile + desktop share the markup but different sizing)
  function renderTablePicker(variant: 'mobile' | 'desktop') {
    if (orderType !== 'hall') return null
    return (
      <div className={variant === 'mobile' ? 'mt-3' : 'mt-2'}>
        {selectedTable && !showTablePicker ? (
          // Bigger, more obvious "switch table" affordance: the whole row is
          // still the click target, but the right-side label is now a real
          // chip with an icon — easier to find than the previous near-invisible
          // "Изменить" muted text. Label upgraded to "Все столы" because that's
          // what tapping it actually shows (the full grid), not an "edit" form.
          <button onClick={() => !lockDestination && setShowTablePicker(true)}
            disabled={lockDestination}
            className={`w-full flex items-center justify-between gap-3 px-3.5 py-3 border-2 rounded-xl text-sm transition-colors ${
              existingOrderId ? 'bg-amber-50 border-amber-300 hover:bg-amber-100' :
              selectedTable.status === 'reserved' ? 'bg-blue-50 border-blue-300 hover:bg-blue-100' :
              'bg-primary/5 border-primary/30 hover:bg-primary/10'
            }`}>
            <span className={`text-base font-semibold ${
              existingOrderId ? 'text-amber-700' :
              selectedTable.status === 'reserved' ? 'text-blue-700' :
              'text-primary'
            }`}>
              {selectedTable.name} · {selectedTable.capacity} мест
              {existingOrderId && <span className="ml-1.5 text-[10px] px-1.5 py-0.5 bg-amber-200 text-amber-800 rounded font-semibold align-middle">ДОЗАКАЗ</span>}
              {selectedTable.status === 'reserved' && !existingOrderId && <span className="ml-1.5 text-[10px] px-1.5 py-0.5 bg-blue-200 text-blue-800 rounded font-semibold align-middle">БРОНЬ → посадить</span>}
            </span>
            {!lockDestination && (
              <span className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-background border border-border text-foreground text-sm font-medium shadow-sm">
                <LayoutGrid className="size-4" />
                Все столы
              </span>
            )}
          </button>
        ) : (
          <div className="bg-background border border-border rounded-xl p-3 space-y-3">
            {zones.length === 0 ? (
              <p className="text-xs text-muted-foreground text-center py-2">Нет зон</p>
            ) : zones.map(zone => {
              // Скрываем merged-secondary столы (mergedWith != null) — они
              // живут «внутри» primary'я после объединения. Раньше такие
              // столы продолжали светиться отдельной плиткой в POS, и кассир
              // мог открыть пустой merged-secondary вместо primary'я.
              const zoneTables = tables.filter(t => t.zone === zone.id && !t.mergedWith).slice().sort((a, b) => {
                const an = parseInt(a.name, 10), bn = parseInt(b.name, 10)
                if (!isNaN(an) && !isNaN(bn) && an !== bn) return an - bn
                return a.name.localeCompare(b.name, undefined, { numeric: true })
              })
              if (zoneTables.length === 0) return null
              return (
                <div key={zone.id}>
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2 px-0.5">{zone.name}</p>
                  {/* Bigger tile per cashier UX request — was tight px-2.5 py-1.5
                      pills that took roughly 28×60px each. Now ~52×88px which
                      hits the comfortable touch-target minimum (≥48px) and
                      surfaces more state. Sidebar height grows naturally as
                      the grid wraps — that's the desired behaviour. */}
                  <div className="grid grid-cols-3 gap-2">
                    {zoneTables.map(t => {
                      const isFree = t.status === 'free'
                      const isOccupied = t.status === 'occupied'
                      const isReserved = t.status === 'reserved'
                      const isBillRequested = t.status === 'bill_requested'
                      // Все статусы кроме чисто-«сломанного» доступны для
                      // выбора. Раньше bill_requested выпадал из isSelectable
                      // и кассир не мог открыть «Счёт!»-стол чтобы оплатить
                      // его — приходилось обходным путём через карту зала.
                      const isSelectable = isFree || isOccupied || isReserved || isBillRequested
                      const isSelected = selectedTableId === t.id
                      // Количество открытых групп на столе. На /table-map это
                      // показывается бейджем «⊕»/числом — добавляем тот же
                      // индикатор сюда, чтобы кассир видел, что на столе уже
                      // несколько счетов, ДО того как кликнет.
                      const tabsCount = t.currentOrderIds?.length ?? 0
                      return (
                        <button key={t.id}
                          onClick={() => { if (isSelectable) { setSelectedTableId(t.id); setShowTablePicker(false) } }}
                          disabled={!isSelectable}
                          className={`relative flex items-center justify-center min-h-[3.25rem] rounded-xl text-sm font-semibold border-2 transition-colors ${
                            isSelected ? 'border-primary bg-primary text-primary-foreground shadow-sm' :
                            isFree ? 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100' :
                            isOccupied ? 'border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100' :
                            isBillRequested ? 'border-rose-300 bg-rose-50 text-rose-700 hover:bg-rose-100' :
                            isReserved ? 'border-blue-300 bg-blue-50 text-blue-700 hover:bg-blue-100' :
                            'border-yellow-200 bg-yellow-50 text-yellow-500 cursor-not-allowed opacity-60'
                          }`}>
                          {t.name}
                          {tabsCount >= 2 && (
                            <span
                              title={`Открыто групп: ${tabsCount}`}
                              className="absolute -top-1.5 -right-1.5 size-5 rounded-full bg-amber-500 text-white text-[10px] font-bold flex items-center justify-center shadow-sm ring-2 ring-card"
                            >
                              {tabsCount}
                            </span>
                          )}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {/* Multi-tab picker — compact pill row.
            Раньше каждая группа была большой плиткой с label + статусом +
            суммой (3 строки, ~68px высоты). В реальной работе на столе
            почти всегда одна группа, и эта плитка занимала четверть высоты
            сайдбара. Теперь это компактные pills в одну строку: label +
            активный stroke. Статус и сумма ушли — они уже видны в
            OrderActionsPanel сверху и в футере. */}
        {selectedTable && openTabs.length >= 1 && !showTablePicker && (
          <div className="mt-3">
            <div className="flex items-center gap-1.5 flex-wrap">
              {openTabs.map((t, i) => {
                const active = selectedExistingOrderId === t.id
                const label = t.tabLabel || `Группа ${i + 1}`
                return (
                  <button key={t.id}
                    onClick={() => { setSelectedExistingOrderId(t.id); setPendingTabLabel('') }}
                    className={`shrink-0 inline-flex items-center px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                      active ? 'border-amber-400 bg-amber-50 text-amber-900' : 'border-border text-foreground hover:bg-muted'
                    }`}
                  >
                    {label}
                  </button>
                )
              })}
              <button
                onClick={() => { setSelectedExistingOrderId(null); setPendingTabLabel(`Группа ${openTabs.length + 1}`) }}
                title="Новая группа за тем же столом"
                className={`shrink-0 inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium border border-dashed transition-colors ${
                  selectedExistingOrderId === null ? 'border-primary bg-primary/5 text-primary' : 'border-primary/40 text-primary hover:bg-primary/5'
                }`}
              >
                <Plus className="size-3.5" />
                <span>Новая</span>
              </button>
            </div>
            {selectedExistingOrderId === null && (
              <input
                type="text"
                value={pendingTabLabel}
                onChange={e => setPendingTabLabel(e.target.value.slice(0, 32))}
                placeholder={`Метка группы (напр. «Гость ${openTabs.length + 1}»)`}
                className="mt-1.5 w-full px-2.5 py-1.5 rounded-lg border border-border bg-card text-xs focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            )}
          </div>
        )}
      </div>
    )
  }

  // ─── New iiko-style top bar ─────────────────────────────────────────────
  // Полноширочная шапка с переключателем ЗАЛ/С СОБОЙ, поиском и профилем кассира.
  // Только в новом layout (useNewLayout). Заменяет правопанельный селектор типа
  // и поиск в левой панели — они теперь все вверху и видны постоянно.
  // Тап на ЗАЛ ведёт на /operations/table-map (используем существующий экран
  // карты зала вместо дублирования picker'а в композере). После выбора стола
  // там — редирект сюда с ?tableId=, и состав заказа открывается уже для стола.
  const renderTopBar = () => {
    const isHall = orderType === 'hall'
    return (
      <div className="shrink-0 bg-card border-b border-border px-6 py-3 flex items-center gap-4">
        {/* Mode toggle */}
        {!isAddMode && !lockDestination ? (
          <div className="flex items-center gap-1.5 bg-muted rounded-2xl p-1.5 shrink-0">
            <button
              onClick={() => {
                // Тап на ЗАЛ → переключаем тип заказа на hall и остаёмся в POS.
                // Если стол ещё не выбран, под селектором появится inline
                // table-picker (renderTablePicker). Раньше здесь был
                // navigate('/operations/table-map') — убран по запросу:
                // кассир не должен покидать POS, чтобы выбрать стол.
                if (orderType === 'hall') return
                setOrderType('hall')
              }}
              className={`px-6 py-2.5 rounded-xl text-base font-semibold transition-all ${
                isHall ? 'bg-primary text-primary-foreground shadow-md' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              🍽 ЗАЛ
            </button>
            <button
              onClick={() => {
                // Переключение на «С СОБОЙ» — сохраняем выбранную категорию.
                // Раньше тут был setDrilledCategory(null), и активная
                // категория сбрасывалась на первую — кассиру приходилось
                // снова искать нужный раздел после смены типа заказа.
                setOrderType('takeaway')
                setSelectedTableId('')
              }}
              className={`px-6 py-2.5 rounded-xl text-base font-semibold transition-all ${
                !isHall ? 'bg-primary text-primary-foreground shadow-md' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              🥡 С СОБОЙ
            </button>
          </div>
        ) : null}

        {/* Хлебная крошка «← Зал › Стол №X › Группа N» убрана по запросу:
            контекст выбранного стола уже виден в чипе table-picker'а в
            правом сайдбаре, дубль в шапке только перетягивал внимание.
            Сменить стол можно через кнопку «Изменить» в этом чипе. */}

        {/* Search — единый input по центру шапки. */}
        <div className="flex-1 relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-5 text-muted-foreground" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Поиск блюда (введите название)"
            className="w-full pl-11 pr-4 py-2.5 bg-muted border border-transparent rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:bg-background focus:border-border"
          />
        </div>

        {/* Recent orders quick access — открывает drawer со списком сегодняшних
            заказов с фильтром «Открытые / Закрытые». Без этой кнопки кассир
            уходил на /operations/orders искать заказ который только что
            «Сохранён без оплаты» или давно открыт. */}
        <button
          onClick={() => { setOrdersFilter('open'); setOrdersDrawerOpen(true) }}
          className="shrink-0 inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-muted text-foreground text-sm font-medium hover:bg-border transition-colors"
          title="Сегодняшние заказы"
        >
          <Receipt className="size-5" />
          <span className="hidden lg:inline">Заказы</span>
        </button>

        {/* Failed prints — badge with count of kitchen prints the server gave
            up on after 5 attempts. Click to see them and retry / inspect.
            Lives next to «Заказы» so the cashier notices without leaving POS. */}
        <FailedPrintsButton />
      </div>
    )
  }

  // Desktop layout
  // Структура: сайдбар-корзина справа — sibling «(топбар + меню)», а не
  // вложен в content-row под топбаром. Так корзина растягивается на всю
  // высоту вьюпорта от верха до низа — симметрично AppSidebar слева.
  // Топбар (ЗАЛ/С СОБОЙ + поиск) остаётся только над колонкой меню.
  const renderDesktop = () => (
    <div className="flex h-full min-h-0">
      {/* LEFT column: top bar + menu grid */}
      <div className="flex-1 flex flex-col min-w-0 border-r border-border">
        {useNewLayout ? renderTopBar() : null}
        <div className="flex-1 flex flex-col min-w-0 min-h-0">
        {/* compactMode: search + горизонтальные табы категорий внутри левой панели */}
        {!useNewLayout ? (
          <div className="p-3 border-b border-border space-y-2 bg-card">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Поиск блюда..."
                className="w-full pl-10 pr-4 py-2.5 bg-background border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
            </div>
            <div
              className="flex gap-1.5 overflow-x-auto pb-1 scrollbar-hide"
              onWheel={(e) => {
                if (e.deltaY === 0) return
                e.currentTarget.scrollLeft += e.deltaY
              }}
            >
              <button onClick={() => setCategory('Все')}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap ${category === 'Все' ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground'}`}>Все</button>
              {visibleCategories.map(cat => (
                <button key={cat} onClick={() => setCategory(cat)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap ${category === cat ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground'}`}>{cat}</button>
              ))}
            </div>
          </div>
        ) : useNewLayout && categoriesWithCounts.length > 0 ? (
          /* Категории — wrap-полоса (не horizontal scroll).
             Раньше была overflow-x-auto + shrink-0 на пилюлях — при большом
             числе категорий уезжали вправо и оставались скрыты до скролла.
             Теперь flex-wrap на 1-2 строки. Размер пилюль увеличен (px-4 py-2,
             text-sm), счётчики «· N» убраны — список блюд категории кассир
             уже видит ниже, цифра в pill'е была лишним шумом. */
          <div className="px-3 py-2 border-b border-border bg-card flex items-center gap-1.5 flex-wrap">
            {search ? (
              <button
                onClick={() => setSearch('')}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-bold whitespace-nowrap hover:bg-primary/90 transition-colors"
                title="Сбросить поиск"
              >
                <span>Поиск «{search}»</span>
                <X className="size-4" />
              </button>
            ) : null}
            {/* Избранное-чип всегда первый — даже когда список пуст. Это
                чтобы кассир знал, что фича существует (пустое состояние
                покажет hint про long-press). */}
            {(() => {
              const isActive = !search && activeCategory === FAVORITES_KEY
              return (
                <button
                  onClick={() => { setDrilledCategory(FAVORITES_KEY); setSearch('') }}
                  className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-colors ${
                    isActive
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted text-foreground hover:bg-border'
                  }`}
                  title="Долгое нажатие на блюдо чтобы добавить/убрать"
                >
                  <span aria-hidden>★</span>
                  <span>Избранное</span>
                </button>
              )
            })()}
            {categoriesWithCounts.map(c => {
              const isActive = !search && c.name === activeCategory
              return (
                <button
                  key={c.name}
                  onClick={() => { setDrilledCategory(c.name); setSearch('') }}
                  className={`px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-colors ${
                    isActive
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted text-foreground hover:bg-border'
                  }`}
                >
                  {c.name}
                </button>
              )
            })}
          </div>
        ) : null}
        {isDrillDishesView ? (
          /* Сетка блюд: фиксированный размер карточек (aspect-square) +
             адаптивные колонки по ширине. Когда блюд много — контейнер
             скроллится. Раньше сетка растягивала карточки на всю высоту
             через pickGridLayout, и при 4-10 блюдах одна карточка
             занимала пол-экрана. */
          <div className="flex-1 overflow-y-auto p-3 scrollbar-hide" style={{ scrollbarWidth: 'none' }}>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-2">
              {drillDishes.map(item => {
                const inCart = cartByMenuId.get(item.id)
                const isFav = favoriteIds.includes(item.id)
                const isFreq = frequentIds.includes(item.id)
                return (
                  <ContextMenu key={item.id}>
                    <ContextMenuTrigger asChild>
                      <div className="aspect-square">
                        <DishTile
                          name={item.name}
                          price={item.price}
                          emoji={item.emoji}
                          qtyInCart={inCart?.qty}
                          isStopped={!item.isAvailable}
                          onClick={() => addToCart(item)}
                        />
                      </div>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      {isFav ? (
                        <ContextMenuItem
                          onSelect={() => {
                            if (!restaurant?.id) return
                            toggleFavorite(restaurant.id, item.id)
                            toast.message('Убрано из избранного', { description: item.name })
                          }}
                          className="text-destructive focus:text-destructive"
                        >
                          <span className="mr-2">✕</span> Убрать из избранного
                        </ContextMenuItem>
                      ) : (
                        <ContextMenuItem
                          onSelect={() => {
                            if (!restaurant?.id) return
                            toggleFavorite(restaurant.id, item.id)
                            toast.success(`«${item.name}» в избранном`)
                          }}
                        >
                          <span className="mr-2">★</span> Добавить в избранное
                        </ContextMenuItem>
                      )}
                      {isFreq ? (
                        <ContextMenuItem
                          onSelect={() => {
                            if (!restaurant?.id) return
                            toggleFrequent(restaurant.id, item.id)
                            toast.message('Убрано из частых', { description: item.name })
                          }}
                          className="text-destructive focus:text-destructive"
                        >
                          <span className="mr-2">✕</span> Убрать из частых
                        </ContextMenuItem>
                      ) : (
                        <ContextMenuItem
                          onSelect={() => {
                            if (!restaurant?.id) return
                            toggleFrequent(restaurant.id, item.id)
                            toast.success(`«${item.name}» добавлено в частые`)
                          }}
                        >
                          <span className="mr-2">⚡</span> Добавить в частые
                        </ContextMenuItem>
                      )}
                    </ContextMenuContent>
                  </ContextMenu>
                )
              })}
            </div>
            {drillDishes.length === 0 && (
              <div className="flex flex-col items-center justify-center h-40 gap-1 text-center px-4">
                {search ? (
                  <p className="text-sm text-muted-foreground">Ничего не найдено: «{search}»</p>
                ) : activeCategory === FAVORITES_KEY ? (
                  <>
                    <p className="text-sm font-medium text-foreground">Избранное пусто</p>
                    <p className="text-xs text-muted-foreground max-w-[18rem]">
                      Удерживайте долго на блюде или нажмите правой кнопкой,
                      чтобы добавить или убрать из избранного.
                    </p>
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">Нет доступных блюд</p>
                )}
              </div>
            )}
          </div>
        ) : (
        <div className="flex-1 overflow-y-auto p-3 scrollbar-hide" style={{ scrollbarWidth: 'none' }}>
          <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-1.5">
            {availableMenu.map(item => {
              const inCart = cartByMenuId.get(item.id)
              return (
                <button key={item.id} onClick={() => addToCart(item)}
                  className={`relative aspect-square rounded-xl overflow-hidden text-left bg-card border border-border hover:border-primary/40 hover:shadow-sm active:scale-[0.97] transition-all ${inCart ? 'ring-2 ring-primary border-transparent' : ''}`}>
                  {item.imageUrl ? (
                    <>
                      <img src={item.imageUrl} alt={item.name} className="absolute inset-0 w-full h-full object-cover" />
                      <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent" />
                      <div className="absolute bottom-0 left-0 right-0 p-2">
                        <p className="text-[11px] font-bold text-white leading-tight line-clamp-2">{item.name}</p>
                        <p className="text-xs font-bold text-amber-300 mt-0.5">{formatPriceLabel(item.price, item.unit, item.unitSize)}</p>
                      </div>
                    </>
                  ) : (
                    <div className="absolute inset-0 flex flex-col items-center justify-center p-2 text-center">
                      <p className="text-sm font-bold text-foreground leading-snug line-clamp-3">{item.name}</p>
                      {item.price > 0 && <p className="text-sm font-bold text-primary mt-1">{formatPriceLabel(item.price, item.unit, item.unitSize)}</p>}
                    </div>
                  )}
                  {inCart && (
                    <span className="absolute top-1 right-1 size-6 rounded-full bg-primary text-primary-foreground text-xs font-bold flex items-center justify-center shadow-lg">{inCart.qty}</span>
                  )}
                </button>
              )
            })}
          </div>
          {availableMenu.length === 0 && (
            loading ? (
              <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-1.5">
                {Array.from({ length: 18 }).map((_, i) => (
                  <div key={i} className="aspect-square rounded-xl bg-zinc-200 dark:bg-zinc-800 animate-pulse" />
                ))}
              </div>
            ) : (
              <div className="flex items-center justify-center h-32">
                <p className="text-sm text-muted-foreground">{search ? `Ничего не найдено: "${search}"` : 'Нет доступных блюд'}</p>
              </div>
            )
          )}
        </div>
        )}
        {/* «Часто используемые» — sticky-полоса в одну строку под сеткой
            блюд. Источник — ручной shortlist (right-click → «Добавить в
            частые»). Видна на любой категории (включая ★ Избранное и
            поиск); клик мгновенно добавляет в корзину. Скрыта пока
            список пуст — не показываем кассиру пустую полосу-пустышку. */}
        {useNewLayout ? (() => {
          const items = frequentIds
            .map(id => menuItems.find(m => m.id === id))
            .filter((m): m is MenuItem => !!m && !isHidden(m))
            .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
          if (items.length === 0) return null
          return (
            <div className="shrink-0 border-t border-border bg-muted/30 px-3 py-2">
              {/* Multi-row wrap (не horizontal scroll). При большом списке
                  растёт вниз, занимая столько строк сколько нужно. */}
              <div className="flex items-center gap-2 flex-wrap">
                <Zap className="size-4 text-muted-foreground" aria-label="Часто используемые" />

                {items.map(item => {
                  const inCart = cartByMenuId.get(item.id)
                  // Visual stop indicator regardless of permission. Click
                  // permission gating happens inside addToCart (toast warning
                  // for users без orders.create_stopped, info-toast для
                  // тех у кого permission есть).
                  const isStopped = !item.isAvailable
                  return (
                    <button
                      key={item.id}
                      onClick={() => addToCart(item)}
                      className={`relative inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors ${
                        isStopped
                          ? 'border-border bg-muted text-muted-foreground'
                          : inCart && inCart.qty > 0
                            ? 'border-primary bg-primary/5 text-foreground'
                            : 'border-border bg-background text-foreground hover:bg-muted hover:border-primary/40'
                      }`}
                    >
                      <span className={`text-base leading-none ${isStopped ? 'grayscale opacity-60' : ''}`}>{item.emoji ?? '·'}</span>
                      <span className="truncate max-w-[10rem]">{item.name}</span>
                      <span className={isStopped ? 'text-muted-foreground/70 tabular-nums' : 'text-muted-foreground tabular-nums'}>{formatCurrencyCompact(item.price)}</span>
                      {inCart && inCart.qty > 0 ? (
                        <span className="ml-0.5 size-4 rounded-full bg-primary text-primary-foreground text-[10px] font-bold inline-flex items-center justify-center">
                          {inCart.qty}
                        </span>
                      ) : null}
                    </button>
                  )
                })}
              </div>
            </div>
          )
        })() : null}
      </div>
      </div>

      {/* RIGHT: Cart + tables sidebar — sibling of LEFT column, full viewport
          height. Widened from w-80 lg:w-96 (320/384px) so the 3-column table
          grid + status colours stay readable at cashier glance distance. */}
      <div className="w-96 lg:w-[28rem] xl:w-[32rem] flex flex-col bg-card">
        {!isAddMode && (
          <div className="p-3 border-b border-border">
            {/* В новом layout селектор типа заказа уехал в TopBar — здесь его не дублируем.
                В compactMode остаётся как было. */}
            {!useNewLayout ? renderOrderTypeSelector('desktop') : null}
            {orderType === 'hall' && renderTablePicker('desktop')}
            {(orderType === 'takeaway' || orderType === 'delivery') && renderTakeawayOrdersPicker()}
          </div>
        )}
        {isAddMode && (
          <DestinationLockedBanner label={(props as Extract<OrderComposerProps, { mode: 'add' }>).destinationLabel} />
        )}

        {/* Inline OrderActionsPanel overrides the standard cart scroll+footer
            when an existing tab is selected and the cart is empty (no
            in-progress dozakaz). Phase 2 of «всё-в-одном POS» — превращает
            правый сайдбар в полноценный экран оплаты. Любой клик по блюду
            (cart.length > 0) автоматически вернёт стандартную корзину. */}
        {inlinePanelActive && selectedExistingOrder ? (
          <OrderActionsPanel
            order={selectedExistingOrder}
            users={users}
            onClosed={() => {
              // После закрытия+оплаты — сбрасываем выбор группы, освежаем
              // tabs (оплаченный заказ выпадает), сообщаем родителю
              // (table-map перерисуется).
              setSelectedExistingOrderId(null)
              void refreshTabsItems()
              onSubmitted?.({ orderId: selectedExistingOrder.id, mode: 'add' })
            }}
            onCancelled={() => {
              setSelectedExistingOrderId(null)
              void refreshTabsItems()
              onSubmitted?.({ orderId: selectedExistingOrder.id, mode: 'add' })
            }}
            onItemsChanged={() => { void refreshTabsItems(); void refreshSelectedVoids() }}
            onOpenAdvanced={openOrderActions}
          />
        ) : null}

        <div className={`flex-1 overflow-y-auto p-3 space-y-3 ${inlinePanelActive ? 'hidden' : ''}`}>
          {/* Existing-order items (read-only) when adding to a tab.
              Показываем ВСЕ позиции (живые + отменённые + воиднутые), но
              отменённые/воиднутые рендерим зачёркнутыми и без вклада в
              сумму «Уже заказано». Так кассир видит полный исторический
              состав группы и понимает что было списано. Раньше cart
              фильтровал только cancelledAt — voids (отдельная таблица)
              утекали в список как живые. */}
          {(() => {
            if (isAddMode || !selectedExistingOrderId) return null
            const allItems = openTabs.find(t => t.id === selectedExistingOrderId)?.items ?? []
            if (allItems.length === 0) return null
            const flags = voidedItemFlags(allItems, selectedOrderVoids)
            const liveItems = allItems.filter((_, i) => !flags[i])
            const liveTotal = liveItems.reduce(
              (s, i) => s + calcLineTotal(i.price, i.qty, i.unit, i.unitSize),
              0,
            )
            const voidedCount = flags.filter(Boolean).length
            return (
              <div className="rounded-xl border border-amber-200 bg-amber-50/60">
                <div className="flex items-center justify-between px-3 py-2 border-b border-amber-200">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-amber-900">
                    Уже заказано · {liveItems.length}
                    {voidedCount > 0 ? (
                      <span className="ml-1.5 font-normal text-amber-900/70">· списано {voidedCount}</span>
                    ) : null}
                  </span>
                  <span className="text-xs font-bold text-amber-900 tabular-nums">{formatCurrency(liveTotal)}</span>
                </div>
                <div className="divide-y divide-amber-200/70">
                  {allItems.map((it, idx) => {
                    const voided = flags[idx]
                    return (
                      <div
                        key={`exist-${it.id ?? idx}-${idx}`}
                        className={`flex items-center gap-2 px-3 py-2 ${voided ? 'opacity-60' : ''}`}
                      >
                        <span className={`text-base shrink-0 ${voided ? 'opacity-50' : ''}`}>{it.emoji ?? '·'}</span>
                        <div className="flex-1 min-w-0">
                          <p className={`text-xs font-medium truncate ${voided ? 'text-muted-foreground line-through' : 'text-amber-950'}`}>
                            {it.name}
                          </p>
                          <p className={`text-[10px] ${voided ? 'text-muted-foreground line-through' : 'text-amber-700'}`}>
                            ×{it.unit && it.unit !== 'piece' ? formatQty(it.qty, it.unit) : it.qty} · {formatPriceLabel(it.price, it.unit, it.unitSize)}
                          </p>
                        </div>
                        <span className={`text-xs font-semibold min-w-[5rem] text-right whitespace-nowrap tabular-nums ${
                          voided ? 'text-muted-foreground line-through' : 'text-amber-900'
                        }`}>
                          {formatCurrency(calcLineTotal(it.price, it.qty, it.unit, it.unitSize))}
                        </span>
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })()}

          {cart.length === 0 ? (
            <div className={`flex flex-col items-center justify-center text-center ${selectedExistingOrderId ? 'py-6' : 'h-full'}`}>
              <ShoppingCart className="size-12 text-muted-foreground/20 mb-3" />
              <p className="text-sm text-muted-foreground">{selectedExistingOrderId ? 'Добавьте позиции к дозаказу' : 'Корзина пуста'}</p>
              <p className="text-xs text-muted-foreground mt-1">Нажмите на блюдо чтобы добавить</p>
            </div>
          ) : (
            <div className="space-y-2">
              {cart.map((line, idx) => {
                const isWeight = line.unit !== 'piece'
                return (
                  <div key={`${line.menuItemId}-${idx}`} className="flex items-center gap-2 bg-background rounded-xl p-2.5 border border-border">
                    <span className="text-lg shrink-0">{line.emoji}</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-foreground truncate">
                        {line.name}
                        {isWeight && <span className="text-[10px] text-muted-foreground ml-1">{formatQty(line.qty, line.unit)}</span>}
                      </p>
                      <p className="text-xs text-muted-foreground">{formatPriceLabel(line.price, line.unit, line.unitSize)}</p>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button onClick={() => updateQty(line.menuItemId, -1)} className="size-7 rounded-lg border border-border flex items-center justify-center hover:bg-muted">
                        <Minus className="size-3" />
                      </button>
                      <span className="text-sm font-bold w-10 text-center">{isWeight ? formatQty(line.qty, line.unit) : line.qty}</span>
                      <button onClick={() => updateQty(line.menuItemId, 1)} className="size-7 rounded-lg border border-border flex items-center justify-center hover:bg-muted">
                        <Plus className="size-3" />
                      </button>
                    </div>
                    <span className="text-sm font-bold text-foreground min-w-[5.5rem] text-right whitespace-nowrap tabular-nums">{formatCurrency(lineTotal(line))}</span>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <div className={`p-3 border-t border-border space-y-2 bg-card ${inlinePanelActive ? 'hidden' : ''}`}>
          {!isAddMode && orderType === 'hall' && (
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground flex items-center gap-1"><UsersIcon className="size-3" />Гостей</span>
              <div className="flex items-center gap-1.5">
                <button onClick={() => setGuestsCount(Math.max(1, guestsCount - 1))} disabled={guestsCount <= 1}
                  className="size-6 rounded-md border border-border flex items-center justify-center hover:bg-muted disabled:opacity-30">
                  <Minus className="size-3" />
                </button>
                <span className="text-sm font-bold w-5 text-center">{guestsCount}</span>
                <button onClick={() => setGuestsCount(Math.min(20, guestsCount + 1))} disabled={guestsCount >= 20}
                  className="size-6 rounded-md border border-border flex items-center justify-center hover:bg-muted disabled:opacity-30">
                  <Plus className="size-3" />
                </button>
              </div>
            </div>
          )}
          {/* Итог + явная текстовая кнопка очистки (с подтверждением).
              Раньше была иконка-корзина без подтверждения — слишком легко
              случайно сбросить заказ. Теперь полноценный «Очистить корзину»
              + AlertDialog. */}
          <div className="flex items-end justify-between gap-2">
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">{totalItems} позиц{totalItems === 1 ? 'ия' : totalItems < 5 ? 'ии' : 'ий'}</p>
              <p className="text-2xl font-bold text-foreground tabular-nums leading-tight">{formatCurrency(total)}</p>
            </div>
            {cart.length > 0 && (
              <button
                onClick={() => setClearConfirmOpen(true)}
                className="inline-flex items-center gap-1 text-xs font-medium text-destructive hover:bg-destructive/10 px-2 py-1.5 rounded-md transition-colors shrink-0"
              >
                <Trash2 className="size-3.5" />
                Очистить корзину
              </button>
            )}
          </div>
          {!isAddMode && orderType === 'hall' && !selectedTableId && cart.length > 0 && (
            <p className="text-xs text-amber-600 text-center">Выберите стол для заказа в зале</p>
          )}
          {/* Inline-оплата только для С СОБОЙ (takeaway) и нового заказа в новом
              layout. Кнопки сразу проводят оплату (createOrder + closeOrderWithPayment +
              печать чека). Для зала и для дозаказа — обычная кнопка submit. */}
          {useNewLayout && !isAddMode && !existingOrderId && orderType === 'takeaway' ? (
            <div className="space-y-2">
              {/* «Создать без оплаты» — первая кнопка (отдельная строка) над
                  способами оплаты. Раньше была col-span-2 ПОД ними — кассиры
                  с долговыми клиентами должны видеть её сразу, без скана
                  глазами через Нал/Карта. Эмодзи 💵/💳 убраны: текст с цифрой
                  читается сам по себе, иконки добавляли визуальный шум. */}
              <button
                onClick={() => handleSubmit()}
                disabled={submitDisabled}
                className="w-full py-2.5 bg-card border border-border text-muted-foreground rounded-xl text-xs font-medium hover:bg-muted hover:text-foreground disabled:opacity-50"
              >
                Создать без оплаты
              </button>
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => handleSubmit('cash')}
                  disabled={submitDisabled}
                  className="py-4 bg-emerald-600 text-white rounded-xl text-sm font-bold hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {submitting ? '...' : `Нал · ${formatCurrency(total)}`}
                </button>
                <button
                  onClick={() => handleSubmit('card')}
                  disabled={submitDisabled}
                  className="py-4 bg-blue-600 text-white rounded-xl text-sm font-bold hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {submitting ? '...' : `Карта · ${formatCurrency(total)}`}
                </button>
              </div>
            </div>
          ) : (
            /* Note: Phase 2 заменил «Закрыть и оплатить» CTA здесь на
               OrderActionsPanel, который рендерится выше вместо стандартного
               cart scroll+footer когда existing-tab выбран и корзина пуста.
               Эта ветка теперь — fallback для new-order и dozakaz-flow. */
            <button onClick={() => handleSubmit()} disabled={submitDisabled}
              className="w-full py-3.5 bg-primary text-primary-foreground rounded-xl text-sm font-bold hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2">
              <CreditCard className="size-5" />
              {submitting ? 'Отправка...' : submitLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  )

  return (
    <div className={`h-full ${className ?? ''}`}>
      <div className="md:hidden h-full">
        {mobileView === 'menu' ? renderMobileMenu() : renderMobileCart()}
      </div>
      <div className="hidden md:block h-full">
        {renderDesktop()}
      </div>
      <WeightInputSheet
        item={weightItem}
        value={weightValue}
        onChange={setWeightValue}
        onClose={() => { setWeightItem(null); setWeightValue(0) }}
        onConfirm={confirmWeight}
        nested
      />

      {/* Recent-orders drawer — список заказов за сегодня с фильтром
          «Открытые / Закрытые». Клик по открытому заказу переключает
          POS-контекст (orderType + selection) и закрывает drawer; по
          закрытому — открывает legacy OrderActionsDialog (read-only +
          reprint + reopen). */}
      <Sheet open={ordersDrawerOpen} onOpenChange={setOrdersDrawerOpen}>
        <SheetContent className="md:h-full h-[95vh] flex flex-col md:!max-w-md">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <Receipt className="size-5 text-primary" />
              Заказы за сегодня
            </SheetTitle>
            <SheetDescription>
              Открытые — ещё не оплачены. Закрытые — уже завершены, можно перепечатать или переоткрыть.
            </SheetDescription>
          </SheetHeader>

          {/* Filter segmented control */}
          {(() => {
            const open = recentOrders.filter(o => o.status !== 'done' && o.status !== 'cancelled')
            const closed = recentOrders.filter(o => o.status === 'done' || o.status === 'cancelled')
            const visible = ordersFilter === 'open' ? open : closed
            return (
              <>
                <div className="px-4">
                  <div className="grid grid-cols-2 p-0.5 bg-muted rounded-md">
                    <button
                      onClick={() => setOrdersFilter('open')}
                      className={`py-1.5 rounded text-xs font-medium transition-colors ${
                        ordersFilter === 'open' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      Открытые · {open.length}
                    </button>
                    <button
                      onClick={() => setOrdersFilter('closed')}
                      className={`py-1.5 rounded text-xs font-medium transition-colors ${
                        ordersFilter === 'closed' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      Закрытые · {closed.length}
                    </button>
                  </div>
                </div>

                <div className="flex-1 overflow-y-auto px-4 py-3 space-y-1.5">
                  {recentOrdersLoading && recentOrders.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-8">Загрузка...</p>
                  ) : visible.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-8">
                      {ordersFilter === 'open' ? 'Нет открытых заказов' : 'Нет закрытых заказов'}
                    </p>
                  ) : visible.map(o => {
                    const isHall = o.type !== 'delivery' && o.type !== 'takeaway'
                    const tableName = isHall && o.tableId ? tables.find(t => t.id === o.tableId)?.name : null
                    const typeLabel = isHall
                      ? (tableName ? `Стол ${tableName}` : 'Зал')
                      : o.type === 'takeaway' ? 'С собой' : 'Доставка'
                    const itemsCount = (o.items ?? []).filter(i => !i.cancelledAt).length
                    const isClosed = o.status === 'done' || o.status === 'cancelled'
                    // Time-since: открытым показываем «сколько уже открыт»;
                    // закрытым — «когда закрыт» (HH:MM локально + N мин назад).
                    const closedAt = isClosed ? (o.closedAt ?? null) : null
                    const sinceOpen = !isClosed ? getTimeSince(o.createdAt) : ''
                    const closedTimeStr = closedAt
                      ? new Date(closedAt).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })
                      : ''
                    const closedAgo = closedAt ? getTimeSince(closedAt) : ''
                    const statusBadge = o.status === 'cancelled' ? 'Отменён'
                      : o.status === 'done' ? 'Оплачен'
                      : o.status === 'cooking' ? 'Готовится'
                      : o.status === 'ready' ? 'К выдаче'
                      : o.status === 'served' ? 'Подан'
                      : o.status === 'bill_requested' ? 'Счёт'
                      : 'Новый'
                    const badgeColor = o.status === 'cancelled' ? 'bg-zinc-100 text-zinc-700'
                      : o.status === 'done' ? 'bg-emerald-50 text-emerald-700'
                      : o.status === 'cooking' ? 'bg-amber-50 text-amber-700'
                      : o.status === 'ready' ? 'bg-blue-50 text-blue-700'
                      : 'bg-muted text-foreground'
                    return (
                      <button
                        key={o.id}
                        onClick={() => {
                          setOrdersDrawerOpen(false)
                          if (isClosed) {
                            void openOrderActionsFor(o.id)
                            return
                          }
                          // Открытый заказ → переключаем POS-контекст.
                          if (isHall && o.tableId) {
                            setOrderType('hall')
                            setSelectedTableId(o.tableId)
                            setSelectedExistingOrderId(o.id)
                          } else if (o.type === 'takeaway' || o.type === 'delivery') {
                            setOrderType(o.type)
                            setSelectedTableId('')
                            setSelectedExistingOrderId(o.id)
                          }
                          setShowTablePicker(false)
                          setSearch('')
                        }}
                        className="w-full text-left rounded-lg border border-border bg-card hover:bg-muted hover:border-primary/40 transition-colors p-3"
                      >
                        <div className="flex items-baseline justify-between gap-2 mb-1">
                          <span className="text-sm font-bold tabular-nums">
                            #{o.orderNumber ?? o.id.slice(-6)}
                          </span>
                          <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded font-bold ${badgeColor}`}>
                            {statusBadge}
                          </span>
                        </div>
                        <div className="flex items-baseline justify-between gap-2 text-xs">
                          <span className="text-muted-foreground truncate">
                            {typeLabel} · {itemsCount} поз
                            {isClosed
                              ? closedAt ? ` · закрыт в ${closedTimeStr}${closedAgo ? ` (${closedAgo})` : ''}` : ''
                              : sinceOpen ? ` · ${sinceOpen}` : ''}
                          </span>
                          <span className="font-semibold tabular-nums whitespace-nowrap">
                            {formatCurrency(o.totalWithService ?? o.total)}
                          </span>
                        </div>
                      </button>
                    )
                  })}
                </div>
              </>
            )
          })()}
        </SheetContent>
      </Sheet>
      {/* Phase 1 inline order actions: переоткрываем существующий
          OrderActionsDialog поверх POS. Реюзаем готовую логику оплаты,
          скидки, обслуживания, split-bill, отмены без копирования кода. */}
      <OrderActionsDialog
        order={selectedFullOrder}
        open={orderActionsOpen}
        onOpenChange={(o) => { setOrderActionsOpen(o); if (!o) setSelectedFullOrder(null) }}
        onItemsChanged={() => { void refreshTabsItems(); void refreshSelectedVoids() }}
        onAction={async (action, data) => {
          if (!selectedFullOrder) return
          const o = selectedFullOrder
          try {
            if (action === 'close_and_pay') {
              await closeOrderWithPayment(
                o.id,
                data?.paymentMethod || 'cash',
                o.tableId || null,
                o.total,
                o.items.reduce((s, i) => s + calcLineCogs(i.cogs || 0, i.qty, i.unit, i.unitSize), 0),
                effectiveUser?.id,
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
              setOrderActionsOpen(false)
              setSelectedFullOrder(null)
              // После закрытия заказа: сбросить выбор группы, обновить tabs.
              setSelectedExistingOrderId(null)
              void refreshTabsItems()
            } else if (action === 'cancel') {
              await deleteOrder(o.id)
              if (o.tableId) await updateTableStatus(o.tableId, 'free')
              toast.success('Заказ отменён')
              setOrderActionsOpen(false)
              setSelectedFullOrder(null)
              setSelectedExistingOrderId(null)
              void refreshTabsItems()
            } else if (action === 'reopen') {
              await reopenOrder(o.id)
              toast.success('Заказ открыт для редактирования')
              setOrderActionsOpen(false)
              setSelectedFullOrder(null)
              void refreshTabsItems()
            } else if (action === 'start_cooking') {
              await updateOrderStatus(o.id, 'cooking')
              toast.success('Заказ отправлен на кухню')
              setOrderActionsOpen(false)
              setSelectedFullOrder(null)
              void refreshTabsItems()
            } else if (action === 'mark_ready') {
              await updateOrderStatus(o.id, 'ready', { ready_at: new Date().toISOString() })
              toast.success('Заказ готов к выдаче')
              setOrderActionsOpen(false)
              setSelectedFullOrder(null)
              void refreshTabsItems()
            } else if (action === 'add_items') {
              // Диалог сообщает «добавить позиции» — у нас уже выбран этот
              // заказ как existing tab, кассир может сразу нажимать блюда.
              setOrderActionsOpen(false)
              setSelectedFullOrder(null)
            } else if (action === 'refresh') {
              void refreshTabsItems()
            }
          } catch (e) {
            toast.error(e instanceof Error ? e.message : 'Ошибка действия')
          }
        }}
      />
      {/* Custom confirmation for the «Очистить корзину» action.
          Replaces the no-warning click that used to wipe the cart instantly. */}
      <AlertDialog open={clearConfirmOpen} onOpenChange={setClearConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Очистить корзину?</AlertDialogTitle>
            <AlertDialogDescription>
              Все {totalItems} позиц{totalItems === 1 ? 'ия' : totalItems < 5 ? 'ии' : 'ий'} будут удалены. Это действие нельзя отменить.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Отмена</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { clearCart(); setClearConfirmOpen(false) }}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              Очистить
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function DestinationLockedBanner({ label }: { label?: string }) {
  if (!label) return null
  return (
    <div className="px-4 py-3 bg-amber-50 border-b border-amber-200 flex items-center gap-2">
      <ChefHat className="size-4 text-amber-600 shrink-0" />
      <span className="text-sm font-medium text-amber-800 truncate">Дозаказ · {label}</span>
    </div>
  )
}
