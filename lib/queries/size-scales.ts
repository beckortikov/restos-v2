import { api, unwrap } from './_client'
import type { SizeScale } from '../types'
import { logAction } from './audit'

export async function fetchSizeScales(): Promise<SizeScale[]> {
  const res: any = await unwrap(api.GET('/api/v1/size-scales'))
  const rows: Record<string, unknown>[] = res?.data ?? []
  return rows.map(mapSizeScale)
}

export async function createSizeScale(
  name: string,
  values: { code: string; title?: string; sortOrder?: number; isDefault?: boolean }[],
): Promise<SizeScale> {
  const data: any = await unwrap(api.POST('/api/v1/size-scales', {
    body: {
      name,
      values: values.map((v, i) => ({
        code: v.code,
        title: v.title || undefined,
        sort_order: v.sortOrder ?? i,
        is_default: v.isDefault ?? false,
      })),
    },
  }))
  logAction('size_scale.create', 'size_scale', data?.id as string | undefined, name)
  return mapSizeScale(data ?? {})
}

// updateSizeScale — patch. values, если передан, ПОЛНОСТЬЮ заменяет текущие
// значения шкалы (delete+recreate на бэке) — не диффит по id.
export async function updateSizeScale(
  id: string,
  patch: { name?: string; values?: { id?: string; code: string; title?: string; sortOrder?: number; isDefault?: boolean }[] },
): Promise<SizeScale> {
  const body: {
    name?: string
    values?: { id?: string; code: string; title?: string; sort_order?: number; is_default?: boolean }[]
  } = {}
  if (patch.name !== undefined) body.name = patch.name
  if (patch.values !== undefined) {
    body.values = patch.values.map((v, i) => ({
      id: v.id || undefined,
      code: v.code,
      title: v.title || undefined,
      sort_order: v.sortOrder ?? i,
      is_default: v.isDefault ?? false,
    }))
  }
  const data: any = await unwrap(api.PATCH('/api/v1/size-scales/{id}', { params: { path: { id } }, body }))
  logAction('size_scale.edit', 'size_scale', id)
  return mapSizeScale(data ?? {})
}

export async function deleteSizeScale(id: string): Promise<void> {
  await unwrap(api.DELETE('/api/v1/size-scales/{id}', { params: { path: { id } } }))
  logAction('size_scale.delete', 'size_scale', id)
}

// ─── Mappers ──────────────────────────────────────────────────────────────

function mapSizeScale(r: Record<string, unknown>): SizeScale {
  const valuesRaw: Record<string, unknown>[] = Array.isArray(r.values) ? (r.values as Record<string, unknown>[]) : []
  return {
    id: (r.id as string) ?? '',
    name: (r.name as string) ?? '',
    values: valuesRaw.map(v => ({
      id: v.id as string,
      sizeScaleId: (v.size_scale_id as string) ?? '',
      code: (v.code as string) ?? '',
      title: (v.title as string | null) ?? undefined,
      sortOrder: Number(v.sort_order ?? 0),
      isDefault: Boolean(v.is_default),
    })),
  }
}
