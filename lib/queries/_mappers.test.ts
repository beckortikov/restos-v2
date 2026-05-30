import { describe, it, expect } from 'vitest'
import { _mapBackendOrderStatus, ACTIVE_ORDER_STATUSES } from './_mappers'

// v2.0.14 — backend хранит статус 'open'/'closed', FE OrderStatus enum
// знает только 'new'/'cooking'/.../'done'/'cancelled'. Без маппинга
// STATUS_STYLE[status] возвращал undefined и .bg падал в дочернем
// компоненте OrderActionsDialog.
describe('_mapBackendOrderStatus', () => {
  it('maps backend "open" → "new"', () => {
    expect(_mapBackendOrderStatus('open')).toBe('new')
  })

  it('maps backend "closed" → "done"', () => {
    expect(_mapBackendOrderStatus('closed')).toBe('done')
  })

  it('passes through valid FE statuses unchanged', () => {
    for (const s of ['new', 'cooking', 'ready', 'served', 'bill_requested', 'done', 'cancelled']) {
      expect(_mapBackendOrderStatus(s)).toBe(s)
    }
  })

  it('falls back to "new" for unknown/empty/null/undefined values', () => {
    expect(_mapBackendOrderStatus('paid')).toBe('new')          // legacy/future status
    expect(_mapBackendOrderStatus('')).toBe('new')
    expect(_mapBackendOrderStatus(null)).toBe('new')
    expect(_mapBackendOrderStatus(undefined)).toBe('new')
    expect(_mapBackendOrderStatus(0)).toBe('new')
    expect(_mapBackendOrderStatus({})).toBe('new')
  })
})

// v2.0.16 — fetchTables фильтрует raw backend status'ы по этому списку.
// Backend пишет 'open' для новых заказов; без него filter выкидывал все
// активные заказы → t.currentOrderIds = [] → группы не показывались в POS.
describe('ACTIVE_ORDER_STATUSES', () => {
  it('includes raw backend "open" status (regression for v2.0.16)', () => {
    expect(ACTIVE_ORDER_STATUSES).toContain('open')
  })

  it('includes all FE-side active statuses', () => {
    for (const s of ['new', 'cooking', 'ready', 'served', 'bill_requested']) {
      expect(ACTIVE_ORDER_STATUSES).toContain(s)
    }
  })

  it('excludes terminal statuses', () => {
    expect(ACTIVE_ORDER_STATUSES).not.toContain('done')
    expect(ACTIVE_ORDER_STATUSES).not.toContain('closed')
    expect(ACTIVE_ORDER_STATUSES).not.toContain('cancelled')
  })
})
