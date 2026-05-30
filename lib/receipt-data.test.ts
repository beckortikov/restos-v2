import { describe, it, expect } from 'vitest'
import { buildReceiptData } from './receipt-data'
import type { Order, OrderItem } from './types'

// buildReceiptData — единый source of truth для пре-чека и финального чека.
// v4 формула: subtotal → −discount → +service(% от discountedSubtotal) → +tip.
// Это отличается от v1 (там service считался от subtotal до скидки) — поэтому
// нельзя просто перенести v1-тест.

function mkItem(over: Partial<OrderItem> = {}): OrderItem {
  return {
    menuItemId: 'mi',
    name: 'Лагман',
    qty: 1,
    price: 30,
    cogs: 10,
    ...over,
  } as OrderItem
}

function mkOrder(over: Partial<Order> = {}): Order {
  return {
    id: 'order-1',
    status: 'new',
    type: 'hall',
    items: [mkItem()],
    total: 30,
    createdAt: '2026-01-01T10:00:00Z',
    ...over,
  } as Order
}

const ctxEmpty = {
  tables: [],
  users: [],
  zones: [],
  restaurant: null,
  currentUser: null,
  voids: null,
}

describe('buildReceiptData — math (v4 формула: subtotal → −discount → +service → +tip)', () => {
  it('subtotal — точная сумма line-итогов (без float drift)', () => {
    const items = [
      mkItem({ qty: 3, price: 30 }),  // 90
      mkItem({ qty: 1, price: 10.10 }),  // 10.10
    ]
    const data = buildReceiptData(mkOrder({ items }), ctxEmpty, { isPreCheck: false })
    expect(data.subtotal).toBe(100.10)
  })

  it('сервис вычисляется от discounted-subtotal, не от raw subtotal', () => {
    const items = [mkItem({ qty: 2, price: 50 })] // subtotal = 100
    const data = buildReceiptData(mkOrder({ items, total: 100 }), ctxEmpty, {
      isPreCheck: false,
      includeService: true,
      servicePercent: 10,
      discountAmount: 20, // discounted = 80, service = 80*10%=8
    })
    expect(data.subtotal).toBe(100)
    expect(data.discountAmount).toBe(20)
    expect(data.serviceAmount).toBe(8)
    expect(data.total).toBe(88) // (100−20)+8+0
  })

  it('опускает сервис когда includeService=false', () => {
    const data = buildReceiptData(mkOrder({ total: 100, items: [mkItem({ qty: 2, price: 50 })] }), ctxEmpty, {
      isPreCheck: false,
      includeService: false,
      servicePercent: 10,
    })
    expect(data.serviceAmount).toBe(0)
    expect(data.servicePercent).toBe(0)
    expect(data.total).toBe(100)
  })

  it('total = subtotal − discount + service + tip', () => {
    const items = [mkItem({ qty: 2, price: 50 })] // 100
    const data = buildReceiptData(mkOrder({ items, total: 100 }), ctxEmpty, {
      isPreCheck: false,
      includeService: true,
      servicePercent: 10,
      discountAmount: 10,
      tipAmount: 5,
    })
    // discounted=90, service=9, total=90+9+5=104
    expect(data.total).toBe(104)
  })

  it('discount=0 → discountAmount undefined в результате (UI скрывает строку)', () => {
    const data = buildReceiptData(mkOrder(), ctxEmpty, {
      isPreCheck: false,
      discountAmount: 0,
    })
    expect(data.discountAmount).toBeUndefined()
    expect(data.discountReason).toBeUndefined()
  })

  it('tip=0 → tipAmount undefined в результате', () => {
    const data = buildReceiptData(mkOrder(), ctxEmpty, {
      isPreCheck: false,
      tipAmount: 0,
    })
    expect(data.tipAmount).toBeUndefined()
  })
})

describe('buildReceiptData — voided / cancelled items', () => {
  it('исключает items с cancelledAt из subtotal и body', () => {
    const items = [
      mkItem({ qty: 1, price: 30 }),
      mkItem({ qty: 1, price: 30, cancelledAt: '2026-01-01T10:05:00Z' } as Partial<OrderItem>),
    ]
    const data = buildReceiptData(mkOrder({ items, total: 60 }), ctxEmpty, { isPreCheck: false })
    expect(data.subtotal).toBe(30)
    expect(data.items).toHaveLength(1)
  })
})

describe('buildReceiptData — order type invariants', () => {
  it('hall: подставляет table/zone/waiter из ctx', () => {
    const data = buildReceiptData(
      mkOrder({ type: 'hall', tableId: 'tbl-2', waiterId: 'w1', guestsCount: 3 }),
      {
        ...ctxEmpty,
        tables: [{ id: 'tbl-2', name: '2', zone: 'zone-1', capacity: 4, status: 'occupied' }] as any,
        zones: [{ id: 'zone-1', name: 'Veranda' }] as any,
        users: [{ id: 'w1', name: 'Aziza' }] as any,
      },
      { isPreCheck: false },
    )
    expect(data.tableName).toBe('2')
    expect(data.zoneName).toBe('Veranda')
    expect(data.waiterName).toBe('Aziza')
    expect(data.guestsCount).toBe(3)
  })

  it('hall без zone в ctx → fallback на "Зал"', () => {
    const data = buildReceiptData(
      mkOrder({ type: 'hall', tableId: 'tbl-2' }),
      { ...ctxEmpty, tables: [{ id: 'tbl-2', name: '2', zone: 'missing', capacity: 2, status: 'occupied' }] as any },
      { isPreCheck: false },
    )
    expect(data.zoneName).toBe('Зал')
  })

  it('delivery/takeaway: table/zone/guests = undefined', () => {
    for (const type of ['delivery', 'takeaway'] as const) {
      const data = buildReceiptData(
        mkOrder({ type, tableId: 'tbl-2', guestsCount: 5 }),
        ctxEmpty,
        { isPreCheck: false },
      )
      expect(data.tableName).toBeUndefined()
      expect(data.zoneName).toBeUndefined()
      expect(data.guestsCount).toBeUndefined()
    }
  })

  it('orderType="hall" по умолчанию когда order.type missing', () => {
    const data = buildReceiptData(mkOrder({ type: undefined as any }), ctxEmpty, { isPreCheck: false })
    expect(data.orderType).toBe('hall')
  })
})

describe('buildReceiptData — pass-through metadata', () => {
  it('переносит orderId/orderNumber/createdAt/paymentMethod/accountName/isPreCheck', () => {
    const data = buildReceiptData(
      mkOrder({ id: 'OID', orderNumber: 42, createdAt: '2026-05-29T12:00:00Z' }),
      { ...ctxEmpty, currentUser: { id: 'u', name: 'Cashier-1', role: 'cashier' } as any },
      {
        isPreCheck: true,
        paymentMethod: 'cash',
        accountName: 'Main cash',
      },
    )
    expect(data.orderId).toBe('OID')
    expect(data.orderNumber).toBe(42)
    expect(data.createdAt).toBe('2026-05-29T12:00:00Z')
    expect(data.paymentMethod).toBe('cash')
    expect(data.accountName).toBe('Main cash')
    expect(data.cashierName).toBe('Cashier-1')
    expect(data.isPreCheck).toBe(true)
  })
})
