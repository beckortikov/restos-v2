// Чистая корзинная арифметика /pos2 — вынесена из app/pos2/order/page.tsx,
// чтобы её можно было юнит-тестировать в изоляции (деньги = где живут баги).
// Логика 1:1 с прежним инлайном: штучные позиции считаются price×qty,
// весовые — price×(qty/unitSize), всё умножается на число порций.

import type { CartLine } from '@/components/order/types'
import type { OrderItem } from '@/lib/types'
import { dMul, dDiv, dSum } from '@/lib/decimal'

/** Число порций строки. undefined/1 → 1; для весовых «4 по 100г» → 4. */
export function portionsOf(l: CartLine): number {
  return l.portionQty && l.portionQty > 1 ? l.portionQty : 1
}

/** Сумма одной строки корзины (с учётом веса и числа порций). */
export function lineTotal(l: CartLine): number {
  const base = l.unit === 'piece'
    ? dMul(l.price, l.qty)
    : dMul(l.price, dDiv(l.qty, l.unitSize > 0 ? l.unitSize : 1))
  return dMul(base, portionsOf(l))
}

/** Подытог корзины. */
export function cartSubtotal(cart: CartLine[]): number {
  return dSum(cart.map(lineTotal))
}

/** Кол-во единиц в корзине (штучные — qty, весовые — число порций). */
export function cartCount(cart: CartLine[]): number {
  return cart.reduce((s, l) => s + (l.unit === 'piece' ? l.qty : portionsOf(l)), 0)
}

/** Себестоимость корзины (для revenue-entry при инлайн-оплате). */
export function cartCogs(cart: CartLine[]): number {
  return dSum(cart.map(l => {
    const per = l.unit === 'piece'
      ? dMul(l.cogs, l.qty)
      : dMul(l.cogs, dDiv(l.qty, l.unitSize > 0 ? l.unitSize : 1))
    return dMul(per, portionsOf(l))
  }))
}

/** Разворачивает корзину в OrderItem[]: весовая строка на N порций → N позиций
 *  по qty каждая (чтобы чек/кухня печатали каждую порцию отдельно). */
export function cartToItems(cart: CartLine[]): OrderItem[] {
  return cart.flatMap(l => {
    const one: OrderItem = {
      menuItemId: l.menuItemId, name: l.name, qty: l.qty, price: l.price,
      cogs: l.cogs, unit: l.unit, unitSize: l.unitSize, emoji: l.emoji,
    }
    return Array.from({ length: portionsOf(l) }, () => ({ ...one }))
  })
}
