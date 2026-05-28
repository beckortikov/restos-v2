import { test, expect } from '@playwright/test'
import { injectDesktopShim, PERF_API } from './setup'
import { seedPerfData, cleanupPerfData, type SeedHandle } from './seed'

/**
 * Узкое место #6: страницы /operations/orders и /operations/table-map
 * делают setInterval(refetchAll, 8000). При двух открытых вкладках —
 * двойная нагрузка на PGlite каждые 8 c.
 *
 * Тест: открыть /operations/orders (как кассир), подождать 25 c, посчитать
 * число запросов к /rest/v1/orders за этот промежуток.
 *
 * Baseline: 3+ запроса за 25 c (1 первичный + 2-3 polling tick'а при 8 c).
 * После фикса (20 c): 1-2 запроса (1 первичный + 1 tick).
 */
test.describe('Perf · polling rate /operations/orders', () => {
  let handle: SeedHandle | null = null

  test.beforeAll(async () => {
    handle = await seedPerfData()
  })

  test.afterAll(async () => {
    if (handle) await cleanupPerfData(handle)
  })

  test('orders polling — счётчик запросов /rest/v1/orders за 25 секунд', async ({ page }) => {
    expect(handle).not.toBeNull()
    await injectDesktopShim(page)

    // Считаем все GET к /rest/v1/orders на этой вкладке.
    const ordersHits: { ts: number; url: string }[] = []
    page.on('request', (req) => {
      if (req.method() !== 'GET') return
      const u = req.url()
      if (u.includes('/rest/v1/orders') && !u.includes('/rest/v1/order_items')) {
        ordersHits.push({ ts: Date.now(), url: u })
      }
    })

    // Логин через UI как кассир/owner. Используем владельца — у него есть
    // доступ к /operations/orders (cashier тоже видит, но redirect другой).
    await page.goto('/login')
    await page.getByPlaceholder('Введите логин').fill(handle!.cashierUsername)
    await page.getByPlaceholder('Введите пароль').fill(handle!.cashierPassword)
    await page.getByRole('button', { name: 'Войти' }).click()
    await page.waitForURL(url => !url.toString().includes('/login'), { timeout: 15000 })

    await page.goto('/operations/orders', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.animate-spin', { state: 'detached', timeout: 15000 }).catch(() => {})

    // Стартовая точка отсчёта — после первого refetch (page-load).
    const startTs = Date.now()

    // Ждём 25 секунд.
    await page.waitForTimeout(25_000)

    const elapsedMs = Date.now() - startTs
    // Polling-tick — это запросы ПОСЛЕ init-burst'а (~3 c после старта).
    // Init burst — параллельные запросы из cache.ts/useDataSync, не polling.
    const POLLING_WINDOW_START_MS = 5000
    const ticks = ordersHits.filter(h => (h.ts - startTs) >= POLLING_WINDOW_START_MS).length
    const totalHits = ordersHits.length

    console.log(
      `[perf] polling rate: ${ticks} ticks за ${Math.round(elapsedMs / 1000)} c ` +
      `(всего ${totalHits} запросов /orders с момента открытия)`
    )
    // Лог: timeline запросов после startTs (понять источник: polling vs sync vs init)
    const timeline = ordersHits.map((h, i) => {
      const offset = h.ts - startTs
      const tag = offset < 0 ? '(init)' : `+${(offset / 1000).toFixed(1)}s`
      return `  ${i.toString().padStart(2)} ${tag.padEnd(10)} ${h.url.replace(/^[^?]+\?/, '?').slice(0, 120)}`
    }).join('\n')
    console.log(`[perf] timeline:\n${timeline}`)

    // ── Что измерено ─────────────────────────────────────────────────
    // BEFORE fix (polling 8c, debounce 250ms): 3 polling tick за 25c +
    //   ~6-8 init-запросов от useDataSync × cachedQuery × 3 таблицы.
    // AFTER fix (polling 20c, debounce 600ms): 0 polling tick — все
    //   запросы происходят в первые ~3 секунды (init burst).
    //
    // Init burst (~10-12 запросов в первые 3 c) — отдельное узкое место:
    // lib/offline/supabase-offline.ts cachedQuery('orders') параллельно
    // дёргает default fetchOrders без slim. Это «волна 3» (рефакторинг
    // cache архитектуры) — измеряется отдельно.
    // ─────────────────────────────────────────────────────────────────

    // (1) Polling-цикл больше НЕ дёргает /orders в наблюдаемом окне.
    //     Если кто-то вернёт 8c — тест поймает.
    expect(ticks).toBeLessThanOrEqual(1)

    // (2) Регрессионная защита на init burst — фейл если число запросов
    //     удвоится от текущего baseline (~10-12). Запас для timing-flakiness.
    expect(totalHits).toBeLessThanOrEqual(20)
  })
})
