// Единый источник сборки `ReceiptPrintData` для пред-чека и финального чека.
// Раньше OrderActionsDialog/TableDetailSheet/waiter-страница руками копировали
// этот код, и расхождения (zoneName/guestsCount забывались в одном из мест,
// subtotal считался от ord.total в другом) приводили к «двум видам» чека.
//
// Инвариант полей по типу заказа:
//   - hall:     tableName/zoneName/guestsCount всегда заполнены (zone fallback 'Зал').
//   - delivery: tableName/zoneName/guestsCount = undefined.
//   - takeaway: tableName/zoneName/guestsCount = undefined.

import { dAdd, dDiv, dMul, dRound, dSub, dSum } from './decimal'
import { calcLineTotal, visibleReceiptItems } from './helpers'
import type { Order, OrderVoid, PaymentMethod, Restaurant, Table, User, Zone } from './types'

// Структура данных чека. Используется только для HTML-превью в UI-drawer'ах
// (см. components/print-receipt.tsx). Реальная ESC/POS-печать собирается на
// бэке — фронт лишь зовёт POST /orders/{id}/close (создаёт чек-job) или
// POST /orders/{id}/print-pre-bill (создаёт пре-чек-job), worker печатает.
//
// Раньше этот же тип был payload'ом для client-side ESC/POS-сборщика
// (lib/print-service.ts) — после удаления Path A type живёт здесь.
export interface ReceiptPrintData {
  orderId: string
  orderNumber?: number | string
  orderType: 'hall' | 'delivery' | 'takeaway'
  restaurantName?: string
  restaurantAddress?: string
  tableName?: string
  zoneName?: string
  deliveryPhone?: string
  deliveryAddress?: string
  waiterName?: string
  cashierName?: string
  items: { name: string; qty: number; price: number; unit?: 'piece' | 'g' | 'kg'; unitSize?: number; modifiers?: { name: string; price: number }[]; portions?: number }[]
  subtotal: number
  discountAmount?: number
  discountReason?: string
  servicePercent: number
  serviceAmount: number
  tipAmount?: number
  guestsCount?: number
  total: number
  paymentMethod?: PaymentMethod
  accountName?: string
  /** Смешанная оплата: разбивка по платежам. Если задано — на чеке печатается
   *  список платежей вместо одной строки «Оплата». */
  payments?: { method: PaymentMethod; amount: number; accountName?: string }[]
  createdAt: string
  closedAt: string
  isPreCheck?: boolean
}

const isHallType = (t?: string | null) => t !== 'delivery' && t !== 'takeaway'

export interface BuildReceiptCtx {
  tables?: Table[]
  users?: User[]
  zones?: Zone[]
  restaurant?: Restaurant | null
  currentUser?: { name?: string } | null
  /** Voids активного заказа — позиции из них не попадут в тело чека. */
  voids?: OrderVoid[] | null
}

export interface BuildReceiptOpts {
  isPreCheck: boolean
  /** Включать ли строку обслуживания. Для hall обычно true, для takeaway/delivery — false. */
  includeService?: boolean
  /** Процент обслуживания (только если includeService=true). */
  servicePercent?: number
  discountAmount?: number
  discountReason?: string
  tipAmount?: number
  /** Только для финального чека (isPreCheck=false). */
  paymentMethod?: PaymentMethod
  accountName?: string
  /** Смешанная оплата — разбивка по платежам (нал/безнал + счёт). */
  payments?: { method: PaymentMethod; amount: number; accountName?: string }[]
}

function modSignature(mods?: { name: string; price: number }[]): string {
  if (!mods || mods.length === 0) return ''
  return mods.map(m => `${m.name}:${m.price}`).sort().join('|')
}

/** Группирует одинаковые весовые порции (g/kg) в одну с portions=N.
 *  Штучные не трогаются. Порядок сохраняется. */
function groupWeightPortions<T extends {
  name: string; qty: number; price: number
  unit?: 'piece' | 'g' | 'kg'; unitSize?: number
  modifiers?: { name: string; price: number }[]
}>(items: T[]): (T & { portions: number })[] {
  const out: (T & { portions: number })[] = []
  const idx = new Map<string, number>()
  for (const it of items) {
    if (it.unit === 'g' || it.unit === 'kg') {
      const key = `${it.name}|${it.price}|${it.unit}|${it.unitSize}|${it.qty}|${modSignature(it.modifiers)}`
      const at = idx.get(key)
      if (at !== undefined) { out[at].portions += 1; continue }
      idx.set(key, out.length)
    }
    out.push({ ...it, portions: 1 })
  }
  return out
}

export function buildReceiptData(
  order: Order,
  ctx: BuildReceiptCtx,
  opts: BuildReceiptOpts,
): ReceiptPrintData {
  const items = visibleReceiptItems(order.items, ctx.voids)
  const subtotal = dRound(dSum(items.map(i => calcLineTotal(i.price, i.qty, i.unit, i.unitSize))))
  // Группируем одинаковые весовые порции для отображения: «Блюдо 100г × 3»
  // одной строкой. Subtotal считается выше из исходных строк — не меняется.
  const displayItems = groupWeightPortions(items)

  const discountAmount = opts.discountAmount && opts.discountAmount > 0 ? opts.discountAmount : 0
  const discountedSubtotal = dSub(subtotal, discountAmount)
  const servicePercent = opts.includeService ? (opts.servicePercent ?? 0) : 0
  const serviceAmount = servicePercent > 0
    ? dRound(dDiv(dMul(discountedSubtotal, servicePercent), 100))
    : 0
  const tipAmount = opts.tipAmount && opts.tipAmount > 0 ? opts.tipAmount : 0
  const total = dAdd(dAdd(discountedSubtotal, serviceAmount), tipAmount)

  const isHall = isHallType(order.type)
  const table = isHall && order.tableId ? ctx.tables?.find(t => t.id === order.tableId) : null
  const zone = isHall && table ? ctx.zones?.find(z => z.id === table.zone) : null
  const waiter = order.waiterId ? ctx.users?.find(u => u.id === order.waiterId) : null

  return {
    orderId: order.id,
    orderNumber: order.orderNumber,
    orderType: (order.type ?? 'hall') as 'hall' | 'delivery' | 'takeaway',
    restaurantName: ctx.restaurant?.name,
    restaurantAddress: ctx.restaurant?.address,
    tableName: table?.name,
    zoneName: isHall ? (zone?.name ?? 'Зал') : undefined,
    deliveryPhone: order.type === 'delivery' ? order.deliveryPhone : undefined,
    deliveryAddress: order.type === 'delivery' ? order.deliveryAddress : undefined,
    waiterName: waiter?.name,
    cashierName: ctx.currentUser?.name,
    items: displayItems.map(i => ({
      name: i.name,
      qty: i.qty,
      price: i.price,
      unit: i.unit,
      unitSize: i.unitSize,
      modifiers: i.modifiers?.map(m => ({ name: m.name, price: m.price })),
      portions: i.portions,
    })),
    subtotal,
    discountAmount: discountAmount > 0 ? discountAmount : undefined,
    discountReason: discountAmount > 0 ? (opts.discountReason || undefined) : undefined,
    servicePercent,
    serviceAmount,
    tipAmount: tipAmount > 0 ? tipAmount : undefined,
    guestsCount: isHall ? order.guestsCount : undefined,
    total,
    paymentMethod: opts.paymentMethod,
    accountName: opts.accountName,
    payments: opts.payments && opts.payments.length > 0 ? opts.payments : undefined,
    createdAt: order.createdAt,
    closedAt: new Date().toISOString(),
    isPreCheck: opts.isPreCheck,
  }
}
