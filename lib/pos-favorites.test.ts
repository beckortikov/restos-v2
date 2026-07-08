import { describe, it, expect, beforeEach } from 'vitest'
import { getFavorites, isFavorite, toggleFavorite } from './pos-favorites'

const RID = 'rest-1'

describe('pos-favorites', () => {
  beforeEach(() => window.localStorage.clear())

  it('пустой список по умолчанию', () => {
    expect(getFavorites(RID)).toEqual([])
    expect(isFavorite(RID, 'x')).toBe(false)
  })

  it('toggle добавляет (→true) и удаляет (→false)', () => {
    expect(toggleFavorite(RID, 'x')).toBe(true)
    expect(isFavorite(RID, 'x')).toBe(true)
    expect(getFavorites(RID)).toEqual(['x'])
    expect(toggleFavorite(RID, 'x')).toBe(false)
    expect(isFavorite(RID, 'x')).toBe(false)
    expect(getFavorites(RID)).toEqual([])
  })

  it('несколько id сохраняются в порядке добавления', () => {
    toggleFavorite(RID, 'a')
    toggleFavorite(RID, 'b')
    expect(getFavorites(RID)).toEqual(['a', 'b'])
  })

  it('разные рестораны изолированы', () => {
    toggleFavorite('r1', 'x')
    expect(getFavorites('r1')).toEqual(['x'])
    expect(getFavorites('r2')).toEqual([])
  })

  it('пустой restaurantId не пишет и читается пустым', () => {
    toggleFavorite('', 'x')
    expect(getFavorites('')).toEqual([])
  })

  it('битый JSON в localStorage не роняет чтение', () => {
    window.localStorage.setItem('restos-pos-favorites:rr', '{not json')
    expect(getFavorites('rr')).toEqual([])
  })

  it('не-массив в localStorage → []', () => {
    window.localStorage.setItem('restos-pos-favorites:rr', '"строка"')
    expect(getFavorites('rr')).toEqual([])
  })
})
