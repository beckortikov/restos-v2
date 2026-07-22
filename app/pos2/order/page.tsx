'use client'

import { useEffect, useMemo, useRef, useState, useDeferredValue, useCallback } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  LayoutGrid, Search, ShoppingBag, Plus, Minus, Trash2, CreditCard,
  UtensilsCrossed, Banknote, X, Send, MapPin, Users, Star, Printer, MoreHorizontal, Check, ClipboardList, Pencil, Undo2, Bike,
  ChevronUp, ChevronDown,
} from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '@/lib/auth-store'
import { toggleFavorite, useFavorites } from '@/lib/pos-favorites'
import { useOrderData } from '@/components/order/use-order-data'
import { useDataSync } from '@/hooks/use-data-sync'
import { randomId } from '@/lib/random-id'
import { createOrder, closeOrderWithPayment, openTableForOrder, fetchActiveShift, fetchFinancialAccounts, addItemsToOrder, fetchOrders, patchOrder, printPreBill, fetchOrderSplits, paySplit, cancelSplits, fetchStopList, cancelOrderItem, cancelOrderItemPartial, reprintOrderReceipt, refundOrder, reopenOrder } from '@/lib/queries'
import { formatCurrency, formatCurrencyCompact, calcLineTotal, calcOrderDisplayTotal, getTimeSince, startOfToday, endOfDay } from '@/lib/helpers'
import { humanizeError } from '@/lib/errors'
import { dMul, dDiv } from '@/lib/decimal'
import { portionsOf, lineTotal, cartSubtotal, cartCount, cartCogs, cartToItems } from '@/lib/pos-v2/cart'
import { useMenuGrid, menuGridStyle } from '@/lib/pos-v2/menu-grid'
import { PosModal } from '@/components/pos-v2/pos-modal'
import { buildReceiptData } from '@/lib/receipt-data'
import { PrintReceipt } from '@/components/print-receipt'
import { PaymentPanel } from '@/components/pos-v2/payment-panel'
import { OrderExtras } from '@/components/pos-v2/order-extras'
import type { MenuItem, TableStatus, Order, OrderItem, FinancialAccount, OrderSplit, OrderType } from '@/lib/types'
import { ORDER_TYPE_LABELS, ORDER_TYPE_TITLES, availableOrderTypes, canCreateWithoutPayment, isTogo, needsDeliveryContacts } from '@/lib/order-types'
import { describePayment } from '@/lib/payment-labels'
import type { CartLine } from '@/components/order/types'

const STATUS: Record<TableStatus, { soft: string; dot: string; text: string; label: string }> = {
  free: { soft: 'var(--pv-free-soft)', dot: 'var(--pv-free-dot)', text: 'var(--pv-free-text)', label: 'Свободен' },
  occupied: { soft: 'var(--pv-occ-soft)', dot: 'var(--pv-occ-dot)', text: 'var(--pv-occ-text)', label: 'Занят' },
  reserved: { soft: 'var(--pv-res-soft)', dot: 'var(--pv-res-dot)', text: 'var(--pv-res-text)', label: 'Бронь' },
  bill_requested: { soft: 'var(--pv-bill-soft)', dot: 'var(--pv-bill-dot)', text: 'var(--pv-bill-text)', label: 'Счёт' },
}
const num = (s: string) => Math.max(0, parseFloat(s.replace(',', '.').replace(/\s/g, '')) || 0)
const ITEM_REASONS = ['Гость передумал', 'Ошибка кухни', 'Некачественно', 'Другое']
// Печать требует настроенного чекового принтера (бэк: «no default receipt
// printer configured»). Показываем понятную подсказку вместо сырой ошибки.
function printerErr(e: unknown): string {
  const msg = humanizeError(e)
  return /printer|принтер/i.test(msg) ? 'Не настроен чековый принтер — Настройки → Принтеры' : `Не удалось: ${msg}`
}

// dishNameStyle — кегль и число строк под длину названия.
//
// Раньше кегль был фиксированным (14cqw) при жёстком обрезании в две строки:
// «ЛАВАШ КУРИНИЙ С ОВОЩАМИ» и «Паста карбонара с курицей» упирались в предел
// и уезжали в «…» — кассир не видел, что именно он нажимает, и отличить
// два похожих блюда мог только по цене.
//
// Считаем по длине имени, а не по факту переполнения: измерять реальную
// высоту пришлось бы в JS после отрисовки, это лишний layout-проход на
// каждую карточку сетки. Длина символов — достаточно точный прокси, а
// container query (cqw) продолжает подстраивать кегль под ширину карточки.
function dishNameStyle(name: string): { fontSize: string; WebkitLineClamp: number; display: string; WebkitBoxOrient: 'vertical'; overflow: string } {
  const n = name.length
  const [fontSize, lines] =
    n <= 14 ? ['clamp(0.62rem, 14cqw, 1.4rem)', 2] :
    n <= 22 ? ['clamp(0.58rem, 11cqw, 1.1rem)', 3] :
    n <= 32 ? ['clamp(0.54rem, 9cqw, 0.92rem)', 3] :
              ['clamp(0.5rem, 7.5cqw, 0.8rem)', 4]
  return {
    fontSize,
    display: '-webkit-box',
    WebkitBoxOrient: 'vertical',
    WebkitLineClamp: lines,
    overflow: 'hidden',
  }
}

// Иконки типов заказа. Лейблы — в lib/order-types.ts (общий словарь), иконки
// живут здесь: lib/ не должен зависеть от lucide.
const ORDER_TYPE_ICONS: Record<OrderType, React.ElementType> = {
  hall: UtensilsCrossed,
  takeaway: ShoppingBag,
  delivery: Bike,
}

// Phase 2 + критичный блок: заказ на реальных данных. Зал/такаут, гости, стоп-лист
// override (менеджер), весовые позиции (вес × порции). Логику не переписываем.
export default function PosV2Order() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { user, canDo, restaurantId, restaurant } = useAuth()
  const { menuItems, categories, tables, zones, loading } = useOrderData(true)
  const favorites = useFavorites(restaurantId ?? '')
  const favSet = useMemo(() => new Set(favorites), [favorites])

  const [orderType, setOrderType] = useState<OrderType>('hall')
  // Фастфуд без столов (restaurants.tablesEnabled=false): «Зал» ведётся БЕЗ стола —
  // заказ по номеру, ровно как «С собой» (тип остаётся 'hall' — для отчётов
  // «здесь» vs «навынос»). numberMode = «работаем по номеру, стола нет».
  // При tablesEnabled=true (дефолт) numberMode ≡ (заказ не в зал),
  // т.е. классический зал со столами не меняется вообще.
  const tablesEnabled = restaurant?.tablesEnabled ?? true
  const numberMode = isTogo(orderType) || !tablesEnabled
  // Типы заказа в переключателе: «Доставка» появляется третьей только если
  // включена в настройках ресторана (052).
  const orderTypes = useMemo(() => availableOrderTypes(restaurant), [restaurant])
  // Фастфуд = оплата вперёд: кнопки «Создать без оплаты» нет вовсе, чек и
  // кухонный бегунок печатаются вместе по факту оплаты. Зеркалит серверный
  // kitchenOnPay() — если разойдётся, касса покажет кнопку, а кухня всё равно
  // не получит бегунок до оплаты.
  // Можно ли создать заказ без оплаты. В фастфуде нельзя, но доставка —
  // исключение: заказ принимают по телефону, деньги привозит курьер.
  const allowNoPay = canCreateWithoutPayment(restaurant, orderType)
  const [menuGrid] = useMenuGrid()
  // Высота области сетки блюд — чтобы в матричном режиме (N×M) подогнать высоту
  // рядов под экран (карточки квадратнее, а не «широкие и низкие»).
  const gridScrollRef = useRef<HTMLDivElement>(null)
  const [gridAreaH, setGridAreaH] = useState(0)
  // Крупные кнопки-стрелки для прокрутки блюд (тач: нативный скролл мелкий).
  // Дизаблим на краях, прячем целиком, если контент помещается без скролла.
  const [canScrollUp, setCanScrollUp] = useState(false)
  const [canScrollDown, setCanScrollDown] = useState(false)
  const updateScrollBtns = useCallback(() => {
    const el = gridScrollRef.current
    if (!el) return
    const { scrollTop, scrollHeight, clientHeight } = el
    setCanScrollUp(scrollTop > 4)
    setCanScrollDown(scrollTop + clientHeight < scrollHeight - 4)
  }, [])
  useEffect(() => {
    const el = gridScrollRef.current
    if (!el) return
    setGridAreaH(el.clientHeight)
    updateScrollBtns()
    // ResizeObserver есть во всех браузерах и Electron, но НЕ в jsdom (тесты):
    // без guard'а экран заказа падал с ReferenceError и не монтировался.
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => { setGridAreaH(el.clientHeight); updateScrollBtns() })
    ro.observe(el)
    return () => ro.disconnect()
  }, [updateScrollBtns])
  function scrollDishes(dir: 1 | -1) {
    const el = gridScrollRef.current
    if (!el) return
    el.scrollBy({ top: dir * el.clientHeight * 0.85, behavior: 'smooth' })
  }
  const [search, setSearch] = useState('')
  const deferred = useDeferredValue(search)
  const [activeCat, setActiveCat] = useState<string | null>(null)
  // Избранное: долгое нажатие по карточке блюда (тач) или правый клик (мышь).
  // Раньше /pos2 умел только ЧИТАТЬ список — вкладка «Избранное» была, а
  // положить в неё что-то можно было лишь из старого POS.
  const longPress = useRef<{ timer?: number; fired: boolean; x: number; y: number }>({ fired: false, x: 0, y: 0 })
  const toggleFav = useCallback((m: MenuItem) => {
    if (!restaurantId) return
    if (toggleFavorite(restaurantId, m.id)) toast.success(`«${m.name}» в избранном`)
    else toast.message('Убрано из избранного', { description: m.name })
  }, [restaurantId])
  const pressStart = useCallback((e: React.PointerEvent, m: MenuItem) => {
    // Правая кнопка мыши — не долгое нажатие, её обрабатывает onContextMenu.
    if (e.pointerType === 'mouse' && e.button !== 0) return
    longPress.current.fired = false
    longPress.current.x = e.clientX
    longPress.current.y = e.clientY
    window.clearTimeout(longPress.current.timer)
    longPress.current.timer = window.setTimeout(() => {
      longPress.current.fired = true
      toggleFav(m)
    }, 450)
  }, [toggleFav])
  const pressCancel = useCallback(() => window.clearTimeout(longPress.current.timer), [])
  // Палец поехал — это скролл сетки, а не удержание.
  const pressMove = useCallback((e: React.PointerEvent) => {
    if (Math.abs(e.clientX - longPress.current.x) > 12 || Math.abs(e.clientY - longPress.current.y) > 12) {
      window.clearTimeout(longPress.current.timer)
    }
  }, [])
  const [cart, setCart] = useState<CartLine[]>([])
  const [selectedTableId, setSelectedTableId] = useState<string>('')
  const [tablesOpen, setTablesOpen] = useState(false)
  // Активная зона-таб в пикере столов (иначе при многих столах не помещается).
  const [pickerZone, setPickerZone] = useState<string | null>(null)
  const [guests, setGuests] = useState(1)
  // Единый сайдбар: занятый стол раскрывается на месте — вкладки групп + содержимое.
  const [tableOrders, setTableOrders] = useState<Order[]>([])
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null)
  const [tableLoading, setTableLoading] = useState(false)
  const [adding, setAdding] = useState(false)
  const addingRef = useRef(false)
  // Оптимистичная занятость: стол помечается занятым сразу после «Отправить»,
  // пока SSE не обновит tables.currentOrderIds (иначе плитка ~1с оставалась «Свободен»).
  const [justOccupied, setJustOccupied] = useState<Set<string>>(() => new Set())
  // Инлайн-оплата зального заказа прямо в сайдбаре (без ухода на /pos2/pay).
  const [accounts, setAccounts] = useState<FinancialAccount[]>([])
  const [payTarget, setPayTarget] = useState<Order | null>(null)
  const [extrasOpen, setExtrasOpen] = useState(false)
  const [splits, setSplits] = useState<OrderSplit[]>([])
  // Отмена отдельной позиции уже отправленного заказа (как в старом POS/тикете).
  const [cancelItem, setCancelItem] = useState<OrderItem | null>(null)
  const [itemReason, setItemReason] = useState(ITEM_REASONS[0])
  const [itemBusy, setItemBusy] = useState(false)
  const itemBusyRef = useRef(false)
  // Пре-чек: превью на экране + печать (превью работает и без принтера).
  const [preBill, setPreBill] = useState<Order | null>(null)
  const [printingPre, setPrintingPre] = useState(false)
  // Заказы прямо в ПОС (модалка вместо перехода на /pos2/orders): активные +
  // закрытые; закрытый → просмотр + печать чека.
  const [ordersOpen, setOrdersOpen] = useState(false)
  const [ordersTab, setOrdersTab] = useState<'active' | 'closed'>('active')
  const [ordersList, setOrdersList] = useState<Order[]>([])
  const [ordersLoading, setOrdersLoading] = useState(false)
  const [ordersSearch, setOrdersSearch] = useState('')
  const [viewReceipt, setViewReceipt] = useState<Order | null>(null)
  const [reprinting, setReprinting] = useState(false)
  // Возврат/редактирование закрытого заказа (по правам orders.refund / orders.edit).
  const [refundTarget, setRefundTarget] = useState<Order | null>(null)
  const [refundReason, setRefundReason] = useState('')
  const [refundAmt, setRefundAmt] = useState('')
  const [refundBusy, setRefundBusy] = useState(false)
  const refundKeyRef = useRef('') // #3: стабильный Idempotency-Key на попытку возврата

  const selectedTable = useMemo(() => tables.find(t => t.id === selectedTableId), [tables, selectedTableId])
  const activeGroup = useMemo(() => tableOrders.find(o => o.id === activeGroupId) ?? null, [tableOrders, activeGroupId])
  const canOverrideStop = canDo('orders.create_stopped')
  // Гейт orders.view_others: в пикере столов официант видит только свободные +
  // свои занятые (иначе выбирает/видит чужие столы).
  const canViewOthers = canDo('orders.view_others')

  // Backend stop-list: нехватка ингредиентов (computed-on-read) + ручной override.
  // Без него касса видела стоп только по menu.is_available → ловила 409 на
  // «Отправить», а менеджер не мог провести override (флаг уходил по неверному
  // признаку). Копия логики order-composer (stoppedIds + reasons + SSE-refetch).
  const [stoppedIds, setStoppedIds] = useState<Set<string>>(new Set())
  const [stopReasons, setStopReasons] = useState<Map<string, string>>(new Map())
  const reloadStopList = useCallback(async () => {
    try {
      const list = await fetchStopList()
      const ids = new Set<string>()
      const reasons = new Map<string, string>()
      for (const row of list) {
        ids.add(row.menuItemId)
        if (row.manual) reasons.set(row.menuItemId, 'В стоп-листе (вручную)')
        else if (row.ingredients?.length) { const n = row.ingredients.map(i => i.name).filter(Boolean).join(', '); reasons.set(row.menuItemId, n ? `Нет ингредиентов: ${n}` : 'Нет ингредиентов') }
        else reasons.set(row.menuItemId, 'В стоп-листе')
      }
      setStoppedIds(ids); setStopReasons(reasons)
    } catch { /* бэк недоступен — остаёмся на menu.is_available */ }
  }, [])
  useEffect(() => { void reloadStopList() }, [reloadStopList])
  useDataSync(['ingredients', 'stock_movements', 'orders', 'menu_items'], reloadStopList)

  // Грузит открытые заказы (группы) стола. extraIds — только что созданный заказ,
  // которого ещё нет в tables.currentOrderIds (SSE догонит позже).
  const loadTableOrders = useCallback(async (tableId: string, selectId?: string, extraIds: string[] = []) => {
    const t = tables.find(x => x.id === tableId)
    const ids = Array.from(new Set([...(t?.currentOrderIds ?? []), ...extraIds])).filter(Boolean)
    if (ids.length === 0) { setTableOrders([]); setActiveGroupId(null); return }
    setTableLoading(true)
    try {
      const os = await fetchOrders({ ids, slim: false })
      const live = os.filter(o => o.status !== 'done' && o.status !== 'cancelled')
      setTableOrders(live)
      setActiveGroupId(selectId && live.some(o => o.id === selectId) ? selectId : (live[0]?.id ?? null))
    } catch { /* ignore */ } finally { setTableLoading(false) }
  }, [tables])

  // Загрузка открытых заказов «по номеру» (без стола) — тот же модельный слой
  // (tableOrders), чтобы созданный «без оплаты» заказ оставался виден в сайдбаре
  // до оплаты. Тип параметризован: «С собой» всегда, а в фастфуде (tablesEnabled
  // = false) так же работает и «Зал» — заказ без стола, идентификация по номеру.
  const loadQueue = useCallback(async (type: OrderType, selectId?: string) => {
    setTableLoading(true)
    try {
      const os = await fetchOrders({ type, slim: false }).catch(() => [] as Order[])
      const live = os.filter(o => o.status !== 'done' && o.status !== 'cancelled')
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      setTableOrders(live)
      if (selectId) setActiveGroupId(selectId)
    } finally { setTableLoading(false) }
  }, [])

  // Приход с ?table= / ?order= — раскрываем контекст стола/группы (после загрузки данных).
  const initedRef = useRef(false)
  useEffect(() => {
    if (initedRef.current || loading) return
    const orderParam = searchParams.get('order')
    const tableParam = searchParams.get('table')
    if (orderParam) {
      initedRef.current = true
      fetchOrders({ ids: [orderParam], slim: false }).then(os => {
        const o = os[0]; if (!o) return
        if (o.tableId) { setOrderType('hall'); setSelectedTableId(o.tableId); loadTableOrders(o.tableId, o.id, [o.id]) }
        else { setOrderType('takeaway'); setTableOrders([o]); setActiveGroupId(o.id) }
      }).catch(() => {})
    } else if (tableParam) {
      // tables грузятся ОТДЕЛЬНО от loading (loading завязан только на menuItems,
      // см. use-order-data), поэтому в момент loading=false стол может ещё не
      // подъехать. Ждём, пока он появится в tables — иначе loadTableOrders не
      // найдёт currentOrderIds и сайдбар останется пустым (баг: тап по столу с
      // экрана «Столы» открывал ПОС с пустым сайдбаром вместо заказа стола).
      if (!tables.some(t => t.id === tableParam)) return
      initedRef.current = true
      setOrderType('hall'); setSelectedTableId(tableParam); loadTableOrders(tableParam)
    }
  }, [loading, searchParams, tables, loadTableOrders])

  // Как только SSE обновил tables (стол реально занят) — снимаем оптимистичную метку.
  useEffect(() => {
    if (justOccupied.size === 0) return
    const keep = new Set<string>()
    for (const id of justOccupied) {
      const t = tables.find(x => x.id === id)
      if (!t || (t.currentOrderIds?.length ?? 0) === 0) keep.add(id)
    }
    if (keep.size !== justOccupied.size) setJustOccupied(keep)
  }, [tables, justOccupied])

  // Переключение типа заказа (после mount): такаут → грузим открытые «С собой»,
  // зал → сбрасываем контекст (стол выбирается заново).
  const typeInitRef = useRef(true)
  // Когда тип переключается ради загрузки конкретного заказа из модалки «Заказы»,
  // сброс контекста не нужен (иначе он затрёт выбранный стол/группу).
  const skipTypeResetRef = useRef(false)
  useEffect(() => {
    // Первый рендер: контекст сбрасывать нечего, но очередь загрузить НАДО.
    // Раньше здесь был просто return, и на свежеоткрытом экране список заказов
    // по номеру не подтягивался вовсе — вкладки появлялись только после
    // переключения типа туда-обратно. Отсюда «то попадает, то стоит».
    if (typeInitRef.current) {
      typeInitRef.current = false
      if (numberMode) loadQueue(orderType)
      return
    }
    if (skipTypeResetRef.current) { skipTypeResetRef.current = false; return }
    // Корзину при смене типа НЕ чистим: кассир набрал блюда и понял, что это
    // «с собой», а не в зал — переключение типа не должно стирать набранное.
    // Контекст заказа (группа/стол) сбрасываем — он привязан к прежнему типу.
    setActiveGroupId(null)
    if (numberMode) { setSelectedTableId(''); loadQueue(orderType) }
    else { setSelectedTableId(''); setTableOrders([]) }
  }, [orderType, numberMode, loadQueue])

  useEffect(() => { fetchFinancialAccounts().then(setAccounts).catch(() => {}) }, [])

  // Разделённый заказ — грузим части (оплачиваются прямо в сайдбаре).
  useEffect(() => {
    if (activeGroup?.isSplit) fetchOrderSplits(activeGroup.id).then(setSplits).catch(() => setSplits([]))
    else setSplits([])
  }, [activeGroupId, activeGroup?.isSplit, activeGroup])

  // После оплаты из сайдбара — перечитываем контекст (стол или список «С собой»).
  async function onPaidDone() {
    const t = payTarget
    setPayTarget(null); setActiveGroupId(null)
    if (t?.tableId) await loadTableOrders(t.tableId)
    else await loadQueue(orderType)
  }

  async function reloadContext() {
    // Перечитываем контекст, СОХРАНЯЯ уже известные заказы группы (extraIds) и
    // активную вкладку. Без этого после действий вроде «назначить официанта»
    // (assignWaiter каскадит waiter_id) заказ пропадал из сайдбара, если
    // tables.currentOrderIds на миг оказывался пустым (SSE ещё не догнал), хотя
    // на карте зала стол занят.
    const known = tableOrders.map(o => o.id)
    if (selectedTableId) await loadTableOrders(selectedTableId, activeGroupId ?? undefined, known)
    else await loadQueue(orderType, activeGroupId ?? undefined)
  }

  // Отмена одной позиции. Бэк сам пересчитывает total и, если это была последняя
  // живая позиция, закрывает заказ (allCancelled) — тогда снимаем активную группу.
  async function doCancelItem() {
    if (itemBusyRef.current || !cancelItem?.id) return
    itemBusyRef.current = true; setItemBusy(true)
    try {
      const res = await cancelOrderItem(cancelItem.id, itemReason, user?.id, activeGroup?.id)
      toast.success('Позиция отменена')
      setCancelItem(null)
      if (res.allCancelled) { toast.info('Все позиции отменены — заказ закрыт'); setActiveGroupId(null) }
      await reloadContext()
    } catch (e) { toast.error(`Не удалось: ${humanizeError(e)}`) }
    finally { itemBusyRef.current = false; setItemBusy(false) }
  }

  // Убрать ОДНУ штуку из отправленной позиции (qty×N → qty×(N−1)) без отмены всей
  // позиции. Для штучных с qty>1; у весовых «одну штуку» смысла нет — там корзина.
  async function decOrderItem(i: OrderItem) {
    if (itemBusyRef.current || !i.id) return
    itemBusyRef.current = true; setItemBusy(true)
    try {
      const res = await cancelOrderItemPartial(i.id, 1, 'Корректировка количества', user?.id, activeGroup?.id)
      toast.success('Убрана 1 шт.')
      if (res.allCancelled) { setActiveGroupId(null) }
      await reloadContext()
    } catch (e) { toast.error(`Не удалось: ${humanizeError(e)}`) }
    finally { itemBusyRef.current = false; setItemBusy(false) }
  }

  async function paySplitNow(s: OrderSplit, method: 'cash' | 'card') {
    if (payingRef.current || !activeGroup) return
    payingRef.current = true; setPaying(true)
    try {
      // Нал по сплиту — на СЧЁТ СМЕНЫ (как полная оплата closeOrderWithPayment),
      // иначе нал по сплитам и по полной оплате лёг бы на разные счета.
      const shift = method === 'cash' ? await fetchActiveShift().catch(() => null) : null
      const sAcc = shift as { accountId?: string; accountName?: string } | null
      const acc = method === 'cash'
        ? (sAcc?.accountId ? { id: sAcc.accountId, name: sAcc.accountName } : (accounts.find(a => a.type === 'cash') ?? accounts[0]))
        : (accounts.find(a => a.type !== 'cash') ?? accounts[0])
      if (!acc?.id) { toast.error('Нет счёта для оплаты'); return }
      await paySplit(s.id, method, acc.id, acc.name ?? '', user?.id)
      toast.success(`Часть ${s.splitNumber} оплачена · ${formatCurrency(s.total)}`)
      const remaining = splits.filter(x => x.id !== s.id && x.status !== 'paid')
      if (remaining.length === 0) { toast.success('Все части оплачены — заказ закрыт'); setActiveGroupId(null); await reloadContext() }
      else setSplits(await fetchOrderSplits(activeGroup.id).catch(() => splits))
    } catch (e) { toast.error(`Оплата не прошла: ${humanizeError(e)}`) }
    finally { payingRef.current = false; setPaying(false) }
  }

  async function doCancelSplits() {
    if (payingRef.current || !activeGroup) return
    payingRef.current = true; setPaying(true)
    try { await cancelSplits(activeGroup.id); toast.success('Разделение отменено'); await reloadContext() }
    catch (e) { toast.error(`Не удалось: ${humanizeError(e)}`) }
    finally { payingRef.current = false; setPaying(false) }
  }

  const visibleCats = useMemo(() => categories.filter(c => c && !c.toLowerCase().includes('полуфабрикат')), [categories])
  const currentCat = activeCat ?? visibleCats[0] ?? null

  // Варианты (parentId) не показываются отдельными карточками: их продукт-
  // родитель — одна карточка с пикером комбинаций (Размер/Вкус).
  const variantsByParent = useMemo(() => {
    const map = new Map<string, MenuItem[]>()
    for (const m of menuItems) {
      if (m.parentId) (map.get(m.parentId) ?? map.set(m.parentId, []).get(m.parentId)!).push(m)
    }
    return map
  }, [menuItems])

  const dishes = useMemo(() => {
    const base = menuItems.filter(m => !m.parentId)
    const q = deferred.trim().toLowerCase()
    if (q) return base.filter(m => m.name.toLowerCase().includes(q))
    if (currentCat === '__fav__') return base.filter(m => favSet.has(m.id))
    return base.filter(m => m.category === currentCat)
  }, [menuItems, currentCat, deferred, favSet])
  // Пересчёт стрелок прокрутки при смене категории/поиска/сетки (меняется высота контента).
  useEffect(() => { updateScrollBtns() }, [dishes, gridAreaH, menuGrid, updateScrollBtns])

  const tablesByZone = useMemo(() => {
    const zoneName = (z: string) => zones.find(zz => zz.id === z)?.name ?? z ?? 'Зал'
    const visible = canViewOthers ? tables : tables.filter(t => t.status === 'free' || t.waiterId === user?.id)
    const map = new Map<string, typeof tables>()
    for (const t of visible) { const k = zoneName(t.zone); (map.get(k) ?? map.set(k, []).get(k)!).push(t) }
    return Array.from(map.entries()).map(([zone, ts]) => ({ zone, tables: [...ts].sort((a, b) => a.number - b.number) }))
  }, [tables, zones, canViewOthers, user?.id])

  // ── Weight modal ──────────────────────────────────────────────
  const [weightItem, setWeightItem] = useState<MenuItem | null>(null)
  const [wAmt, setWAmt] = useState('')
  const [wPortions, setWPortions] = useState(1)

  // ── Variant picker (продукт с атрибутами Размер/Вкус) ────────
  const [variantItem, setVariantItem] = useState<MenuItem | null>(null)
  const [variantSel, setVariantSel] = useState<Record<string, string>>({}) // attrId → valueId

  function openVariantPicker(m: MenuItem) {
    const sel: Record<string, string> = {}
    for (const a of m.attributes ?? []) {
      if (a.values.length > 0) sel[a.id] = a.values[0].id
    }
    setVariantSel(sel)
    setVariantItem(m)
  }

  // Резолв комбинации: вариант, чей набор value_ids совпадает с выбором.
  const resolvedVariant = useMemo(() => {
    if (!variantItem) return null
    const selected = Object.values(variantSel).sort().join(',')
    return (variantsByParent.get(variantItem.id) ?? []).find(v =>
      [...(v.variantValueIds ?? [])].sort().join(',') === selected
    ) ?? null
  }, [variantItem, variantSel, variantsByParent])

  // Два источника стопа: legacy menu.is_available (owner вручную в админке) и
  // backend stop-list (stoppedIds — нехватка ингредиентов / override). Без права
  // — отказ с причиной; с правом — info-toast + флаг override ТОЛЬКО для реально
  // backend-стопнутых (иначе POST /orders вернёт 409 ITEM_STOPPED).
  function add(m: MenuItem) {
    // Продукт с вариантами: карточка одна, конкретную комбинацию выбирают в
    // пикере (variantItem) — в корзину попадает menu_item_id варианта.
    if (variantsByParent.has(m.id)) {
      openVariantPicker(m)
      return
    }
    const backendStopped = stoppedIds.has(m.id)
    const isStopped = m.isAvailable === false || backendStopped
    if (isStopped && !canOverrideStop) {
      toast.warning(`«${m.name}» — ${backendStopped ? (stopReasons.get(m.id) ?? 'в стопе') : 'в стоп-листе'}`)
      return
    }
    const needsOverride = isStopped ? backendStopped : false
    if (isStopped && canOverrideStop) toast.info(`«${m.name}» в стопе — добавлено по разрешению`)
    if ((m.unit ?? 'piece') !== 'piece') {
      setWeightItem(m); setWAmt(String(m.unitSize ?? 100)); setWPortions(1)
      return
    }
    setCart(prev => {
      const i = prev.findIndex(l => l.unit === 'piece' && l.menuItemId === m.id)
      if (i >= 0) { const n = [...prev]; n[i] = { ...n[i], qty: n[i].qty + 1, overrideStopList: n[i].overrideStopList || needsOverride }; return n }
      return [...prev, { lineId: randomId(), menuItemId: m.id, name: m.name, emoji: m.emoji, qty: 1, price: m.price, cogs: m.cogs, unit: 'piece', unitSize: 1, overrideStopList: needsOverride || undefined }]
    })
  }
  function addWeight() {
    if (!weightItem) return
    const amount = num(wAmt)
    if (amount <= 0) { toast.error('Укажите вес'); return }
    const m = weightItem
    const needsOverride = stoppedIds.has(m.id)
    // Весовые НЕ мержим: каждая навеска — отдельная строка (иначе прежний вес
    // перезаписывался: «300г» + «500г» давали 2×500г). Как в старом ПОС.
    setCart(prev => [...prev, { lineId: randomId(), menuItemId: m.id, name: m.name, emoji: m.emoji, qty: amount, price: m.price, cogs: m.cogs, unit: (m.unit ?? 'g'), unitSize: (m.unitSize ?? 100), portionQty: wPortions, overrideStopList: needsOverride || undefined }])
    setWeightItem(null)
  }
  const lineKey = (l: CartLine) => l.lineId ?? l.menuItemId
  function setQty(id: string, delta: number) {
    setCart(prev => prev.flatMap(l => {
      if (lineKey(l) !== id) return [l]
      if (l.unit !== 'piece') { const p = portionsOf(l) + delta; return p <= 0 ? [] : [{ ...l, portionQty: p }] }
      const q = l.qty + delta; return q <= 0 ? [] : [{ ...l, qty: q }]
    }))
  }
  function removeLine(id: string) { setCart(prev => prev.filter(l => lineKey(l) !== id)) }

  const subtotal = useMemo(() => cartSubtotal(cart), [cart])
  const count = cartCount(cart)
  // Превью обслуживания в сайдбаре (зал): база (новый заказ = подытог корзины,
  // иначе итог группы) + сервис-% ресторана. Бэк начисляет то же при закрытии.
  const footBase = cart.length > 0 ? subtotal : (activeGroup?.total ?? 0)
  const svcPct = orderType === 'hall' ? (restaurant?.servicePercent ?? 0) : 0
  const footSvc = svcPct > 0 ? dMul(footBase, dDiv(svcPct, 100)) : 0
  const footTotal = footBase + footSvc
  const wUnit = weightItem?.unit === 'kg' ? 'кг' : 'г'
  const wPreview = weightItem ? dMul(dMul(weightItem.price, dDiv(num(wAmt), (weightItem.unitSize || 100))), wPortions) : 0

  const overrideStopList = () => cart.some(l => l.overrideStopList)

  // ── Оплата «С собой» ──────────────────────────────────────────
  const [paying, setPaying] = useState(false)
  const payingRef = useRef(false)

  // ── Контакты доставки (052) ───────────────────────────────────
  // Спрашиваем ПЕРЕД оплатой, а не при создании заказа: кассир сначала
  // набирает корзину, контакты — последний шаг перед чеком. Сохраняем их
  // patch'ем на заказ, бэкенд читает на close и печатает курьеру.
  const [contactsFor, setContactsFor] = useState<Order | null>(null)
  const [contactPhone, setContactPhone] = useState('')
  const [contactAddress, setContactAddress] = useState('')
  const [savingContacts, setSavingContacts] = useState(false)
  // 'pay' — модалка ведёт в панель оплаты; 'queue' — заказ «без оплаты»,
  // после сохранения контактов просто закрываемся, оставляя заказ в очереди.
  const [contactsIntent, setContactsIntent] = useState<'pay' | 'queue'>('pay')
  const contactsOnConfirmRef = useRef<((order: Order) => void) | null>(null)

  // requireDeliveryContacts — единая точка входа перед любым завершением
  // создания заказа доставки (оплата ИЛИ «без оплаты»), чтобы телефон/адрес
  // нельзя было обойти ни одним из путей создания заказа.
  const requireDeliveryContacts = useCallback((order: Order, intent: 'pay' | 'queue', onReady: (order: Order) => void) => {
    if (needsDeliveryContacts(restaurant, order.type) && !order.deliveryAddress) {
      setContactPhone(order.deliveryPhone ?? '')
      setContactAddress(order.deliveryAddress ?? '')
      setContactsIntent(intent)
      contactsOnConfirmRef.current = onReady
      setContactsFor(order)
      return
    }
    onReady(order)
  }, [restaurant])

  // openPayment — единая точка входа в оплату. Для доставки с включённым
  // запросом контактов сначала показывает модалку, иначе сразу панель оплаты.
  // Все кнопки «К оплате» идут через неё, чтобы контакты нельзя было обойти
  // ни из очереди, ни из карточки заказа.
  const openPayment = useCallback((order: Order) => {
    requireDeliveryContacts(order, 'pay', setPayTarget)
  }, [requireDeliveryContacts])

  async function confirmContacts() {
    const order = contactsFor
    if (!order || savingContacts) return
    const phone = contactPhone.trim()
    const address = contactAddress.trim()
    if (!phone) { toast.error('Укажите телефон клиента'); return }
    if (!address) { toast.error('Укажите адрес доставки'); return }
    setSavingContacts(true)
    try {
      await patchOrder(order.id, { deliveryPhone: phone, deliveryAddress: address })
      const updated = { ...order, deliveryPhone: phone, deliveryAddress: address }
      // Иначе activeGroup (из tableOrders) остаётся без контактов, и повторный
      // клик «К оплате» по тому же заказу снова спросит телефон/адрес.
      setTableOrders(prev => prev.map(o => o.id === order.id ? { ...o, deliveryPhone: phone, deliveryAddress: address } : o))
      setContactsFor(null)
      contactsOnConfirmRef.current?.(updated)
      contactsOnConfirmRef.current = null
    } catch (e) {
      toast.error(`Не удалось сохранить контакты: ${humanizeError(e)}`)
    } finally {
      setSavingContacts(false)
    }
  }

  // Заказ «по номеру» (без стола) без оплаты — остаётся открытым до оплаты.
  // Это «С собой», а в фастфуде (tablesEnabled=false) так же и «Зал».
  async function createQueueOrderNoPay() {
    if (payingRef.current || cart.length === 0) return
    payingRef.current = true; setPaying(true)
    try {
      const shift = await fetchActiveShift()
      const order = await createOrder({ type: orderType, items: cartToItems(cart), total: subtotal, shiftId: shift?.id, waiterId: user?.id ?? undefined, guestsCount: 1, overrideStopList: overrideStopList() })
      if (!order) throw new Error('Заказ не создан')
      toast.success(`Заказ создан · ${formatCurrency(subtotal)}`, { description: 'Без оплаты — оплатите позже' })
      setCart([])
      await loadQueue(orderType, order.id) // остаётся в списке открытых до оплаты
      // Контакты доставки нельзя обойти и в флоу «без оплаты» — тот же гейт,
      // что и перед панелью оплаты, только без перехода в неё после сохранения.
      const [fresh] = await fetchOrders({ ids: [order.id], slim: false }).catch(() => [order])
      requireDeliveryContacts(fresh ?? order, 'queue', () => {})
    } catch (e) { toast.error(`Не удалось: ${humanizeError(e)}`) }
    finally { payingRef.current = false; setPaying(false) }
  }

  // Заказ «по номеру» + сразу ОБЩАЯ панель оплаты (нал/безнал с выбором кошелька/
  // смешанная/скидка/пре-чек). Единый платёжный флоу. Это и есть pay-first
  // фастфуда: в связке с kitchen_on_pay кухня получит бегунок после оплаты.
  async function payNewQueueOrder() {
    if (payingRef.current || cart.length === 0) return
    payingRef.current = true; setPaying(true)
    try {
      const shift = await fetchActiveShift()
      if (!shift) { toast.error('Откройте кассовую смену перед оплатой'); return }
      const order = await createOrder({ type: orderType, items: cartToItems(cart), total: subtotal, shiftId: shift.id, waiterId: user?.id ?? undefined, guestsCount: 1, overrideStopList: overrideStopList() })
      if (!order) throw new Error('Заказ не создан')
      setCart([])
      const [fresh] = await fetchOrders({ ids: [order.id], slim: false }).catch(() => [order])
      await loadQueue(orderType, order.id)
      openPayment(fresh ?? order)
    } catch (e) { toast.error(`Не удалось: ${humanizeError(e)}`) }
    finally { payingRef.current = false; setPaying(false) }
  }

  // Выбор стола из пикера — раскрываем его контекст (группы + содержимое) в сайдбаре.
  // Корзину НЕ чистим: если набрали блюда до выбора стола, они остаются и уходят
  // на выбранный стол (баг: раньше setCart([]) стирал набранное при выборе стола).
  function selectTable(tableId: string) {
    setSelectedTableId(tableId); setTablesOpen(false)
    loadTableOrders(tableId)
  }
  // Переключение вкладки группы. null = новая группа на том же столе.
  function selectGroup(id: string | null) { setActiveGroupId(id); setCart([]) }

  // ── Отправка заказа зала на кухню (новая группа / первый заказ стола) ──
  const [sending, setSending] = useState(false)
  const sendingRef = useRef(false)

  async function sendToKitchen() {
    if (sendingRef.current || cart.length === 0 || !selectedTableId) return
    sendingRef.current = true; setSending(true)
    try {
      const shift = await fetchActiveShift()
      const total = subtotal
      const groupsBefore = tableOrders.length
      const order = await createOrder({ type: 'hall', tableId: selectedTableId, items: cartToItems(cart), total, shiftId: shift?.id, waiterId: user?.id ?? undefined, guestsCount: guests, tabLabel: groupsBefore > 0 ? `Группа ${groupsBefore + 1}` : undefined, overrideStopList: overrideStopList() })
      if (!order) throw new Error('Заказ не создан')
      await openTableForOrder(selectedTableId, order.id, user?.id).catch(() => {})
      setJustOccupied(prev => { const n = new Set(prev); n.add(selectedTableId); return n }) // стол занят сразу
      toast.success(`Заказ отправлен · Стол ${selectedTable?.number ?? ''} · ${formatCurrency(total)}`, { description: 'Кухня уже видит заказ' })
      setCart([]); setGuests(1)
      await loadTableOrders(selectedTableId, order.id, [order.id]) // новая группа сразу в сайдбаре
    } catch (e) { toast.error(`Не удалось отправить: ${humanizeError(e)}`) }
    finally { sendingRef.current = false; setSending(false) }
  }

  // Дозаказ в активную группу — список обновляется на месте, без ухода со страницы.
  async function addToActiveGroup() {
    if (addingRef.current || cart.length === 0 || !activeGroupId) return
    addingRef.current = true; setAdding(true)
    try {
      await addItemsToOrder(activeGroupId, cartToItems(cart), { overrideStopList: overrideStopList() })
      toast.success(`Добавлено ${count} поз.`)
      setCart([])
      await loadTableOrders(selectedTableId, activeGroupId, [activeGroupId])
    } catch (e) { toast.error(`Не удалось добавить: ${humanizeError(e)}`) }
    finally { addingRef.current = false; setAdding(false) }
  }

  async function groupGuests(delta: number) {
    if (!activeGroup) return
    const cur = activeGroup.guestsCount ?? 1
    const next = Math.max(1, cur + delta)
    if (next === cur) return
    const gid = activeGroup.id
    setTableOrders(prev => prev.map(o => o.id === gid ? { ...o, guestsCount: next } : o))
    try { await patchOrder(gid, { guestsCount: next }) }
    catch (e) { toast.error(humanizeError(e)); setTableOrders(prev => prev.map(o => o.id === gid ? { ...o, guestsCount: cur } : o)) }
  }

  // Пре-чек: открываем ПРЕВЬЮ на экране (как в старом POS) — оно работает и без
  // принтера. Печать — из превью.
  function doPreBill(id: string) {
    const o = tableOrders.find(x => x.id === id) ?? (activeGroup && activeGroup.id === id ? activeGroup : null)
    if (o) setPreBill(o)
  }
  async function doPrintPreBill() {
    if (!preBill || printingPre) return
    setPrintingPre(true)
    try { await printPreBill(preBill.id); toast.success('Пре-чек отправлен на печать') }
    catch (e) { toast.error(printerErr(e)) }
    finally { setPrintingPre(false) }
  }
  const preBillReceipt = useMemo(() => preBill ? buildReceiptData(
    preBill,
    { restaurant, tables, zones, currentUser: user },
    { isPreCheck: true, includeService: preBill.type === 'hall', servicePercent: restaurant?.servicePercent ?? 0 },
  ) : null, [preBill, restaurant, tables, zones, user])

  // ── Заказы модалкой прямо в ПОС ──────────────────────────────────────────
  async function openOrders() {
    setOrdersOpen(true); setOrdersLoading(true); setOrdersSearch('')
    try {
      // Раньше скоуп был строго по текущей кассовой смене (fetchOrders({ shiftId })).
      // Из-за этого открытые заказы ЗАЛА не попадали в список: их пробивает
      // официант (Kotlin APK, без кассовой смены) или они остались с прошлой
      // смены — их shift_id ≠ текущей смене. Виден был только «С собой» (его
      // пробивает касса в текущей смене). Скоуп по ДАТЕ (сегодня, любой тип и
      // смена) + добор открытых заказов занятых столов (currentOrderIds) на
      // случай заказа, открытого до полуночи — чтобы ни один открытый заказ
      // не потерялся. Заголовок «Заказы за сегодня» этому и соответствует.
      const strandedIds = Array.from(new Set(tables.flatMap(t => t.currentOrderIds ?? []).filter(Boolean)))
      const [today, stranded] = await Promise.all([
        fetchOrders({ from: startOfToday(), to: endOfDay(new Date()), slim: false }).catch(() => [] as Order[]),
        strandedIds.length ? fetchOrders({ ids: strandedIds, slim: false }).catch(() => [] as Order[]) : Promise.resolve([] as Order[]),
      ])
      const byId = new Map<string, Order>()
      for (const o of [...today, ...stranded]) byId.set(o.id, o)
      setOrdersList(Array.from(byId.values()))
    } finally { setOrdersLoading(false) }
  }
  function tapOrder(o: Order) {
    if (o.status === 'done') { setViewReceipt(o); return } // закрытый → чек
    if (o.status === 'cancelled') return
    // активный → грузим в сайдбар (без ухода с экрана)
    setOrdersOpen(false)
    // Тип восстанавливаем из самого заказа: доставку нельзя схлопывать в
    // «с собой», иначе тап по заказу-доставке молча менял бы его тип в UI.
    // Заказ 'hall' без стола при включённых столах — данные из очереди по
    // номеру, показываем как «с собой» (поведение до 052).
    const nextType: OrderType = (o.type === 'hall' && (o.tableId || !tablesEnabled))
      ? 'hall'
      : isTogo(o.type) ? o.type : 'takeaway'
    if (nextType !== orderType) skipTypeResetRef.current = true
    setOrderType(nextType)
    if (nextType === 'hall' && o.tableId) { setSelectedTableId(o.tableId); loadTableOrders(o.tableId, o.id, [o.id]) }
    else { loadQueue(nextType, o.id) }
  }
  async function doReprintReceipt() {
    if (!viewReceipt || reprinting) return
    setReprinting(true)
    try { await reprintOrderReceipt(viewReceipt.id); toast.success('Чек отправлен на печать') }
    catch (e) { toast.error(printerErr(e)) }
    finally { setReprinting(false) }
  }
  const closedReceipt = useMemo(() => viewReceipt ? buildReceiptData(
    viewReceipt,
    { restaurant, tables, zones, currentUser: user },
    {
      isPreCheck: false,
      includeService: (viewReceipt.serviceAmount ?? 0) > 0 || (viewReceipt.servicePercent ?? 0) > 0,
      servicePercent: viewReceipt.servicePercent,
      discountAmount: viewReceipt.discountAmount,
      tipAmount: viewReceipt.tipAmount,
      paymentMethod: viewReceipt.paymentMethod,
      payments: viewReceipt.payments,
    },
  ) : null, [viewReceipt, restaurant, tables, zones, user])

  // Права на действия с закрытым заказом (по умолчанию выключены в матрице).
  const canRefund = canDo('orders.refund')
  const canEditClosed = canDo('orders.edit')
  const remainingRefund = (o: Order) => Math.max(0, ((o.totalWithService ?? o.total) || 0) - (o.refundedTotal ?? 0))

  // «Редактировать» закрытый заказ = переоткрыть и загрузить в сайдбар ПОС.
  async function doEditClosed(o: Order) {
    try {
      await reopenOrder(o.id)
      toast.success('Заказ переоткрыт для редактирования')
      setViewReceipt(null); setOrdersOpen(false)
      // Тип восстанавливаем из самого заказа: доставку нельзя схлопывать в
    // «с собой», иначе тап по заказу-доставке молча менял бы его тип в UI.
    // Заказ 'hall' без стола при включённых столах — данные из очереди по
    // номеру, показываем как «с собой» (поведение до 052).
    const nextType: OrderType = (o.type === 'hall' && (o.tableId || !tablesEnabled))
      ? 'hall'
      : isTogo(o.type) ? o.type : 'takeaway'
      if (nextType !== orderType) skipTypeResetRef.current = true
      setOrderType(nextType)
      if (nextType === 'hall' && o.tableId) { setSelectedTableId(o.tableId); loadTableOrders(o.tableId, o.id, [o.id]) }
      else { loadQueue(nextType, o.id) }
    } catch (e) { toast.error(`Не удалось: ${humanizeError(e)}`) }
  }
  function openRefund(o: Order) { setRefundTarget(o); setRefundReason(''); setRefundAmt(String(remainingRefund(o))); refundKeyRef.current = randomId() }
  async function doRefund() {
    if (!refundTarget || refundBusy) return
    const rem = remainingRefund(refundTarget)
    const amt = Math.max(0, parseFloat(refundAmt.replace(',', '.').replace(/\s/g, '')) || 0)
    if (amt <= 0) { toast.error('Укажите сумму возврата'); return }
    if (amt > rem + 0.01) { toast.error(`Больше остатка (${formatCurrency(rem)}) нельзя`); return }
    if (!refundReason.trim()) { toast.error('Укажите причину возврата'); return }
    setRefundBusy(true)
    try {
      await refundOrder(refundTarget.id, refundReason.trim(), amt, refundKeyRef.current)
      toast.success(`Возврат ${formatCurrency(amt)}`)
      setRefundTarget(null); setViewReceipt(null)
      await openOrders()
    } catch (e) { toast.error(`Не удалось: ${humanizeError(e)}`) }
    finally { setRefundBusy(false) }
  }

  const busy = paying || sending || adding || tableLoading

  // Esc закрывает открытый инлайн-оверлей (вес / выбор стола) — WCAG 2.1.2.
  // PaymentPanel-модалка (payTarget) закрывается через свой PosModal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (weightItem) setWeightItem(null)
      else if (variantItem) setVariantItem(null)
      else if (tablesOpen) setTablesOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [weightItem, variantItem, tablesOpen])

  return (
    <div className="flex h-full w-full overflow-hidden">
      {/* ── Left: menu ─────────────────────────────────────────── */}
      <div className="flex-1 min-w-0 flex flex-col" style={{ padding: 'var(--pv-gap) 0 0 var(--pv-pad-x)' }}>
        <div className="flex items-center shrink-0" style={{ gap: 'var(--pv-gap)', paddingRight: 'var(--pv-gap)' }}>
          <button onClick={() => navigate('/pos2')} className="flex items-center gap-2 rounded-xl border shrink-0 active:scale-95 transition-transform" style={{ background: 'var(--pv-card)', borderColor: 'var(--pv-border)', padding: 'clamp(0.6rem,0.9vw,0.85rem) clamp(0.8rem,1.1vw,1.1rem)' }}>
            <LayoutGrid style={{ width: 'clamp(1.1rem,1.4vw,1.4rem)', height: 'clamp(1.1rem,1.4vw,1.4rem)', color: 'var(--pv-brand)' }} />
            <span className="font-semibold" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }}>Меню</span>
          </button>
          <div className="flex items-center rounded-2xl border shrink-0" style={{ background: 'var(--pv-card)', borderColor: 'var(--pv-border)', padding: '4px', gap: '4px' }}>
            {orderTypes.map(val => {
              const on = orderType === val
              const Icon = ORDER_TYPE_ICONS[val]
              return (
                <button key={val} onClick={() => setOrderType(val)} className="flex items-center gap-1.5 rounded-xl font-semibold whitespace-nowrap" style={{ background: on ? 'var(--pv-brand)' : 'transparent', color: on ? '#fff' : 'var(--pv-text-2)', padding: 'clamp(0.5rem,0.8vw,0.75rem) clamp(0.7rem,1.2vw,1.3rem)', fontSize: 'var(--pv-ctl)' }}>
                  <Icon style={{ width: 'clamp(0.9rem,1.2vw,1.15rem)', height: 'clamp(0.9rem,1.2vw,1.15rem)' }} />{ORDER_TYPE_LABELS[val]}
                </button>
              )
            })}
          </div>
          <div className="flex items-center gap-2 rounded-xl border flex-1 min-w-0" style={{ background: 'var(--pv-card)', borderColor: 'var(--pv-border)', padding: 'clamp(0.6rem,0.9vw,0.85rem) clamp(0.8rem,1vw,1rem)' }}>
            <Search style={{ width: 'clamp(1.1rem,1.4vw,1.4rem)', height: 'clamp(1.1rem,1.4vw,1.4rem)', color: 'var(--pv-text-3)' }} className="shrink-0" />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Поиск блюда" aria-label="Поиск блюда" className="flex-1 min-w-0 bg-transparent outline-none" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }} />
          </div>
          {/* Заказы прямо из ПОС (как раздел «Заказы» в старом POS): активные +
              закрытые, просмотр и печать чека закрытого заказа. */}
          <button onClick={openOrders} className="flex items-center gap-2 rounded-xl border shrink-0 active:scale-95 transition-transform" style={{ background: 'var(--pv-card)', borderColor: 'var(--pv-border)', padding: 'clamp(0.6rem,0.9vw,0.85rem) clamp(0.8rem,1.1vw,1.1rem)' }} title="Заказы: активные и закрытые, печать чека">
            <ClipboardList style={{ width: 'clamp(1.1rem,1.4vw,1.4rem)', height: 'clamp(1.1rem,1.4vw,1.4rem)', color: 'var(--pv-brand)' }} />
            <span className="font-semibold whitespace-nowrap" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }}>Заказы</span>
          </button>
        </div>

        {/* Категории видны ВСЕГДА (раньше прятались при любом тексте в поиске —
            даже одна буква убирала все категории). Тап по категории очищает поиск. */}
        {/* Категории переносятся на второй ряд (flex-wrap), а не скроллятся
            горизонтально — все категории видны сразу. Интервалы уменьшены. */}
        <div className="flex flex-wrap items-center shrink-0" style={{ gap: 'clamp(0.3rem,0.5vw,0.5rem)', padding: 'var(--pv-gap) var(--pv-gap) clamp(0.35rem,0.6vw,0.55rem) 0' }}>
          {/* Чип виден ВСЕГДА, даже когда список пуст: иначе про избранное просто
              не узнать — жест удержания сам себя не покажет. Пустая вкладка
              объясняет, как класть блюда. */}
          <button onClick={() => { setSearch(''); setActiveCat('__fav__') }} title="Удержите блюдо, чтобы добавить или убрать из избранного" className="rounded-full font-semibold whitespace-nowrap shrink-0 border flex items-center gap-1.5" style={{ background: currentCat === '__fav__' ? 'var(--pv-brand)' : 'var(--pv-card)', color: currentCat === '__fav__' ? '#fff' : 'var(--pv-text-2)', borderColor: currentCat === '__fav__' ? 'var(--pv-brand)' : 'var(--pv-border)', padding: 'clamp(0.5rem,0.75vw,0.7rem) clamp(0.75rem,1.15vw,1.15rem)', fontSize: 'var(--pv-ctl)' }}>
            <Star style={{ width: '1rem', height: '1rem', fill: currentCat === '__fav__' ? '#fff' : 'transparent' }} />Избранное
          </button>
          {visibleCats.map(c => {
            const on = c === currentCat && !deferred.trim()
            return <button key={c} onClick={() => { setSearch(''); setActiveCat(c) }} className="rounded-full font-semibold whitespace-nowrap shrink-0 border" style={{ background: on ? 'var(--pv-brand)' : 'var(--pv-card)', color: on ? '#fff' : 'var(--pv-text-2)', borderColor: on ? 'var(--pv-brand)' : 'var(--pv-border)', padding: 'clamp(0.5rem,0.75vw,0.7rem) clamp(0.75rem,1.15vw,1.15rem)', fontSize: 'var(--pv-ctl)' }}>{c}</button>
          })}
        </div>

        <div className="relative flex-1 min-h-0">
          <div ref={gridScrollRef} onScroll={updateScrollBtns} className="h-full overflow-y-auto pv-noscroll" style={{ padding: 'clamp(0.4rem,0.7vw,0.7rem) clamp(0.4rem,0.7vw,0.7rem) clamp(0.5rem,1vw,1rem) 0' }}>
          {loading ? (
            <div className="h-full flex items-center justify-center" style={{ color: 'var(--pv-text-3)' }}>Загрузка меню…</div>
          ) : dishes.length === 0 ? (
            currentCat === '__fav__' && !deferred.trim() ? (
              <div className="h-full flex flex-col items-center justify-center text-center" style={{ color: 'var(--pv-text-3)', gap: '0.6rem', padding: '1rem' }}>
                <Star style={{ width: '2.2rem', height: '2.2rem', color: 'var(--pv-border)' }} />
                <span className="font-semibold" style={{ color: 'var(--pv-text-2)', fontSize: 'var(--pv-ctl)' }}>Избранное пусто</span>
                <span style={{ fontSize: 'calc(var(--pv-ctl) - 0.1rem)' }}>Откройте категорию и удержите блюдо секунду — оно попадёт сюда</span>
              </div>
            ) : (
              <div className="h-full flex items-center justify-center" style={{ color: 'var(--pv-text-3)' }}>Ничего не найдено</div>
            )
          ) : (
            <div style={menuGridStyle(menuGrid, gridAreaH)}>
              {dishes.map(m => {
                const variants = variantsByParent.get(m.id)
                // Продукт с вариантами стопится когда недоступен сам ИЛИ все
                // его варианты в стопе; цена на карточке — «от минимальной».
                const stopped = variants
                  ? m.isAvailable === false || variants.every(v => v.isAvailable === false || stoppedIds.has(v.id))
                  : m.isAvailable === false || stoppedIds.has(m.id)
                const weight = !variants && (m.unit ?? 'piece') !== 'piece'
                const minPrice = variants ? Math.min(...variants.map(v => v.price)) : m.price
                return (
                  // Карточка блюда по дизайну restos.pen (DishTile): белая карточка
                  // (radius 16, тонкая рамка + мягкая тень), содержимое ПО ЦЕНТРУ —
                  // название и цена-«пилюля» (brand-soft фон, бренд-текст). БЕЗ
                  // эмодзи-плейсхолдера и БЕЗ звёздочки-избранного на карточке.
                  // Цена — без ,00 (formatCurrencyCompact): «300 с.», не «300,00 с.».
                  <div key={m.id} className="relative">
                    <button
                      onClick={() => {
                        // Клик после сработавшего удержания — это «хвост» того же
                        // жеста: блюдо уже ушло в избранное, в корзину не кладём.
                        if (longPress.current.fired) { longPress.current.fired = false; return }
                        add(m)
                      }}
                      onPointerDown={e => pressStart(e, m)}
                      onPointerUp={pressCancel}
                      onPointerLeave={pressCancel}
                      onPointerCancel={pressCancel}
                      onPointerMove={pressMove}
                      onContextMenu={e => {
                        e.preventDefault()
                        pressCancel()
                        if (!longPress.current.fired) { toggleFav(m); longPress.current.fired = true }
                      }}
                      disabled={stopped && !canOverrideStop} aria-label={`Добавить ${m.name}, ${formatCurrencyCompact(m.price)}`} className="w-full flex flex-col items-center justify-center text-center transition-transform active:scale-[0.97] disabled:opacity-45 disabled:pointer-events-none overflow-hidden" style={{ containerType: 'inline-size', background: 'var(--pv-card)', border: '1px solid var(--pv-border)', borderRadius: 'var(--pv-radius)', boxShadow: '0 2px 8px rgba(0,0,0,0.06)', padding: 'clamp(0.45rem,0.9vw,1rem) clamp(0.4rem,0.7vw,0.85rem)', gap: 'clamp(0.3rem,0.6vw,0.8rem)', minHeight: menuGrid === 'auto' ? 'clamp(7rem,11vw,9.5rem)' : 0, height: menuGrid === 'auto' ? undefined : '100%', opacity: stopped ? 0.6 : 1, userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none' }}>
                      <span className="font-semibold leading-tight" style={{ color: 'var(--pv-text)', ...dishNameStyle(m.name) }}>{m.name}</span>
                      <span className="rounded-full font-bold whitespace-nowrap" style={{ background: 'var(--pv-brand-soft)', color: 'var(--pv-brand)', padding: '0.35em 0.85em', fontSize: 'clamp(0.58rem, 11cqw, 1.1rem)' }}>{variants ? `от ${formatCurrencyCompact(minPrice)}` : formatCurrencyCompact(m.price)}{weight ? ` / ${m.unitSize}${m.unit === 'kg' ? 'кг' : 'г'}` : ''}</span>
                    </button>
                    {stopped && <span title={stopReasons.get(m.id) ?? 'В стоп-листе'} className="absolute rounded-full font-bold pointer-events-none" style={{ top: '0.5rem', right: '0.5rem', background: 'var(--pv-occ-soft)', color: 'var(--pv-occ-text)', padding: '0.1rem 0.5rem', fontSize: '0.65rem' }}>СТОП</span>}
                    {/* Звёздочка только у избранного: иначе кассир не видит, что
                        повторное удержание УБЕРЁТ блюдо из списка. */}
                    {favSet.has(m.id) && <Star className="absolute pointer-events-none" style={{ top: '0.5rem', left: '0.5rem', width: '0.95rem', height: '0.95rem', color: 'var(--pv-brand)', fill: 'var(--pv-brand)' }} />}
                  </div>
                )
              })}
            </div>
          )}
          </div>
          {/* Крупные стрелки прокрутки блюд (тач-дружелюбно; появляются только при
              переполнении, гаснут на краях). Дизайн pv-card + бренд-стрелка. */}
          {(canScrollUp || canScrollDown) && (
            <div className="absolute z-10 flex flex-col pointer-events-none" style={{ right: 'clamp(0.6rem,1vw,1rem)', bottom: 'clamp(1rem,2vw,1.75rem)', gap: 'clamp(0.5rem,0.8vw,0.75rem)' }}>
              <button onClick={() => scrollDishes(-1)} disabled={!canScrollUp} aria-label="Прокрутить блюда вверх" className="pointer-events-auto flex items-center justify-center rounded-2xl border active:scale-90 transition-all disabled:opacity-25" style={{ width: 'clamp(3.5rem,4.6vw,4.5rem)', height: 'clamp(3.5rem,4.6vw,4.5rem)', background: 'var(--pv-card)', borderColor: 'var(--pv-border)', color: 'var(--pv-brand)', boxShadow: '0 8px 22px rgba(0,0,0,0.14)' }}>
                <ChevronUp style={{ width: '52%', height: '52%' }} strokeWidth={2.75} />
              </button>
              <button onClick={() => scrollDishes(1)} disabled={!canScrollDown} aria-label="Прокрутить блюда вниз" className="pointer-events-auto flex items-center justify-center rounded-2xl border active:scale-90 transition-all disabled:opacity-25" style={{ width: 'clamp(3.5rem,4.6vw,4.5rem)', height: 'clamp(3.5rem,4.6vw,4.5rem)', background: 'var(--pv-card)', borderColor: 'var(--pv-border)', color: 'var(--pv-brand)', boxShadow: '0 8px 22px rgba(0,0,0,0.14)' }}>
                <ChevronDown style={{ width: '52%', height: '52%' }} strokeWidth={2.75} />
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ── Right: cart ────────────────────────────────────────── */}
      <aside className="shrink-0 flex flex-col border-l" style={{ width: 'clamp(20rem, 26vw, 30rem)', background: 'var(--pv-card)', borderColor: 'var(--pv-border)' }}>
        {/* Header */}
        <div className="flex items-center justify-between gap-2 shrink-0 border-b" style={{ padding: 'clamp(0.9rem,1.4vw,1.4rem)', borderColor: 'var(--pv-border)' }}>
          {!numberMode ? (
            // Выбор стола прямо в сайдбаре заказа (тап открывает пикер столов),
            // слева от счётчика позиций. В зале стол выбирают здесь, а не в топбаре.
            <button onClick={() => setTablesOpen(true)} className="flex items-center gap-1.5 rounded-xl border min-w-0 active:scale-95 transition-transform" style={{ background: selectedTable ? 'var(--pv-brand-soft)' : 'var(--pv-card)', borderColor: selectedTable ? 'var(--pv-brand)' : 'var(--pv-border)', padding: 'clamp(0.45rem,0.7vw,0.65rem) clamp(0.7rem,1vw,0.95rem)' }} aria-label="Выберите стол">
              <MapPin style={{ width: 'clamp(1.05rem,1.35vw,1.35rem)', height: 'clamp(1.05rem,1.35vw,1.35rem)', color: 'var(--pv-brand)' }} className="shrink-0" />
              <span className="font-bold truncate" style={{ color: selectedTable ? 'var(--pv-brand)' : 'var(--pv-text-2)', fontSize: 'clamp(1rem,1.35vw,1.25rem)' }}>{selectedTable ? `Стол ${selectedTable.number}` : 'Выберите стол'}{selectedTable && activeGroup && tableOrders.length > 1 ? ` · Гр. ${tableOrders.findIndex(o => o.id === activeGroupId) + 1}` : ''}</span>
            </button>
          ) : (
            <span className="font-bold truncate" style={{ color: 'var(--pv-text)', fontSize: 'clamp(1.05rem,1.5vw,1.4rem)' }}>Заказ</span>
          )}
          <span className="rounded-full font-semibold shrink-0" style={{ background: 'var(--pv-brand-soft)', color: 'var(--pv-brand)', padding: '0.25rem 0.7rem', fontSize: 'var(--pv-ctl)' }}>{cart.length > 0 ? `${count} поз.` : activeGroup ? `${(activeGroup.items ?? []).filter(i => !i.cancelledAt).length} поз.` : '0 поз.'}</span>
        </div>

        {/* Вкладки: группы занятого стола / открытые «С собой» */}
        {(numberMode || selectedTable) && (tableOrders.length >= 1 || tableLoading) && (
          <div className="flex items-center gap-2 flex-wrap shrink-0 border-b" style={{ padding: '0.6rem clamp(0.7rem,1vw,1rem)', borderColor: 'var(--pv-border)' }}>
            {tableOrders.map((o, i) => { const on = o.id === activeGroupId; return (
              <button key={o.id} onClick={() => selectGroup(o.id)} className="rounded-xl font-semibold border" style={{ background: on ? 'var(--pv-brand)' : 'var(--pv-card)', color: on ? '#fff' : 'var(--pv-text-2)', borderColor: on ? 'var(--pv-brand)' : 'var(--pv-border)', padding: '0.35rem 0.75rem', fontSize: 'calc(var(--pv-ctl) - 0.05rem)' }}>{!numberMode ? `Группа ${i + 1}` : `#${o.orderNumber ?? i + 1} · ${formatCurrency(o.total)}`}</button>
            ) })}
            <button onClick={() => selectGroup(null)} className="rounded-xl font-semibold border border-dashed flex items-center gap-1" style={{ background: activeGroupId === null ? 'var(--pv-brand-soft)' : 'var(--pv-card)', borderColor: 'var(--pv-brand)', color: 'var(--pv-brand)', padding: '0.35rem 0.75rem', fontSize: 'calc(var(--pv-ctl) - 0.05rem)' }}>
              <Plus style={{ width: '0.95rem', height: '0.95rem' }} />{!numberMode ? 'Группа' : 'Новый'}
            </button>
          </div>
        )}

        {/* Контент: корзина / уже заказано / пусто */}
        <div className="flex-1 min-h-0 overflow-y-auto" style={{ padding: 'clamp(0.7rem,1vw,1rem)' }}>
          {cart.length > 0 ? (
            <div className="flex flex-col" style={{ gap: 'clamp(0.5rem,0.8vw,0.75rem)' }}>
              {activeGroup && <div className="rounded-lg text-center font-semibold shrink-0" style={{ background: 'var(--pv-brand-soft)', color: 'var(--pv-brand)', padding: '0.4rem', fontSize: 'calc(var(--pv-ctl) - 0.05rem)' }}>Дозаказ в {!numberMode ? `Группу ${tableOrders.findIndex(o => o.id === activeGroupId) + 1}` : `заказ #${activeGroup.orderNumber ?? ''}`}</div>}
              {cart.map(l => {
                const weight = l.unit !== 'piece'
                const k = lineKey(l)
                return (
                  <div key={k} className="flex items-center gap-2 rounded-xl" style={{ background: 'var(--pv-bg)', padding: 'clamp(0.5rem,0.8vw,0.75rem)' }}>
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold truncate" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }}>{l.emoji} {l.name}{l.overrideStopList ? ' ⚠' : ''}</div>
                      <div style={{ color: 'var(--pv-text-3)', fontSize: 'calc(var(--pv-ctl) - 0.1rem)' }}>{weight ? `${portionsOf(l)}×${l.qty}${l.unit === 'kg' ? 'кг' : 'г'} · ` : `${formatCurrency(l.price)} × ${l.qty} · `}{formatCurrency(lineTotal(l))}</div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button onClick={() => setQty(k, -1)} className="rounded-lg flex items-center justify-center active:scale-90 transition-transform" style={{ background: 'var(--pv-card)', border: '1px solid var(--pv-border)', width: '2rem', height: '2rem' }}><Minus className="size-4" style={{ color: 'var(--pv-text-2)' }} /></button>
                      <span className="text-center font-bold" style={{ color: 'var(--pv-text)', width: '1.75rem', fontSize: 'var(--pv-ctl)' }}>{weight ? portionsOf(l) : l.qty}</span>
                      <button onClick={() => setQty(k, +1)} className="rounded-lg flex items-center justify-center active:scale-90 transition-transform" style={{ background: 'var(--pv-brand)', width: '2rem', height: '2rem' }}><Plus className="size-4 text-white" /></button>
                      <button onClick={() => removeLine(k)} className="rounded-lg flex items-center justify-center ml-1" style={{ width: '2rem', height: '2rem' }}><Trash2 className="size-4" style={{ color: 'var(--pv-occ-text)' }} /></button>
                    </div>
                  </div>
                )
              })}
            </div>
          ) : activeGroup?.isSplit ? (
            <div className="flex flex-col" style={{ gap: 'clamp(0.5rem,0.9vw,0.8rem)' }}>
              <div className="font-semibold shrink-0" style={{ color: 'var(--pv-text-3)', fontSize: 'calc(var(--pv-ctl) - 0.05rem)' }}>Счёт разделён — оплата по частям</div>
              {splits.map(s => { const paid = s.status === 'paid'; return (
                <div key={s.id} className="flex items-center gap-3 rounded-2xl" style={{ background: 'var(--pv-bg)', padding: 'clamp(0.6rem,1vw,0.9rem)' }}>
                  <div className="rounded-full flex items-center justify-center font-bold shrink-0" style={{ background: paid ? 'var(--pv-free-soft)' : 'var(--pv-brand-soft)', color: paid ? 'var(--pv-free-text)' : 'var(--pv-brand)', width: '2.2rem', height: '2.2rem' }}>{s.splitNumber}</div>
                  <div className="flex-1 min-w-0">
                    <div className="font-bold" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }}>Часть {s.splitNumber}</div>
                    <div style={{ color: 'var(--pv-text-3)', fontSize: 'calc(var(--pv-ctl) - 0.12rem)' }}>{formatCurrency(s.total)}</div>
                  </div>
                  {paid ? (
                    <div className="flex items-center gap-1 rounded-xl shrink-0" style={{ background: 'var(--pv-free-soft)', color: 'var(--pv-free-text)', padding: '0.4rem 0.7rem' }}><Check style={{ width: '1rem', height: '1rem' }} /><span className="font-semibold" style={{ fontSize: 'calc(var(--pv-ctl) - 0.1rem)' }}>Оплачено</span></div>
                  ) : (
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button disabled={paying} onClick={() => paySplitNow(s, 'cash')} className="rounded-lg flex items-center gap-1 font-semibold disabled:opacity-50 active:scale-95 transition-transform" style={{ background: 'var(--pv-free-soft)', color: 'var(--pv-free-text)', padding: '0.45rem 0.7rem', fontSize: 'calc(var(--pv-ctl) - 0.1rem)' }}><Banknote style={{ width: '0.95rem', height: '0.95rem' }} />Нал</button>
                      <button disabled={paying} onClick={() => paySplitNow(s, 'card')} className="rounded-lg flex items-center gap-1 font-semibold disabled:opacity-50 active:scale-95 transition-transform" style={{ background: 'var(--pv-brand-soft)', color: 'var(--pv-brand)', padding: '0.45rem 0.7rem', fontSize: 'calc(var(--pv-ctl) - 0.1rem)' }}><CreditCard style={{ width: '0.95rem', height: '0.95rem' }} />Карта</button>
                    </div>
                  )}
                </div>
              ) })}
            </div>
          ) : activeGroup ? (
            <div className="flex flex-col" style={{ gap: 'clamp(0.4rem,0.7vw,0.6rem)' }}>
              <div className="font-semibold shrink-0" style={{ color: 'var(--pv-text-3)', fontSize: 'calc(var(--pv-ctl) - 0.05rem)' }}>Уже заказано</div>
              {(activeGroup.items ?? []).map((i, idx) => { const c = !!i.cancelledAt; return (
                <div key={i.id ?? idx} className="flex items-center gap-2 rounded-xl" style={{ background: 'var(--pv-bg)', padding: 'clamp(0.5rem,0.8vw,0.7rem)', opacity: c ? 0.5 : 1 }}>
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold truncate" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)', textDecoration: c ? 'line-through' : 'none' }}>{i.name}</div>
                    <div style={{ color: 'var(--pv-text-3)', fontSize: 'calc(var(--pv-ctl) - 0.12rem)' }}>{formatCurrency(i.price)} × {i.qty}{c ? ' · отменено' : ''}{i.note ? ` · 💬 ${i.note}` : ''}</div>
                  </div>
                  <span className="font-bold shrink-0" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }}>{formatCurrency(calcLineTotal(i.price, i.qty, i.unit, i.unitSize))}</span>
                  {!c && i.id && (i.unit ?? 'piece') === 'piece' && i.qty > 1 && (
                    <button disabled={itemBusy} onClick={() => decOrderItem(i)} className="rounded-xl flex items-center justify-center shrink-0 border disabled:opacity-50 active:scale-90 transition-transform" style={{ width: '2.3rem', height: '2.3rem', background: 'var(--pv-card)', borderColor: 'var(--pv-border)' }} aria-label={`Убрать одну «${i.name}»`} title="Убрать 1 шт.">
                      <Minus style={{ width: '1.15rem', height: '1.15rem', color: 'var(--pv-text-2)' }} />
                    </button>
                  )}
                  {!c && i.id && (
                    <button onClick={() => { setCancelItem(i); setItemReason(ITEM_REASONS[0]) }} className="rounded-xl flex items-center justify-center shrink-0 border active:scale-90 transition-transform" style={{ width: '2.3rem', height: '2.3rem', background: 'var(--pv-card)', borderColor: 'var(--pv-occ-soft)' }} aria-label={`Отменить «${i.name}»`} title="Отменить всю позицию">
                      <Trash2 style={{ width: '1.2rem', height: '1.2rem', color: 'var(--pv-occ-text)' }} />
                    </button>
                  )}
                </div>
              ) })}
              <div className="text-center shrink-0" style={{ color: 'var(--pv-text-3)', fontSize: 'calc(var(--pv-ctl) - 0.12rem)', marginTop: '0.3rem' }}>Тапайте блюда слева — дозаказ в эту группу</div>
            </div>
          ) : (
            <div className="h-full flex flex-col items-center justify-center gap-2" style={{ color: 'var(--pv-text-3)' }}>
              <ShoppingBag style={{ width: '2.5rem', height: '2.5rem', opacity: 0.5 }} /><span style={{ fontSize: 'var(--pv-ctl)' }}>{tableLoading ? 'Загрузка…' : 'Корзина пуста'}</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="shrink-0 border-t" style={{ padding: 'clamp(0.9rem,1.4vw,1.4rem)', borderColor: 'var(--pv-border)' }}>
          {!numberMode && (activeGroup || cart.length > 0 || !selectedTableId) && (
            <div className="flex items-center justify-between" style={{ marginBottom: 'clamp(0.5rem,0.9vw,0.85rem)' }}>
              <span className="flex items-center gap-1.5 font-medium" style={{ color: 'var(--pv-text-2)', fontSize: 'var(--pv-ctl)' }}><Users style={{ width: '1.1rem', height: '1.1rem' }} />Гостей</span>
              <div className="flex items-center gap-2">
                <button onClick={() => activeGroup ? groupGuests(-1) : setGuests(g => Math.max(1, g - 1))} className="rounded-lg flex items-center justify-center" style={{ background: 'var(--pv-bg)', border: '1px solid var(--pv-border)', width: '2rem', height: '2rem' }}><Minus className="size-4" style={{ color: 'var(--pv-text-2)' }} /></button>
                <span className="text-center font-bold" style={{ color: 'var(--pv-text)', width: '1.75rem', fontSize: 'var(--pv-ctl)' }}>{activeGroup ? (activeGroup.guestsCount ?? 1) : guests}</span>
                <button onClick={() => activeGroup ? groupGuests(1) : setGuests(g => Math.min(20, g + 1))} className="rounded-lg flex items-center justify-center" style={{ background: 'var(--pv-bg)', border: '1px solid var(--pv-border)', width: '2rem', height: '2rem' }}><Plus className="size-4" style={{ color: 'var(--pv-text-2)' }} /></button>
              </div>
            </div>
          )}
          {svcPct > 0 && footBase > 0 && (
            <div className="flex items-center justify-between" style={{ marginBottom: '0.35rem' }}>
              <span className="font-medium" style={{ color: 'var(--pv-text-3)', fontSize: 'calc(var(--pv-ctl) - 0.05rem)' }}>Обслуживание {svcPct}%</span>
              <span className="font-semibold" style={{ color: 'var(--pv-text-2)', fontSize: 'var(--pv-ctl)' }}>+{formatCurrency(footSvc)}</span>
            </div>
          )}
          <div className="flex items-center justify-between" style={{ marginBottom: 'clamp(0.6rem,1vw,1rem)' }}>
            <span className="font-medium" style={{ color: 'var(--pv-text-2)', fontSize: 'var(--pv-ctl)' }}>Итого</span>
            <span className="font-bold" style={{ color: 'var(--pv-text)', fontSize: 'clamp(1.3rem,2vw,1.9rem)' }}>{formatCurrency(footTotal)}</span>
          </div>
          {numberMode ? (
            activeGroup ? (
              cart.length > 0 ? (
                <button disabled={busy} onClick={addToActiveGroup} className="w-full flex items-center justify-center gap-2 rounded-2xl font-bold text-white disabled:opacity-40 active:scale-[0.98] transition-transform" style={{ background: 'var(--pv-brand)', padding: 'clamp(0.85rem,1.3vw,1.15rem)', fontSize: 'clamp(1rem,1.4vw,1.2rem)', boxShadow: '0 6px 18px rgba(216,90,48,0.35)' }}>
                  <Plus style={{ width: '1.3em', height: '1.3em' }} />{adding ? 'Добавляем…' : `Добавить в заказ #${activeGroup.orderNumber ?? ''}`}
                </button>
              ) : (
                <div className="flex items-center gap-2">
                  <button disabled={busy} onClick={() => doPreBill(activeGroup.id)} className="flex items-center justify-center shrink-0 rounded-2xl font-semibold active:scale-[0.98] transition-transform" style={{ background: 'var(--pv-bg)', color: 'var(--pv-text-2)', padding: 'clamp(0.75rem,1.2vw,1.05rem) clamp(0.7rem,1vw,1rem)' }}><Printer style={{ width: '1.3em', height: '1.3em' }} /></button>
                  <button onClick={() => openPayment(activeGroup)} className="flex-1 flex items-center justify-center gap-2 rounded-2xl font-bold text-white active:scale-[0.98] transition-transform" style={{ background: 'var(--pv-brand)', padding: 'clamp(0.85rem,1.3vw,1.15rem)', fontSize: 'clamp(1rem,1.4vw,1.2rem)', boxShadow: '0 6px 18px rgba(216,90,48,0.35)' }}><CreditCard style={{ width: '1.3em', height: '1.3em' }} />К оплате</button>
                </div>
              )
            ) : cart.length > 0 ? (
              <div className="flex flex-col" style={{ gap: '0.6rem' }}>
                {/* Фастфуд = оплата вперёд: заказ без оплаты не создаётся вовсе.
                    Чек гостю и бегунок на кухню печатаются вместе по оплате. */}
                {allowNoPay && (
                  <button disabled={paying} onClick={createQueueOrderNoPay} className="w-full flex items-center justify-center gap-2 rounded-2xl font-semibold border disabled:opacity-50 active:scale-[0.98] transition-transform" style={{ background: 'var(--pv-card)', borderColor: 'var(--pv-border)', color: 'var(--pv-text-2)', padding: 'clamp(0.7rem,1.1vw,1rem)', fontSize: 'var(--pv-ctl)' }}>Создать без оплаты</button>
                )}
                <button disabled={paying} onClick={payNewQueueOrder} className="w-full flex items-center justify-center gap-2 rounded-2xl font-bold text-white disabled:opacity-40 active:scale-[0.98] transition-transform" style={{ background: 'var(--pv-brand)', padding: 'clamp(0.85rem,1.3vw,1.15rem)', fontSize: 'clamp(1rem,1.4vw,1.2rem)', boxShadow: '0 6px 18px rgba(216,90,48,0.35)' }}>
                  <CreditCard style={{ width: '1.3em', height: '1.3em' }} />К оплате · {formatCurrency(subtotal)}
                </button>
              </div>
            ) : (
              <button disabled className="w-full flex items-center justify-center gap-2 rounded-2xl font-bold disabled:opacity-40" style={{ background: 'var(--pv-bg)', color: 'var(--pv-text-3)', padding: 'clamp(0.85rem,1.3vw,1.15rem)', fontSize: 'clamp(1rem,1.4vw,1.2rem)' }}>
                Добавьте блюда
              </button>
            )
          ) : cart.length > 0 ? (
            activeGroup ? (
              <button disabled={busy} onClick={addToActiveGroup} className="w-full flex items-center justify-center gap-2 rounded-2xl font-bold text-white disabled:opacity-40 active:scale-[0.98] transition-transform" style={{ background: 'var(--pv-brand)', padding: 'clamp(0.85rem,1.3vw,1.15rem)', fontSize: 'clamp(1rem,1.4vw,1.2rem)', boxShadow: '0 6px 18px rgba(216,90,48,0.35)' }}>
                <Plus style={{ width: '1.3em', height: '1.3em' }} />{adding ? 'Добавляем…' : `Добавить в Группу ${tableOrders.findIndex(o => o.id === activeGroupId) + 1}`}
              </button>
            ) : (
              <button disabled={!selectedTableId || busy} onClick={sendToKitchen} className="w-full flex items-center justify-center gap-2 rounded-2xl font-bold text-white disabled:opacity-40 active:scale-[0.98] transition-transform" style={{ background: 'var(--pv-brand)', padding: 'clamp(0.85rem,1.3vw,1.15rem)', fontSize: 'clamp(1rem,1.4vw,1.2rem)', boxShadow: selectedTableId ? '0 6px 18px rgba(216,90,48,0.35)' : 'none' }}>
                <Send style={{ width: '1.3em', height: '1.3em' }} />{sending ? 'Отправка…' : selectedTableId ? (tableOrders.length > 0 ? 'Отправить (новая группа)' : 'Отправить на кухню') : 'Выберите стол'}
              </button>
            )
          ) : activeGroup?.isSplit ? (
            splits.some(s => s.status === 'paid') ? (
              <div className="text-center font-semibold" style={{ color: 'var(--pv-text-3)', padding: '0.6rem', fontSize: 'var(--pv-ctl)' }}>Оплата по частям — см. выше</div>
            ) : (
              <button disabled={paying} onClick={doCancelSplits} className="w-full flex items-center justify-center gap-2 rounded-2xl font-semibold border disabled:opacity-50 active:scale-[0.98] transition-transform" style={{ background: 'var(--pv-card)', borderColor: 'var(--pv-occ-dot)', borderWidth: '2px', color: 'var(--pv-occ-text)', padding: 'clamp(0.8rem,1.2vw,1.1rem)', fontSize: 'var(--pv-ctl)' }}>
                <X style={{ width: '1.2em', height: '1.2em' }} />Отменить разделение
              </button>
            )
          ) : activeGroup ? (
            <div className="flex flex-col" style={{ gap: '0.5rem' }}>
              <div className="flex items-center gap-2">
                <button onClick={() => doPreBill(activeGroup.id)} className="flex-1 flex items-center justify-center gap-1.5 rounded-2xl font-semibold active:scale-[0.98] transition-transform" style={{ background: 'var(--pv-bg)', color: 'var(--pv-text-2)', padding: 'clamp(0.7rem,1.1vw,1rem)', fontSize: 'var(--pv-ctl)' }}><Printer style={{ width: '1.15em', height: '1.15em' }} />Пре-чек</button>
                <button onClick={() => setExtrasOpen(true)} className="flex-1 flex items-center justify-center gap-1.5 rounded-2xl font-semibold active:scale-[0.98] transition-transform" style={{ background: 'var(--pv-bg)', color: 'var(--pv-text-2)', padding: 'clamp(0.7rem,1.1vw,1rem)', fontSize: 'var(--pv-ctl)' }}><MoreHorizontal style={{ width: '1.15em', height: '1.15em' }} />Ещё</button>
              </div>
              <button onClick={() => openPayment(activeGroup)} className="w-full flex items-center justify-center gap-2 rounded-2xl font-bold text-white active:scale-[0.98] transition-transform" style={{ background: 'var(--pv-brand)', padding: 'clamp(0.85rem,1.3vw,1.15rem)', fontSize: 'clamp(1rem,1.4vw,1.2rem)', boxShadow: '0 6px 18px rgba(216,90,48,0.35)' }}>
                <CreditCard style={{ width: '1.3em', height: '1.3em' }} />К оплате
              </button>
            </div>
          ) : (
            <button disabled className="w-full flex items-center justify-center gap-2 rounded-2xl font-bold disabled:opacity-40" style={{ background: 'var(--pv-bg)', color: 'var(--pv-text-3)', padding: 'clamp(0.85rem,1.3vw,1.15rem)', fontSize: 'clamp(1rem,1.4vw,1.2rem)' }}>
              {selectedTableId ? 'Добавьте блюда' : 'Выберите стол'}
            </button>
          )}
        </div>
      </aside>

      {/* ── Weight modal — PosModal (role=dialog): экранная клавиатура поднимает
             модалку, а не скроллит фон (раньше сырой оверлей → экран прыгал). ── */}
      {weightItem && (
        <PosModal open onClose={() => setWeightItem(null)} width="clamp(20rem,38vw,30rem)" title={weightItem.name}>
          <div className="flex flex-col" style={{ padding: 'clamp(1.2rem,1.8vw,1.6rem)', gap: '0.9rem' }}>
            <div>
              <div className="font-medium" style={{ color: 'var(--pv-text-2)', fontSize: 'var(--pv-ctl)', marginBottom: '0.4rem' }}>Вес порции ({wUnit})</div>
              <div className="flex items-center rounded-xl border" style={{ borderColor: 'var(--pv-border)', borderWidth: '1px', padding: '0.7rem 1rem' }}>
                <input autoFocus inputMode="decimal" value={wAmt} onChange={e => setWAmt(e.target.value)} aria-label={`Вес порции, ${wUnit}`} className="flex-1 min-w-0 bg-transparent outline-none font-bold" style={{ color: 'var(--pv-text)', fontSize: 'clamp(1.2rem,1.8vw,1.6rem)', textAlign: 'center' }} />
                <span className="font-medium" style={{ color: 'var(--pv-text-3)', fontSize: 'var(--pv-ctl)' }}>{wUnit}</span>
              </div>
            </div>
            <div className="flex items-center justify-between">
              <span className="font-medium" style={{ color: 'var(--pv-text-2)', fontSize: 'var(--pv-ctl)' }}>Порций (печатается N строками)</span>
              <div className="flex items-center gap-2">
                <button onClick={() => setWPortions(p => Math.max(1, p - 1))} className="rounded-lg flex items-center justify-center" style={{ background: 'var(--pv-bg)', border: '1px solid var(--pv-border)', width: '2rem', height: '2rem' }}><Minus className="size-4" style={{ color: 'var(--pv-text-2)' }} /></button>
                <span className="text-center font-bold" style={{ color: 'var(--pv-text)', width: '1.75rem', fontSize: 'var(--pv-ctl)' }}>{wPortions}</span>
                <button onClick={() => setWPortions(p => p + 1)} className="rounded-lg flex items-center justify-center" style={{ background: 'var(--pv-bg)', border: '1px solid var(--pv-border)', width: '2rem', height: '2rem' }}><Plus className="size-4" style={{ color: 'var(--pv-text-2)' }} /></button>
              </div>
            </div>
            <div className="flex items-center justify-between rounded-xl" style={{ background: 'var(--pv-bg)', padding: '0.6rem 1rem' }}>
              <span className="font-medium" style={{ color: 'var(--pv-text-2)', fontSize: 'var(--pv-ctl)' }}>Стоимость</span>
              <span className="font-bold" style={{ color: 'var(--pv-brand)', fontSize: 'clamp(1.1rem,1.5vw,1.35rem)' }}>{formatCurrency(wPreview)}</span>
            </div>
            <button onClick={addWeight} className="w-full flex items-center justify-center gap-2 rounded-2xl font-bold text-white active:scale-[0.98] transition-transform" style={{ background: 'var(--pv-brand)', padding: 'clamp(0.85rem,1.3vw,1.15rem)', fontSize: 'clamp(1rem,1.4vw,1.2rem)' }}>
              <Plus style={{ width: '1.3em', height: '1.3em' }} />Добавить
            </button>
          </div>
        </PosModal>
      )}

      {/* ── Variant picker — выбор комбинации атрибутов (Размер/Вкус).
             В корзину уходит menu_item_id конкретного варианта; стоп-лист и
             override обрабатывает общий add(). ── */}
      {variantItem && (
        <PosModal open onClose={() => setVariantItem(null)} width="clamp(20rem,38vw,30rem)" title={variantItem.name}>
          <div className="flex flex-col" style={{ padding: 'clamp(1.2rem,1.8vw,1.6rem)', gap: '0.9rem' }}>
            {(variantItem.attributes ?? []).map(attr => (
              <div key={attr.id}>
                <div className="font-medium" style={{ color: 'var(--pv-text-2)', fontSize: 'var(--pv-ctl)', marginBottom: '0.4rem' }}>{attr.name}</div>
                <div className="flex flex-wrap" style={{ gap: '0.5rem' }}>
                  {attr.values.map(val => {
                    const on = variantSel[attr.id] === val.id
                    return (
                      <button key={val.id} onClick={() => setVariantSel(prev => ({ ...prev, [attr.id]: val.id }))}
                        className="rounded-xl font-semibold border active:scale-95 transition-transform"
                        style={{ background: on ? 'var(--pv-brand)' : 'var(--pv-card)', color: on ? '#fff' : 'var(--pv-text)', borderColor: on ? 'var(--pv-brand)' : 'var(--pv-border)', padding: 'clamp(0.6rem,0.9vw,0.8rem) clamp(0.9rem,1.3vw,1.2rem)', fontSize: 'var(--pv-ctl)' }}>
                        {val.label}
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}
            <div className="flex items-center justify-between rounded-xl" style={{ background: 'var(--pv-bg)', padding: '0.6rem 1rem' }}>
              <span className="font-medium" style={{ color: 'var(--pv-text-2)', fontSize: 'var(--pv-ctl)' }}>Цена</span>
              <span className="font-bold flex items-center gap-2" style={{ color: 'var(--pv-brand)', fontSize: 'clamp(1.1rem,1.5vw,1.35rem)' }}>
                {resolvedVariant ? formatCurrency(resolvedVariant.price) : '—'}
                {resolvedVariant && (resolvedVariant.isAvailable === false || stoppedIds.has(resolvedVariant.id)) && (
                  <span className="rounded-full font-bold" style={{ background: 'var(--pv-occ-soft)', color: 'var(--pv-occ-text)', padding: '0.1rem 0.5rem', fontSize: '0.65rem' }}>СТОП</span>
                )}
              </span>
            </div>
            <button
              onClick={() => { if (!resolvedVariant) return; const v = resolvedVariant; setVariantItem(null); add(v) }}
              disabled={!resolvedVariant}
              className="w-full flex items-center justify-center gap-2 rounded-2xl font-bold text-white active:scale-[0.98] transition-transform disabled:opacity-50"
              style={{ background: 'var(--pv-brand)', padding: 'clamp(0.85rem,1.3vw,1.15rem)', fontSize: 'clamp(1rem,1.4vw,1.2rem)' }}
            >
              <Plus style={{ width: '1.3em', height: '1.3em' }} />Добавить
            </button>
          </div>
        </PosModal>
      )}

      {/* ── Контакты доставки — спрашиваем ПЕРЕД панелью оплаты ──── */}
      {contactsFor && (
        <PosModal open onClose={() => setContactsFor(null)} width="clamp(20rem,44vw,32rem)"
          title={`Доставка · заказ #${contactsFor.orderNumber ?? ''}`}>
          <div className="flex flex-col" style={{ gap: 'clamp(0.7rem,1.1vw,1rem)' }}>
            <div className="flex flex-col" style={{ gap: '0.35rem' }}>
              <label htmlFor="pv-delivery-phone" className="font-semibold" style={{ color: 'var(--pv-text-2)', fontSize: 'var(--pv-ctl)' }}>Телефон клиента</label>
              <input
                id="pv-delivery-phone"
                value={contactPhone}
                onChange={e => setContactPhone(e.target.value)}
                inputMode="tel"
                autoFocus
                placeholder="+992 ..."
                className="rounded-xl border outline-none"
                style={{ background: 'var(--pv-bg)', borderColor: 'var(--pv-border)', color: 'var(--pv-text)', padding: 'clamp(0.7rem,1vw,0.95rem)', fontSize: 'clamp(1rem,1.4vw,1.2rem)' }}
              />
            </div>
            <div className="flex flex-col" style={{ gap: '0.35rem' }}>
              <label htmlFor="pv-delivery-address" className="font-semibold" style={{ color: 'var(--pv-text-2)', fontSize: 'var(--pv-ctl)' }}>Адрес доставки</label>
              <textarea
                id="pv-delivery-address"
                value={contactAddress}
                onChange={e => setContactAddress(e.target.value)}
                rows={3}
                placeholder="Улица, дом, квартира, подъезд"
                className="rounded-xl border outline-none resize-none"
                style={{ background: 'var(--pv-bg)', borderColor: 'var(--pv-border)', color: 'var(--pv-text)', padding: 'clamp(0.7rem,1vw,0.95rem)', fontSize: 'clamp(1rem,1.4vw,1.2rem)' }}
              />
            </div>
            <p style={{ color: 'var(--pv-text-3)', fontSize: 'calc(var(--pv-ctl) - 0.1rem)' }}>
              Напечатаются на бегунке курьеру вместе с составом заказа.
            </p>
            <button
              disabled={savingContacts}
              onClick={confirmContacts}
              className="w-full flex items-center justify-center gap-2 rounded-2xl font-bold text-white disabled:opacity-40 active:scale-[0.98] transition-transform"
              style={{ background: 'var(--pv-brand)', padding: 'clamp(0.85rem,1.3vw,1.15rem)', fontSize: 'clamp(1rem,1.4vw,1.2rem)', boxShadow: '0 6px 18px rgba(216,90,48,0.35)' }}
            >
              {contactsIntent === 'pay' ? <CreditCard style={{ width: '1.3em', height: '1.3em' }} /> : <Check style={{ width: '1.3em', height: '1.3em' }} />}
              {savingContacts ? 'Сохраняем…' : (contactsIntent === 'pay' ? 'Далее · к оплате' : 'Сохранить')}
            </button>
          </div>
        </PosModal>
      )}

      {/* ── Оплата зального заказа (инлайн, в одном окне) ──────── */}
      {payTarget && (
        <PosModal open onClose={() => setPayTarget(null)} width="clamp(22rem,64vw,52rem)"
          title={`Оплата · ${payTarget.type === 'hall' && !numberMode ? `Стол ${selectedTable?.number ?? ''}` : `${ORDER_TYPE_TITLES[payTarget.type] ?? ''} #${payTarget.orderNumber ?? ''}`} · ${formatCurrency(payTarget.total)}`}>
          <PaymentPanel order={payTarget} servicePercent={restaurant?.servicePercent ?? 0} accounts={accounts} userId={user?.id} onPaid={onPaidDone} previewCtx={{ restaurant, tables, zones, currentUser: user }} />
        </PosModal>
      )}

      {/* Действия с заказом (разделить/перенести/отменить) — инлайн, без ухода на тикет */}
      {activeGroup && (
        <OrderExtras
          order={activeGroup}
          tables={tables}
          servicePercent={restaurant?.servicePercent ?? 0}
          open={extrasOpen}
          onClose={() => setExtrasOpen(false)}
          onChanged={() => { setExtrasOpen(false); reloadContext() }}
          onCancelled={() => { setExtrasOpen(false); setActiveGroupId(null); reloadContext() }}
        />
      )}

      {/* Отмена отдельной позиции — причина + подтверждение */}
      {cancelItem && (
        <PosModal open onClose={() => { if (!itemBusy) setCancelItem(null) }} dismissable={!itemBusy} width="clamp(20rem,42vw,32rem)" title={`Отмена: ${cancelItem.name}`}>
          <div className="flex flex-col" style={{ padding: 'clamp(1.2rem,1.8vw,1.6rem)', gap: '1rem' }}>
            <div className="flex flex-wrap gap-2">
              {ITEM_REASONS.map(r => { const on = r === itemReason; return <button key={r} onClick={() => setItemReason(r)} className="rounded-full font-semibold border" style={{ background: on ? 'var(--pv-brand)' : 'var(--pv-card)', color: on ? '#fff' : 'var(--pv-text-2)', borderColor: on ? 'var(--pv-brand)' : 'var(--pv-border)', padding: '0.4rem 0.9rem', fontSize: 'calc(var(--pv-ctl) - 0.05rem)' }}>{r}</button> })}
            </div>
            <button disabled={itemBusy} onClick={doCancelItem} className="w-full flex items-center justify-center gap-2 rounded-2xl font-bold text-white disabled:opacity-50 active:scale-[0.98] transition-transform" style={{ background: 'var(--pv-occ-dot)', padding: 'clamp(0.85rem,1.3vw,1.15rem)', fontSize: 'clamp(1rem,1.4vw,1.2rem)' }}>
              <Trash2 style={{ width: '1.3em', height: '1.3em' }} />{itemBusy ? 'Отмена…' : 'Отменить позицию'}
            </button>
          </div>
        </PosModal>
      )}

      {/* Пре-чек — превью на экране + печать (превью работает и без принтера) */}
      {preBill && (
        <PosModal open onClose={() => { if (!printingPre) setPreBill(null) }} dismissable={!printingPre} width="clamp(20rem,42vw,30rem)" title="Пре-чек">
          <div className="flex flex-col" style={{ padding: 'clamp(1rem,1.6vw,1.4rem)', gap: '1rem' }}>
            <div className="overflow-y-auto flex justify-center" style={{ maxHeight: '58vh', background: 'var(--pv-bg)', borderRadius: 'var(--pv-radius)', padding: '0.8rem' }}>
              {preBillReceipt ? <PrintReceipt data={preBillReceipt} /> : <span style={{ color: 'var(--pv-text-3)' }}>Нет данных</span>}
            </div>
            <button disabled={printingPre} onClick={doPrintPreBill} className="w-full flex items-center justify-center gap-2 rounded-2xl font-bold text-white disabled:opacity-50 active:scale-[0.98] transition-transform" style={{ background: 'var(--pv-brand)', padding: 'clamp(0.85rem,1.3vw,1.15rem)', fontSize: 'clamp(1rem,1.4vw,1.2rem)' }}>
              <Printer style={{ width: '1.3em', height: '1.3em' }} />{printingPre ? 'Печать…' : 'Печать пре-чека'}
            </button>
          </div>
        </PosModal>
      )}

      {/* Заказы прямо в ПОС: активные + закрытые (закрытый → чек + печать) */}
      {ordersOpen && (
        <div className="fixed inset-0 z-50" onClick={() => setOrdersOpen(false)}>
          <div className="absolute inset-0" style={{ background: 'rgba(26,26,26,0.4)' }} />
          {/* Боковой drawer СПРАВА — поверх сайдбара «Заказ»: плотный список строк
              для открытых и закрытых, с фильтром-счётчиком и поиском. */}
          <div role="dialog" aria-modal="true" aria-label="Заказы за сегодня" className="absolute inset-y-0 right-0 flex flex-col pv-drawer-right" style={{ width: 'clamp(20rem,34vw,32rem)', background: 'var(--pv-card)', boxShadow: '0 0 60px rgba(0,0,0,0.35)' }} onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b shrink-0" style={{ padding: 'clamp(0.9rem,1.4vw,1.3rem)', borderColor: 'var(--pv-border)' }}>
              <span className="font-bold" style={{ fontSize: 'clamp(1.05rem,1.5vw,1.35rem)', color: 'var(--pv-text)' }}>Заказы за сегодня</span>
              <button onClick={() => setOrdersOpen(false)} className="rounded-lg" style={{ padding: '0.4rem' }} aria-label="Закрыть"><X style={{ color: 'var(--pv-text-2)' }} /></button>
            </div>
            {(() => {
              const q = ordersSearch.trim().toLowerCase()
              const tNum = (o: Order) => o.tableId ? (tables.find(t => t.id === o.tableId)?.number ?? '') : ''
              const matchQ = (o: Order) => !q || String(o.orderNumber ?? '').includes(q) || String(tNum(o)).includes(q)
              const openOrders = ordersList.filter(o => o.status !== 'done' && o.status !== 'cancelled')
              const closedOrders = ordersList.filter(o => o.status === 'done' || o.status === 'cancelled')
              const rows = (ordersTab === 'closed' ? closedOrders : openOrders).filter(matchQ).slice().sort((a, b) => {
                const ka = ordersTab === 'closed' ? (a.closedAt ?? a.createdAt) : a.createdAt
                const kb = ordersTab === 'closed' ? (b.closedAt ?? b.createdAt) : b.createdAt
                return String(kb).localeCompare(String(ka))
              })
              return (
                <>
                  <div className="flex flex-col shrink-0 border-b" style={{ padding: 'clamp(0.7rem,1vw,1rem)', gap: 'clamp(0.5rem,0.8vw,0.7rem)', borderColor: 'var(--pv-border)' }}>
                    <div className="grid grid-cols-2 rounded-xl" style={{ background: 'var(--pv-bg)', padding: '3px', gap: '3px' }}>
                      {([['active', 'Открытые', openOrders.length], ['closed', 'Закрытые', closedOrders.length]] as const).map(([t, l, cnt]) => { const on = ordersTab === t; return (
                        <button key={t} onClick={() => setOrdersTab(t)} className="rounded-lg font-semibold" style={{ background: on ? 'var(--pv-card)' : 'transparent', color: on ? 'var(--pv-brand)' : 'var(--pv-text-2)', padding: 'clamp(0.5rem,0.8vw,0.7rem)', fontSize: 'var(--pv-ctl)', boxShadow: on ? '0 1px 3px rgba(0,0,0,0.1)' : 'none' }}>{l} · {cnt}</button>
                      ) })}
                    </div>
                    <div className="flex items-center gap-2 rounded-xl border" style={{ background: 'var(--pv-bg)', borderColor: 'var(--pv-border)', padding: 'clamp(0.5rem,0.8vw,0.7rem) clamp(0.7rem,1vw,1rem)' }}>
                      <Search style={{ width: '1.1rem', height: '1.1rem', color: 'var(--pv-text-3)' }} className="shrink-0" />
                      <input value={ordersSearch} onChange={e => setOrdersSearch(e.target.value)} inputMode="numeric" placeholder="№ заказа или стол" aria-label="Поиск заказа" className="flex-1 min-w-0 bg-transparent outline-none" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }} />
                      {ordersSearch && <button onClick={() => setOrdersSearch('')} className="shrink-0"><X style={{ width: '1rem', height: '1rem', color: 'var(--pv-text-3)' }} /></button>}
                    </div>
                  </div>
                  <div className="flex-1 min-h-0 overflow-y-auto pv-noscroll" style={{ padding: 'clamp(0.6rem,1vw,0.9rem)' }}>
                    {ordersLoading && ordersList.length === 0 ? (
                      <div className="text-center" style={{ color: 'var(--pv-text-3)', padding: '2rem' }}>Загрузка…</div>
                    ) : rows.length === 0 ? (
                      <div className="text-center" style={{ color: 'var(--pv-text-3)', padding: '2rem' }}>{q ? 'Ничего не найдено' : (ordersTab === 'closed' ? 'Нет закрытых заказов' : 'Нет открытых заказов')}</div>
                    ) : (
                      <div className="flex flex-col" style={{ gap: '0.4rem' }}>
                        {rows.map(o => {
                          const loc = o.type === 'hall' ? `Стол ${o.tableId ? (tNum(o) || '—') : '—'}` : o.type === 'delivery' ? 'Доставка' : 'С собой'
                          const n = (o.items ?? []).filter(i => !i.cancelledAt).length
                          const isClosed = o.status === 'done' || o.status === 'cancelled'
                          const time = isClosed ? (o.closedAt ? ` · закрыт ${new Date(o.closedAt).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })}` : '') : ` · ${getTimeSince(o.createdAt)}`
                          // Возврат: закрытый заказ (бэк 'refunded'/'closed' → 'done') с refundedTotal > 0.
                          // Полный → «Возврат», частичный → «Возврат части». Иначе «Оплачен».
                          const refundedAmt = o.status === 'done' ? (o.refundedTotal ?? 0) : 0
                          const paidAmt = (o.totalWithService ?? o.total) || 0
                          const refundedFull = refundedAmt > 0 && refundedAmt >= paidAmt - 0.01
                          const badge = o.status === 'cancelled' ? 'Отменён' : refundedAmt > 0 ? (refundedFull ? 'Возврат' : 'Возврат части') : o.status === 'done' ? 'Оплачен' : o.status === 'cooking' ? 'Готовится' : o.status === 'ready' ? 'Готов' : o.status === 'served' ? 'Подан' : o.status === 'bill_requested' ? 'Счёт' : 'Открыт'
                          const bt = o.status === 'cancelled' ? { bg: 'var(--pv-bg)', c: 'var(--pv-text-3)' } : refundedAmt > 0 ? { bg: 'var(--pv-occ-soft)', c: 'var(--pv-occ-text)' } : o.status === 'done' ? { bg: 'var(--pv-free-soft)', c: 'var(--pv-free-text)' } : o.status === 'bill_requested' ? { bg: 'var(--pv-bill-soft)', c: 'var(--pv-bill-text)' } : { bg: 'var(--pv-brand-soft)', c: 'var(--pv-brand)' }
                          return (
                            <button key={o.id} onClick={() => tapOrder(o)} className="w-full text-left rounded-xl border active:scale-[0.99] transition-transform" style={{ background: 'var(--pv-card)', borderColor: 'var(--pv-border)', padding: 'clamp(0.6rem,0.95vw,0.85rem)' }}>
                              <div className="flex items-baseline justify-between gap-2" style={{ marginBottom: '0.25rem' }}>
                                <span className="font-bold tabular-nums" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }}>№{o.orderNumber ?? '—'}</span>
                                <span className="rounded-full font-semibold shrink-0" style={{ background: bt.bg, color: bt.c, padding: '0.1rem 0.55rem', fontSize: 'calc(var(--pv-ctl) - 0.2rem)' }}>{badge}</span>
                              </div>
                              <div className="flex items-baseline justify-between gap-2">
                                <span className="truncate" style={{ color: refundedAmt > 0 ? 'var(--pv-occ-text)' : 'var(--pv-text-3)', fontSize: 'calc(var(--pv-ctl) - 0.1rem)' }}>{loc} · {n} поз{time}{refundedAmt > 0 ? ` · возврат ${formatCurrency(refundedAmt)}` : ''}</span>
                                <span className="font-bold tabular-nums whitespace-nowrap" style={{ color: o.status === 'cancelled' ? 'var(--pv-text-3)' : 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }}>{formatCurrency(calcOrderDisplayTotal(o, restaurant?.servicePercent))}</span>
                              </div>
                              {/* Чем расплатились — у оплаченных заказов. */}
                              {o.status === 'done' && (() => {
                                const pay = describePayment(o)
                                if (!pay) return null
                                return (
                                  <div className="truncate" style={{ color: 'var(--pv-text-3)', fontSize: 'calc(var(--pv-ctl) - 0.2rem)', marginTop: '0.15rem' }}>
                                    {pay.isMixed && pay.parts.length > 0
                                      ? pay.parts.map(p => `${p.label}${p.account ? ` (${p.account})` : ''} ${formatCurrency(p.amount)}`).join(' + ')
                                      : `${pay.label}${pay.account ? ` · ${pay.account}` : ''}`}
                                  </div>
                                )
                              })()}
                            </button>
                          )
                        })}
                      </div>
                    )}
                  </div>
                </>
              )
            })()}
          </div>
        </div>
      )}

      {/* Чек закрытого заказа — просмотр + печать (из модалки «Заказы») */}
      {viewReceipt && (
        <PosModal open onClose={() => { if (!reprinting) setViewReceipt(null) }} dismissable={!reprinting} width="clamp(20rem,42vw,30rem)" title={`Чек · №${viewReceipt.orderNumber ?? '—'}`}>
          <div className="flex flex-col" style={{ padding: 'clamp(1rem,1.6vw,1.4rem)', gap: '1rem' }}>
            <div className="overflow-y-auto flex justify-center" style={{ maxHeight: '58vh', background: 'var(--pv-bg)', borderRadius: 'var(--pv-radius)', padding: '0.8rem' }}>
              {closedReceipt ? <PrintReceipt data={closedReceipt} /> : <span style={{ color: 'var(--pv-text-3)' }}>Нет данных</span>}
            </div>
            <button disabled={reprinting} onClick={doReprintReceipt} className="w-full flex items-center justify-center gap-2 rounded-2xl font-bold text-white disabled:opacity-50 active:scale-[0.98] transition-transform" style={{ background: 'var(--pv-brand)', padding: 'clamp(0.85rem,1.3vw,1.15rem)', fontSize: 'clamp(1rem,1.4vw,1.2rem)' }}>
              <Printer style={{ width: '1.3em', height: '1.3em' }} />{reprinting ? 'Печать…' : 'Печать чека'}
            </button>
            {/* Редактирование / возврат закрытого — только по правам (матрица доступов). */}
            {viewReceipt.status === 'done' && (canEditClosed || (canRefund && remainingRefund(viewReceipt) > 0)) && (
              <div className="flex gap-2">
                {canEditClosed && (
                  <button onClick={() => doEditClosed(viewReceipt)} className="flex-1 flex items-center justify-center gap-2 rounded-2xl font-semibold border active:scale-[0.98] transition-transform" style={{ background: 'var(--pv-card)', borderColor: 'var(--pv-border)', color: 'var(--pv-text-2)', padding: 'clamp(0.75rem,1.1vw,1rem)', fontSize: 'var(--pv-ctl)' }}>
                    <Pencil style={{ width: '1.15em', height: '1.15em' }} />Редактировать
                  </button>
                )}
                {canRefund && remainingRefund(viewReceipt) > 0 && (
                  <button onClick={() => openRefund(viewReceipt)} className="flex-1 flex items-center justify-center gap-2 rounded-2xl font-semibold border active:scale-[0.98] transition-transform" style={{ background: 'var(--pv-card)', borderColor: 'var(--pv-occ-dot)', color: 'var(--pv-occ-text)', padding: 'clamp(0.75rem,1.1vw,1rem)', fontSize: 'var(--pv-ctl)' }}>
                    <Undo2 style={{ width: '1.15em', height: '1.15em' }} />Возврат
                  </button>
                )}
              </div>
            )}
          </div>
        </PosModal>
      )}

      {/* Возврат закрытого заказа (по праву orders.refund) */}
      {refundTarget && (
        <PosModal open onClose={() => { if (!refundBusy) setRefundTarget(null) }} dismissable={!refundBusy} width="clamp(20rem,42vw,30rem)" title={`Возврат · №${refundTarget.orderNumber ?? '—'}`}>
          <div className="flex flex-col" style={{ padding: 'clamp(1.1rem,1.7vw,1.5rem)', gap: '0.9rem' }}>
            <div className="flex items-center justify-between rounded-xl" style={{ background: 'var(--pv-bg)', padding: '0.6rem 0.9rem' }}>
              <span style={{ color: 'var(--pv-text-2)', fontSize: 'var(--pv-ctl)' }}>Остаток к возврату</span>
              <span className="font-bold" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }}>{formatCurrency(remainingRefund(refundTarget))}</span>
            </div>
            <div>
              <div className="font-medium" style={{ color: 'var(--pv-text-2)', fontSize: 'var(--pv-ctl)', marginBottom: '0.35rem' }}>Сумма возврата</div>
              <div className="flex items-center rounded-xl border" style={{ borderColor: 'var(--pv-border)', padding: '0.55rem 0.9rem' }}>
                <input inputMode="decimal" value={refundAmt} onChange={e => setRefundAmt(e.target.value)} className="flex-1 min-w-0 bg-transparent outline-none font-semibold" style={{ color: 'var(--pv-text)', fontSize: 'var(--pv-ctl)' }} />
                <span style={{ color: 'var(--pv-text-3)', fontSize: 'calc(var(--pv-ctl) - 0.1rem)' }}>с.</span>
              </div>
            </div>
            <div>
              <div className="font-medium" style={{ color: 'var(--pv-text-2)', fontSize: 'var(--pv-ctl)', marginBottom: '0.35rem' }}>Причина</div>
              <div className="flex flex-wrap gap-2">
                {['Жалоба гостя', 'Ошибка кассира', 'Некачественно', 'Другое'].map(r => { const on = r === refundReason; return (
                  <button key={r} onClick={() => setRefundReason(r)} className="rounded-full font-semibold border" style={{ background: on ? 'var(--pv-brand)' : 'var(--pv-card)', color: on ? '#fff' : 'var(--pv-text-2)', borderColor: on ? 'var(--pv-brand)' : 'var(--pv-border)', padding: '0.4rem 0.9rem', fontSize: 'calc(var(--pv-ctl) - 0.05rem)' }}>{r}</button>
                ) })}
              </div>
            </div>
            <button disabled={refundBusy} onClick={doRefund} className="w-full flex items-center justify-center gap-2 rounded-2xl font-bold text-white disabled:opacity-50 active:scale-[0.98] transition-transform" style={{ background: 'var(--pv-occ-dot)', padding: 'clamp(0.85rem,1.3vw,1.15rem)', fontSize: 'clamp(1rem,1.4vw,1.2rem)' }}>
              <Undo2 style={{ width: '1.3em', height: '1.3em' }} />{refundBusy ? 'Возврат…' : 'Оформить возврат'}
            </button>
          </div>
        </PosModal>
      )}

      {/* ── Table picker overlay (hall) ────────────────────────── */}
      {tablesOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(26,26,26,0.5)' }} onClick={() => setTablesOpen(false)}>
          <div role="dialog" aria-modal="true" aria-label="Выберите стол" className="rounded-3xl overflow-hidden flex flex-col" style={{ background: 'var(--pv-card)', width: 'clamp(26rem, 60vw, 56rem)', maxHeight: '82vh', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }} onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b shrink-0" style={{ padding: 'clamp(1rem,1.6vw,1.4rem) clamp(1.2rem,1.8vw,1.6rem)', borderColor: 'var(--pv-border)' }}>
              <span className="font-bold" style={{ fontSize: 'clamp(1.1rem,1.6vw,1.4rem)', color: 'var(--pv-text)' }}>Выберите стол</span>
              <button onClick={() => setTablesOpen(false)} className="rounded-lg" style={{ padding: '0.4rem' }}><X style={{ color: 'var(--pv-text-2)' }} /></button>
            </div>
            <div className="flex-1 min-h-0 overflow-hidden flex flex-col" style={{ padding: 'clamp(1rem,1.6vw,1.5rem)' }}>
              {tables.length === 0 ? (
                <div className="text-center" style={{ color: 'var(--pv-text-3)', padding: '2rem' }}>Столы не заведены</div>
              ) : (() => {
                // Зоны — табы (а не стопкой), иначе при многих столах не помещается.
                const activeZone = (pickerZone && tablesByZone.some(g => g.zone === pickerZone)) ? pickerZone : tablesByZone[0]?.zone
                const activeTables = tablesByZone.find(g => g.zone === activeZone)?.tables ?? []
                return (
                  <>
                    {tablesByZone.length > 1 && (
                      <div className="flex items-center overflow-x-auto shrink-0 pv-noscroll" style={{ gap: 'clamp(0.4rem,0.7vw,0.6rem)', marginBottom: 'clamp(0.8rem,1.2vw,1.1rem)' }}>
                        {tablesByZone.map(g => { const on = g.zone === activeZone; return (
                          <button key={g.zone} onClick={() => setPickerZone(g.zone)} className="rounded-full font-semibold whitespace-nowrap shrink-0 border" style={{ background: on ? 'var(--pv-brand)' : 'var(--pv-card)', color: on ? '#fff' : 'var(--pv-text-2)', borderColor: on ? 'var(--pv-brand)' : 'var(--pv-border)', padding: 'clamp(0.45rem,0.7vw,0.65rem) clamp(0.9rem,1.4vw,1.4rem)', fontSize: 'var(--pv-ctl)' }}>{g.zone}</button>
                        ) })}
                      </div>
                    )}
                    <div className="flex-1 min-h-0 overflow-y-auto">
                      <div style={{ display: 'grid', gap: 'clamp(0.6rem,1vw,0.9rem)', gridTemplateColumns: 'repeat(auto-fill, minmax(clamp(6.5rem,10vw,8.5rem), 1fr))' }}>
                        {activeTables.map(t => {
                          const optOcc = justOccupied.has(t.id) && (t.currentOrderIds?.length ?? 0) === 0
                          const st = optOcc ? STATUS.occupied : (STATUS[t.status] ?? STATUS.free)
                          const sel = t.id === selectedTableId
                          const groupsN = Math.max(t.currentOrderIds?.length ?? 0, optOcc ? 1 : 0)
                          return (
                            <button key={t.id} onClick={() => selectTable(t.id)} className="relative flex flex-col items-center justify-center rounded-2xl active:scale-[0.97] transition-transform" style={{ background: sel ? 'var(--pv-brand)' : st.soft, border: `2px solid ${sel ? 'var(--pv-brand)' : 'transparent'}`, padding: 'clamp(0.8rem,1.3vw,1.2rem)', gap: '0.35rem', minHeight: 'clamp(5rem,7vw,6.5rem)' }}>
                              {groupsN >= 2 && <span className="absolute rounded-full font-bold flex items-center justify-center" style={{ top: '0.35rem', right: '0.35rem', background: sel ? 'rgba(255,255,255,0.9)' : 'var(--pv-brand)', color: sel ? 'var(--pv-brand)' : '#fff', minWidth: '1.3rem', height: '1.3rem', fontSize: '0.7rem' }}>{groupsN}</span>}
                              <span className="font-bold" style={{ color: sel ? '#fff' : 'var(--pv-text)', fontSize: 'clamp(1.1rem,1.6vw,1.5rem)' }}>№{t.number}</span>
                              <div className="flex items-center gap-1.5">
                                <span className="rounded-full" style={{ width: '0.5rem', height: '0.5rem', background: sel ? 'rgba(255,255,255,0.9)' : st.dot }} />
                                <span className="font-medium" style={{ color: sel ? 'rgba(255,255,255,0.9)' : st.text, fontSize: 'calc(var(--pv-ctl) - 0.05rem)' }}>{sel ? 'Выбран' : st.label}</span>
                              </div>
                              <div className="flex items-center gap-1" style={{ color: sel ? 'rgba(255,255,255,0.75)' : 'var(--pv-text-3)' }}>
                                <Users style={{ width: '0.8rem', height: '0.8rem' }} /><span style={{ fontSize: 'calc(var(--pv-ctl) - 0.15rem)' }}>{t.capacity}</span>
                              </div>
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  </>
                )
              })()}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
