import type { OrderType, User } from '@/lib/types'

export interface CartLine {
  /** Устойчивый ID строки корзины. Нужен, чтобы весовые навески одного и того же
   *  блюда (например «300г» и «500г») были ОТДЕЛЬНЫМИ строками и не перетирали
   *  друг друга (адресация по menuItemId их бы схлопнула). Штучные позиции
   *  по-прежнему мержатся по menuItemId. undefined — legacy-строки (fallback на
   *  menuItemId). */
  lineId?: string
  menuItemId: string
  name: string
  emoji: string
  qty: number
  price: number
  cogs: number
  unit: 'piece' | 'g' | 'kg'
  unitSize: number
  /** Кол-во порций для весовой позиции (например «4 по 100г»). В корзине
   *  хранится одной строкой; при отправке заказа разворачивается в N отдельных
   *  OrderItem'ов по `qty` каждый — чтобы чек/кухня печатали по порции отдельно.
   *  undefined/1 — обычная одиночная порция. Для штучных позиций не используется. */
  portionQty?: number
  /** Set to true when a manager/owner-permission user explicitly bypasses
   *  the backend stop-list for this dish. Causes the order request to
   *  carry `override_stop_list: true`, allowing the backend to accept the
   *  item that would otherwise return 409 ITEM_STOPPED. */
  overrideStopList?: boolean
}

export interface TabInfo {
  id: string
  tabLabel?: string
  total: number
  status: string
  /** Позиции уже сделанного заказа этой группы. Используется в POS чтобы
   *  показать их как read-only «Уже заказано» над текущей корзиной — без
   *  этого кассир не видит, что́ группа уже заказала, и принимает дозаказ
   *  вслепую. */
  items?: import('@/lib/types').OrderItem[]
  /** Полный объект Order — нужен инлайн-панели OrderActionsPanel (Phase 2)
   *  для прокидывания discount/service/comment/etc без повторного fetch'а
   *  при переключении групп. */
  order?: import('@/lib/types').Order
}

export type OrderComposerMode = 'new' | 'add'

interface CommonProps {
  className?: string
  onSubmitted?: (result: { orderId: string; mode: OrderComposerMode }) => void
  onCancel?: () => void
  /** PIN-auth override; falls back to logged-in user. */
  effectiveUser?: User | null
  /** Если true — используется legacy compact layout (горизонтальные категории-табы,
   *  табличный picker столов справа). По умолчанию используется новый iiko-style
   *  drill-down: сетка категорий → сетка блюд, полноэкранный picker столов. true
   *  передают: waiter-страницы (`/waiter/...`) и диалоги (create-order, add-items),
   *  где места под полноэкранную сетку нет. */
  compactMode?: boolean
}

interface NewOrderProps extends CommonProps {
  mode?: 'new'
  initialTableId?: string
  initialOrderType?: OrderType
  initialGuests?: number
  initialTabLabel?: string
  /** When true, the destination (type/table/multi-tab) is read-only. Used when launched from a specific table card. */
  lockDestination?: boolean
  /** Resume an in-progress cart (used by waiter drafts). */
  initialCart?: CartLine[]
  /** Fires on every cart/destination change. Used by waiter drafts to autosave. */
  onCartChange?: (state: { cart: CartLine[]; tableId: string; guestsCount: number; tabLabel: string }) => void
  /** When true, never auto-pick an existing tab on the chosen table — always
   * create a brand-new order ("Новая группа" UX from the waiter app). */
  forceNewOrder?: boolean
  /** Pre-select an existing open order by id (when coming from
   *  OrderActionsBody «Дозаказ» — кассир уже выбрал конкретную группу).
   *  Без этого composer auto-pick'нет первую в openTabs. */
  initialExistingOrderId?: string
}

interface AddItemsProps extends CommonProps {
  mode: 'add'
  orderId: string
  /** Optional context shown in the locked destination header. */
  destinationLabel?: string
}

export type OrderComposerProps = NewOrderProps | AddItemsProps
