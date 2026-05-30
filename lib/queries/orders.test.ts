import { describe, it, expect, vi, beforeEach } from 'vitest'

// v2.0.18 — /operations/orders грузит список через fetchOrders({ slim: true })
// для скорости. Когда пользователь кликает по заказу, OrderActionsDialog
// нужны items для расчёта чека/COGS. handleOpenOrder теперь догружает full.
//
// Покрываем поведение fetchOrders по slim-флагу: slim:true → 1 GET (без
// деталей), slim:false → 1 GET + N detail-GET'ов.

const mockGET = vi.fn()
vi.mock('./_client', () => ({
  api: { GET: (...args: any[]) => mockGET(...args) },
  // unwrap просто возвращает .data поля из openapi-fetch-style ответа.
  unwrap: async (p: Promise<{ data?: any; error?: any }>) => {
    const r = await p
    if (r.error) throw r.error
    return r.data
  },
  V4Error: class V4Error extends Error {},
}))

// audit logger — побочный эффект; в тесте не нужен.
vi.mock('./audit', () => ({ logAction: vi.fn() }))

import { fetchOrders } from './orders'

describe('fetchOrders — slim vs full', () => {
  beforeEach(() => {
    mockGET.mockReset()
  })

  it('slim:true → один GET к /orders, items пустые', async () => {
    mockGET.mockResolvedValueOnce({
      data: { data: [{ id: 'o1', status: 'open', total: '10', created_at: '2026-01-01' }] },
    })

    const out = await fetchOrders({ slim: true })

    expect(mockGET).toHaveBeenCalledTimes(1)
    expect(mockGET.mock.calls[0][0]).toBe('/api/v1/orders')
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe('o1')
    expect(out[0].items).toEqual([])
  })

  it('slim:false (default) → list + per-row detail GET; items приходят', async () => {
    mockGET
      .mockResolvedValueOnce({ data: { data: [{ id: 'o1', status: 'open', total: '50', created_at: '2026-01-01' }] } })
      .mockResolvedValueOnce({ data: { order: { id: 'o1', status: 'open', total: '50', created_at: '2026-01-01' }, items: [{ id: 'i1', menu_item_id: 'mi1', name: 'Plov', qty: '2', price: '25' }] } })

    const out = await fetchOrders({ slim: false })

    expect(mockGET).toHaveBeenCalledTimes(2)
    expect(mockGET.mock.calls[0][0]).toBe('/api/v1/orders')
    expect(mockGET.mock.calls[1][0]).toBe('/api/v1/orders/{id}')
    expect(out[0].items).toHaveLength(1)
    expect(out[0].items[0].name).toBe('Plov')
  })

  it('slim:false по ids=[X] делает targeted detail-fetch только для X', async () => {
    mockGET
      .mockResolvedValueOnce({
        data: { data: [
          { id: 'o1', status: 'open', total: '10', created_at: '2026-01-01' },
          { id: 'o2', status: 'open', total: '20', created_at: '2026-01-01' },
        ] },
      })
      .mockResolvedValueOnce({ data: { order: { id: 'o2' }, items: [{ id: 'i', menu_item_id: 'm', name: 'X', qty: '1', price: '20' }] } })

    const out = await fetchOrders({ ids: ['o2'], slim: false })

    expect(out).toHaveLength(1)
    expect(out[0].id).toBe('o2')
    expect(out[0].items[0].name).toBe('X')
    // detail-fetch только по o2 (после filter по ids).
    expect(mockGET).toHaveBeenCalledTimes(2)
    expect(mockGET.mock.calls[1][1]?.params?.path?.id).toBe('o2')
  })

  it('detail-fetch падение НЕ убивает весь запрос — возвращаем slim-ряд без items', async () => {
    mockGET
      .mockResolvedValueOnce({ data: { data: [{ id: 'o1', status: 'open', total: '10', created_at: '2026-01-01' }] } })
      .mockRejectedValueOnce(new Error('boom'))

    const out = await fetchOrders({ slim: false })

    expect(out).toHaveLength(1)
    expect(out[0].id).toBe('o1')
    expect(out[0].items).toEqual([])
  })
})
