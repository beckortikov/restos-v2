import { describe, it, expect } from 'vitest'
import { _mapBackendOrderStatus, ACTIVE_ORDER_STATUSES, calcCogsFromTechCard, previewTechCardCogs } from './_mappers'

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

// Зеркалит server/internal/service/menu_cogs_test.go — те же кейсы, та же
// формула (см. techCardCogs.go комментарий "Зеркалит...").
describe('calcCogsFromTechCard', () => {
  it('считает базовый случай: 100 г по 100/кг → 10', () => {
    const lines = [{ ingredient_id: 'ing1', qty: 100, unit: 'г' }]
    const prices = new Map([['ing1', { price: 100, unit: 'кг', wastePercent: 0 }]])
    expect(calcCogsFromTechCard(lines, prices)).toBe(10)
  })

  it('учитывает отходы: 100 г при waste=20% → 125 г × 100/кг = 12.5', () => {
    const lines = [{ ingredient_id: 'ing1', qty: 100, unit: 'г' }]
    const prices = new Map([['ing1', { price: 100, unit: 'кг', wastePercent: 20 }]])
    expect(calcCogsFromTechCard(lines, prices)).toBe(12.5)
  })

  it('waste >= 100% не даёт Infinity/NaN — поправка не применяется', () => {
    const lines = [{ ingredient_id: 'ing1', qty: 100, unit: 'г' }]
    const prices100 = new Map([['ing1', { price: 100, unit: 'кг', wastePercent: 100 }]])
    const prices150 = new Map([['ing1', { price: 100, unit: 'кг', wastePercent: 150 }]])
    expect(calcCogsFromTechCard(lines, prices100)).toBe(10)
    expect(calcCogsFromTechCard(lines, prices150)).toBe(10)
  })

  it('несводимые единицы (г → шт без unitWeight) — строка пропущена, не qty-как-есть', () => {
    const lines = [{ ingredient_id: 'ing1', qty: 200, unit: 'г' }]
    const prices = new Map([['ing1', { price: 50, unit: 'шт', wastePercent: 0 }]])
    expect(calcCogsFromTechCard(lines, prices)).toBe(0)
  })

  it('штучный ингредиент с unitWeight конвертируется через фактор: 34г при 340г/шт по 50/шт → 5', () => {
    const lines = [{ ingredient_id: 'ing1', qty: 34, unit: 'г' }]
    const prices = new Map([['ing1', { price: 50, unit: 'шт', wastePercent: 0, unitWeight: 340, unitWeightUnit: 'г' }]])
    expect(calcCogsFromTechCard(lines, prices)).toBe(5)
  })

  it('п/ф с несводимой единицей — пропущен, не qty-как-есть', () => {
    const lines = [{ semi_type_id: 'semi1', qty: 2, unit: 'шт' }]
    const semiPrices = new Map([['semi1', { price: 40, unit: 'кг' }]])
    expect(calcCogsFromTechCard(lines, new Map(), semiPrices)).toBe(0)
  })

  it('смешанная тех-карта: ингредиент + п/ф суммируются', () => {
    const lines = [
      { ingredient_id: 'ing1', qty: 100, unit: 'г' },
      { semi_type_id: 'semi1', qty: 0.5, unit: 'кг' },
    ]
    const prices = new Map([['ing1', { price: 100, unit: 'кг', wastePercent: 0 }]])
    const semiPrices = new Map([['semi1', { price: 40, unit: 'кг' }]])
    expect(calcCogsFromTechCard(lines, prices, semiPrices)).toBe(30)
  })
})

describe('previewTechCardCogs', () => {
  it('пустые/плейсхолдерные строки без ингредиента → 0', () => {
    expect(previewTechCardCogs([{ qty: 0, unit: '' }], [], [])).toBe(0)
  })

  it('считает превью из camelCase-строк формы и справочников Ingredient[]/SemiFinishedStock[]', () => {
    const lines = [{ ingredientId: 'ing1', qty: 300, unit: 'г' }]
    const ingredients = [{ id: 'ing1', pricePerUnit: 20, unit: 'кг', wastePercent: 0 }]
    expect(previewTechCardCogs(lines, ingredients, [])).toBe(6)
  })

  it('учитывает полуфабрикат из SemiFinishedStock[]', () => {
    const lines = [{ semiId: 'semi1', qty: 0.5, unit: 'кг' }]
    const semiStock = [{ semiTypeId: 'semi1', pricePerUnit: 40, unit: 'кг' }]
    expect(previewTechCardCogs(lines, [], semiStock)).toBe(20)
  })
})
