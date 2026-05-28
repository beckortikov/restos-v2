import Decimal from 'decimal.js'

// Configure for financial calculations
Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP })

// decimal.js throws "Invalid argument: undefined/null/NaN" when fed bad input.
// In real data (e.g. shift.opening_balance, account.balance) we sometimes get
// null from the DB or undefined from a partial fetch. Coerce to 0 instead of
// crashing the whole UI — the value will still be wrong, but the user can
// continue working and see the issue in the surfaced number.
function safe(n: unknown): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 0
  return n
}

/** Multiply two numbers precisely: dMul(0.1, 0.2) = 0.02 */
export function dMul(a: number, b: number): number {
  return new Decimal(safe(a)).mul(safe(b)).toNumber()
}

/** Divide two numbers precisely: dDiv(1, 3) = 0.3333... rounded */
export function dDiv(a: number, b: number): number {
  const sb = safe(b)
  if (sb === 0) return 0
  return new Decimal(safe(a)).div(sb).toNumber()
}

/** Subtract precisely: dSub(0.4, 0.3) = 0.1 (not 0.09999...) */
export function dSub(a: number, b: number): number {
  return new Decimal(safe(a)).sub(safe(b)).toNumber()
}

/** Add precisely: dAdd(0.1, 0.2) = 0.3 (not 0.30000000000000004) */
export function dAdd(a: number, b: number): number {
  return new Decimal(safe(a)).add(safe(b)).toNumber()
}

/** Round to N decimal places (default 2 for currency) */
export function dRound(n: number, places: number = 2): number {
  return new Decimal(safe(n)).toDecimalPlaces(places, Decimal.ROUND_HALF_UP).toNumber()
}

/** Sum an array of numbers precisely */
export function dSum(nums: number[]): number {
  return nums.reduce((acc, n) => new Decimal(acc).add(safe(n)), new Decimal(0)).toNumber()
}

/** Calculate line total: price * qty, or price * (qty / unitSize) for weighted items */
export function dLineTotal(price: number, qty: number, unit?: string, unitSize?: number): number {
  if (unit === 'piece' || !unit) return dMul(price, qty)
  const size = unitSize && unitSize > 0 ? unitSize : 1
  return dMul(price, dDiv(qty, size))
}
