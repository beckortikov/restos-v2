import { api, unwrap, unwrapOr404, V4Error } from './_client'
import type { Restaurant } from '../types'
import { logAction } from './audit'
import { mapRestaurantRow } from './_mappers'

export function getRestaurantId(): string {
  if (typeof window === 'undefined') return ''
  try {
    const stored = localStorage.getItem('restos-auth-user')
    if (stored) {
      const user = JSON.parse(stored)
      return user?.restaurantId || ''
    }
  } catch {}
  return ''
}

export async function fetchRestaurantById(id: string): Promise<Restaurant | null> {
  const data: any = await unwrapOr404(api.GET('/api/v1/restaurants/{id}', { params: { path: { id } } }))
  if (!data) return null
  return mapRestaurantRow(data)
}

export async function createRestaurant(data: {
  name: string
  slug: string
  address?: string
  phone?: string
}): Promise<Restaurant> {
  const body: Record<string, unknown> = {
    name: data.name,
    slug: data.slug,
  }
  if (data.address) body.address = data.address
  if (data.phone) body.phone = data.phone
  const row: any = await unwrap(api.POST('/api/v1/restaurants', { body: body as any }))
  return mapRestaurantRow(row)
}

export async function updateRestaurant(id: string, data: Partial<{
  name: string
  logoUrl: string
  address: string
  phone: string
  servicePercent: number
  enforceStockCheck: boolean
  techCardsEnabled: boolean
  autoReadyMode: boolean
  autoReadyBufferMin: number
  pinLockEnabled: boolean
  pinLockTimeoutMin: number
  supplyAllowNegative: boolean
  isBlocked: boolean
  blockReason: string
  licenseKey: string
  licenseExpiresAt: string
}>): Promise<void> {
  const updates: Record<string, unknown> = {}
  if (data.name !== undefined) updates.name = data.name
  if (data.logoUrl !== undefined) updates.logo_url = data.logoUrl
  if (data.address !== undefined) updates.address = data.address
  if (data.phone !== undefined) updates.phone = data.phone
  if (data.servicePercent !== undefined) updates.service_percent = String(data.servicePercent)
  if (data.enforceStockCheck !== undefined) updates.enforce_stock_check = data.enforceStockCheck
  if (data.techCardsEnabled !== undefined) updates.tech_cards_enabled = data.techCardsEnabled
  if (data.autoReadyMode !== undefined) updates.auto_ready_mode = data.autoReadyMode
  if (data.autoReadyBufferMin !== undefined) updates.auto_ready_buffer_min = data.autoReadyBufferMin
  if (data.pinLockEnabled !== undefined) updates.pin_lock_enabled = data.pinLockEnabled
  if (data.pinLockTimeoutMin !== undefined) updates.pin_lock_timeout_min = data.pinLockTimeoutMin
  if (data.supplyAllowNegative !== undefined) updates.supply_allow_negative = data.supplyAllowNegative
  if (Object.keys(updates).length > 0) {
    await unwrap(api.PATCH('/api/v1/restaurants/{id}', { params: { path: { id } }, body: updates as any }))
  }
  logAction('settings.update', 'settings', id)
}

export async function fetchAllRestaurants(): Promise<Restaurant[]> {
  const res: any = await unwrap(api.GET('/api/v1/restaurants'))
  const rows: any[] = Array.isArray(res?.data) ? res.data : (Array.isArray(res) ? res : [])
  return rows.map(mapRestaurantRow)
}

export async function clearRestaurantOperations(restaurantId: string): Promise<{ counts: Record<string, number> }> {
  const out: any = await unwrap(api.POST('/api/v1/restaurants/{id}/clear-operations', {
    params: { path: { id: restaurantId } },
    body: {} as any,
  }))
  const counts = (out?.counts ?? {}) as Record<string, number>
  logAction('admin.clear_operations', 'restaurant', restaurantId, undefined, { counts })
  return { counts }
}

export async function clearRestaurantMenu(restaurantId: string): Promise<{ counts: Record<string, number> }> {
  const out: any = await unwrap(api.POST('/api/v1/restaurants/{id}/clear-menu', {
    params: { path: { id: restaurantId } },
    body: {} as any,
  }))
  const counts = (out?.counts ?? {}) as Record<string, number>
  logAction('admin.clear_menu', 'restaurant', restaurantId, undefined, { counts })
  return { counts }
}

export async function getRestaurantStats(restaurantId: string): Promise<{
  usersCount: number
  ordersCount: number
  totalRevenue: number
}> {
  const out: any = await unwrap(api.GET('/api/v1/restaurants/{id}/stats', { params: { path: { id: restaurantId } } }))
  return {
    usersCount: Number(out?.users_count ?? 0),
    ordersCount: Number(out?.orders_count ?? 0),
    totalRevenue: out?.total_revenue != null ? Number(out.total_revenue) : 0,
  }
}

export async function deleteRestaurant(restaurantId: string): Promise<void> {
  try {
    await unwrap(api.DELETE('/api/v1/restaurants/{id}', { params: { path: { id: restaurantId } } }))
  } catch (e) {
    if (e instanceof V4Error) {
      throw new Error(`Ошибка удаления: ${e.envelope()?.message || e.message}`)
    }
    throw e
  }
}

export async function seedRestaurantData(restaurantId: string): Promise<{
  zones: number; tables: number; accounts: number; ingredients: number; menuItems: number; techCardLines: number
}> {
  const out: any = await unwrap(api.POST('/api/v1/restaurants/{id}/seed', {
    params: { path: { id: restaurantId }, query: { dataset: 'demo' as const } },
    body: {} as any,
  }))
  return {
    zones: Number(out?.zones ?? 0),
    tables: Number(out?.tables ?? 0),
    accounts: 0,
    ingredients: Number(out?.ingredients ?? 0),
    menuItems: Number(out?.menu_items ?? 0),
    techCardLines: 0,
  }
}
