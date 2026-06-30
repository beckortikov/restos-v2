import { api, unwrap } from './_client'

// Multi-branch: перемещения между филиалами + сетевой каталог номенклатуры
// (ADR-003, Фаза 1).

export interface Branch {
  id: string
  name: string
  kind?: 'outlet' | 'central_warehouse' | null
}

export interface Nomenclature {
  id: string
  name: string
  unit?: string | null
  category?: string | null
}

export interface TransferLine {
  id: string
  ingredientId?: string | null
  nomenclatureId?: string | null
  ingredientName?: string | null
  qty: number
  unit?: string | null
  costPerUnit: number
}

export interface Transfer {
  id: string
  fromRestaurantId?: string | null
  toRestaurantId?: string | null
  transferNumber?: number | null
  status: 'draft' | 'sent' | 'received' | 'cancelled'
  note?: string | null
  sentAt?: string | null
  receivedAt?: string | null
  createdAt?: string | null
  lines: TransferLine[]
}

function mapLine(r: any): TransferLine {
  return {
    id: r.id,
    ingredientId: r.ingredient_id,
    nomenclatureId: r.nomenclature_id,
    ingredientName: r.ingredient_name,
    qty: Number(r.qty ?? 0),
    unit: r.unit,
    costPerUnit: Number(r.cost_per_unit ?? 0),
  }
}

function mapTransfer(r: any): Transfer {
  return {
    id: r.id,
    fromRestaurantId: r.from_restaurant_id,
    toRestaurantId: r.to_restaurant_id,
    transferNumber: r.transfer_number,
    status: r.status,
    note: r.note,
    sentAt: r.sent_at,
    receivedAt: r.received_at,
    createdAt: r.created_at,
    lines: Array.isArray(r.lines) ? r.lines.map(mapLine) : [],
  }
}

// ─── Филиалы сети ────────────────────────────────────────────────────────────
export async function fetchBranches(): Promise<Branch[]> {
  const env: any = await unwrap(api.GET('/api/v1/network/branches'))
  const rows: any[] = Array.isArray(env?.data) ? env.data : []
  return rows.map(r => ({ id: r.id, name: r.name, kind: r.kind }))
}

// ─── Номенклатура сети ─────────────────────────────────────────────────────────
export async function fetchNomenclature(): Promise<Nomenclature[]> {
  const env: any = await unwrap(api.GET('/api/v1/nomenclature'))
  const rows: any[] = Array.isArray(env?.data) ? env.data : []
  return rows.map(r => ({ id: r.id, name: r.name, unit: r.unit, category: r.category }))
}

export async function createNomenclature(input: { name: string; unit?: string; category?: string }): Promise<Nomenclature> {
  const r: any = await unwrap(api.POST('/api/v1/nomenclature', { body: input as any }))
  return { id: r.id, name: r.name, unit: r.unit, category: r.category }
}

export async function linkIngredientNomenclature(ingredientId: string, nomenclatureId: string): Promise<void> {
  await unwrap(api.POST('/api/v1/stock/ingredients/{id}/nomenclature', {
    params: { path: { id: ingredientId } },
    body: { nomenclature_id: nomenclatureId } as any,
  }))
}

// ─── Перемещения ───────────────────────────────────────────────────────────────
export async function fetchTransfers(): Promise<Transfer[]> {
  const env: any = await unwrap(api.GET('/api/v1/stock/transfers'))
  const rows: any[] = Array.isArray(env?.data) ? env.data : []
  return rows.map(mapTransfer)
}

export async function fetchTransfer(id: string): Promise<Transfer> {
  const r: any = await unwrap(api.GET('/api/v1/stock/transfers/{id}', { params: { path: { id } } }))
  return mapTransfer(r)
}

export async function createTransfer(input: {
  toRestaurantId: string
  note?: string
  lines: { ingredientId: string; qty: number; costPerUnit?: number }[]
}): Promise<Transfer> {
  const r: any = await unwrap(api.POST('/api/v1/stock/transfers', {
    body: {
      to_restaurant_id: input.toRestaurantId,
      note: input.note,
      lines: input.lines.map(l => ({
        ingredient_id: l.ingredientId,
        qty: String(l.qty),
        ...(l.costPerUnit != null ? { cost_per_unit: String(l.costPerUnit) } : {}),
      })),
    } as any,
  }))
  return mapTransfer(r)
}

export async function receiveTransfer(id: string): Promise<Transfer> {
  const r: any = await unwrap(api.POST('/api/v1/stock/transfers/{id}/receive', { params: { path: { id } } }))
  return mapTransfer(r)
}
