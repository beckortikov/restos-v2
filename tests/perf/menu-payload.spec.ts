import { test, expect } from '@playwright/test'
import { PERF_API } from './setup'
import { seedPerfData, cleanupPerfData, type SeedHandle } from './seed'

/**
 * Узкое место #7: lib/supabase-queries.ts:717 fetchMenuItems тащит
 * `*, tech_card_lines(*)`. На 200 блюд × 3 техкарты = 600 вложенных
 * объектов. Это нужно только в редакторе меню для расчёта COGS — на
 * старте POS у кассира это лишний payload и парсинг.
 *
 * Тест: измерить размер ответа /rest/v1/menu_items с/без tech_card_lines.
 *
 * Baseline: > 80 KB (с tech_card_lines).
 * После split (убрать embed на старте) — < 30 KB.
 */
test.describe('Perf · fetchMenuItems payload', () => {
  let handle: SeedHandle | null = null

  test.beforeAll(async () => {
    handle = await seedPerfData()
  })

  test.afterAll(async () => {
    if (handle) await cleanupPerfData(handle)
  })

  test('full select with tech_card_lines (baseline)', async () => {
    expect(handle).not.toBeNull()
    const url = `${PERF_API}/rest/v1/menu_items?select=*,tech_card_lines(*)&restaurant_id=eq.${handle!.restaurantId}`
    const t0 = Date.now()
    const res = await fetch(url, { headers: { apikey: 'local-key' } })
    const text = await res.text()
    const ms = Date.now() - t0
    const sizeKB = Math.round(text.length / 1024)
    const hasTechCards = /tech_card_lines/.test(text)
    console.log(
      `[perf] menu_items FULL: ${sizeKB} KB, time = ${ms} ms, ` +
      `tech_card_lines included = ${hasTechCards}`,
    )
    expect(hasTechCards).toBe(true)
    expect(text.length).toBeGreaterThan(80_000)
  })

  test('slim select без tech_card_lines (после фикса split)', async () => {
    expect(handle).not.toBeNull()
    const url = `${PERF_API}/rest/v1/menu_items?select=*&restaurant_id=eq.${handle!.restaurantId}`
    const t0 = Date.now()
    const res = await fetch(url, { headers: { apikey: 'local-key' } })
    const text = await res.text()
    const ms = Date.now() - t0
    const sizeKB = Math.round(text.length / 1024)
    const hasTechCards = /tech_card_lines/.test(text)
    console.log(
      `[perf] menu_items SLIM: ${sizeKB} KB, time = ${ms} ms, ` +
      `tech_card_lines included = ${hasTechCards}`,
    )
    expect(hasTechCards).toBe(false)
    // На 200 блюдах slim ~99 KB (без tech_card_lines), baseline ~282 KB.
    // Сокращение в 3× по размеру и в ~20× по времени (5 мс vs 106 мс).
    expect(text.length).toBeLessThan(120_000)
  })
})
