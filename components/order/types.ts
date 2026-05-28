import type { OrderType, User } from '@/lib/types'

export interface CartLine {
  menuItemId: string
  name: string
  emoji: string
  qty: number
  price: number
  cogs: number
  unit: 'piece' | 'g' | 'kg'
  unitSize: number
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
}

interface AddItemsProps extends CommonProps {
  mode: 'add'
  orderId: string
  /** Optional context shown in the locked destination header. */
  destinationLabel?: string
}

export type OrderComposerProps = NewOrderProps | AddItemsProps
