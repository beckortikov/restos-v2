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
import type { ReceiptPrintData } from './print-service'

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
}

export function buildReceiptData(
  order: Order,
  ctx: BuildReceiptCtx,
  opts: BuildReceiptOpts,
): ReceiptPrintData {
  const items = visibleReceiptItems(order.items, ctx.voids)
  const subtotal = dRound(dSum(items.map(i => calcLineTotal(i.price, i.qty, i.unit, i.unitSize))))

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
    waiterName: waiter?.name,
    cashierName: ctx.currentUser?.name,
    items: items.map(i => ({
      name: i.name,
      qty: i.qty,
      price: i.price,
      unit: i.unit,
      unitSize: i.unitSize,
      modifiers: i.modifiers?.map(m => ({ name: m.name, price: m.price })),
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
    createdAt: order.createdAt,
    closedAt: new Date().toISOString(),
    isPreCheck: opts.isPreCheck,
  }
}
