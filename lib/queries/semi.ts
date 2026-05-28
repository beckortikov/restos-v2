import { api, unwrap } from './_client'
import type { SemiFinishedType, SemiFinishedStock } from '../types'
import { logAction } from './audit'
import { checkAndUpdateStopList } from './stock'

export async function fetchSemiTypes(): Promise<SemiFinishedType[]> {
  const res: any = await unwrap(api.GET('/api/v1/semi/types', { params: { query: { include: 'recipe' } } }))
  const rows: Record<string, unknown>[] = res?.data ?? []
  return rows.map(mapSemiType) as SemiFinishedType[]
}

export async function fetchSemiStock(): Promise<SemiFinishedStock[]> {
  const res: any = await unwrap(api.GET('/api/v1/semi/stock'))
  const rows: Record<string, unknown>[] = res?.data ?? []
  return rows.map(mapSemiStock) as SemiFinishedStock[]
}

export async function createSemiType(name: string, outputUnit: string, recipe: { ingredientId: string; name: string; qtyPerUnit: number; unit: string }[], yieldPercent = 100) {
  const data: any = await unwrap(api.POST('/api/v1/semi/types', {
    body: {
      name,
      output_unit: outputUnit,
      yield_percent: String(yieldPercent),
      recipe: recipe.map(l => ({
        ingredient_id: l.ingredientId,
        name: l.name,
        qty_per_unit: String(l.qtyPerUnit),
        unit: l.unit,
      })),
    } as any,
  }))
  logAction('semi.create', 'semi', data?.id as string | undefined, name)
  return data
}

export async function deleteSemiType(id: string) {
  await unwrap(api.DELETE('/api/v1/semi/types/{id}', { params: { path: { id } } }))
  logAction('semi.delete', 'semi', id)
}

export async function produceSemiFab(semiTypeId: string, qty: number) {
  await unwrap(api.POST('/api/v1/semi/prepare', {
    body: { semi_type_id: semiTypeId, qty: String(qty) } as any,
  }))
  await checkAndUpdateStopList()
  logAction('semi.produce', 'semi', semiTypeId, '', { qty })
}

// ─── Mappers ──────────────────────────────────────────────────────────────

function mapSemiRecipeLine(l: Record<string, unknown>) {
  return {
    ingredientId: (l.ingredient_id as string) ?? '',
    name: (l.name as string) ?? '',
    qtyPerUnit: Number(l.qty_per_unit ?? 0),
    unit: (l.unit as string) ?? '',
  }
}

function mapSemiType(r: Record<string, unknown>): SemiFinishedType {
  const recipeRaw: Record<string, unknown>[] = Array.isArray(r.recipe) ? (r.recipe as Record<string, unknown>[]) : []
  return {
    id: r.id as string,
    name: (r.name as string) ?? '',
    outputUnit: (r.output_unit as string) ?? '',
    yieldPercent: Number(r.yield_percent ?? 100) || 100,
    recipe: recipeRaw.map(mapSemiRecipeLine),
  } as SemiFinishedType
}

function mapSemiStock(r: Record<string, unknown>): SemiFinishedStock {
  return {
    id: r.id as string,
    semiTypeId: (r.semi_type_id as string) ?? '',
    name: (r.name as string) ?? '',
    qty: Number(r.qty ?? 0),
    unit: (r.unit as string) ?? '',
    pricePerUnit: Number(r.price_per_unit ?? 0),
    lastProducedAt: (r.last_produced_at as string) ?? '',
  } as SemiFinishedStock
}
