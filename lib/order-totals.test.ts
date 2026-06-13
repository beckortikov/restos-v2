import { describe, it, expect } from 'vitest'
import { calcOrderDisplayTotal, visibleReceiptItems, calcLineTotal } from './helpers'
import { dSum, dRound, dDiv, dMul } from './decimal'
import type { Order, OrderItem, OrderVoid } from './types'

// Цель: доказать, что итог считается ОДИНАКОВО двумя путями фронта при
// согласованном backend-скаляре order.total (его бэк держит после фикса
// CreateVoid):
//   • путь карты/официанта  — calcOrderDisplayTotal(order) (читает order.total)
//   • путь диалога оплаты    — подытог по visibleReceiptItems + обслуживание
// Бэкенд-тест (server/.../void_totals_test.go) отдельно проверяет, что
// order.total из API == подытогу видимых позиций. Вместе это и есть
// «через api и фронт одинаково».

const isHall = (t?: string | null) => t !== 'delivery' && t !== 'takeaway'

// Точный порт components/dialogs/order-actions-body.tsx (subtotal/service),
// без скидки и чая (discount=0, tip=0). voids диалог грузит отдельным запросом
// (fetchVoidsForOrder), поэтому передаём их явно, а не через order.
function paymentDialogTotal(order: Order, voids: OrderVoid[] | null, restaurantPercent: number): number {
  const visible = visibleReceiptItems(order.items, voids)
  const subtotal = dRound(dSum(visible.map(i => calcLineTotal(i.price, i.qty, i.unit, i.unitSize))))
  const includeService = isHall(order.type)
  // useEffect в диалоге: order.servicePercent>0 ? order.servicePercent : restaurant.servicePercent
  const pct = (order.servicePercent && order.servicePercent > 0) ? order.servicePercent : restaurantPercent
  const serviceAmount = includeService && pct > 0 ? dRound(dDiv(dMul(subtotal, pct), 100)) : 0
  return subtotal + serviceAmount
}

let idSeq = 0
function item(name: string, price: number, qty: number, extra: Partial<OrderItem> = {}): OrderItem {
  return {
    id: `it-${++idSeq}`, menuItemId: `mi-${name}`, name, price, qty, cogs: 0, ...extra,
  }
}
function voidRec(name: string, price: number, qty: number): OrderVoid {
  return {
    id: `v-${++idSeq}`, orderId: 'o1', itemName: name, itemPrice: price, itemQty: qty,
    reason: 'guest_changed_mind', createdAt: '2026-06-13T00:00:00Z',
  }
}

// Собирает Order с order.total = подытог видимых позиций — ровно так его
// хранит бэк после отмен (см. CreateVoid).
function makeOrder(opts: {
  type: Order['type']
  items: OrderItem[]
  voids?: OrderVoid[]
  servicePercent?: number
  status?: Order['status']
}): Order {
  const visible = visibleReceiptItems(opts.items, opts.voids ?? null)
  const total = dRound(dSum(visible.map(i => calcLineTotal(i.price, i.qty, i.unit, i.unitSize))))
  return {
    id: 'o1',
    status: opts.status ?? 'new',
    type: opts.type,
    items: opts.items,
    total,
    totalWithService: total,
    servicePercent: opts.servicePercent,
    createdAt: '2026-06-13T00:00:00Z',
  } as Order
}

describe('итог чека: путь карты == путь диалога оплаты', () => {
  const REST_PCT = 10

  const cases: Array<{ name: string; order: Order; voids?: OrderVoid[]; restPct?: number }> = [
    {
      name: 'зал, без отмен',
      order: makeOrder({ type: 'hall', items: [item('Plov', 25, 2), item('Lagman', 40, 1)] }),
    },
    {
      name: 'зал, полная отмена одной позиции',
      voids: [voidRec('Lagman', 40, 1)],
      order: makeOrder({
        type: 'hall',
        items: [item('Plov', 25, 2), item('Lagman', 40, 1)],
        voids: [voidRec('Lagman', 40, 1)],
      }),
    },
    {
      name: 'зал, несколько отмен (часть остаётся)',
      voids: [voidRec('Plov', 25, 1), voidRec('Tea', 8, 3)],
      order: makeOrder({
        type: 'hall',
        items: [item('Plov', 25, 1), item('Lagman', 40, 2), item('Tea', 8, 3)],
        voids: [voidRec('Plov', 25, 1), voidRec('Tea', 8, 3)],
      }),
      restPct: 15,
    },
    {
      name: 'зал, отмена через cancelledAt на позиции',
      order: makeOrder({
        type: 'hall',
        items: [item('Plov', 25, 2), item('Tea', 8, 2, { cancelledAt: '2026-06-13T01:00:00Z' })],
      }),
    },
    {
      name: 'самовывоз — обслуживание не начисляется',
      voids: [voidRec('Lagman', 40, 1)],
      order: makeOrder({
        type: 'takeaway',
        items: [item('Plov', 25, 2), item('Lagman', 40, 1)],
        voids: [voidRec('Lagman', 40, 1)],
      }),
    },
    {
      name: 'заказ со своим service_percent (перекрывает дефолт ресторана)',
      order: makeOrder({
        type: 'hall',
        items: [item('Plov', 25, 4)],
        servicePercent: 7,
      }),
    },
    {
      name: 'весовая позиция (unit=g, unitSize=100)',
      order: makeOrder({
        type: 'hall',
        items: [item('Salat', 30, 250, { unit: 'g', unitSize: 100 }), item('Tea', 8, 1)],
      }),
    },
    {
      name: 'все позиции отменены → 0',
      voids: [voidRec('Plov', 25, 2)],
      order: makeOrder({
        type: 'hall',
        items: [item('Plov', 25, 2)],
        voids: [voidRec('Plov', 25, 2)],
      }),
    },
  ]

  for (const c of cases) {
    it(c.name, () => {
      const restPct = c.restPct ?? REST_PCT
      const mapTotal = calcOrderDisplayTotal(c.order, restPct)
      const payTotal = paymentDialogTotal(c.order, c.voids ?? null, restPct)
      expect(mapTotal).toBe(payTotal)
    })
  }

  it('done-заказ: карта берёт зафиксированный totalWithService', () => {
    const base = makeOrder({ type: 'hall', items: [item('Plov', 25, 2)], status: 'done' })
    const order: Order = { ...base, totalWithService: 55 } // 50 + чай/обслуж зафиксированы
    expect(calcOrderDisplayTotal(order, REST_PCT)).toBe(55)
  })
})
