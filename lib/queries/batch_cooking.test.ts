import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── ПРОБЛЕМА 2: ложное «Нет техкарты» у заготовочного блюда ────────────────
//
// Баг (со слов пользователя): «ингредиент в техкарте есть на складе и у блюда
// техкарта тоже есть, но при создании приготавливаемого блюда пишет, что нет
// техкарты, а после приготовления со склада списывается».
//
// Корень был — в calculateMaxPortions (lib/queries/batch_cooking.ts):
//   • поле `ingredients` строилось ТОЛЬКО из `blockers` (недостающие);
//   • экран решал «Нет техкарты» по `ingredients.length === 0`.
// Когда техкарта ЕСТЬ и остатка ХВАТАЕТ, blockers пуст → ingredients=[] →
// UI ложно показывал «Нет техкарты».
//
// Фикс: backend max-portions отдаёт has_recipe + полный ingredients; экран
// опирается на hasRecipe. Тесты ниже фиксируют этот контракт.

const mockGET = vi.fn()
vi.mock('./_client', () => ({
  api: { GET: (...args: any[]) => mockGET(...args) },
  unwrap: async (p: Promise<{ data?: any; error?: any }>) => {
    const r = await p
    if (r.error) throw r.error
    return r.data
  },
  // unwrapRaw отдаёт сырой ответ (нужен response.status) — повторяем поведение api/index.ts.
  unwrapRaw: async (p: Promise<any>) => await p,
  V4Error: class V4Error extends Error {
    constructor(public status: number, public payload: unknown) {
      super('v4error')
    }
  },
}))

// Побочные эффекты импорта модуля — гасим.
vi.mock('./audit', () => ({ logAction: vi.fn() }))
vi.mock('./stock', () => ({ checkAndUpdateStopList: vi.fn() }))

import { calculateMaxPortions } from './batch_cooking'

describe('calculateMaxPortions — Problem 2: ложное «Нет техкарты»', () => {
  beforeEach(() => {
    mockGET.mockReset()
  })

  it('блюдо С техкартой и достаточным остатком НЕ помечается как «без техкарты»', async () => {
    // Бэкенд: техкарта есть (Гуш 300 г), на складе 3 кг → 10 порций, blockers пуст.
    mockGET.mockResolvedValueOnce({
      response: { status: 200 },
      data: {
        max: 10,
        has_recipe: true,
        blockers: [],
        ingredients: [{
          ingredient_id: 'guhsh', name: 'Гуш', unit: 'кг', recipe_unit: 'г',
          stock_qty: '3', recipe_qty_per_portion: '300', possible_portions: 10, is_bottleneck: true,
        }],
      },
    })

    const res = await calculateMaxPortions('shashlyk')

    expect(res.maxPortions).toBe(10)
    expect(res.hasRecipe).toBe(true)
    // ingredients берётся из полного списка, а не из blockers — единицы реальные.
    expect(res.ingredients).toHaveLength(1)
    expect(res.ingredients[0].unit).toBe('кг')
    expect(res.ingredients[0].recipeUnit).toBe('г')
    expect(res.ingredients[0].stockQty).toBe(3)
  })

  it('блюдо БЕЗ техкарты помечается hasRecipe=false', async () => {
    // Для блюда без рецепта backend.MaxPortions возвращает sentinel max=MaxInt32.
    mockGET.mockResolvedValueOnce({
      response: { status: 200 },
      data: { max: 2147483647, has_recipe: false, ingredients: [], blockers: [] },
    })

    const res = await calculateMaxPortions('cola')

    // Нужно отличать «нет рецепта» от «рецепт есть, хватает остатка».
    expect(res.hasRecipe).toBe(false)
  })

  it('404 (рецепта нет вовсе) → hasRecipe=false', async () => {
    mockGET.mockResolvedValueOnce({
      response: { status: 404 },
      error: { code: 'NOT_FOUND' },
    })

    const res = await calculateMaxPortions('ghost')

    expect(res.maxPortions).toBe(0)
    expect(res.hasRecipe).toBe(false)
  })
})
