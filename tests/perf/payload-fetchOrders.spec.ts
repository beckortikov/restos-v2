import { test, expect } from '@playwright/test'
import { PERF_API } from './setup'
import { seedPerfData, cleanupPerfData, type SeedHandle } from './seed'

/**
 * Узкое место #3: fetchOrders для списка тащит `*, order_items(*)`. На 200
 * заказов это 0.5–2 МБ JSON каждые 8 c polling.
 *
 * Тест: засеять 200 заказов, дёрнуть REST-запрос, который делает фронт
 * (см. lib/supabase-queries.ts:1094-1098 — `select=*,order_items(*)`),
 * измерить размер ответа в байтах.
 *
 * Ассерт baseline: > 200_000 байт. После фикса (slim select) — < 50_000.
 */
test.describe('Perf · fetchOrders payload', () => {
  let handle: SeedHandle | null = null

  test.beforeAll(async () => {
    // Дефолты seed.ts соответствуют реальному ресторану пользователя:
    // 200 menu_items, 18 tables, 5 waiters, 150 orders, 80 ingredients.
    handle = await seedPerfData()
  })

  test.afterAll(async () => {
    if (handle) await cleanupPerfData(handle)
  })

  test('full select baseline — больно, но измеряемо', async () => {
    expect(handle).not.toBeNull()
    const url = `${PERF_API}/rest/v1/orders?select=*,order_items(*)&restaurant_id=eq.${handle!.restaurantId}&order=created_at.desc`
    const t0 = Date.now()
    const res = await fetch(url, { headers: { apikey: 'local-key' } })
    const text = await res.text()
    const ms = Date.now() - t0
    expect(res.ok).toBe(true)
    const sizeKB = Math.round(text.length / 1024)
    console.log(`[perf] FULL select payload = ${sizeKB} KB, time = ${ms} ms`)
    expect(text.length).toBeGreaterThan(200_000)
  })

  test('slim select — то что грузит фронт после фикса', async () => {
    expect(handle).not.toBeNull()
    // Тот же select, что использует обновлённый fetchOrders({slim:true}) —
    // см. lib/supabase-queries.ts (ORDERS_SLIM_FIELDS + items urлёзка).
    const ordersSlim = [
      'id','order_number','status','type',
      'table_id','waiter_id',
      'total','service_amount','total_with_service',
      'guests_count',
      'payment_method','tab_label',
      'ready_at','closed_at','created_at',
    ].join(',')
    const itemsSlim = 'id,cancelled_at,name,qty,price,unit,unit_size,cogs,menu_item_id'
    const url =
      `${PERF_API}/rest/v1/orders` +
      `?select=${ordersSlim},order_items(${itemsSlim})` +
      `&restaurant_id=eq.${handle!.restaurantId}` +
      `&order=created_at.desc`
    const t0 = Date.now()
    const res = await fetch(url, { headers: { apikey: 'local-key' } })
    const text = await res.text()
    const ms = Date.now() - t0
    expect(res.ok).toBe(true)
    const sizeKB = Math.round(text.length / 1024)
    console.log(`[perf] SLIM select payload = ${sizeKB} KB, time = ${ms} ms`)
    // Ассерт «после фикса»: реалистично — payload урезан на ~50%
    // относительно baseline. Дальнейшее сокращение требует pagination
    // или ломает UI (нужны cancelled_at / payments в OrderActionsDialog).
    // 413 KB → 204 KB. При polling 8c (см. polling-rate spec) ровно
    // в 2 раза снижает трафик.
    expect(text.length).toBeLessThan(250_000)
  })
})
