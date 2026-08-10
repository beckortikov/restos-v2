import { describe, it, expect } from 'vitest'
import { aggregate, cookProgress, splitBoard, COOK_TARGET_MIN, type BoardOrder } from './board-logic'
import type { KdsBoardItem } from '@/lib/queries'

function item(p: Partial<KdsBoardItem>): KdsBoardItem {
  return {
    id: Math.random().toString(36).slice(2),
    orderId: 'o',
    orderNumber: 1,
    orderType: 'takeaway',
    name: 'Бургер',
    qty: '1',
    stationStatus: 'pending',
    createdAt: '2026-08-10T10:00:00Z',
    statusAt: '2026-08-10T10:00:00Z',
    ageSeconds: 0,
    ...p,
  }
}

describe('aggregate — свёртка per-dish позиций в заказы', () => {
  it('заказ «готовится», пока есть хоть одна позиция pending/cooking', () => {
    const [o] = aggregate([
      item({ orderNumber: 7, stationStatus: 'ready' }),
      item({ orderNumber: 7, stationStatus: 'cooking' }), // ← одна ещё готовится
    ])
    expect(o.orderNumber).toBe(7)
    expect(o.cooking).toBe(true)
  })

  it('заказ «готов», когда ВСЕ оставшиеся позиции ready', () => {
    const [o] = aggregate([
      item({ orderNumber: 7, stationStatus: 'ready', statusAt: '2026-08-10T10:05:00Z' }),
      item({ orderNumber: 7, stationStatus: 'ready', statusAt: '2026-08-10T10:06:00Z' }),
    ])
    expect(o.cooking).toBe(false)
    // readyAt = максимальный status_at готовых позиций (когда доготовилась последняя)
    expect(o.readyAt).toBe('2026-08-10T10:06:00Z')
  })

  it('pending считается «готовится» (повар ещё не взял в работу)', () => {
    const [o] = aggregate([item({ orderNumber: 3, stationStatus: 'pending' })])
    expect(o.cooking).toBe(true)
  })

  it('maxAgeSeconds — возраст самой старой позиции заказа', () => {
    const [o] = aggregate([
      item({ orderNumber: 3, ageSeconds: 40 }),
      item({ orderNumber: 3, ageSeconds: 120 }),
      item({ orderNumber: 3, ageSeconds: 90 }),
    ])
    expect(o.maxAgeSeconds).toBe(120)
  })

  it('разные номера — разные заказы; пустой orderNumber игнорируется', () => {
    const res = aggregate([
      item({ orderNumber: 1 }),
      item({ orderNumber: 2 }),
      item({ orderNumber: 0 }), // не должно создать заказ
    ])
    expect(res.map(o => o.orderNumber).sort()).toEqual([1, 2])
  })
})

describe('splitBoard — раскладка на колонки', () => {
  it('«готовится» — старейший вверху, «готово» — свежеготовый первым', () => {
    const orders: BoardOrder[] = [
      { orderNumber: 1, cooking: true, maxAgeSeconds: 30, readyAt: '' },
      { orderNumber: 2, cooking: true, maxAgeSeconds: 300, readyAt: '' },
      { orderNumber: 3, cooking: false, maxAgeSeconds: 0, readyAt: '2026-08-10T10:01:00Z' },
      { orderNumber: 4, cooking: false, maxAgeSeconds: 0, readyAt: '2026-08-10T10:09:00Z' },
    ]
    const { cooking, ready } = splitBoard(orders)
    expect(cooking.map(o => o.orderNumber)).toEqual([2, 1]) // 300с старше 30с → выше
    expect(ready.map(o => o.orderNumber)).toEqual([4, 3]) // 10:09 свежее 10:01 → первым
  })
})

describe('cookProgress — полоса готовки', () => {
  const base: BoardOrder = { orderNumber: 1, cooking: true, maxAgeSeconds: 0, readyAt: '' }

  it('зажата в [0.06, 0.97] — не пустая и не полная', () => {
    expect(cookProgress({ ...base, maxAgeSeconds: 0 }, 1000, 1000)).toBe(0.06)
    // возраст сильно больше цели → почти полная, но не 1
    expect(cookProgress({ ...base, maxAgeSeconds: COOK_TARGET_MIN * 60 * 5 }, 1000, 1000)).toBe(0.97)
  })

  it('на половине целевого времени полоса ≈ 0.5', () => {
    const half = (COOK_TARGET_MIN * 60) / 2 // секунд = половина цели
    const p = cookProgress({ ...base, maxAgeSeconds: half }, 5000, 5000)
    expect(p).toBeCloseTo(0.5, 2)
  })

  it('иммунно к абсолютным часам ТВ: растёт по дельте локального времени', () => {
    // ageSeconds=60 на момент загрузки (dataUpdatedAt), прошло ещё 60с локально
    const o = { ...base, maxAgeSeconds: 60 }
    const dataUpdatedAt = 1_000_000
    const p1 = cookProgress(o, dataUpdatedAt, dataUpdatedAt) // 60с
    const p2 = cookProgress(o, dataUpdatedAt + 60_000, dataUpdatedAt) // 120с
    expect(p2).toBeGreaterThan(p1)
    // 120с из 480с целевых = 0.25
    expect(p2).toBeCloseTo(0.25, 2)
  })
})
