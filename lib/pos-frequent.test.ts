import { describe, it, expect, beforeEach } from 'vitest'
import { getFrequent, isFrequent, toggleFrequent } from './pos-frequent'
import { getFavorites, toggleFavorite } from './pos-favorites'

const RID = 'rest-1'

describe('pos-frequent', () => {
  beforeEach(() => window.localStorage.clear())

  it('пустой по умолчанию', () => {
    expect(getFrequent(RID)).toEqual([])
    expect(isFrequent(RID, 'x')).toBe(false)
  })

  it('toggle добавляет и удаляет', () => {
    expect(toggleFrequent(RID, 'x')).toBe(true)
    expect(getFrequent(RID)).toEqual(['x'])
    expect(toggleFrequent(RID, 'x')).toBe(false)
    expect(getFrequent(RID)).toEqual([])
  })

  it('«частые» и «избранное» — независимые списки (не мешают друг другу)', () => {
    toggleFrequent(RID, 'a')
    toggleFavorite(RID, 'b')
    expect(getFrequent(RID)).toEqual(['a'])
    expect(getFavorites(RID)).toEqual(['b'])
  })
})
