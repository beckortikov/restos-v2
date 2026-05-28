/**
 * REST seed для perf-тестов через локальный desktop standalone API на :3001.
 *
 * Все вставленные записи маркируются tab_label / name с уникальным runId,
 * чтобы cleanup в afterAll удалял точно своё.
 *
 * Не использует supabase-js (мы вне браузера), только нативный fetch.
 */
import { PERF_API } from './setup'

export interface SeedHandle {
  runId: string
  restaurantId: string
  cashierId: string
  cashierUsername: string
  cashierPassword: string
  zoneId: string
  tableIds: string[]
  menuItemIds: string[]
  ingredientIds: string[]
  orderIds: string[]
  account: { id: string; name: string }
}

interface SeedOpts {
  tables?: number
  menuItems?: number
  ingredients?: number
  waiters?: number
  orders?: number
  itemsPerOrder?: number
  enforceStockCheck?: boolean
  api?: string
}

// Дефолты под реальный размер ресторана пользователя:
// меню ~200 блюд, 18 столов, 4-5 официантов, ~150 заказов в день в час пик.
const DEFAULT_TABLES = 18
const DEFAULT_MENU = 200
const DEFAULT_WAITERS = 5
const DEFAULT_ORDERS = 150
const DEFAULT_INGREDIENTS = 80
const DEFAULT_ITEMS_PER_ORDER = 5

async function post<T = any>(api: string, table: string, row: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${api}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      prefer: 'return=representation',
      accept: 'application/vnd.pgrst.object+json',
      apikey: 'local-key',
    },
    body: JSON.stringify(row),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`POST ${table} ${res.status}: ${text.slice(0, 200)}`)
  }
  return res.json()
}

async function postMany<T = any>(api: string, table: string, rows: Record<string, unknown>[]): Promise<T[]> {
  // Десктопный сервер принимает batch, см. handlePost; но для надёжности
  // делаем последовательно с возвратом representation.
  const out: T[] = []
  for (const row of rows) {
    out.push(await post<T>(api, table, row))
  }
  return out
}

async function del(api: string, table: string, query: string): Promise<void> {
  const res = await fetch(`${api}/rest/v1/${table}?${query}`, {
    method: 'DELETE',
    headers: { apikey: 'local-key' },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    console.warn(`[seed] DELETE ${table}?${query} ${res.status}: ${text.slice(0, 120)}`)
  }
}

const DISH_NAMES = [
  'Лагман', 'Манты', 'Плов', 'Шашлык', 'Шурпа', 'Самса', 'Норин', 'Куурдак',
  'Долма', 'Чучвара', 'Бешбармак', 'Курутоб', 'Хушан', 'Угра', 'Машхурда',
  'Тушпара', 'Кабоб', 'Хасип', 'Сомса', 'Лагмон',
]
const DRINK_NAMES = ['Чай чёрный', 'Чай зелёный', 'Кола', 'Сок апельсин', 'Сок яблочный', 'Айран', 'Компот']
const SALAD_NAMES = ['Цезарь', 'Оливье', 'Винегрет', 'Греческий', 'Цезарь с курицей']

function pickName(i: number): { name: string; category: string; price: number } {
  if (i % 7 === 0) return { name: DRINK_NAMES[i % DRINK_NAMES.length], category: 'drinks', price: 8 + (i % 4) }
  if (i % 5 === 0) return { name: SALAD_NAMES[i % SALAD_NAMES.length], category: 'salads', price: 25 + (i % 10) }
  return { name: DISH_NAMES[i % DISH_NAMES.length], category: 'hot', price: 40 + (i % 60) }
}

export async function seedPerfData(opts: SeedOpts = {}): Promise<SeedHandle> {
  const api = opts.api || PERF_API
  const runId = `PERF-${Date.now().toString(36)}`
  const tablesN = opts.tables ?? DEFAULT_TABLES
  const menuN = opts.menuItems ?? DEFAULT_MENU
  const ingN = opts.ingredients ?? DEFAULT_INGREDIENTS
  const waitersN = opts.waiters ?? DEFAULT_WAITERS
  const ordersN = opts.orders ?? DEFAULT_ORDERS
  const itemsPerOrder = opts.itemsPerOrder ?? DEFAULT_ITEMS_PER_ORDER

  // 1. Restaurant
  const restaurant = await post<{ id: string }>(api, 'restaurants', {
    name: `PERF Restaurant ${runId}`,
    enforce_stock_check: opts.enforceStockCheck ?? false,
    tech_cards_enabled: true,
  })
  const restaurantId = restaurant.id

  // 2. Cashier (знаем пароль для UI-логина) + N официантов.
  const cashier = await post<{ id: string }>(api, 'users', {
    username: `cashier_${runId}`.toLowerCase(),
    password: '1234',
    name: `Cashier ${runId}`,
    role: 'cashier',
    restaurant_id: restaurantId,
  })
  const waiterIds: string[] = []
  for (let w = 0; w < waitersN; w++) {
    const waiter = await post<{ id: string }>(api, 'users', {
      username: `waiter_${runId}_${w}`.toLowerCase(),
      password: '1234',
      name: `Waiter${w + 1} ${runId}`,
      role: 'waiter',
      restaurant_id: restaurantId,
    })
    waiterIds.push(waiter.id)
  }

  // 3. Zone
  const zone = await post<{ id: string }>(api, 'zones', {
    name: `Zone ${runId}`,
    restaurant_id: restaurantId,
  })

  // 4. Tables
  const tableIds: string[] = []
  for (let i = 0; i < tablesN; i++) {
    const t = await post<{ id: string }>(api, 'tables', {
      name: `T${i + 1}`,
      number: i + 1,
      capacity: 2 + (i % 6),
      zone_id: zone.id,
      restaurant_id: restaurantId,
      status: 'free',
    })
    tableIds.push(t.id)
  }

  // 5. Ingredients
  const ingredientIds: string[] = []
  for (let i = 0; i < ingN; i++) {
    const ing = await post<{ id: string }>(api, 'ingredients', {
      name: `Ing-${runId}-${i}`,
      category: 'meat',
      qty: 1000,
      min_qty: 100,
      unit: 'g',
      price_per_unit: 0.05,
      restaurant_id: restaurantId,
    })
    ingredientIds.push(ing.id)
  }

  // 6. Menu items + tech_card_lines (по 3 ингредиента на блюдо)
  const menuItemIds: string[] = []
  for (let i = 0; i < menuN; i++) {
    const meta = pickName(i)
    const mi = await post<{ id: string }>(api, 'menu_items', {
      name: `${meta.name}-${runId}-${i}`,
      category: meta.category,
      price: meta.price,
      cogs: meta.price * 0.4,
      emoji: '🍽',
      is_available: true,
      restaurant_id: restaurantId,
      unit: 'piece',
      unit_size: 1,
    })
    menuItemIds.push(mi.id)

    // 3 tech_card_lines на каждое блюдо для теста validateStockForItems
    for (let k = 0; k < 3; k++) {
      const ingId = ingredientIds[(i * 3 + k) % ingredientIds.length]
      await post(api, 'tech_card_lines', {
        menu_item_id: mi.id,
        ingredient_id: ingId,
        name: `Ing-${k}`,
        qty: 50,
        unit: 'g',
        restaurant_id: restaurantId,
      })
    }
  }

  // 7. Financial account
  const account = await post<{ id: string; name: string }>(api, 'financial_accounts', {
    name: 'Касса',
    type: 'cash',
    balance: 0,
    restaurant_id: restaurantId,
  })

  // 8. Orders + order_items
  const orderIds: string[] = []
  const STATUSES = ['new', 'cooking', 'ready', 'served', 'done', 'done', 'done']
  for (let i = 0; i < ordersN; i++) {
    const status = STATUSES[i % STATUSES.length]
    const itemsForOrder = 3 + ((i * 7) % (itemsPerOrder - 1))
    let total = 0
    const order = await post<{ id: string }>(api, 'orders', {
      status,
      type: i % 8 === 0 ? 'takeaway' : 'hall',
      table_id: tableIds[i % tableIds.length],
      waiter_id: waiterIds[i % waiterIds.length],
      total: 0,
      service_percent: 5,
      service_amount: 0,
      tab_label: runId,
      restaurant_id: restaurantId,
      guests_count: 2,
      ...(status === 'done' ? { closed_at: new Date(Date.now() - i * 60_000).toISOString() } : {}),
    })

    for (let j = 0; j < itemsForOrder; j++) {
      const miIdx = (i * 11 + j) % menuItemIds.length
      const meta = pickName(miIdx)
      total += meta.price
      await post(api, 'order_items', {
        order_id: order.id,
        menu_item_id: menuItemIds[miIdx],
        name: `${meta.name}-${runId}`,
        qty: 1 + (j % 2),
        price: meta.price,
        cogs: meta.price * 0.4,
        unit: 'piece',
        unit_size: 1,
      })
    }

    // Обновляем total на orders (имитируем результат createOrder)
    await fetch(`${api}/rest/v1/orders?id=eq.${order.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', apikey: 'local-key' },
      body: JSON.stringify({ total, service_amount: total * 0.05, total_with_service: total * 1.05 }),
    })

    orderIds.push(order.id)
  }

  return {
    runId,
    restaurantId,
    cashierId: cashier.id,
    cashierUsername: `cashier_${runId}`.toLowerCase(),
    cashierPassword: '1234',
    zoneId: zone.id,
    tableIds,
    menuItemIds,
    ingredientIds,
    orderIds,
    account,
  }
}

/**
 * Чистка по runId. Удаляет всё что было засеяно — без зависимостей от ID
 * (на случай если сид частично упал).
 */
export async function cleanupPerfData(handle: SeedHandle, api = PERF_API): Promise<void> {
  // FK-deletion order: order_items → orders → tech_card_lines → menu_items →
  //                    ingredients → tables → zones → financial_accounts →
  //                    users → restaurants
  await del(api, 'order_items', `order_id=in.(${handle.orderIds.join(',')})`)
  await del(api, 'orders', `tab_label=eq.${handle.runId}`)
  await del(api, 'tech_card_lines', `restaurant_id=eq.${handle.restaurantId}`)
  await del(api, 'menu_items', `restaurant_id=eq.${handle.restaurantId}`)
  await del(api, 'ingredients', `restaurant_id=eq.${handle.restaurantId}`)
  await del(api, 'tables', `restaurant_id=eq.${handle.restaurantId}`)
  await del(api, 'zones', `restaurant_id=eq.${handle.restaurantId}`)
  await del(api, 'financial_accounts', `restaurant_id=eq.${handle.restaurantId}`)
  await del(api, 'users', `restaurant_id=eq.${handle.restaurantId}`)
  await del(api, 'restaurants', `id=eq.${handle.restaurantId}`)
}
