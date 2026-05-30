// Shared snake_case → camelCase mappers and pure helpers. Each domain file
// imports the mappers it needs from here rather than redefining them inline.
import { dRound } from '../decimal'
import type {
  User, Order, OrderItem, Restaurant,
  OrderStatus, OrderType, CashShift, CashShiftStatus,
  ModifierGroup,
  OrderSplit, SplitStatus,
  Reservation, ReservationStatus,
  OrderVoid,
  Customer,
  TimeEntry,
} from '../types'

// ─── Constants ────────────────────────────────────────────────────────────

export const ROLE_DISPLAY_FULL: Record<string, string> = {
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

// Active order statuses — raw backend values. Backend Create() emits 'open'
// (we map it to FE-side 'new' in _mapBackendOrderStatus, but fetchTables
// filters RAW status before mapping, so 'open' must be listed here too).
export const ACTIVE_ORDER_STATUSES = ['open', 'new', 'cooking', 'ready', 'served', 'bill_requested']

// Backend stores Go-side statuses 'open'/'closed' for newly-created and
// fully-paid orders. The FE OrderStatus enum doesn't know those — without
// the mapping `STATUS_STYLE[order.status]` would be undefined and crash on
// `.bg` access (e.g. in OrderActionsDialog). Map them to the closest FE
// equivalent so the UI is consistent.
export function _mapBackendOrderStatus(s: unknown): OrderStatus {
  if (s === 'open') return 'new'
  if (s === 'closed') return 'done'
  if (s === 'new' || s === 'cooking' || s === 'ready' || s === 'served'
    || s === 'bill_requested' || s === 'done' || s === 'cancelled') {
    return s
  }
  return 'new'
}

// Slim-выборка для страниц списка orders.
export const ORDERS_SLIM_SELECT =
  'id,order_number,status,type,' +
  'table_id,waiter_id,' +
  'total,service_amount,total_with_service,' +
  'guests_count,' +
  'payment_method,tab_label,' +
  'ready_at,closed_at,created_at,' +
  'order_items(id,cancelled_at,name,qty,price,unit,unit_size,cogs,menu_item_id)'

export const SHIFT_SELECT = '*, opener:users!cash_shifts_opened_by_fkey(name), closer:users!cash_shifts_closed_by_fkey(name)'

// ─── Generic helpers ──────────────────────────────────────────────────────

export function mapRow<T>(row: Record<string, unknown>, mapping: Record<string, string>): T {
  const result: Record<string, unknown> = {}
  for (const [dbKey, jsKey] of Object.entries(mapping)) {
    result[jsKey] = row[dbKey]
  }
  for (const [k, v] of Object.entries(row)) {
    if (!mapping[k]) result[k] = v
  }
  return result as T
}

export function generateLicenseKey(slug: string): string {
  const prefix = slug.slice(0, 3).toUpperCase()
  const year = new Date().getFullYear()
  const random = Math.random().toString(36).slice(2, 8).toUpperCase()
  return `${prefix}-${year}-${random}`
}

// No-op in v4 (server caskades). Kept for callers that haven't been migrated.
export async function freeTableIfNoOtherOpenOrders(tableId: string, justClosedOrderId: string): Promise<void> {
  void tableId; void justClosedOrderId
}

// ─── Unit conversions ─────────────────────────────────────────────────────

export function convertToRecipeUnit(stockQty: number, stockUnit: string, recipeUnit: string): number {
  const s = stockUnit.toLowerCase().trim()
  const r = recipeUnit.toLowerCase().trim()
  if (s === r) return stockQty
  if ((s === 'кг' || s === 'kg') && (r === 'г' || r === 'g' || r === 'гр')) return stockQty * 1000
  if ((s === 'г' || s === 'g' || s === 'гр') && (r === 'кг' || r === 'kg')) return stockQty / 1000
  if ((s === 'л' || s === 'l') && (r === 'мл' || r === 'ml')) return stockQty * 1000
  if ((s === 'мл' || s === 'ml') && (r === 'л' || r === 'l')) return stockQty / 1000
  return stockQty
}

export function convertDeductToStockUnit(deductQty: number, stockUnit: string, recipeUnit: string): number {
  const s = stockUnit.toLowerCase().trim()
  const r = recipeUnit.toLowerCase().trim()
  if (s === r) return deductQty
  if ((s === 'кг' || s === 'kg') && (r === 'г' || r === 'g' || r === 'гр')) return deductQty / 1000
  if ((s === 'г' || s === 'g' || s === 'гр') && (r === 'кг' || r === 'kg')) return deductQty * 1000
  if ((s === 'л' || s === 'l') && (r === 'мл' || r === 'ml')) return deductQty / 1000
  if ((s === 'мл' || s === 'ml') && (r === 'л' || r === 'l')) return deductQty * 1000
  return deductQty
}

export function calcCogsFromTechCard(
  techLines: Record<string, unknown>[],
  ingredientPrices: Map<string, { price: number; unit: string; wastePercent: number }>,
): number {
  let cogs = 0
  for (const line of techLines) {
    const ingId = line.ingredient_id as string | null
    if (!ingId) continue
    const ing = ingredientPrices.get(ingId)
    if (!ing) continue
    const recipeQty = Number(line.qty) || 0
    const recipeUnit = (line.unit as string) || ''
    const wasteMultiplier = ing.wastePercent > 0 ? 1 / (1 - ing.wastePercent / 100) : 1
    const adjustedQty = recipeQty * wasteMultiplier
    const qtyInStockUnit = convertDeductToStockUnit(adjustedQty, ing.unit, recipeUnit)
    cogs += qtyInStockUnit * ing.price
  }
  return dRound(cogs)
}

// ─── Restaurant ───────────────────────────────────────────────────────────

export function mapRestaurantRow(r: Record<string, any>): Restaurant {
  return {
    id: r.id,
    name: r.name,
    slug: r.slug,
    logoUrl: r.logo_url,
    address: r.address,
    phone: r.phone,
    currency: r.currency || 'TJS',
    servicePercent: r.service_percent != null ? Number(r.service_percent) : 10,
    timezone: r.timezone || 'Asia/Dushanbe',
    enforceStockCheck: r.enforce_stock_check ?? false,
    techCardsEnabled: r.tech_cards_enabled ?? true,
    autoReadyMode: r.auto_ready_mode ?? false,
    autoReadyBufferMin: r.auto_ready_buffer_min ?? 5,
    pinLockEnabled: r.pin_lock_enabled ?? false,
    pinLockTimeoutMin: r.pin_lock_timeout_min ?? 5,
    supplyAllowNegative: r.supply_allow_negative ?? true,
    localServerIp: r.local_server_ip ?? undefined,
    licenseKey: r.license_key ?? undefined,
    licenseExpiresAt: r.license_expires_at ?? undefined,
    isBlocked: r.is_blocked ?? false,
    blockReason: r.block_reason ?? undefined,
    lastSeenAt: r.last_seen_at ?? undefined,
    appVersion: r.app_version ?? undefined,
    createdAt: r.created_at,
  }
}

// ─── User ─────────────────────────────────────────────────────────────────

export function mapUserRow(r: Record<string, any>): User {
  return {
    id: r.id,
    username: r.username ?? '',
    name: r.name ?? '',
    role: r.role,
    roleDisplay: ROLE_DISPLAY_FULL[r.role as string] ?? r.role,
    restaurantId: r.restaurant_id || '',
    salary: r.salary != null ? Number(r.salary) || 0 : 0,
    advance: r.advance != null ? Number(r.advance) || 0 : 0,
    deductions: r.deductions != null ? Number(r.deductions) || 0 : 0,
    position: r.position || undefined,
    birthDate: r.birth_date || undefined,
    station: r.station || undefined,
    shiftNumber: r.shift_number ? Number(r.shift_number) : undefined,
    pin: r.pin || undefined,
    password: r.password || undefined,
    permissions: r.permissions && typeof r.permissions === 'object' ? r.permissions as import('../types').UserPermissions : undefined,
  } as User
}

// ─── Orders ───────────────────────────────────────────────────────────────

export function _mapV4OrderItem(i: Record<string, any>): OrderItem {
  return {
    id: i.id,
    menuItemId: i.menu_item_id,
    name: i.name ?? '',
    qty: Number(i.qty) || 0,
    price: Number(i.price) || 0,
    cogs: Number(i.cogs) || 0,
    unit: (i.unit as 'piece' | 'g' | 'kg') || 'piece',
    unitSize: Number(i.unit_size) || 1,
    cancelledAt: i.cancelled_at ?? undefined,
    cancelledBy: i.cancelled_by ?? undefined,
    cancelReason: i.cancel_reason ?? undefined,
    printedAt: (i.printed_at as string | null) ?? null,
    cancelPrintedAt: (i.cancel_printed_at as string | null) ?? null,
    servedAt: i.served_at ?? undefined,
    servedBy: i.served_by ?? undefined,
    note: (i.note as string | null | undefined) ?? null,
    kitchenStatus: i.kitchen_status ?? null,
    modifiers: Array.isArray(i.modifiers)
      ? i.modifiers.map((m: any) => ({
          modifierId: m.modifier_id ?? m.id ?? undefined,
          name: m.name ?? '',
          price: Number(m.price ?? 0) || 0,
        }))
      : undefined,
  }
}

export function _mapV4Order(r: Record<string, any>, items?: Record<string, any>[]): Order {
  const mappedItems = (items ?? []).map(_mapV4OrderItem)
  let payments: import('../types').OrderPayment[] = []
  if (Array.isArray(r.payments)) payments = r.payments
  else if (typeof r.payments === 'string' && r.payments.length > 0) {
    try { const p = JSON.parse(r.payments); if (Array.isArray(p)) payments = p } catch {}
  }
  return {
    id: r.id,
    orderNumber: r.order_number != null ? Number(r.order_number) : undefined,
    status: _mapBackendOrderStatus(r.status),
    type: r.type as OrderType,
    tableId: r.table_id ?? undefined,
    waiterId: r.waiter_id ?? undefined,
    cashierId: r.cashier_id ?? undefined,
    paymentMethod: r.payment_method ?? undefined,
    comment: r.comment ?? undefined,
    total: Number(r.total ?? 0),
    servicePercent: Number(r.service_percent ?? 0) || 0,
    serviceAmount: Number(r.service_amount ?? 0) || 0,
    totalWithService: r.total_with_service != null ? Number(r.total_with_service) : undefined,
    createdAt: r.created_at,
    readyAt: r.ready_at ?? undefined,
    expectedReadyAt: r.expected_ready_at ?? undefined,
    closedAt: r.closed_at ?? undefined,
    shiftId: r.shift_id ?? undefined,
    isSplit: r.is_split ?? false,
    splitCount: r.split_count ?? 0,
    guestsCount: Number(r.guests_count ?? 1) || 1,
    tipAmount: Number(r.tip_amount ?? 0) || 0,
    payments,
    discountType: r.discount_type ?? undefined,
    discountValue: Number(r.discount_value ?? 0) || 0,
    discountAmount: Number(r.discount_amount ?? 0) || 0,
    discountReason: r.discount_reason ?? undefined,
    cancelledAt: r.cancelled_at ?? undefined,
    cancelledBy: r.cancelled_by ?? undefined,
    cancelReason: r.cancel_reason ?? undefined,
    cancelledTotal: r.cancelled_total != null ? Number(r.cancelled_total) : undefined,
    tabLabel: r.tab_label ?? undefined,
    items: mappedItems,
  }
}

// ─── Reservation ──────────────────────────────────────────────────────────

export function _mapV4Reservation(r: any): Reservation {
  return {
    id: r.id,
    tableId: r.table_id ?? '',
    guestName: r.guest_name ?? '',
    guestPhone: r.guest_phone ?? undefined,
    guestsCount: Number(r.guests_count ?? 0),
    reservedAt: r.reserved_at,
    durationMin: Number(r.duration_min ?? 120),
    note: r.note ?? undefined,
    createdBy: r.created_by ?? undefined,
    createdByName: undefined,
    status: (r.status as ReservationStatus) ?? 'active',
    createdAt: r.created_at,
  }
}

// ─── Split ────────────────────────────────────────────────────────────────

export function _mapV4Split(r: Record<string, any>): OrderSplit {
  let items: { name: string; qty: number; price: number }[] | undefined
  if (Array.isArray(r.items)) {
    items = r.items.map((it: any) => ({
      name: String(it.name ?? ''),
      qty: Number(it.qty ?? 0),
      price: Number(it.price ?? 0),
    }))
  } else if (typeof r.items === 'string' && r.items.length > 0) {
    try {
      const p = JSON.parse(r.items)
      if (Array.isArray(p)) items = p.map((it: any) => ({
        name: String(it.name ?? ''), qty: Number(it.qty ?? 0), price: Number(it.price ?? 0),
      }))
    } catch {}
  }
  return {
    id: r.id,
    orderId: r.order_id,
    splitNumber: Number(r.split_number ?? 0),
    splitType: (r.split_type as 'equal' | 'by_items') ?? 'equal',
    items,
    subtotal: Number(r.subtotal ?? 0),
    servicePercent: Number(r.service_percent ?? 0),
    serviceAmount: Number(r.service_amount ?? 0),
    total: Number(r.total ?? 0),
    paymentMethod: r.payment_method ?? undefined,
    accountId: r.account_id ?? undefined,
    accountName: r.account_name ?? undefined,
    paidAt: r.paid_at ?? undefined,
    paidBy: r.paid_by ?? undefined,
    status: (r.status as SplitStatus) ?? 'pending',
  }
}

// ─── Modifiers ────────────────────────────────────────────────────────────

export function _mapV4ModifierGroup(g: any, mods: any[]): ModifierGroup {
  return {
    id: g.id,
    name: g.name,
    menuItemId: g.menu_item_id ?? null,
    isRequired: !!g.is_required,
    maxSelect: Number(g.max_select ?? 0),
    modifiers: mods
      .slice()
      .sort((a, b) => Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0))
      .map(m => ({
        id: m.id as string,
        groupId: m.group_id as string,
        name: m.name as string,
        price: Number(m.price ?? 0),
        isDefault: !!m.is_default,
      })),
  }
}

// ─── Cash shifts ──────────────────────────────────────────────────────────

export function mapShift(r: Record<string, unknown>): CashShift {
  return {
    id: r.id as string,
    restaurantId: r.restaurant_id as string,
    accountId: (r.account_id as string | null) ?? undefined,
    accountName: undefined,
    openedBy: r.opened_by as string,
    openedByName: (r.opener as Record<string, unknown>)?.name as string | undefined,
    closedBy: r.closed_by as string | undefined,
    closedByName: (r.closer as Record<string, unknown>)?.name as string | undefined,
    openedAt: r.opened_at as string,
    closedAt: r.closed_at as string | undefined,
    openingBalance: Number(r.opening_balance),
    closingBalance: r.closing_balance != null ? Number(r.closing_balance) : undefined,
    expectedCash: r.expected_cash != null ? Number(r.expected_cash) : undefined,
    cashRevenue: Number(r.cash_revenue),
    cardRevenue: Number(r.card_revenue),
    ordersCount: Number(r.orders_count),
    avgCheck: Number(r.avg_check),
    status: r.status as CashShiftStatus,
  }
}

export function _mapV4Shift(r: Record<string, any>): CashShift {
  return {
    id: r.id,
    restaurantId: r.restaurant_id ?? '',
    accountId: r.account_id ?? undefined,
    accountName: r.account_name ?? undefined,
    openedBy: r.opened_by ?? '',
    openedByName: undefined,
    closedBy: r.closed_by ?? undefined,
    closedByName: undefined,
    openedAt: r.opened_at,
    closedAt: r.closed_at ?? undefined,
    openingBalance: Number(r.opening_balance ?? 0),
    closingBalance: r.closing_balance != null ? Number(r.closing_balance) : undefined,
    expectedCash: r.expected_cash != null ? Number(r.expected_cash) : undefined,
    cashRevenue: Number(r.cash_revenue ?? 0),
    cardRevenue: Number(r.card_revenue ?? 0),
    ordersCount: Number(r.orders_count ?? 0),
    avgCheck: Number(r.avg_check ?? 0),
    status: (r.status as CashShiftStatus) ?? 'open',
  }
}

// ─── Order voids ──────────────────────────────────────────────────────────

export function _mapV4Void(r: Record<string, any>): OrderVoid {
  return {
    id: r.id,
    orderId: r.order_id,
    itemName: r.item_name ?? '',
    itemQty: Number(r.item_qty ?? 0),
    itemPrice: Number(r.item_price ?? 0),
    reason: r.reason ?? '',
    approvedByName: r.approved_by_name ?? undefined,
    createdByName: r.created_by_name ?? undefined,
    createdAt: r.created_at,
  }
}

// ─── Time entries ─────────────────────────────────────────────────────────

export function mapTimeEntry(r: Record<string, unknown>): TimeEntry {
  return {
    id: r.id as string,
    userId: r.user_id as string,
    userName: (r.users as Record<string, unknown>)?.name as string ?? (r.user_name as string) ?? undefined,
    clockIn: r.clock_in as string,
    clockOut: (r.clock_out as string) ?? undefined,
    breakMinutes: Number(r.break_minutes) || 0,
    totalHours: r.total_hours != null ? Number(r.total_hours) : undefined,
    status: r.status as TimeEntry['status'],
    note: (r.note as string) ?? undefined,
    createdAt: r.created_at as string,
  }
}

// ─── Customer ─────────────────────────────────────────────────────────────

export function mapCustomer(r: Record<string, unknown>): Customer {
  return {
    id: r.id as string,
    name: r.name as string,
    phone: (r.phone as string) ?? undefined,
    email: (r.email as string) ?? undefined,
    birthDate: (r.birth_date as string) ?? undefined,
    notes: (r.notes as string) ?? undefined,
    visitsCount: Number(r.visits_count) || 0,
    totalSpent: Number(r.total_spent) || 0,
    avgCheck: Number(r.avg_check) || 0,
    lastVisitAt: (r.last_visit_at as string) ?? undefined,
    createdAt: r.created_at as string,
  }
}
