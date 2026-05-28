import { dAdd, dDiv, dMul, dRound } from './decimal'
import type { Order, OrderItem, OrderVoid } from './types'

/** Активные позиции для отображения в чеке (тело гостевого/пре-чека).
 *
 *  Исключаем:
 *  1) Явно отменённые позиции — `cancelledAt` стоит на самом order_items
 *     (через `cancelOrderItem` / `cancelOrderItemPartial`).
 *  2) Списанные через voids — `createVoid` пишет запись в `order_voids` и
 *     уменьшает `orders.total`, но `cancelledAt` на order_items НЕ ставит.
 *     Без этого фильтра позиция остаётся в теле чека, но из подытога её нет —
 *     и чек выглядит «несоответствующе» (Кийма ×4 печатается, но 96 TJS не в сумме).
 *
 *  voids ссылаются на (name, price), без id позиции — значит при нескольких
 *  одинаковых строках сопоставляем по сумме qty: если суммарно списано ≥ qty
 *  позиции — она считается списанной полностью. Остаток qty уходит в бакет
 *  для следующих одноимённых позиций (это редкий кейс). */
/** Параллельно `visibleReceiptItems` строит маску по индексам исходного
 *  массива: `true` означает, что позиция полностью списана (cancelledAt или
 *  суммарный void.qty ≥ item.qty). Используется в UI для пометки позиции как
 *  «Отменено» при повторном открытии диалога — раньше эта индикация жила
 *  только в локальном Set текущей сессии и терялась после reopen. */
export function voidedItemFlags(items: OrderItem[], voids?: OrderVoid[] | null): boolean[] {
  if (!voids || voids.length === 0) return items.map(i => !!i.cancelledAt)
  const voidedQty = new Map<string, number>()
  for (const v of voids) {
    const key = `${v.itemName}|${v.itemPrice}`
    voidedQty.set(key, (voidedQty.get(key) ?? 0) + (v.itemQty ?? 0))
  }
  return items.map(i => {
    if (i.cancelledAt) return true
    const key = `${i.name}|${i.price}`
    const voided = voidedQty.get(key) ?? 0
    if (voided <= 0) return false
    const qty = i.qty ?? 0
    if (voided >= qty) {
      voidedQty.set(key, voided - qty)
      return true
    }
    voidedQty.set(key, 0)
    return false
  })
}

export function visibleReceiptItems(items: OrderItem[], voids?: OrderVoid[] | null): OrderItem[] {
  if (!voids || voids.length === 0) return items.filter(i => !i.cancelledAt)
  const voidedQty = new Map<string, number>()
  for (const v of voids) {
    const key = `${v.itemName}|${v.itemPrice}`
    voidedQty.set(key, (voidedQty.get(key) ?? 0) + (v.itemQty ?? 0))
  }
  return items.filter(i => {
    if (i.cancelledAt) return false
    const key = `${i.name}|${i.price}`
    const voided = voidedQty.get(key) ?? 0
    if (voided <= 0) return true
    const qty = i.qty ?? 0
    if (voided >= qty) {
      voidedQty.set(key, voided - qty)
      return false
    }
    voidedQty.set(key, 0)
    return true
  })
}

/** Начало текущих локальных суток (00:00:00 по таймзоне устройства). Используется операционными
 * страницами как нижняя граница окна `fetchOrders` — кассир и день-в-день флоу видят только сегодня. */
export function startOfToday(): Date {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d
}

/** Начало локальных суток для произвольной даты. */
export function startOfDay(d: Date): Date {
  const c = new Date(d)
  c.setHours(0, 0, 0, 0)
  return c
}

/** Конец локальных суток (23:59:59.999). */
export function endOfDay(d: Date): Date {
  const c = new Date(d)
  c.setHours(23, 59, 59, 999)
  return c
}

/**
 * Format number for display: trims floating-point artifacts (e.g. 77.83279999999999 → 77.83),
 * no trailing zeros, max 3 decimals.
 * Examples: 2213 → "2213", 47.0001 → "47", 77.8328 → "77.833", 0.0001 → "0.0001"
 */
export function formatNum(n: number | null | undefined, maxDecimals: number = 3): string {
  const v = Number(n) || 0
  if (v === 0) return '0'
  // Round to avoid floating-point artifacts
  const rounded = Math.round(v * Math.pow(10, maxDecimals)) / Math.pow(10, maxDecimals)
  // Strip trailing zeros
  return rounded.toString()
}

export function formatCurrency(amount: number | null | undefined): string {
  const safe = Number(amount) || 0
  return new Intl.NumberFormat('ru-RU', {
    style: 'decimal',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    useGrouping: true,
  }).format(safe) + ' TJS'
}

/** Compact currency: drops «,00» when the amount is a whole number.
 *  «40,00 TJS» → «40 TJS», but «40,50 TJS» stays «40,50 TJS». Используется
 *  для плотных мест UI (карточки меню в POS, чипы), где trailing-zeros —
 *  визуальный шум. Финальные суммы (К оплате, отчёты, чек) остаются на
 *  formatCurrency для точности и единообразия. */
export function formatCurrencyCompact(amount: number | null | undefined): string {
  const safe = Number(amount) || 0
  const isWhole = Number.isInteger(safe)
  return new Intl.NumberFormat('ru-RU', {
    style: 'decimal',
    minimumFractionDigits: isWhole ? 0 : 2,
    maximumFractionDigits: 2,
    useGrouping: true,
  }).format(safe) + ' TJS'
}

// Format order item quantity with unit label
// piece: "×2" or "×1"
// g: "250г"
// kg: "1.5кг"
export function formatQty(qty: number, unit?: 'piece' | 'g' | 'kg'): string {
  if (unit === 'g') return `${Math.round(qty)}г`
  if (unit === 'kg') return `${qty.toFixed(qty < 10 ? 2 : 1).replace(/\.?0+$/, '')}кг`
  return `×${qty}`
}

// Calculate line total: for weighted items it's price * (qty / unitSize)
// For piece items it's just price * qty
// Uses decimal.js to avoid floating point issues
export function calcLineTotal(price: number, qty: number, unit?: 'piece' | 'g' | 'kg', unitSize?: number): number {
  if (unit === 'piece' || !unit) return dMul(price, qty)
  const size = unitSize && unitSize > 0 ? unitSize : 1
  return dMul(price, dDiv(qty, size))
}

// Same formula as calcLineTotal but for COGS (cost per unit × effective portions).
// Separate name so intent is obvious at call sites — both price and cogs are stored
// "per unitSize" for weight items, so they scale identically.
export function calcLineCogs(cogs: number, qty: number, unit?: 'piece' | 'g' | 'kg', unitSize?: number): number {
  return calcLineTotal(cogs, qty, unit, unitSize)
}

const isHallOrderType = (t?: string | null) => t !== 'delivery' && t !== 'takeaway'

// Сумма заказа для отображения в списках: с обслуживанием для зала.
// Для оплаченных заказов берём зафиксированный totalWithService (учитывает скидки/чай).
export function calcOrderDisplayTotal(order: Order, restaurantServicePercent?: number): number {
  // totalWithService — это «зафиксированный итог» оплаченного заказа (со скидкой/чаем).
  // Для незакрытых заказов парсер DB подставляет туда обычный total как fallback,
  // поэтому полагаться на это поле можно только когда заказ реально done.
  if (order.status === 'done' && typeof order.totalWithService === 'number' && order.totalWithService > 0) {
    return order.totalWithService
  }
  if (!isHallOrderType(order.type)) return order.total
  // У старых заказов service_percent может быть 0 в БД (Number(null)||0), а
  // у новых — реальный процент, зафиксированный при создании. Если у заказа
  // 0 — берём актуальный процент ресторана (legacy fallback).
  const pct = (order.servicePercent && order.servicePercent > 0)
    ? order.servicePercent
    : (restaurantServicePercent ?? 0)
  if (!pct) return order.total
  const service = dRound(dDiv(dMul(order.total, pct), 100))
  return dAdd(order.total, service)
}

// Price label for menu (per unit)
// piece: "15 TJS"
// g + unitSize=100: "15 TJS / 100г"
// kg: "150 TJS / кг"
//
// Uses formatCurrencyCompact so whole-number prices (40 TJS) don't render
// as "40,00 TJS" — менюшный шум при плотной сетке. Drobbed for both POS
// desktop and waiter app for visual consistency. Receipts / totals stay
// on formatCurrency.
export function formatPriceLabel(price: number, unit?: 'piece' | 'g' | 'kg', unitSize?: number): string {
  const base = formatCurrencyCompact(price)
  if (unit === 'g') return `${base} / ${unitSize ?? 100}г`
  if (unit === 'kg') return `${base} / кг`
  return base
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })
}

export function getTimeSince(iso: string | null | undefined, endIso?: string | null): string {
  if (!iso) return '0 мин'
  const start = new Date(iso).getTime()
  if (isNaN(start)) return '0 мин'
  const end = endIso ? new Date(endIso).getTime() : Date.now()
  const diff = end - start
  const mins = Math.max(0, Math.floor(diff / 60000))
  if (mins < 60) return `${mins} мин`
  const hours = Math.floor(mins / 60)
  // ≥24ч переключаемся на «дни + часы», иначе вырастает «107ч 28мин».
  if (hours >= 24) {
    const days = Math.floor(hours / 24)
    const remHours = hours % 24
    return remHours > 0 ? `${days}д ${remHours}ч` : `${days}д`
  }
  const rem = mins % 60
  return `${hours}ч ${rem}мин`
}
