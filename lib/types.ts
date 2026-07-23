// ─── Types ────────────────────────────────────────────────────────────────────

export type UserRole =
  | 'superadmin'
  | 'owner'
  | 'manager'
  | 'waiter'
  | 'cashier'
  | 'cook'
  | 'storekeeper'
  | 'accountant'
  | 'other'

export type TableStatus = 'free' | 'occupied' | 'reserved' | 'bill_requested'
export type OrderStatus = 'new' | 'cooking' | 'ready' | 'served' | 'bill_requested' | 'done' | 'cancelled'
export type OrderType = 'hall' | 'delivery' | 'takeaway'
export type PaymentMethod = 'cash' | 'card' | 'transfer'
export type StockMovementType = 'in' | 'out' | 'semi' | 'audit' | 'adj' | 'batch' | 'return'
export type FinancialActivity = 'operational' | 'investment' | 'financial'
export type FinancialOperationType = 'in' | 'out' | 'transfer'
export type ReceiptPaymentType = 'paid' | 'credit' | 'partial'
export type ABCClass = 'A' | 'B' | 'C'

export const UNITS = ['кг', 'г', 'л', 'мл', 'шт.', 'порц.', 'уп.', 'бут.'] as const
export type Unit = typeof UNITS[number]

// ─── Restaurant (Multi-tenant) ────────────────────────────────────────────────

export interface Restaurant {
  id: string
  name: string
  slug: string
  logoUrl?: string
  address?: string
  phone?: string
  currency: string
  servicePercent: number
  // Скидка ВЫШЕ этого % требует одобрения менеджера/владельца (default 10).
  discountApprovalThreshold?: number
  timezone: string
  enforceStockCheck: boolean
  techCardsEnabled?: boolean
  autoReadyMode?: boolean
  autoReadyBufferMin?: number
  pinLockEnabled?: boolean
  pinLockTimeoutMin?: number
  // Экранная клавиатура (iiko-style) на POS/смене/зале. Default false —
  // включается в настройках владельца для тач-терминалов без физ. клавиатуры.
  onScreenKeyboardEnabled?: boolean
  // Режим обслуживания (041 + 052). tablesEnabled=false → фастфуд: заказ по
  // номеру без столов, создать его без оплаты нельзя, чек и кухонный бегунок
  // печатаются вместе по факту оплаты.
  // kitchenOnPay — legacy-флаг из 041: то же «кухня на оплате», но для зала со
  // столами. Отдельного тумблера в настройках больше нет (фастфуд включает
  // поведение сам), поле оставлено ради существующих конфигов.
  // posV2Default=true → новый POS по умолчанию на кассах ресторана.
  tablesEnabled?: boolean
  kitchenOnPay?: boolean
  posV2Default?: boolean
  // Сортировать меню в POS/pos2 по продаваемости (окно 30 дней). Default false
  // → алфавит. Тумблер в настройках ресторана (060).
  menuSortBySales?: boolean
  // Доставка (052). deliveryEnabled=false → в POS только «Зал» и «С собой».
  // deliveryContactsRequired=true → перед оплатой доставки касса спрашивает
  // телефон и адрес.
  deliveryEnabled?: boolean
  deliveryContactsRequired?: boolean
  // Разрешает хозтоварам (is_food=false) уходить в реальный минус. Когда false —
  // createSupplyExpense блокирует выдачу если qty > остаток.
  supplyAllowNegative?: boolean
  localServerIp?: string
  licenseKey?: string
  licenseExpiresAt?: string
  isBlocked?: boolean
  blockReason?: string
  lastSeenAt?: string
  appVersion?: string
  createdAt: string
}

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface UserPermissions {
  nav: string[]
  actions: Record<string, boolean>
}

export interface User {
  id: string
  username: string
  name: string
  role: UserRole
  roleDisplay: string
  restaurantId: string
  salary?: number
  // Тип оплаты труда (054). 'monthly' — оклад (salary), 'daily' — ставка за
  // отработанный день (dailyRate × дни с отметкой в табеле). Пусто = monthly.
  payType?: 'monthly' | 'daily'
  dailyRate?: number
  advance?: number
  deductions?: number
  password?: string
  position?: string       // Должность: "Салатчи (старший)"
  birthDate?: string      // Дата рождения: "1988-03-27"
  station?: string        // Привязка к станции: "cold_kitchen"
  shiftNumber?: number    // Номер смены: 1, 2
  pin?: string
  permissions?: UserPermissions
}

export interface Zone {
  id: string
  name: string
}

export interface Table {
  id: string
  number: number
  name: string
  capacity: number
  zone: string
  status: TableStatus
  // Legacy single-order pointer. Kept for backwards compatibility during the
  // multi-tab rollout — equals the first id in currentOrderIds. New code reads
  // currentOrderIds and ignores this.
  currentOrderId?: string
  // Multi-tab: ids of all open (non-done, non-cancelled) orders on this table.
  // Derived in fetchTables from a side query against orders.
  currentOrderIds: string[]
  waiterId?: string
  openedAt?: string
  mergedWith?: string // ID of primary table if this table is merged
}

export interface TechCardLine {
  ingredientId?: string
  semiId?: string
  name: string
  qty: number
  unit: string
}

export type MenuStation = 'hot_kitchen' | 'cold_kitchen' | 'grill' | 'bar' | 'showcase'

export const STATION_LABELS: Record<MenuStation, string> = {
  hot_kitchen: 'Горячий цех',
  cold_kitchen: 'Холодный цех',
  grill: 'Шашлычный',
  bar: 'Бар',
  showcase: 'Витрина',
}

export const STATION_ICONS: Record<MenuStation, string> = {
  hot_kitchen: '🔥',
  cold_kitchen: '🥗',
  grill: '🍖',
  bar: '☕',
  showcase: '🥟',
}

export const ALL_STATIONS: MenuStation[] = ['hot_kitchen', 'cold_kitchen', 'grill', 'bar', 'showcase']

export interface MenuItem {
  id: string
  name: string
  category: string
  price: number
  emoji: string
  imageUrl?: string
  isAvailable: boolean
  stopListOverride: boolean
  isPurchased?: boolean  // покупной товар (бэк сам ведёт складской ингредиент + 1:1 техкарту)
  cogs: number          // эффективная (auto из техкарты, иначе ручная) — для маржи/списка
  cogsManual?: number   // сырое сохранённое значение «себестоимость вручную» (для формы)
  cookTimeMin?: number | null
  station: MenuStation
  techCard: TechCardLine[]
  isBatchCooking: boolean
  preparedQty: number
  // Порог "заканчивается" для заготовочных блюд (по умолчанию 5 порций).
  // Если preparedQty <= lowStockThreshold — карточка подсвечивается как "заканчивается".
  lowStockThreshold?: number
  // Weight-based sales
  unit?: 'piece' | 'g' | 'kg'
  unitSize?: number // price is per N units (1шт | 100г | 1кг)
  saleStep?: number // minimum increment (50г for scales); 0 = any
  // Товары с атрибутами (Размер/Вкус): продукт-родитель хранит attributes,
  // сгенерированные варианты — parentId + variantValueIds (их комбинация).
  // Варианты скрыты из списков UI; POS резолвит комбинацию → вариант.
  parentId?: string | null
  attributes?: MenuAttribute[]
  variantValueIds?: string[]
}

// Значение атрибута — чистый лейбл: цена и закупка задаются per-комбинация
// и живут на строке варианта (menu_items.price / cogs).
export interface MenuAttributeValue {
  id: string
  label: string   // «1 л»
  sizeScaleValueId?: string | null // если атрибут scale-linked — какое значение шкалы это зеркалит
}

export interface MenuAttribute {
  id: string
  name: string         // «Размер»
  values: MenuAttributeValue[]
  // Если задан — values зеркалятся из этой шкалы размеров, а не вводятся
  // вручную (см. components/menu/attributes-editor.tsx).
  sizeScaleId?: string | null
}

// SizeScale — переиспользуемая шкала размеров («Пиццы 25/30/35»). Продукт
// (через MenuAttribute.sizeScaleId) и заготовка (через
// SemiFinishedType.sizeScaleValueId) ссылаются на неё вместо того, чтобы
// заводить одинаковые значения размера с нуля на каждой карточке.
export interface SizeScaleValue {
  id: string
  sizeScaleId: string
  code: string        // «25»
  title?: string       // «Маленькая» (опционально)
  sortOrder: number
  isDefault: boolean
}

export interface SizeScale {
  id: string
  name: string
  values: SizeScaleValue[]
}

export interface SemiRecipeLine {
  ingredientId: string
  name: string
  qtyPerUnit: number
  unit: string
}

export interface SemiFinishedType {
  id: string
  name: string
  outputUnit: string
  yieldPercent: number // 70 = из 1кг сырья получается 0.7кг готового
  recipe: SemiRecipeLine[]
  // Тег «это заготовка вот этого размера» (например «Тесто-30» → значение
  // «30» шкалы пиццы) — подсказывает нужную заготовку в редакторе тех. карты.
  sizeScaleValueId?: string | null
}

export interface SemiFinishedStock {
  id: string
  semiTypeId: string
  name: string
  qty: number
  unit: string
  pricePerUnit: number // себестоимость за единицу готового продукта
  lastProducedAt: string
}

export interface BatchCookingLog {
  id: string
  menuItemId: string
  menuItemName: string
  qty: number
  producedBy?: string
  producedById?: string
  costTotal: number
  reason?: string
  createdAt: string
}

export interface BatchPortionCalc {
  maxPortions: number
  hasRecipe: boolean
  ingredients: {
    // Строка ссылается ЛИБО на ингредиент, ЛИБО на полуфабрикат (тесто,
    // соус...) — ровно как TechCardLine. Ровно одно из двух задано.
    ingredientId?: string
    semiTypeId?: string
    name: string
    unit: string
    recipeUnit: string
    stockQty: number
    recipeQtyPerPortion: number
    stockQtyPerPortion: number // расход на порцию в единице склада (после конвертации)
    possiblePortions: number
    isBottleneck: boolean
  }[]
}

export interface Ingredient {
  id: string
  name: string
  category: string
  qty: number
  minQty: number
  unit: string
  pricePerUnit: number
  wastePercent: number // 15 = 15% отходов при очистке
  // Per-unit фактор: вес/объём ОДНОЙ складской единицы, если основная единица
  // штучная (шт/уп/бут), а тех-карта — в весе/объёме. Напр. «1 банка = 340 г».
  // 0/undefined = фактор не задан. См. convertDeductToStockUnit.
  unitWeight?: number
  unitWeightUnit?: string // единица фактора (г/мл)
  isFood: boolean // true = продукт, false = хозтовар
  warehouseId?: string // склад, где лежит товар (мультисклад)
}

// Warehouse — склад (мультисклад). 3 фиксированных: products/purchased/supplies.
export interface Warehouse {
  id: string
  name: string
  kind: 'products' | 'purchased' | 'supplies'
}

export interface OrderItem {
  id?: string
  menuItemId: string
  name: string
  qty: number // number of portions OR actual weight (for weight items)
  price: number // unit price (per unitSize)
  cogs: number
  /** Optional menu-item emoji denormalized into the order item for fast
   *  rendering in POS lists without re-resolving via menu cache. */
  emoji?: string
  modifiers?: OrderItemModifier[]
  // For weight items: actual sold amount (e.g. 250 when unit='g', unitSize=100)
  unit?: 'piece' | 'g' | 'kg'
  unitSize?: number
  // Soft-cancellation
  cancelledAt?: string
  cancelledBy?: string
  cancelReason?: string
  // Atomic claim flags for distributed print dedup (filled by claimItemPrint /
  // claimItemCancelPrint via DB UPDATE … WHERE printed_at IS NULL).
  printedAt?: string | null
  cancelPrintedAt?: string | null
  // Per-item served flag — waiter taps a row to mark/unmark this dish as served
  // independently of the order-level status. Auto-created PGlite column.
  servedAt?: string
  servedBy?: string
  /** Optional free-text note (e.g. "без лука", "хорошо прожарить").
   *  Печатается в кухонном ранере и в пре-чеке. Меняется через
   *  PATCH /orders/{id}/items/{itemId}/note. */
  note?: string | null
  /** Computed бэком per-item: pending/cooking/ready/served/cancelled.
   *  Колонки в БД нет — выводится в service/orders.go::computeItemKitchenStatus. */
  kitchenStatus?: string | null
  /** ISO timestamp when this specific order item was added to the database. */
  createdAt?: string
}

export interface Order {
  id: string
  orderNumber?: number
  status: OrderStatus
  type: OrderType
  tableId?: string
  waiterId?: string
  cashierId?: string
  paymentMethod?: PaymentMethod
  comment?: string
  // Контакты доставки (052) — заполняются на оплате заказа type='delivery',
  // печатаются на бегунке курьеру.
  deliveryPhone?: string
  deliveryAddress?: string
  items: OrderItem[]
  /** v2.1.2: число живых (не-cancelled) позиций. Заполняется backend slim-payload
   *  (items_count) или вычисляется из items. Используется UI чтобы скрыть
   *  zombie-заказы (status=active, но все позиции отменены). */
  aliveItemsCount?: number
  total: number
  // subtotal — Σ price×effectivePortions с бэка (единый источник правды по сумме
  // позиций; total у старых заказов мог считаться прежней формулой).
  subtotal?: number
  servicePercent?: number
  serviceAmount?: number
  totalWithService?: number
  createdAt: string
  readyAt?: string
  expectedReadyAt?: string
  closedAt?: string
  shiftId?: string
  isSplit?: boolean
  splitCount?: number
  guestsCount?: number
  tipAmount?: number
  // Multi-tab: optional human label for the tab (e.g. "Гость 2", "Парень у окна").
  // When absent, UI falls back to "Таб N" by created_at order.
  tabLabel?: string
  payments?: OrderPayment[]
  discountType?: 'percent' | 'fixed' | 'promo'
  discountValue?: number
  discountAmount?: number
  discountReason?: string
  // Soft-cancellation
  cancelledAt?: string
  cancelledBy?: string
  cancelReason?: string
  cancelledTotal?: number
  refundedTotal?: number
  refundedAt?: string
  refundReason?: string
}

export interface OrderPayment {
  method: PaymentMethod
  amount: number
  accountId: string
  accountName?: string
}

export interface Supplier {
  id: string
  name: string
  contactPerson: string
  phone: string
  categories: string[]
  paymentTermsDays: number
  creditLimit: number
  currentDebt: number
}

export interface ReceiptLine {
  // id строки нужен для возврата поставщику (receipt_line_id): возврат
  // привязан к строке, а не к накладной — одна номенклатура может быть в
  // накладной дважды по разным ценам. Отсутствует у ещё не сохранённых строк
  // (форма создания накладной).
  id?: string
  // Сколько ещё можно вернуть по этой строке, в единицах накладной. Считает
  // бэк (min(принято − неотменённые возвраты, остаток склада)) — клиенту это
  // считать нельзя: он не знает про отменённые возвраты и путает единицы
  // склада с единицами накладной. Есть только при ?include=lines.
  availableToReturn?: number
  ingredientId: string
  name: string
  qty: number
  unit: string
  pricePerUnit: number
}

export interface StockReceipt {
  id: string
  supplierId: string
  supplierName: string
  date: string
  note?: string
  totalAmount: number
  paymentType: ReceiptPaymentType
  paidAmount: number
  debtAmount: number
  // Сумма НЕотменённых возвратов поставщику по накладной. >0 → статус
  // «Возвращено» (полный) / «Возврат части» (частичный) вместо статуса оплаты.
  returnedTotal?: number
  dueDate?: string
  confirmedAt?: string
  confirmedBy?: string
  // v2.0.87: атомарная приёмка. Если accountId указан и paid=true (default),
  // бэк сам создаст financial_operation type=out category=stock_purchase
  // source_ref=receipt:<id> и спишет баланс счёта в той же транзакции.
  accountId?: string
  paid?: boolean
  lines: ReceiptLine[]
}

export interface SupplyExpense {
  id: string
  ingredientId: string
  ingredientName: string
  qty: number
  unit: string
  reason: string
  issuedTo?: string
  note?: string
  createdBy?: string
  createdAt: string
}

export const SUPPLY_EXPENSE_REASONS = [
  'Выдано в зал',
  'Выдано на кухню',
  'Выдано на бар',
  'Хозяйственные нужды',
  'Порча / бой',
  'Прочее',
] as const

export interface StockMovement {
  id: string
  type: StockMovementType
  ingredientId?: string
  ingredientName: string
  description: string
  qty: number
  unit: string
  timestamp: string
  belowZero?: boolean
  warehouseId?: string
}

export interface FinancialAccount {
  id: string
  name: string
  type: 'cash' | 'bank'
  balance: number
}

export interface FinancialOperation {
  id: string
  type: FinancialOperationType
  amount: number
  category: string
  accountId: string
  accountName: string
  activity: FinancialActivity
  date: string
  description: string
  counterparty?: string
  isAuto: boolean
  sourceRef?: string
  shiftId?: string
  createdAt?: string // момент ввода — для внутридневной сортировки реестра ДДС
}

export interface BudgetLine {
  id: string
  category: string
  type: 'in' | 'out'
  planAmount: number
  factAmount: number
}

// RecurringPayment — шаблон повторяющегося платежа (модуль «Платежи»).
export interface RecurringPayment {
  id: string
  name: string
  category: string
  amount: number
  accountId?: string
  activity: FinancialActivity
  counterparty?: string
  dayOfMonth: number
  nextDue?: string        // YYYY-MM-DD
  lastPaidAt?: string
  active: boolean
  note?: string
}

// ─── Balance: Assets, Liabilities, Equity ────────────────────────────────────

export type AssetCategory = 'equipment' | 'renovation' | 'furniture' | 'vehicle' | 'other'
export type LiabilityCategory = 'investment' | 'credit' | 'loan' | 'other'
export type EquityCategory = 'capital' | 'retained_earnings' | 'owner_investment'

export const ASSET_CATEGORY_LABELS: Record<AssetCategory, string> = {
  equipment: 'Оборудование',
  renovation: 'Ремонт',
  furniture: 'Мебель',
  vehicle: 'Транспорт',
  other: 'Прочее',
}

export const LIABILITY_CATEGORY_LABELS: Record<LiabilityCategory, string> = {
  investment: 'Инвестиция',
  credit: 'Кредит',
  loan: 'Займ',
  other: 'Прочее',
}

export const EQUITY_CATEGORY_LABELS: Record<EquityCategory, string> = {
  capital: 'Уставной капитал',
  retained_earnings: 'Нерасп. прибыль',
  owner_investment: 'Вложения владельца',
}

// Н22: авто-категории financial_operations, которые бэк создаёт техническими
// кодами (приёмка, оплата долга, гашение обязательства, возврат). В ДДС/ОПиУ
// они показывались сырыми кодами. Ручные категории уже по-русски — для них
// finopCategoryLabel возвращает исходную строку.
export const FINOP_CATEGORY_LABELS: Record<string, string> = {
  stock_purchase: 'Закупка на склад (накладная)',
  supplier_payment: 'Оплата долга поставщику',
  liability_payment: 'Гашение обязательства',
  refund: 'Возврат покупателю',
  revenue: 'Выручка',
  // «Сервис» в расходах — это ВЫПЛАТА собранного сервисного сбора официантам
  // (сбор входит в выручку, выплата — расход; сквозной проход). Уточняем
  // подпись, чтобы строка не читалась как выручка. Хранимое значение категории
  // не меняем — по нему фильтруют Z-отчёт и экспорт.
  'Сервис': 'Сервис (официантам)',
}

// finopCategoryLabel — человекочитаемая подпись категории финоперации.
// Для авто-кодов берёт из словаря, для ручных (уже русских) — как есть.
export function finopCategoryLabel(category?: string | null): string {
  if (!category) return ''
  return FINOP_CATEGORY_LABELS[category] ?? category
}

export interface Asset {
  id: string
  name: string
  category: AssetCategory
  amount: number
  purchaseDate?: string
  usefulLifeMonths?: number | null
  note?: string
}

export interface Liability {
  id: string
  name: string
  category: LiabilityCategory
  totalAmount: number
  paidAmount: number
  remainingAmount: number
  creditor?: string
  dueDate?: string
  monthlyPayment?: number
  interestRate?: number
  note?: string
}

export interface EquityEntry {
  id: string
  name: string
  category: EquityCategory
  amount: number
  note?: string
}

// ─── Reservations ────────────────────────────────────────────────────────────

export type ReservationStatus = 'active' | 'seated' | 'cancelled' | 'no_show'

export const RESERVATION_STATUS_LABELS: Record<ReservationStatus, string> = {
  active: 'Ожидается',
  seated: 'Гость сел',
  cancelled: 'Отменена',
  no_show: 'Не пришёл',
}

export interface Reservation {
  id: string
  tableId: string
  guestName: string
  guestPhone?: string
  guestsCount: number
  reservedAt: string
  durationMin: number
  note?: string
  createdBy?: string
  createdByName?: string
  status: ReservationStatus
  createdAt: string
}

// ─── Order Voids ────────────────────────────────────────────────────────────

export type VoidReason = 'guest_changed_mind' | 'kitchen_error' | 'quality' | 'other'

export const VOID_REASON_LABELS: Record<VoidReason, string> = {
  guest_changed_mind: 'Гость передумал',
  kitchen_error: 'Ошибка кухни',
  quality: 'Проблема качества',
  other: 'Другое',
}

export interface OrderVoid {
  id: string
  orderId: string
  itemName: string
  itemQty: number
  itemPrice: number
  reason: string
  approvedByName?: string
  createdByName?: string
  createdAt: string
}

// ─── Split Bill ──────────────────────────────────────────────────────────────

export type SplitStatus = 'pending' | 'paid'

export interface OrderSplit {
  id: string
  orderId: string
  splitNumber: number
  splitType: 'equal' | 'by_items'
  items?: { name: string; qty: number; price: number }[]
  subtotal: number
  servicePercent: number
  serviceAmount: number
  total: number
  paymentMethod?: PaymentMethod
  accountId?: string
  accountName?: string
  paidAt?: string
  paidBy?: string
  status: SplitStatus
}

// ─── Modifiers ───────────────────────────────────────────────────────────────

export interface ModifierGroup {
  id: string
  name: string
  menuItemId?: string | null
  isRequired: boolean
  maxSelect: number
  modifiers: Modifier[]
}

export interface Modifier {
  id: string
  groupId: string
  name: string
  price: number
  isDefault: boolean
}

export interface OrderItemModifier {
  modifierId?: string
  name: string
  price: number
}

// ─── Stop-List ───────────────────────────────────────────────────────────────

export interface StopListItem {
  menuItemId: string
  menuItemName: string
  category: string
  emoji: string
  reason: string
  ingredientId: string
  ingredientName: string
  currentQty: number
  minQty: number
  unit: string
}

// ─── Cash Shifts ─────────────────────────────────────────────────────────────

export type CashShiftStatus = 'open' | 'closed'
export type CashShiftOpType = 'cash_in' | 'cash_out'

export interface CashShift {
  id: string
  restaurantId: string
  accountId?: string
  accountName?: string
  openedBy: string
  openedByName?: string
  closedBy?: string
  closedByName?: string
  openedAt: string
  closedAt?: string
  openingBalance: number
  closingBalance?: number
  expectedCash?: number
  cashRevenue: number
  cardRevenue: number
  ordersCount: number
  avgCheck: number
  status: CashShiftStatus
}

export interface CashShiftOperation {
  id: string
  shiftId: string
  type: CashShiftOpType
  amount: number
  description?: string
  /** Категория расхода. Заполнена только для расходов (cash_out с категорией);
   *  для внесения/изъятия пустая. См. cash_shift_operations.category. */
  category?: string
  /** Счёт операции. Пусто → счёт смены (наличный ящик). ≠ счёту смены →
   *  безналичная операция: наличный ящик (Ожидается в кассе) не трогает. */
  accountId?: string
  createdBy?: string
  createdByName?: string
  createdAt: string
}

// ─── Writeoffs ───────────────────────────────────────────────────────────────

// Возврат поставщику — не списание: списание наш убыток и бьёт по прибыли,
// возврат это сторно закупки (товар уехал назад, деньги/долг вернулись).
// Поэтому и причин меньше: «дегустация» вернуть поставщику нельзя.
export type ReturnReason = 'spoilage' | 'breakage' | 'expired' | 'other'

export const RETURN_REASON_LABELS: Record<ReturnReason, string> = {
  spoilage: 'Порча',
  breakage: 'Бой',
  expired: 'Просрочка',
  other: 'Другое',
}

// debt — уменьшить долг поставщику (накладная в долг);
// money — деньги вернулись на счёт (накладная оплачена).
export type RefundType = 'debt' | 'money'

export interface StockReturnLine {
  id: string
  receiptLineId: string
  ingredientId: string
  name: string
  qty: number
  unit: string
  pricePerUnit: number
}

export interface StockReturn {
  id: string
  receiptId: string
  supplierId: string
  supplierName: string
  date: string
  reason: ReturnReason
  note?: string
  totalAmount: number
  refundType: RefundType
  accountId?: string
  createdBy?: string
  // Сторно: товар вернулся на склад, деньги/долг откатились. Документ остаётся
  // в истории, но перестаёт считаться возвращённым.
  cancelledAt?: string
  cancelledBy?: string
  createdAt: string
  lines: StockReturnLine[]
}

export type WriteoffReason = 'spoilage' | 'breakage' | 'tasting' | 'expired' | 'other'

export const WRITEOFF_REASON_LABELS: Record<WriteoffReason, string> = {
  spoilage: 'Порча',
  breakage: 'Бой',
  tasting: 'Дегустация',
  expired: 'Просрочка',
  other: 'Прочее',
}

export interface WriteoffLine {
  ingredientId: string
  name: string
  qty: number
  unit: string
  cost: number
}

export interface StockWriteoff {
  id: string
  reason: WriteoffReason
  description?: string
  totalCost: number
  createdBy?: string
  createdByName?: string
  createdAt: string
  lines: WriteoffLine[]
}

// ─── CRM / Customers ────────────────────────────────────────────────────────

export interface Customer {
  id: string
  name: string
  phone?: string
  email?: string
  birthDate?: string
  notes?: string
  visitsCount: number
  totalSpent: number
  avgCheck: number
  lastVisitAt?: string
  createdAt: string
}

// ─── Time Tracking ──────────────────────────────────────────────────────────

export interface TimeEntry {
  id: string
  userId: string
  userName?: string
  clockIn: string
  clockOut?: string
  breakMinutes: number
  totalHours?: number
  status: 'active' | 'completed' | 'edited'
  note?: string
  createdAt: string
}

// ─── Constants & Labels ──────────────────────────────────────────────────────

export const ROLE_LABELS: Record<UserRole, string> = {
  superadmin: 'Супер-админ',
  owner: 'Владелец',
  manager: 'Управляющий',
  waiter: 'Официант',
  cashier: 'Кассир',
  cook: 'Повар',
  storekeeper: 'Кладовщик',
  accountant: 'Бухгалтер',
  other: 'Прочий',
}

export const STATUS_LABELS: Record<TableStatus, string> = {
  free: 'Свободен',
  occupied: 'Занят',
  reserved: 'Резерв',
  bill_requested: 'Счёт!',
}

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  new: 'Новый',
  cooking: 'Готовится',
  ready: 'К выдаче',
  served: 'Подано',
  bill_requested: 'Счёт!',
  done: 'Оплачен',
  cancelled: 'Отменён',
}

export const TEST_PASSWORD = '1234'

// ─── Granular Permissions ────────────────────────────────────────────────────

export const ALL_PERMISSIONS = [
  'orders.create', 'orders.close', 'orders.cancel', 'orders.void',
  'orders.refund',
  'orders.edit',
  'orders.reprint',
  'orders.view_others',
  'orders.create_stopped',
  'orders.service_charge',
  'kitchen.cooking',
  'tables.edit', 'tables.reserve',
  'shifts.manage', 'shifts.history', 'pos.access',
  'showcase.view',
  'inventory.view', 'inventory.manage',
  'suppliers.manage',
  'menu.view', 'menu.edit', 'menu.view_cost',
  'writeoffs.create',
  'batch_cooking.manage',
  'finance.view', 'finance.manage', 'payroll.manage',
  'analytics.view',
  'customers.manage',
  'printers.manage',
  'users.manage',
  'audit.view',
  'data.import',
] as const

export type PermissionKey = typeof ALL_PERMISSIONS[number]

export const PERMISSION_LABELS: Record<PermissionKey, string> = {
  'orders.create': 'Создание заказов',
  'orders.close': 'Закрытие / оплата заказов',
  'orders.cancel': 'Отмена заказов',
  'orders.void': 'Отмена позиций (void)',
  'orders.refund': 'Возврат закрытого заказа',
  'orders.edit': 'Редактирование заказа (переоткрытие закрытого)',
  'orders.reprint': 'Повторная печать чека (копия)',
  'orders.view_others': 'Просмотр и дозаказ к чужим заказам',
  'orders.create_stopped': 'Пробивать стоп-блюда (отметка в чеке)',
  'orders.service_charge': 'Обслуживание в профиле официанта (сумма сервиса)',
  'kitchen.cooking': 'Управление кухней',
  'tables.edit': 'Редактирование столов и зон',
  'tables.reserve': 'Бронирование столов',
  'shifts.manage': 'Управление сменами',
  'shifts.history': 'История смен (все дни)',
  'pos.access': 'Доступ к POS-терминалу',
  'inventory.view': 'Просмотр остатков',
  'inventory.manage': 'Управление складом / накладные',
  'menu.view': 'Просмотр меню',
  'menu.edit': 'Редактирование меню / техкарт',
  'menu.view_cost': 'Просмотр себестоимости',
  'writeoffs.create': 'Создание списаний',
  'batch_cooking.manage': 'Приготовление (заготовки)',
  'finance.view': 'Просмотр финансовых отчётов',
  'finance.manage': 'Финансовые операции',
  'payroll.manage': 'Управление зарплатами',
  'analytics.view': 'Просмотр аналитики',
  'showcase.view': 'Витрина (для гостей)',
  'suppliers.manage': 'Управление поставщиками',
  'customers.manage': 'Клиентская база (CRM)',
  'printers.manage': 'Настройка принтеров',
  'users.manage': 'Управление пользователями и правами',
  'audit.view': 'Просмотр истории изменений',
  'data.import': 'Импорт данных',
}

export const PERMISSION_GROUPS: { label: string; keys: PermissionKey[] }[] = [
  { label: 'Операции', keys: ['orders.create', 'orders.close', 'orders.cancel', 'orders.void', 'orders.refund', 'orders.edit', 'orders.reprint', 'orders.view_others', 'orders.create_stopped', 'orders.service_charge', 'kitchen.cooking', 'batch_cooking.manage', 'tables.edit', 'tables.reserve', 'shifts.manage', 'shifts.history', 'pos.access', 'showcase.view'] },
  { label: 'Склад', keys: ['inventory.view', 'inventory.manage', 'suppliers.manage', 'menu.view', 'menu.edit', 'menu.view_cost', 'writeoffs.create'] },
  { label: 'Финансы', keys: ['finance.view', 'finance.manage', 'payroll.manage'] },
  { label: 'Аналитика и клиенты', keys: ['analytics.view', 'customers.manage'] },
  { label: 'Администрирование', keys: ['printers.manage', 'users.manage', 'audit.view', 'data.import'] },
]

// Nav routes that each permission grants access to
const PERMISSION_NAV_MAP: Record<string, string[]> = {
  'orders.create': ['/operations/table-map', '/operations/orders', '/waiter'],
  'orders.close': ['/operations/orders'],
  'kitchen.cooking': ['/operations/kitchen'],
  'tables.edit': ['/operations/table-map'],
  'tables.reserve': ['/operations/table-map'],
  'shifts.manage': ['/operations/shifts', '/settings/backup'],
  'shifts.history': ['/operations/shifts'],
  'pos.access': ['/operations/pos', '/cashier', '/show-qr'],
  'inventory.view': ['/warehouse/inventory'],
  'inventory.manage': ['/warehouse/inventory', '/warehouse/receipts', '/warehouse/inventory-check', '/warehouse/history', '/warehouse/supply-expenses'],
  'menu.view': ['/warehouse/menu', '/operations/pos'],
  'menu.edit': ['/warehouse/menu', '/warehouse/semi'],
  'writeoffs.create': ['/warehouse/writeoffs'],
  'batch_cooking.manage': ['/operations/batch-cooking'],
  'finance.view': ['/finance/cashflow', '/finance/pnl', '/finance/balance', '/finance/payments'],
  'finance.manage': ['/finance/cashflow', '/finance/accounts', '/finance/budget', '/finance/payments'],
  'payroll.manage': ['/finance/payroll'],
  'analytics.view': ['/analytics/abc-menu', '/analytics/abc-inventory', '/analytics/tables', '/analytics/waiters', '/analytics/peak-hours', '/analytics/food-cost', '/analytics/forecast'],
  'showcase.view': ['/operations/showcase'],
  'suppliers.manage': ['/warehouse/suppliers'],
  'customers.manage': ['/settings/customers'],
  'printers.manage': ['/settings/printers'],
  'users.manage': ['/settings/users'],
  'audit.view': ['/settings/audit'],
  'data.import': ['/settings/import', '/settings/backup'],
}

// Default permissions per role
export const ROLE_DEFAULT_PERMISSIONS: Record<UserRole, UserPermissions> = {
  superadmin: { nav: ['/admin', '/admin/restaurants', '/admin/users'], actions: {} },
  owner: { nav: ['*'], actions: Object.fromEntries(ALL_PERMISSIONS.map(p => [p, true])) },
  manager: { nav: ['*'], actions: Object.fromEntries(ALL_PERMISSIONS.map(p => [p, true])) },
  waiter: {
    nav: [],
    actions: {
      'orders.create': true,
      'tables.reserve': true,
      'menu.view': true,
      'showcase.view': true,
      'orders.service_charge': true,
    },
  },
  cashier: {
    nav: [],
    actions: {
      'orders.create': true, 'orders.close': true, 'orders.void': true,
      // orders.refund / orders.edit — выключены по умолчанию; выдаются в матрице
      // доступов вручную (возврат и переоткрытие закрытого — чувствительные).
      'orders.reprint': true,
      'orders.view_others': true,
      'orders.service_charge': true,
      'tables.reserve': true, 'shifts.manage': true, 'pos.access': true,
      'showcase.view': true,
      'customers.manage': true,
      'printers.manage': true,
    },
  },
  cook: {
    nav: [],
    actions: {
      'kitchen.cooking': true, 'menu.view': true, 'batch_cooking.manage': true,
    },
  },
  storekeeper: {
    nav: [],
    actions: {
      'inventory.view': true, 'inventory.manage': true,
      'suppliers.manage': true,
      'menu.view': true, 'menu.view_cost': true,
      'writeoffs.create': true,
    },
  },
  accountant: {
    nav: [],
    actions: {
      'finance.view': true, 'finance.manage': true,
      'menu.view_cost': true, 'analytics.view': true,
      'audit.view': true,
    },
  },
  other: {
    nav: [],
    actions: {},
  },
}

// Build nav array from actions
export function buildNavFromPermissions(permissions: UserPermissions): string[] {
  if (permissions.nav.includes('*')) return ['*']
  const navSet = new Set<string>(permissions.nav)
  for (const [perm, routes] of Object.entries(PERMISSION_NAV_MAP)) {
    if (permissions.actions[perm]) {
      routes.forEach(r => navSet.add(r))
    }
  }
  // Always add settings for owner/manager (handled by canDo check on page)
  return Array.from(navSet)
}
