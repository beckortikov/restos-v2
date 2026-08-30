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

// batchQty (098) — авторская подсказка формы («рецепт написан на партию N
// единиц выхода»); recipe[].qtyPerUnit остаётся «на 1 единицу» — это
// значение уже нормализовано вызывающей стороной (warehouse/semi/page.tsx)
// делением на batchQty, сюда приходит канонический per-unit qty.
export async function createSemiType(name: string, outputUnit: string, recipe: { ingredientId: string; name: string; qtyPerUnit: number; unit: string }[], yieldPercent = 100, sizeScaleValueId?: string, batchQty = 1) {
  const data: any = await unwrap(api.POST('/api/v1/semi/types', {
    body: {
      name,
      output_unit: outputUnit,
      yield_percent: String(yieldPercent),
      batch_qty: String(batchQty),
      size_scale_value_id: sizeScaleValueId || undefined,
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

// updateSemiType — частичный patch (название/ед./выход/партия/привязка к
// шкале + полный перезалив рецепта). sizeScaleValueId: '' — явная отвязка
// (SET NULL). Бэк (PatchType) при переданном recipe удаляет старые строки
// и создаёт новые.
export async function updateSemiType(id: string, patch: { name?: string; outputUnit?: string; yieldPercent?: number; batchQty?: number; sizeScaleValueId?: string; recipe?: { ingredientId: string; name: string; qtyPerUnit: number; unit: string }[] }) {
  const body: { name?: string; output_unit?: string; yield_percent?: string; batch_qty?: string; size_scale_value_id?: string; recipe?: any[] } = {}
  if (patch.name !== undefined) body.name = patch.name
  if (patch.outputUnit !== undefined) body.output_unit = patch.outputUnit
  if (patch.yieldPercent !== undefined) body.yield_percent = String(patch.yieldPercent)
  if (patch.batchQty !== undefined) body.batch_qty = String(patch.batchQty)
  if (patch.sizeScaleValueId !== undefined) body.size_scale_value_id = patch.sizeScaleValueId
  if (patch.recipe !== undefined) {
    body.recipe = patch.recipe.map(l => ({
      ingredient_id: l.ingredientId,
      name: l.name,
      qty_per_unit: String(l.qtyPerUnit),
      unit: l.unit,
    }))
  }
  const data: any = await unwrap(api.PATCH('/api/v1/semi/types/{id}', { params: { path: { id } }, body }))
  logAction('semi.edit', 'semi', id)
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
    batchQty: Number(r.batch_qty ?? 1) || 1,
    recipe: recipeRaw.map(mapSemiRecipeLine),
    sizeScaleValueId: (r.size_scale_value_id as string | null) ?? undefined,
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
