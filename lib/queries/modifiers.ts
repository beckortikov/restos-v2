import { api, unwrap } from './_client'
import type { ModifierGroup } from '../types'
import { _mapV4ModifierGroup } from './_mappers'

export async function fetchModifierGroupsForMenuItem(menuItemId: string): Promise<ModifierGroup[]> {
  // Сервер фильтрует: groups для этого item OR menu_item_id IS NULL (global).
  const res: any = await unwrap(api.GET('/api/v1/menu/modifier-groups', { params: { query: { menu_item_id: menuItemId, limit: 500 } } }))
  const groups: any[] = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : []
  if (groups.length === 0) return []
  const allModsRes: any = await unwrap(api.GET('/api/v1/menu/modifiers', { params: { query: { limit: 2000 } } }))
  const allMods: any[] = Array.isArray(allModsRes?.data) ? allModsRes.data : Array.isArray(allModsRes) ? allModsRes : []
  return groups
    .slice()
    .sort((a, b) => Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0))
    .map(g => _mapV4ModifierGroup(g, allMods.filter(m => m.group_id === g.id)))
}

export async function fetchAllModifierGroups(): Promise<ModifierGroup[]> {
  const res: any = await unwrap(api.GET('/api/v1/menu/modifier-groups', { params: { query: { limit: 500 } } }))
  const groups: any[] = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : []
  const allModsRes: any = await unwrap(api.GET('/api/v1/menu/modifiers', { params: { query: { limit: 2000 } } }))
  const allMods: any[] = Array.isArray(allModsRes?.data) ? allModsRes.data : Array.isArray(allModsRes) ? allModsRes : []
  return groups
    .slice()
    .sort((a, b) => Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0))
    .map(g => _mapV4ModifierGroup(g, allMods.filter(m => m.group_id === g.id)))
}

export async function createModifierGroup(data: { name: string; menuItemId?: string; isRequired: boolean; maxSelect: number }) {
  const row: any = await unwrap(api.POST('/api/v1/menu/modifier-groups', {
    body: {
      name: data.name,
      menu_item_id: data.menuItemId || null,
      is_required: data.isRequired,
      max_select: data.maxSelect,
    } as any,
  }))
  return row
}

export async function deleteModifierGroup(id: string) {
  await unwrap(api.DELETE('/api/v1/menu/modifier-groups/{id}', { params: { path: { id } } }))
}

export async function createModifier(data: { groupId: string; name: string; price: number; isDefault?: boolean }) {
  await unwrap(api.POST('/api/v1/menu/modifiers', {
    body: {
      group_id: data.groupId,
      name: data.name,
      price: String(data.price),
      is_default: data.isDefault ?? false,
    } as any,
  }))
}

export async function deleteModifier(id: string) {
  await unwrap(api.DELETE('/api/v1/menu/modifiers/{id}', { params: { path: { id } } }))
}
