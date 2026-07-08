// Чистая логика скидки и суммы к оплате /pos2 — вынесена из
// app/pos2/pay/page.tsx. Бэк сам пересчитывает total/service/discount и
// строго валидирует sum(payments) == total; клиент должен показать ту же
// цифру, что закроет сервер, иначе оплата упадёт с mismatch.

import { dSub, dAdd, dMul, dDiv, dRound } from '@/lib/decimal'

export type DiscountType = 'none' | 'percent' | 'fixed'

/** Скидка в деньгах от базы (подытог заказа).
 *  percent клампится к 100 %, fixed — к базе (не больше суммы заказа). */
export function discountAmount(base: number, type: DiscountType, value: number): number {
  if (type === 'none' || !(value > 0) || !(base > 0)) return 0
  return type === 'percent'
    ? dRound(dMul(base, dDiv(Math.min(value, 100), 100)))
    : Math.min(value, base)
}

/** К оплате = (подытог − скидка) + обслуживание.
 *  servicePercent должен быть уже 0, если это не зал или сервис выключен. */
export function payable(subtotal: number, discAmt: number, servicePercent: number): number {
  const base = dSub(subtotal, discAmt)
  return servicePercent > 0
    ? dRound(dAdd(base, dMul(base, dDiv(servicePercent, 100))))
    : base
}
