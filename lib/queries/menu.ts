import { api, unwrap, V4Error } from './_client'
import { randomId } from '../random-id'
import type { MenuItem } from '../types'
import { logAction } from './audit'
import { calcCogsFromTechCard } from './_mappers'

export interface FetchMenuItemsOptions {
  withTechCards?: boolean
}

export async function fetchMenuItems(opts?: FetchMenuItemsOptions): Promise<MenuItem[]> {
  const includeTC = opts?.withTechCards !== false
  const query: { limit: number; include?: string } = { limit: 500 }
  if (includeTC) query.include = 'tech_cards,ingredient_prices'
  const itemsRes: any = await unwrap(api.GET('/api/v1/menu/items', { params: { query } }))
  const items: Record<string, unknown>[] = itemsRes?.data ?? []

  const techByItem = new Map<string, Record<string, unknown>[]>()
  const ingredientPrices = new Map<string, { price: number; unit: string; wastePercent: number }>()
  if (includeTC) {
    for (const r of items) {
      const id = r.id as string
      const lines = Array.isArray(r.tech_card_lines)
        ? (r.tech_card_lines as Record<string, unknown>[])
        : []
      if (lines.length > 0) techByItem.set(id, lines)
    }
    const ipMap = (itemsRes?.ingredient_prices ?? {}) as Record<string, {
      price?: unknown; unit?: unknown; waste_percent?: unknown
    }>
    for (const [id, v] of Object.entries(ipMap)) {
      ingredientPrices.set(id, {
        price: Number(v?.price) || 0,
        unit: (v?.unit as string) || '',
        wastePercent: Number(v?.waste_percent) || 0,
      })
    }
  }

  return items.map(r => mapMenuItem(r, techByItem.get(r.id as string) ?? [], ingredientPrices)) as MenuItem[]
}

export async function createMenuItem(item: Omit<MenuItem, 'id'>) {
  const body = {
    name: item.name,
    category: item.category,
    price: String(item.price),
    emoji: item.emoji,
    image_url: item.imageUrl || null,
    is_available: item.isAvailable,
    stop_list_override: item.stopListOverride ?? false,
    cogs: String(item.cogs ?? 0),
    cook_time_min: item.cookTimeMin ?? null,
    station: item.station || 'hot_kitchen',
    is_batch_cooking: item.isBatchCooking ?? false,
    unit: item.unit || 'piece',
    unit_size: String(item.unitSize ?? 1),
    sale_step: String(item.saleStep ?? 0),
    low_stock_threshold: item.lowStockThreshold != null ? Number(item.lowStockThreshold) : 5,
  }
  const data: any = await unwrap(api.POST('/api/v1/menu/items', { body: body as any }))
  const newId: string | undefined = data?.id
  const validTechLines = item.techCard.filter(l => l.ingredientId || l.semiId)
  if (validTechLines.length > 0 && newId) {
    for (const l of validTechLines) {
      await unwrap(api.POST('/api/v1/menu/tech-cards', {
        body: {
          menu_item_id: newId,
          ingredient_id: l.ingredientId || null,
          semi_type_id: l.semiId || null,
          name: l.name,
          qty: String(l.qty),
          unit: l.unit,
        } as any,
      }))
    }
  }
  logAction('menu.create', 'menu_item', newId, item.name, { price: item.price })
  return data
}

const SEED_MENU_CATEGORIES = [
  'Салаты', 'Супы', 'Вторые (готовые)', 'Вторые (заказные)',
  'Гарниры', 'Завтраки', 'Выпечка', 'Шашлык',
  'Напитки', 'Десерты', 'Закуски',
]

export interface MenuCategory {
  id: string
  name: string
  sortOrder: number
}

export async function fetchMenuCategories(): Promise<string[]> {
  const dedupe = (rows: { name: string }[] | null | undefined): string[] => {
    const seen = new Set<string>()
    const out: string[] = []
    for (const r of rows ?? []) {
      const n = (r.name ?? '').trim()
      if (!n) continue
      const key = n.toLocaleLowerCase('ru-RU')
      if (seen.has(key)) continue
      seen.add(key)
      out.push(n)
    }
    return out
  }

  try {
    const res: any = await unwrap(api.GET('/api/v1/menu/categories'))
    const cats: { name: string; sort_order?: number }[] = res?.data ?? []
    const deduped = dedupe(cats)
    if (deduped.length > 0) return deduped
  } catch {}

  return [...SEED_MENU_CATEGORIES]
}

export async function fetchMenuCategoriesFull(): Promise<MenuCategory[]> {
  const res: any = await unwrap(api.GET('/api/v1/menu/categories'))
  const rows: Record<string, unknown>[] = res?.data ?? []
  return rows.map(mapMenuCategory)
}

export async function createMenuCategory(name: string): Promise<MenuCategory> {
  let nextOrder = 1
  try {
    const res: any = await unwrap(api.GET('/api/v1/menu/categories'))
    const rows: Record<string, unknown>[] = res?.data ?? []
    nextOrder = rows.reduce((max, r) => Math.max(max, (r.sort_order as number) ?? 0), 0) + 1
  } catch {}

  const created: any = await unwrap(api.POST('/api/v1/menu/categories', { body: { name, sort_order: nextOrder } as any }))
  return {
    id: (created?.id as string) ?? randomId(),
    name: (created?.name as string) ?? name,
    sortOrder: (created?.sort_order as number) ?? nextOrder,
  }
}

export async function deleteMenuCategory(id: string): Promise<void> {
  await unwrap(api.DELETE('/api/v1/menu/categories/{id}', { params: { path: { id } } }))
}

export async function seedMenuCategories(_restaurantId: string): Promise<number> {
  try {
    const res: any = await unwrap(api.GET('/api/v1/menu/categories'))
    const rows: Record<string, unknown>[] = res?.data ?? []
    if (rows.length > 0) return 0
  } catch {}
  let count = 0
  for (let i = 0; i < SEED_MENU_CATEGORIES.length; i++) {
    try {
      await unwrap(api.POST('/api/v1/menu/categories', { body: { name: SEED_MENU_CATEGORIES[i], sort_order: i } as any }))
      count++
    } catch {}
  }
  return count
}

export async function fetchIngredientCategories(): Promise<string[]> {
  const res: any = await unwrap(api.GET('/api/v1/stock/ingredient-categories'))
  const rows: unknown = res?.data ?? []
  return Array.isArray(rows) ? (rows as string[]).filter(Boolean) : []
}

export async function toggleMenuAvailability(id: string, isAvailable: boolean) {
  await unwrap(api.PATCH('/api/v1/menu/items/{id}', { params: { path: { id } }, body: { is_available: isAvailable } as any }))
}

export async function uploadDishImage(file: File): Promise<string> {
  const MAX_BYTES = 500 * 1024
  if (file.size > MAX_BYTES) {
    throw new Error(`Изображение слишком большое: ${Math.round(file.size / 1024)} КБ. Лимит ${MAX_BYTES / 1024} КБ — сожмите файл перед загрузкой.`)
  }
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('Не удалось прочитать файл'))
    reader.onload = () => {
      const result = reader.result
      if (typeof result === 'string') resolve(result)
      else reject(new Error('Не удалось преобразовать изображение в base64'))
    }
    reader.readAsDataURL(file)
  })
}

export async function updateMenuItem(id: string, data: Partial<{
  name: string; category: string; price: number; emoji: string; cogs: number;
  isAvailable: boolean; cookTimeMin: number | null; station: string; isBatchCooking: boolean;
  lowStockThreshold: number;
  unit: 'piece' | 'g' | 'kg'; unitSize: number; saleStep: number;
  techCard: { name: string; qty: number; unit: string; ingredientId?: string; semiId?: string }[];
}>) {
  const updates: Record<string, unknown> = {}
  if (data.name !== undefined) updates.name = data.name
  if (data.category !== undefined) updates.category = data.category
  if (data.price !== undefined) updates.price = String(data.price)
  if (data.emoji !== undefined) updates.emoji = data.emoji
  if (data.cogs !== undefined) updates.cogs = String(data.cogs)
  if (data.isAvailable !== undefined) updates.is_available = data.isAvailable
  if (data.cookTimeMin !== undefined) updates.cook_time_min = data.cookTimeMin
  if (data.station !== undefined) updates.station = data.station
  if (data.isBatchCooking !== undefined) updates.is_batch_cooking = data.isBatchCooking
  if (data.lowStockThreshold !== undefined) updates.low_stock_threshold = Number(data.lowStockThreshold)
  if (data.unit !== undefined) updates.unit = data.unit
  if (data.unitSize !== undefined) updates.unit_size = String(data.unitSize)
  if (data.saleStep !== undefined) updates.sale_step = String(data.saleStep)

  await unwrap(api.PATCH('/api/v1/menu/items/{id}', { params: { path: { id } }, body: updates as any }))

  if (data.techCard) {
    try {
      const cur: any = await unwrap(api.GET('/api/v1/menu/tech-cards', { params: { query: { menu_item_id: id } } }))
      const existing: Record<string, unknown>[] = cur?.data ?? []
      for (const line of existing) {
        const lid = line.id as string | undefined
        if (lid) {
          try { await unwrap(api.DELETE('/api/v1/menu/tech-cards/{id}', { params: { path: { id: lid } } })) } catch {}
        }
      }
    } catch {}

    const validTechLines = data.techCard.filter(l => l.ingredientId || l.semiId)
    for (const l of validTechLines) {
      await unwrap(api.POST('/api/v1/menu/tech-cards', {
        body: {
          menu_item_id: id,
          ingredient_id: l.ingredientId || null,
          semi_type_id: l.semiId || null,
          name: l.name,
          qty: String(l.qty),
          unit: l.unit,
        } as any,
      }))
    }
  }
  logAction('menu.edit', 'menu_item', id, data.name)
}

export async function updateMenuItemImage(id: string, imageUrl: string) {
  await unwrap(api.PATCH('/api/v1/menu/items/{id}', { params: { path: { id } }, body: { image_url: imageUrl } as any }))
}

export async function deleteMenuItem(id: string) {
  try {
    await unwrap(api.DELETE('/api/v1/menu/items/{id}', { params: { path: { id } } }))
  } catch (e) {
    if (e instanceof V4Error && e.status === 409) {
      throw new Error('Блюдо связано с историей заказов. Используйте «Архивировать» — оно скроется везде, но в отчётах сохранится.')
    }
    throw e
  }
  logAction('menu.delete', 'menu_item', id)
}

export async function archiveMenuItem(id: string) {
  await unwrap(api.DELETE('/api/v1/menu/items/{id}', { params: { path: { id } } }))
  logAction('menu.archive', 'menu_item', id)
}

// ─── Mappers ──────────────────────────────────────────────────────────────

function mapTechCardLine(l: Record<string, unknown>) {
  return {
    ingredientId: (l.ingredient_id as string | null) ?? undefined,
    semiId: ((l.semi_type_id ?? l.semi_fab_type_id) as string | null) ?? undefined,
    name: l.name as string,
    qty: Number(l.qty),
    unit: l.unit as string,
  }
}

function mapMenuItem(
  r: Record<string, unknown>,
  techLines: Record<string, unknown>[],
  ingredientPrices: Map<string, { price: number; unit: string; wastePercent: number }>,
): MenuItem {
  const autoCogs = techLines.length > 0 ? calcCogsFromTechCard(techLines, ingredientPrices) : 0
  const effectiveCogs = autoCogs > 0 ? autoCogs : (Number(r.cogs) || 0)
  return {
    id: r.id as string,
    name: r.name as string,
    category: r.category as string,
    price: Number(r.price),
    emoji: (r.emoji as string) || '',
    imageUrl: (r.image_url as string) ?? undefined,
    isAvailable: r.is_available as boolean,
    stopListOverride: (r.stop_list_override as boolean) ?? false,
    cogs: effectiveCogs,
    cookTimeMin: (r.cook_time_min as number | null) ?? null,
    station: ((r.station as MenuItem['station']) || 'hot_kitchen'),
    isBatchCooking: (r.is_batch_cooking as boolean) ?? false,
    preparedQty: Number(r.prepared_qty) || 0,
    lowStockThreshold: r.low_stock_threshold != null ? Number(r.low_stock_threshold) : undefined,
    unit: ((r.unit as 'piece' | 'g' | 'kg') || 'piece'),
    unitSize: Number(r.unit_size) || 1,
    saleStep: Number(r.sale_step) || 0,
    techCard: techLines.map(mapTechCardLine),
  } as MenuItem
}

function mapMenuCategory(c: Record<string, unknown>): MenuCategory {
  return {
    id: c.id as string,
    name: c.name as string,
    sortOrder: (c.sort_order as number) ?? 0,
  }
}
