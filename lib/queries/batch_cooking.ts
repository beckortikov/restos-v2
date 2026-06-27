import { api, unwrap, unwrapRaw, V4Error } from './_client'
import { logAction } from './audit'
import { checkAndUpdateStopList } from './stock'

export async function calculateMaxPortions(menuItemId: string): Promise<import('../types').BatchPortionCalc> {
  const res = await unwrapRaw(api.GET('/api/v1/menu/items/{id}/max-portions', { params: { path: { id: menuItemId } } }))
  if (res.response.status === 404) return { maxPortions: 0, ingredients: [], hasRecipe: false }
  if (res.error) throw new V4Error(res.response.status, res.error)
  const r = (res.data as any) ?? {}
  const maxRaw = Number(r?.max ?? 0)
  const maxPortions = Number.isFinite(maxRaw) && maxRaw < 1_000_000 ? maxRaw : 0
  const hasRecipe = Boolean(r?.has_recipe)
  // Полный список ингредиентов тех-карты (для превью «будет списано»).
  // Фолбэк на blockers — на случай старого бэкенда без поля ingredients.
  const rawIngredients = Array.isArray(r?.ingredients) ? (r.ingredients as Record<string, unknown>[]) : []
  const ingredients = rawIngredients.length > 0
    ? rawIngredients.map(mapBatchIngredient)
    : (Array.isArray(r?.blockers) ? (r.blockers as Record<string, unknown>[]).map(mapBatchBlocker) : [])
  return { maxPortions, ingredients, hasRecipe }
}

// Живой остаток заготовок: prepared − порции в незакрытых заказах.
// Возвращает Map menu_item_id → available (порц.).
// NB: путь ещё не в generated.ts (нужен `make api-gen`) — отсюда cast.
export async function fetchBatchAvailability(): Promise<Map<string, number>> {
  const res: any = await unwrap((api as any).GET('/api/v1/menu/batch/availability'))
  const rows: Record<string, unknown>[] = res?.data ?? []
  const m = new Map<string, number>()
  for (const r of rows) {
    m.set((r.menu_item_id as string) ?? '', Number(r.available ?? 0))
  }
  return m
}

export async function produceBatch(menuItemId: string, qty: number): Promise<void> {
  const mi: any = await unwrap(api.POST('/api/v1/menu/items/{id}/batch/produce', {
    params: { path: { id: menuItemId } },
    body: { qty } as any,
  }))
  const name = (mi?.name as string) ?? ''
  logAction('batch.produce', 'menu_item', menuItemId, name, { qty })
  await checkAndUpdateStopList()
}

export async function decrementPreparedQty(menuItemId: string, qty: number): Promise<void> {
  const mi: any = await unwrap(api.POST('/api/v1/menu/items/{id}/batch/decrement', {
    params: { path: { id: menuItemId } },
    body: { qty } as any,
  }))
  const name = (mi?.name as string) ?? ''
  const remaining = Number(mi?.prepared_qty ?? 0)
  logAction('batch.decrement', 'menu_item', menuItemId, name, { qty, remaining })
}

export async function writeoffPreparedBatch(menuItemId: string, qty: number, reason: string): Promise<void> {
  const mi: any = await unwrap(api.POST('/api/v1/menu/items/{id}/batch/writeoff', {
    params: { path: { id: menuItemId } },
    body: { qty, reason } as any,
  }))
  const name = (mi?.name as string) ?? ''
  const remaining = Number(mi?.prepared_qty ?? 0)
  logAction('batch.writeoff', 'menu_item', menuItemId, name, { qty, reason, remaining })
}

export async function fetchBatchCookingLogs(menuItemId?: string): Promise<import('../types').BatchCookingLog[]> {
  const res: any = menuItemId
    ? await unwrap(api.GET('/api/v1/menu/items/{id}/batch/logs', { params: { path: { id: menuItemId }, query: { limit: 500 } } }))
    : await unwrap(api.GET('/api/v1/menu/batch/logs', { params: { query: { limit: 500 } } }))
  const rows: Record<string, unknown>[] = res?.data ?? []
  return rows.map(mapBatchCookingLog)
}

// ─── Mappers ──────────────────────────────────────────────────────────────

function mapBatchIngredient(b: Record<string, unknown>) {
  return {
    ingredientId: (b.ingredient_id as string) ?? '',
    name: (b.name as string) ?? '',
    unit: (b.unit as string) ?? '',
    recipeUnit: (b.recipe_unit as string) ?? '',
    stockQty: Number(b.stock_qty ?? 0),
    recipeQtyPerPortion: Number(b.recipe_qty_per_portion ?? 0),
    possiblePortions: Number(b.possible_portions ?? 0),
    isBottleneck: Boolean(b.is_bottleneck),
  }
}

function mapBatchBlocker(b: Record<string, unknown>) {
  return {
    ingredientId: (b.ingredient_id as string) ?? '',
    name: (b.name as string) ?? '',
    unit: '',
    recipeUnit: '',
    stockQty: Number(b.have ?? 0),
    recipeQtyPerPortion: Number(b.need ?? 0),
    possiblePortions: 0,
    isBottleneck: true,
  }
}

function mapBatchCookingLog(r: Record<string, unknown>): import('../types').BatchCookingLog {
  return {
    id: r.id as string,
    menuItemId: (r.menu_item_id as string) ?? '',
    menuItemName: (r.menu_item_name as string) ?? '',
    qty: Number(r.qty ?? 0),
    producedBy: (r.produced_by as string | null) ?? undefined,
    producedById: (r.produced_by_id as string | null) ?? undefined,
    costTotal: Number(r.cost_total ?? 0),
    reason: (r.reason as string | null) ?? undefined,
    createdAt: (r.created_at as string) ?? '',
  }
}
