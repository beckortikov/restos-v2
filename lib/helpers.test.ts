import { describe, it, expect } from 'vitest'
import {
  visibleReceiptItems,
  voidedItemFlags,
  formatCurrency,
  formatCurrencyCompact,
  formatPriceLabel,
  formatQty,
  formatNum,
  formatTime,
  calcLineTotal,
  calcLineCogs,
  calcOrderDisplayTotal,
  startOfToday,
  startOfDay,
  endOfDay,
  getTimeSince,
} from './helpers'
import type { Order, OrderItem, OrderVoid } from './types'

// ─── visibleReceiptItems + voidedItemFlags ────────────────────────────────
//
// These two helpers gate what the customer sees on every receipt. Bugs here
// produce the worst class of issue we ship: "the printed bill doesn't match
// what we charged". Three failure shapes to pin:
//   1. cancelled_at items must drop entirely (full cancellation).
//   2. voids reference (name, price) — not item id — so the matcher must
//      consume void.qty across duplicate rows and free the remainder.
//   3. flags must be index-aligned with the INPUT array (for "Отменено"
//      strikethrough on re-opened order).

function mkItem(over: Partial<OrderItem>): OrderItem {
  return {
    menuItemId: 'mi',
    name: 'Лагман',
    qty: 1,
    price: 30,
    cogs: 10,
    ...over,
  }
}

function mkVoid(over: Partial<OrderVoid>): OrderVoid {
  return {
    id: 'v',
    orderId: 'o',
    itemName: 'Лагман',
    itemQty: 1,
    itemPrice: 30,
    reason: 'kitchen_error',
    createdAt: '2025-01-01T00:00:00Z',
    ...over,
  }
}

describe('visibleReceiptItems', () => {
  it('returns all items when no voids and no cancellations', () => {
    const items = [mkItem({ name: 'A' }), mkItem({ name: 'B' })]
    expect(visibleReceiptItems(items, null)).toEqual(items)
    expect(visibleReceiptItems(items, [])).toEqual(items)
    expect(visibleReceiptItems(items)).toEqual(items)
  })

  it('filters out items with cancelledAt set', () => {
    const a = mkItem({ name: 'A' })
    const b = mkItem({ name: 'B', cancelledAt: '2025-01-01T10:00:00Z' })
    const c = mkItem({ name: 'C' })
    expect(visibleReceiptItems([a, b, c], null)).toEqual([a, c])
  })

  // A single qty:2 row with one void of qty:2 should disappear entirely.
  it('drops a row fully covered by a single void', () => {
    const a = mkItem({ name: 'Кийма', qty: 2, price: 40 })
    const v = mkVoid({ itemName: 'Кийма', itemQty: 2, itemPrice: 40 })
    expect(visibleReceiptItems([a], [v])).toEqual([])
  })

  // Same name/price across two rows, void covers only first row.
  it('consumes voided qty across duplicate (name, price) rows', () => {
    const a1 = mkItem({ name: 'Чай', qty: 1, price: 6 })
    const a2 = mkItem({ name: 'Чай', qty: 1, price: 6 })
    const v = mkVoid({ itemName: 'Чай', itemQty: 1, itemPrice: 6 })
    const visible = visibleReceiptItems([a1, a2], [v])
    expect(visible).toEqual([a2])
  })

  // Different prices = different keys, so a void on "Чай @ 6" must NOT
  // remove "Чай @ 8". Critical for menu-price changes mid-order.
  it('does not cross (name, price) keys', () => {
    const a = mkItem({ name: 'Чай', qty: 1, price: 6 })
    const b = mkItem({ name: 'Чай', qty: 1, price: 8 })
    const v = mkVoid({ itemName: 'Чай', itemQty: 1, itemPrice: 6 })
    expect(visibleReceiptItems([a, b], [v])).toEqual([b])
  })

  // Edge case: void.qty < row.qty — current behaviour treats the row as still
  // visible (partial voids are stored separately and the row qty stays the
  // ground truth). Pin this so a future "show partial qty" refactor surfaces.
  it('keeps a row when void.qty is less than row.qty (partial void)', () => {
    const a = mkItem({ name: 'Манти', qty: 3, price: 38 })
    const v = mkVoid({ itemName: 'Манти', itemQty: 1, itemPrice: 38 })
    expect(visibleReceiptItems([a], [v])).toEqual([a])
  })

  // Mixed: cancelled-at row + voided row + clean row.
  it('handles cancelledAt + voids together', () => {
    const a = mkItem({ name: 'A', qty: 1, price: 10 })
    const b = mkItem({ name: 'B', qty: 1, price: 20, cancelledAt: '2025-01-01T10:00:00Z' })
    const c = mkItem({ name: 'C', qty: 1, price: 30 })
    const v = mkVoid({ itemName: 'C', itemQty: 1, itemPrice: 30 })
    expect(visibleReceiptItems([a, b, c], [v])).toEqual([a])
  })
})

describe('voidedItemFlags', () => {
  it('returns false-aligned array when no voids and no cancellations', () => {
    const items = [mkItem({ name: 'A' }), mkItem({ name: 'B' })]
    expect(voidedItemFlags(items, null)).toEqual([false, false])
    expect(voidedItemFlags(items, [])).toEqual([false, false])
  })

  it('marks cancelledAt rows true', () => {
    const a = mkItem({ name: 'A' })
    const b = mkItem({ name: 'B', cancelledAt: '2025-01-01T10:00:00Z' })
    expect(voidedItemFlags([a, b], null)).toEqual([false, true])
  })

  // Same shape as visibleReceiptItems but returns boolean[] index-aligned
  // with the input — this is the "reopened-dialog strikethrough" path.
  it('marks fully-voided rows true', () => {
    const a = mkItem({ name: 'Кийма', qty: 2, price: 40 })
    const v = mkVoid({ itemName: 'Кийма', itemQty: 2, itemPrice: 40 })
    expect(voidedItemFlags([a], [v])).toEqual([true])
  })

  it('preserves input index order', () => {
    const items = [
      mkItem({ name: 'A' }),
      mkItem({ name: 'B', cancelledAt: '2025-01-01T10:00:00Z' }),
      mkItem({ name: 'C' }),
    ]
    expect(voidedItemFlags(items, null)).toEqual([false, true, false])
  })

  it('consumes void qty across duplicates same as visibleReceiptItems', () => {
    const a1 = mkItem({ name: 'Чай', qty: 1, price: 6 })
    const a2 = mkItem({ name: 'Чай', qty: 1, price: 6 })
    const v = mkVoid({ itemName: 'Чай', itemQty: 1, itemPrice: 6 })
    // First row gets consumed → flagged true; second row stays.
    expect(voidedItemFlags([a1, a2], [v])).toEqual([true, false])
  })

  // The two helpers SHARE matching semantics. They must agree on every row
  // for any (items, voids) pair — otherwise the receipt body and the UI
  // strikethrough drift. Lightweight cross-check.
  it('agrees with visibleReceiptItems for all rows', () => {
    const items = [
      mkItem({ name: 'A', qty: 1, price: 10 }),
      mkItem({ name: 'B', qty: 2, price: 20 }),
      mkItem({ name: 'B', qty: 1, price: 20 }),
      mkItem({ name: 'C', qty: 1, price: 30, cancelledAt: '2025-01-01T10:00:00Z' }),
    ]
    const voids = [
      mkVoid({ itemName: 'B', itemQty: 2, itemPrice: 20 }),
    ]
    const flags = voidedItemFlags(items, voids)
    const visible = visibleReceiptItems(items, voids)
    // Reconstruct visible set from flags:
    const visibleFromFlags = items.filter((_, i) => !flags[i])
    expect(visibleFromFlags).toEqual(visible)
  })
})

// ─── Formatters ───────────────────────────────────────────────────────────
//
// Format functions are run on every render of every receipt line, every menu
// chip, every order card. They must be defensive against null/undefined and
// preserve the "ru-RU + space-separated thousands + TJS suffix" convention.

describe('formatCurrency', () => {
  it('formats with 2 decimals, ru-RU grouping, TJS suffix', () => {
    // ru-RU uses U+00A0 (non-breaking space) for thousands. Match by regex
    // rather than literal string so tests don't break on locale tweaks.
    const out = formatCurrency(1234.5)
    expect(out).toMatch(/^1[\s ]234,50 TJS$/)
  })

  it('always shows .00 for whole numbers', () => {
    expect(formatCurrency(40)).toBe('40,00 TJS')
  })

  it('coerces null/undefined/NaN to 0', () => {
    expect(formatCurrency(null)).toBe('0,00 TJS')
    expect(formatCurrency(undefined)).toBe('0,00 TJS')
    expect(formatCurrency(NaN)).toBe('0,00 TJS')
  })

  it('rounds to 2 decimals (no truncation drift)', () => {
    expect(formatCurrency(40.005)).toBe('40,01 TJS')
  })
})

describe('formatCurrencyCompact', () => {
  // Same spec as formatCurrency EXCEPT whole numbers drop the ",00".
  it('drops ",00" when the value is a whole number', () => {
    expect(formatCurrencyCompact(40)).toBe('40 TJS')
  })

  it('keeps fractional decimals', () => {
    expect(formatCurrencyCompact(40.5)).toBe('40,50 TJS')
  })

  it('coerces null/undefined to 0 TJS (whole)', () => {
    expect(formatCurrencyCompact(null)).toBe('0 TJS')
  })
})

describe('formatQty', () => {
  it('renders piece items as "×N"', () => {
    expect(formatQty(2, 'piece')).toBe('×2')
    expect(formatQty(2)).toBe('×2')
  })

  it('renders grams as integer "Nг"', () => {
    expect(formatQty(250.4, 'g')).toBe('250г')
    expect(formatQty(99.6, 'g')).toBe('100г')
  })

  it('renders kg with smart decimals and no trailing zeros', () => {
    expect(formatQty(1.5, 'kg')).toBe('1.5кг')
    expect(formatQty(1.0, 'kg')).toBe('1кг')
    // ≥10kg drops to 1 decimal
    expect(formatQty(12.34, 'kg')).toBe('12.3кг')
    expect(formatQty(12.0, 'kg')).toBe('12кг')
  })
})

describe('formatPriceLabel', () => {
  it('plain currency for piece items', () => {
    expect(formatPriceLabel(15, 'piece')).toBe('15 TJS')
  })

  it('appends "/ Ng" for gram items with unitSize', () => {
    expect(formatPriceLabel(15, 'g', 100)).toBe('15 TJS / 100г')
  })

  it('falls back to / 100г when unitSize missing', () => {
    expect(formatPriceLabel(15, 'g')).toBe('15 TJS / 100г')
  })

  it('appends "/ кг" for kg items', () => {
    expect(formatPriceLabel(150, 'kg')).toBe('150 TJS / кг')
  })
})

describe('formatNum', () => {
  it('trims floating-point artifacts', () => {
    expect(formatNum(77.83279999999999)).toBe('77.833')
  })

  it('strips trailing zeros', () => {
    expect(formatNum(47.0001, 3)).toBe('47')
    expect(formatNum(2213)).toBe('2213')
  })

  it('renders 0 as "0"', () => {
    expect(formatNum(0)).toBe('0')
    expect(formatNum(null)).toBe('0')
    expect(formatNum(undefined)).toBe('0')
  })

  it('honors maxDecimals', () => {
    expect(formatNum(0.123456, 2)).toBe('0.12')
    expect(formatNum(0.123456, 4)).toBe('0.1235')
  })
})

// ─── calcLineTotal / calcLineCogs ──────────────────────────────────────────
//
// Identical math, just different "cost" input. Both must scale weight items
// the same way (price-per-unitSize × qty / unitSize) so margin reports stay
// consistent with revenue reports.

describe('calcLineTotal', () => {
  it('piece items: price × qty', () => {
    expect(calcLineTotal(45, 2, 'piece')).toBe(90)
    expect(calcLineTotal(45, 2)).toBe(90)
  })

  it('weight items: scales by qty / unitSize', () => {
    expect(calcLineTotal(12, 250, 'g', 100)).toBe(30)
    expect(calcLineTotal(150, 0.5, 'kg', 1)).toBe(75)
  })

  it('falls back to unitSize=1 on bad data', () => {
    expect(calcLineTotal(10, 5, 'g', 0)).toBe(50)
  })
})

describe('calcLineCogs', () => {
  it('scales the same way as calcLineTotal', () => {
    // Same shape — proves both call dLineTotal under the hood.
    expect(calcLineCogs(4, 250, 'g', 100)).toBe(10)
    expect(calcLineCogs(20, 3, 'piece')).toBe(60)
  })
})

// ─── calcOrderDisplayTotal ─────────────────────────────────────────────────

describe('calcOrderDisplayTotal', () => {
  function mkOrder(over: Partial<Order>): Order {
    return {
      id: 'o',
      status: 'new',
      type: 'hall',
      items: [],
      total: 100,
      createdAt: '2025-01-01T00:00:00Z',
      ...over,
    } as Order
  }

  // Takeaway/delivery never gets service added on top — they're "fast" formats.
  it('returns raw total for delivery/takeaway regardless of service percent', () => {
    expect(calcOrderDisplayTotal(mkOrder({ type: 'delivery' }), 10)).toBe(100)
    expect(calcOrderDisplayTotal(mkOrder({ type: 'takeaway' }), 10)).toBe(100)
  })

  it('adds servicePercent for hall orders', () => {
    expect(calcOrderDisplayTotal(mkOrder({ type: 'hall' }), 10)).toBe(110)
  })

  // Legacy fallback: pre-October orders have servicePercent=0 stored and rely
  // on the restaurant's current setting.
  it('falls back to restaurant servicePercent when order.servicePercent is 0', () => {
    expect(calcOrderDisplayTotal(mkOrder({ type: 'hall', servicePercent: 0 }), 15)).toBe(115)
  })

  // Closed orders fix their totalWithService at close time — UI must show that
  // snapshot, not the live recomputation. Discounts/tips are baked in.
  it('uses totalWithService for closed orders', () => {
    const o = mkOrder({ type: 'hall', status: 'done', totalWithService: 88, total: 100 })
    expect(calcOrderDisplayTotal(o, 10)).toBe(88)
  })

  it('ignores totalWithService when order is not done (parsed fallback case)', () => {
    // status='new' but totalWithService present (parser fallback) — should
    // still compute from total + service.
    const o = mkOrder({ type: 'hall', status: 'new', totalWithService: 100, total: 100 })
    expect(calcOrderDisplayTotal(o, 10)).toBe(110)
  })
})

// ─── Date helpers ──────────────────────────────────────────────────────────

describe('startOfToday / startOfDay / endOfDay', () => {
  it('startOfToday returns midnight today (local)', () => {
    const d = startOfToday()
    expect(d.getHours()).toBe(0)
    expect(d.getMinutes()).toBe(0)
    expect(d.getSeconds()).toBe(0)
    expect(d.getMilliseconds()).toBe(0)
    const now = new Date()
    expect(d.getFullYear()).toBe(now.getFullYear())
    expect(d.getMonth()).toBe(now.getMonth())
    expect(d.getDate()).toBe(now.getDate())
  })

  it('startOfDay is non-mutating', () => {
    const src = new Date('2025-06-15T14:30:00')
    const before = src.getTime()
    startOfDay(src)
    expect(src.getTime()).toBe(before)
  })

  it('endOfDay returns 23:59:59.999', () => {
    const src = new Date('2025-06-15T10:00:00')
    const d = endOfDay(src)
    expect(d.getHours()).toBe(23)
    expect(d.getMinutes()).toBe(59)
    expect(d.getSeconds()).toBe(59)
    expect(d.getMilliseconds()).toBe(999)
  })
})

describe('getTimeSince', () => {
  // Pin a fixed "now" via endIso so the test isn't time-dependent.
  it('formats minutes when < 1h', () => {
    expect(getTimeSince('2025-01-01T10:00:00Z', '2025-01-01T10:30:00Z')).toBe('30 мин')
    expect(getTimeSince('2025-01-01T10:00:00Z', '2025-01-01T10:00:30Z')).toBe('0 мин')
  })

  it('formats hours + mins when 1h..23h', () => {
    expect(getTimeSince('2025-01-01T10:00:00Z', '2025-01-01T13:30:00Z')).toBe('3ч 30мин')
  })

  it('formats days + hours when ≥ 24h', () => {
    expect(getTimeSince('2025-01-01T10:00:00Z', '2025-01-03T12:00:00Z')).toBe('2д 2ч')
    expect(getTimeSince('2025-01-01T10:00:00Z', '2025-01-03T10:00:00Z')).toBe('2д')
  })

  it('clamps negative diff to 0 мин (clock-skew defence)', () => {
    expect(getTimeSince('2025-01-01T10:00:00Z', '2025-01-01T09:00:00Z')).toBe('0 мин')
  })

  it('returns "0 мин" for null/invalid input', () => {
    expect(getTimeSince(null)).toBe('0 мин')
    expect(getTimeSince(undefined)).toBe('0 мин')
    expect(getTimeSince('not a date')).toBe('0 мин')
  })
})

describe('formatTime', () => {
  it('returns HH:MM in local time', () => {
    // Just check the shape — exact hour depends on locale/timezone of CI.
    expect(formatTime('2025-01-01T15:42:00')).toMatch(/^\d{2}:\d{2}$/)
  })
})
