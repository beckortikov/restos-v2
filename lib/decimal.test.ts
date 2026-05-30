import { describe, it, expect } from 'vitest'
import { dMul, dDiv, dSub, dAdd, dRound, dSum, dLineTotal } from './decimal'

// Every other price/totals helper layers on top of these. A bug here corrupts
// every receipt the customer sees and every shift report. These tests pin the
// IEEE-754 traps decimal.js is here to dodge — if any assertion flips, real
// money is at risk.

describe('dAdd', () => {
  it('avoids 0.1 + 0.2 = 0.30000000000000004', () => {
    expect(dAdd(0.1, 0.2)).toBe(0.3)
  })

  it('handles whole numbers', () => {
    expect(dAdd(5, 7)).toBe(12)
  })

  it('handles negative numbers', () => {
    expect(dAdd(-1.5, 0.5)).toBe(-1)
  })

  // Real-world bug shape: DB returned null for opening_balance and the whole
  // shift screen crashed with "Invalid argument" until we added safe().
  it('coerces null/undefined/NaN to 0 instead of throwing', () => {
    // @ts-expect-error — exercising runtime safety, not the type contract
    expect(dAdd(null, 5)).toBe(5)
    // @ts-expect-error
    expect(dAdd(undefined, 5)).toBe(5)
    expect(dAdd(NaN, 5)).toBe(5)
    // @ts-expect-error
    expect(dAdd(5, null)).toBe(5)
  })
})

describe('dSub', () => {
  it('avoids 0.4 - 0.3 = 0.09999999999999998', () => {
    expect(dSub(0.4, 0.3)).toBe(0.1)
  })

  it('returns negative when b > a', () => {
    expect(dSub(2, 5)).toBe(-3)
  })

  // Discount > subtotal scenario: the result is negative here. buildReceiptData
  // clamps it later — this is just the math primitive.
  it('does not clamp; produces negative when subtracted past zero', () => {
    expect(dSub(10, 30)).toBe(-20)
  })
})

describe('dMul', () => {
  it('avoids 0.1 * 0.2 = 0.020000000000000004', () => {
    expect(dMul(0.1, 0.2)).toBe(0.02)
  })

  // Line total: 250г at 12.50 TJS / 100г → (12.50 / 100) * 250 = 31.25
  it('handles realistic price * qty', () => {
    expect(dMul(12.5, 2.5)).toBe(31.25)
  })

  it('returns 0 for zero qty', () => {
    expect(dMul(99.99, 0)).toBe(0)
  })

  it('coerces non-finite to 0', () => {
    // @ts-expect-error
    expect(dMul(null, 10)).toBe(0)
    expect(dMul(Infinity, 10)).toBe(0)
  })
})

describe('dDiv', () => {
  // Weight items hit this constantly: price-per-100g divided by 100.
  it('avoids floating drift for common divisions', () => {
    expect(dDiv(1, 10)).toBe(0.1)
    expect(dDiv(7, 10)).toBe(0.7)
  })

  // CRITICAL: division by zero returns 0 instead of Infinity / NaN. Without
  // this guard the receipt total goes blank or shows "NaN TJS".
  it('returns 0 when dividing by zero', () => {
    expect(dDiv(100, 0)).toBe(0)
  })

  it('returns 0 when dividing by undefined/null/NaN', () => {
    // @ts-expect-error
    expect(dDiv(100, null)).toBe(0)
    expect(dDiv(100, NaN)).toBe(0)
  })

  it('rounds repeating decimals at precision', () => {
    // 1/3 = 0.3333... — decimal.js with precision=20 returns a long decimal
    // that toNumber() rounds back to JS float. We just check it's close.
    const result = dDiv(1, 3)
    expect(result).toBeCloseTo(0.3333333333, 9)
  })
})

describe('dRound', () => {
  it('rounds to 2 decimals by default (TJS currency)', () => {
    expect(dRound(1.005)).toBe(1.01) // ROUND_HALF_UP
    expect(dRound(1.004)).toBe(1.0)
    expect(dRound(123.456)).toBe(123.46)
  })

  it('respects places argument', () => {
    expect(dRound(1.23456, 3)).toBe(1.235)
    expect(dRound(1.5, 0)).toBe(2)
  })

  // ROUND_HALF_UP is set globally — 0.5 rounds away from zero. Banker's
  // rounding would give 0 here. Pin the convention.
  it('rounds .5 up (away from zero)', () => {
    expect(dRound(0.5, 0)).toBe(1)
    expect(dRound(2.5, 0)).toBe(3)
  })

  it('coerces bad input to 0', () => {
    // @ts-expect-error
    expect(dRound(null)).toBe(0)
    expect(dRound(NaN)).toBe(0)
  })
})

describe('dSum', () => {
  it('sums an array without floating drift', () => {
    // 0.1 + 0.2 + 0.3 done naively is 0.6000000000000001
    expect(dSum([0.1, 0.2, 0.3])).toBe(0.6)
  })

  it('returns 0 for empty array', () => {
    expect(dSum([])).toBe(0)
  })

  it('skips null/undefined/NaN entries (treated as 0)', () => {
    // @ts-expect-error
    expect(dSum([10, null, 20, undefined, NaN])).toBe(30)
  })

  // Receipt subtotal scenario: 5 items at varying prices.
  it('sums realistic receipt lines', () => {
    expect(dSum([28.0, 45.0, 18.0, 8.0, 6.0])).toBe(105.0)
  })
})

describe('dLineTotal', () => {
  // piece items: price × qty (the most common branch)
  it('multiplies price × qty for piece items', () => {
    expect(dLineTotal(45, 2, 'piece')).toBe(90)
    expect(dLineTotal(45, 2)).toBe(90) // unit omitted defaults to piece
  })

  // weight items: price is per unitSize, qty is the actual grams sold
  it('scales weight items: price * (qty / unitSize)', () => {
    // 12 TJS / 100г, 250г sold → 30 TJS
    expect(dLineTotal(12, 250, 'g', 100)).toBe(30)
  })

  it('handles kg unit', () => {
    // 150 TJS/kg × 0.5kg → 75 (unitSize=1 default for kg)
    expect(dLineTotal(150, 0.5, 'kg', 1)).toBe(75)
  })

  // Defensive: a corrupted menu item with unitSize=0 must not divide-by-zero
  // and blank out the receipt.
  it('falls back to unitSize=1 when unitSize is 0 or missing', () => {
    expect(dLineTotal(10, 5, 'g', 0)).toBe(50)
    expect(dLineTotal(10, 5, 'g')).toBe(50)
  })
})
