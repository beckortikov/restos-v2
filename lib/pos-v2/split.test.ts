import { describe, it, expect } from 'vitest'
import { buildItemAssignments, isSplitValid } from './split'

describe('buildItemAssignments', () => {
  it('группирует позиции по назначенной части', () => {
    const a = buildItemAssignments(['a', 'b', 'c'], { a: 1, b: 2, c: 2 }, 2)
    expect(a).toEqual([
      { splitNumber: 1, items: [{ orderItemId: 'a' }] },
      { splitNumber: 2, items: [{ orderItemId: 'b' }, { orderItemId: 'c' }] },
    ])
  })

  it('позиции без назначения попадают в часть 1', () => {
    const a = buildItemAssignments(['a', 'b'], {}, 3)
    expect(a).toEqual([{ splitNumber: 1, items: [{ orderItemId: 'a' }, { orderItemId: 'b' }] }])
  })

  it('пустые части опускаются', () => {
    const a = buildItemAssignments(['a', 'b'], { a: 1, b: 3 }, 3)
    expect(a.map(g => g.splitNumber)).toEqual([1, 3])
  })

  it('часть за пределом диапазона клампится, позиция НЕ теряется', () => {
    // Пользователь назначил на часть 3, потом уменьшил число частей до 2.
    // Позиция b должна упасть в часть 2, а не исчезнуть из счёта.
    const a = buildItemAssignments(['a', 'b'], { a: 1, b: 3 }, 2)
    const allIds = a.flatMap(g => g.items.map(i => i.orderItemId))
    expect(allIds.sort()).toEqual(['a', 'b'])
    expect(a.find(g => g.splitNumber === 2)?.items).toEqual([{ orderItemId: 'b' }])
  })

  it('каждая позиция попадает ровно в одну часть (ничего не дублируется и не теряется)', () => {
    const ids = ['a', 'b', 'c', 'd']
    const a = buildItemAssignments(ids, { a: 1, b: 2, c: 1, d: 2 }, 2)
    const allIds = a.flatMap(g => g.items.map(i => i.orderItemId))
    expect(allIds.sort()).toEqual(ids)
  })

  it('часть 0/отрицательная → часть 1', () => {
    const a = buildItemAssignments(['a'], { a: 0 }, 2)
    expect(a).toEqual([{ splitNumber: 1, items: [{ orderItemId: 'a' }] }])
  })

  it('пустой список → []', () => {
    expect(buildItemAssignments([], {}, 3)).toEqual([])
  })
})

describe('isSplitValid', () => {
  it('≥2 непустых частей → валидно', () => {
    expect(isSplitValid(buildItemAssignments(['a', 'b'], { a: 1, b: 2 }, 2))).toBe(true)
  })
  it('всё в одной части → невалидно', () => {
    expect(isSplitValid(buildItemAssignments(['a', 'b'], {}, 3))).toBe(false)
  })
  it('пусто → невалидно', () => {
    expect(isSplitValid([])).toBe(false)
  })
})
