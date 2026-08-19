import { api, unwrap } from './_client'
import type { BundleSlot, BundleSlotOption, MenuItem } from '../types'

function mapSlot(row: any): Omit<BundleSlot, 'options'> {
  return {
    id: row.id,
    bundleMenuItemId: row.bundle_menu_item_id,
    label: row.label ?? '',
    isRequired: !!row.is_required,
    minSelect: Number(row.min_select ?? 1),
    maxSelect: Number(row.max_select ?? 1),
    sortOrder: Number(row.sort_order ?? 0),
  }
}

function mapOption(row: any, menuByID: Map<string, MenuItem>): BundleSlotOption {
  const mi = menuByID.get(row.option_menu_item_id)
  return {
    id: row.id,
    slotId: row.slot_id,
    optionMenuItemId: row.option_menu_item_id,
    optionMenuItemName: mi?.name,
    optionMenuItemPrice: mi?.price,
    price: row.price != null ? Number(row.price) : 0,
    isDefault: !!row.is_default,
    sortOrder: Number(row.sort_order ?? 0),
  }
}

// fetchBundleSlots — все слоты сета с уже подгруженными опциями (2 запроса
// на слот в худшем случае невыгодны — грузим опции ОДНИМ запросом на весь
// набор слотов и раскладываем по slot_id на клиенте).
export async function fetchBundleSlots(bundleMenuItemId: string, menuItems: MenuItem[]): Promise<BundleSlot[]> {
  const res: any = await unwrap(api.GET('/api/v1/menu/bundle-slots', {
    params: { query: { bundle_menu_item_id: bundleMenuItemId, limit: 200 } },
  }))
  const slotRows: any[] = Array.isArray(res?.data) ? res.data : []
  if (slotRows.length === 0) return []

  const menuByID = new Map(menuItems.map(m => [m.id, m]))
  const slots = slotRows.map(mapSlot).sort((a, b) => a.sortOrder - b.sortOrder)

  const optionsBySlot = new Map<string, BundleSlotOption[]>()
  await Promise.all(slots.map(async slot => {
    const optRes: any = await unwrap(api.GET('/api/v1/menu/bundle-slot-options', {
      params: { query: { slot_id: slot.id, limit: 200 } },
    }))
    const rows: any[] = Array.isArray(optRes?.data) ? optRes.data : []
    optionsBySlot.set(slot.id, rows.map(r => mapOption(r, menuByID)).sort((a, b) => a.sortOrder - b.sortOrder))
  }))

  return slots.map(s => ({ ...s, options: optionsBySlot.get(s.id) ?? [] }))
}

export async function createBundleSlot(data: {
  bundleMenuItemId: string
  label: string
  isRequired: boolean
  minSelect: number
  maxSelect: number
  sortOrder?: number
}): Promise<Omit<BundleSlot, 'options'>> {
  const row: any = await unwrap(api.POST('/api/v1/menu/bundle-slots', {
    body: {
      bundle_menu_item_id: data.bundleMenuItemId,
      label: data.label,
      is_required: data.isRequired,
      min_select: data.minSelect,
      max_select: data.maxSelect,
      sort_order: data.sortOrder ?? 0,
    } as any,
  }))
  return mapSlot(row)
}

export async function updateBundleSlot(id: string, data: Partial<{
  label: string
  isRequired: boolean
  minSelect: number
  maxSelect: number
  sortOrder: number
}>): Promise<void> {
  const body: Record<string, unknown> = {}
  if (data.label !== undefined) body.label = data.label
  if (data.isRequired !== undefined) body.is_required = data.isRequired
  if (data.minSelect !== undefined) body.min_select = data.minSelect
  if (data.maxSelect !== undefined) body.max_select = data.maxSelect
  if (data.sortOrder !== undefined) body.sort_order = data.sortOrder
  await unwrap(api.PATCH('/api/v1/menu/bundle-slots/{id}', { params: { path: { id } }, body: body as any }))
}

export async function deleteBundleSlot(id: string): Promise<void> {
  await unwrap(api.DELETE('/api/v1/menu/bundle-slots/{id}', { params: { path: { id } } }))
}

export async function createBundleSlotOption(data: {
  slotId: string
  optionMenuItemId: string
  price: number
  isDefault?: boolean
  sortOrder?: number
}): Promise<void> {
  await unwrap(api.POST('/api/v1/menu/bundle-slot-options', {
    body: {
      slot_id: data.slotId,
      option_menu_item_id: data.optionMenuItemId,
      price: String(data.price),
      is_default: data.isDefault ?? false,
      sort_order: data.sortOrder ?? 0,
    } as any,
  }))
}

export async function updateBundleSlotOption(id: string, data: Partial<{
  price: number
  isDefault: boolean
  sortOrder: number
}>): Promise<void> {
  const body: Record<string, unknown> = {}
  if (data.price !== undefined) body.price = String(data.price)
  if (data.isDefault !== undefined) body.is_default = data.isDefault
  if (data.sortOrder !== undefined) body.sort_order = data.sortOrder
  await unwrap(api.PATCH('/api/v1/menu/bundle-slot-options/{id}', { params: { path: { id } }, body: body as any }))
}

export async function deleteBundleSlotOption(id: string): Promise<void> {
  await unwrap(api.DELETE('/api/v1/menu/bundle-slot-options/{id}', { params: { path: { id } } }))
}
