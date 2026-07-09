import { describe, it, expect } from 'vitest'
import { portionsOf, lineTotal, cartSubtotal, cartCount, cartCogs, cartToItems } from './cart'
import type { CartLine } from '@/components/order/types'

// Корзинная арифметика /pos2. Проверяем ровно те кейсы, где раньше жили баги:
// штучные vs весовые позиции, число порций, разворот в OrderItem'ы, cogs.

function line(p: Partial<CartLine> = {}): CartLine {
  return {
    menuItemId: 'm1', name: 'Блюдо', emoji: '🍽', qty: 1, price: 10, cogs: 3,
    unit: 'piece', unitSize: 1, ...p,
  }
}

describe('portionsOf', () => {
  it('undefined/0/1 → 1 порция', () => {
    expect(portionsOf(line({ portionQty: undefined }))).toBe(1)
    expect(portionsOf(line({ portionQty: 0 }))).toBe(1)
    expect(portionsOf(line({ portionQty: 1 }))).toBe(1)
  })
  it('>1 → само число', () => {
    expect(portionsOf(line({ portionQty: 4 }))).toBe(4)
  })
})

describe('lineTotal', () => {
  it('штучная: price × qty', () => {
    expect(lineTotal(line({ unit: 'piece', price: 25, qty: 3 }))).toBe(75)
  })
  it('весовая: price × (qty / unitSize)', () => {
    // 50 сум за 100г, взяли 250г → 125
    expect(lineTotal(line({ unit: 'g', price: 50, unitSize: 100, qty: 250 }))).toBe(125)
  })
  it('весовая × число порций', () => {
    // 50 за 100г, порция 100г, 4 порции → 200
    expect(lineTotal(line({ unit: 'g', price: 50, unitSize: 100, qty: 100, portionQty: 4 }))).toBe(200)
  })
  it('unitSize=0 не делит на ноль (fallback 1)', () => {
    expect(lineTotal(line({ unit: 'g', price: 50, unitSize: 0, qty: 3 }))).toBe(150)
  })
  it('дробные суммы точны (без float-мусора)', () => {
    // 0.1 × 3 = 0.3, а не 0.30000000000000004
    expect(lineTotal(line({ unit: 'piece', price: 0.1, qty: 3 }))).toBe(0.3)
  })
})

describe('cartSubtotal', () => {
  it('сумма всех строк', () => {
    const cart = [
      line({ unit: 'piece', price: 25, qty: 3 }),               // 75
      line({ unit: 'g', price: 50, unitSize: 100, qty: 250 }),  // 125
    ]
    expect(cartSubtotal(cart)).toBe(200)
  })
  it('пустая корзина → 0', () => {
    expect(cartSubtotal([])).toBe(0)
  })
})

describe('cartCount', () => {
  it('штучные считаются по qty, весовые — по числу порций', () => {
    const cart = [
      line({ unit: 'piece', qty: 3 }),
      line({ unit: 'g', qty: 200, portionQty: 4 }),
    ]
    expect(cartCount(cart)).toBe(7)
  })
})

describe('cartCogs', () => {
  it('штучная cogs×qty + весовая cogs×(qty/unitSize)', () => {
    const cart = [
      line({ unit: 'piece', cogs: 10, qty: 3 }),                 // 30
      line({ unit: 'g', cogs: 20, unitSize: 100, qty: 250 }),    // 50
    ]
    expect(cartCogs(cart)).toBe(80)
  })
  it('весовая cogs × число порций', () => {
    // cogs 20 за 100г, порция 100г, 3 порции → 60
    expect(cartCogs([line({ unit: 'g', cogs: 20, unitSize: 100, qty: 100, portionQty: 3 })])).toBe(60)
  })
})

describe('cartToItems', () => {
  it('штучная строка → одна позиция с тем же qty', () => {
    const items = cartToItems([line({ menuItemId: 'x', name: 'Кола', unit: 'piece', qty: 3 })])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ menuItemId: 'x', name: 'Кола', qty: 3 })
  })
  it('весовая на N порций → N отдельных позиций по qty каждая', () => {
    const items = cartToItems([line({ menuItemId: 'w', unit: 'g', qty: 150, portionQty: 3 })])
    expect(items).toHaveLength(3)
    for (const it of items) expect(it.qty).toBe(150)
  })
  it('порции — независимые копии (не общий объект)', () => {
    const items = cartToItems([line({ unit: 'g', qty: 100, portionQty: 2 })])
    items[0].qty = 999
    expect(items[1].qty).toBe(100)
  })
  it('несколько строк разворачиваются суммарно', () => {
    const items = cartToItems([
      line({ menuItemId: 'a', unit: 'piece', qty: 2 }),        // 1 позиция
      line({ menuItemId: 'b', unit: 'g', qty: 100, portionQty: 3 }), // 3 позиции
    ])
    expect(items).toHaveLength(4)
  })
})
