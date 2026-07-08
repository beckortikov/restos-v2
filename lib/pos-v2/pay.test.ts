import { describe, it, expect } from 'vitest'
import { discountAmount, payable } from './pay'

// Скидка + сумма к оплате. Критично: бэк строго валидирует
// sum(payments) == payable (допуск 0.01), поэтому клиент обязан показать
// ту же цифру, что закроет сервер.

describe('discountAmount', () => {
  it('none → 0', () => {
    expect(discountAmount(200, 'none', 50)).toBe(0)
  })
  it('percent от базы', () => {
    expect(discountAmount(200, 'percent', 10)).toBe(20)
  })
  it('percent клампится к 100 %', () => {
    expect(discountAmount(200, 'percent', 150)).toBe(200)
  })
  it('fixed — как есть', () => {
    expect(discountAmount(200, 'fixed', 30)).toBe(30)
  })
  it('fixed клампится к базе (нельзя списать больше суммы)', () => {
    expect(discountAmount(200, 'fixed', 500)).toBe(200)
  })
  it('нулевое/отрицательное значение → 0', () => {
    expect(discountAmount(200, 'percent', 0)).toBe(0)
    expect(discountAmount(200, 'fixed', -10)).toBe(0)
  })
  it('база 0 → 0', () => {
    expect(discountAmount(0, 'percent', 10)).toBe(0)
  })
  it('percent округляется half-up до копеек', () => {
    // 33.33 × 10% = 3.333 → 3.33
    expect(discountAmount(33.33, 'percent', 10)).toBe(3.33)
  })
})

describe('payable', () => {
  it('без скидки и сервиса = подытог', () => {
    expect(payable(200, 0, 0)).toBe(200)
  })
  it('вычитает скидку', () => {
    expect(payable(200, 20, 0)).toBe(180)
  })
  it('прибавляет сервис к базе', () => {
    expect(payable(200, 0, 10)).toBe(220)
  })
  it('сервис считается от базы ПОСЛЕ скидки', () => {
    // (200 − 20) = 180, +10% = 198
    expect(payable(200, 20, 10)).toBe(198)
  })
  it('сервис округляется half-up до копеек', () => {
    // 33.33 + 10% = 36.663 → 36.66
    expect(payable(33.33, 0, 10)).toBe(36.66)
  })
  it('servicePercent 0 не трогает сумму (даже с дробями)', () => {
    expect(payable(19.99, 5, 0)).toBe(14.99)
  })
})
