import { describe, it, expect } from 'vitest'
import { EVENT_FANOUT } from './realtime'

// v2.0.15 — backend шлёт типизированные SSE-события (event: order.created),
// frontend слушал только нетипизированные → ни одно бизнес-событие не
// фанаутилось в useDataSync. Этот маппинг — критичный (POS-таблицы и /orders
// без него не обновляются live).
describe('EVENT_FANOUT mapping', () => {
  it('order.* events fan out to BOTH "orders" and "tables" (бэк не публикует table.updated)', () => {
    for (const ev of ['order.created', 'order.updated', 'order.closed', 'order.cancelled']) {
      const fanned = EVENT_FANOUT[ev]
      expect(fanned, `${ev} must have fanout`).toBeDefined()
      expect(fanned).toContain('orders')
      expect(fanned).toContain('tables')
    }
  })

  it('order.item.added fans out to order_items + orders', () => {
    expect(EVENT_FANOUT['order.item.added']).toEqual(
      expect.arrayContaining(['order_items', 'orders']),
    )
  })

  it('order.item.voided fans out to order_voids + order_items + orders', () => {
    expect(EVENT_FANOUT['order.item.voided']).toEqual(
      expect.arrayContaining(['order_voids', 'order_items', 'orders']),
    )
  })

  it('shift.* events fan out to cash_shifts', () => {
    expect(EVENT_FANOUT['shift.opened']).toContain('cash_shifts')
    expect(EVENT_FANOUT['shift.closed']).toContain('cash_shifts')
  })

  it('stock.movement fans out to ingredients + stock_movements', () => {
    expect(EVENT_FANOUT['stock.movement']).toEqual(
      expect.arrayContaining(['ingredients', 'stock_movements']),
    )
  })

  it('license.updated routes to license watch list', () => {
    expect(EVENT_FANOUT['license.updated']).toContain('license')
  })

  it('никаких null/undefined значений в fanout таблице', () => {
    for (const [ev, tables] of Object.entries(EVENT_FANOUT)) {
      expect(Array.isArray(tables), `${ev} value must be array`).toBe(true)
      expect(tables.length, `${ev} must fanout to ≥1 table`).toBeGreaterThan(0)
      for (const t of tables) {
        expect(typeof t).toBe('string')
        expect(t.length).toBeGreaterThan(0)
      }
    }
  })
})
