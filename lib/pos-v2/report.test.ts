import { describe, it, expect } from 'vitest'
import { deltaPct } from './report'

describe('deltaPct', () => {
  it('рост', () => {
    expect(deltaPct(120, 100)).toBe(20)
  })
  it('падение', () => {
    expect(deltaPct(80, 100)).toBe(-20)
  })
  it('без изменений → 0', () => {
    expect(deltaPct(100, 100)).toBe(0)
  })
  it('база 0 → null (нет с чем сравнивать)', () => {
    expect(deltaPct(50, 0)).toBeNull()
  })
  it('отрицательная база → null', () => {
    expect(deltaPct(50, -10)).toBeNull()
  })
  it('дробный процент', () => {
    expect(deltaPct(1, 3)).toBeCloseTo(-66.6667, 3)
  })
})
