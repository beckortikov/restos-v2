import { api, unwrap } from './_client'
import { dMul, dSub, dSum } from '../decimal'
import type {
  Ingredient, StockReceipt, StockMovement, StockWriteoff, WriteoffReason, ReceiptPaymentType,
} from '../types'
import { logAction } from './audit'

export async function fetchIngredients(): Promise<Ingredient[]> {
  const res: any = await unwrap(api.GET('/api/v1/stock/ingredients', { params: { query: { limit: 2000 } } }))
  const rows: Record<string, unknown>[] = res?.data ?? []
  return rows.map(mapIngredient) as Ingredient[]
}

export async function createIngredient(data: { name: string; category: string; qty: number; min_qty: number; unit: string; price_per_unit: number; waste_percent?: number; is_food?: boolean }) {
  const row: any = await unwrap(api.POST('/api/v1/stock/ingredients', {
    body: {
      name: data.name,
      category: data.category,
      qty: String(data.qty),
      min_qty: String(data.min_qty),
      unit: data.unit,
      price_per_unit: String(data.price_per_unit),
      waste_percent: String(data.waste_percent ?? 0),
      is_food: data.is_food ?? true,
    } as any,
  }))
  logAction('ingredient.create', 'ingredient', row?.id as string | undefined, data.name)
  return row ? mapIngredient(row) : null
}

export async function updateIngredient(id: string, data: Partial<{ name: string; category: string; min_qty: number; unit: string; price_per_unit: number; waste_percent: number; is_food: boolean }>) {
  const body: Record<string, unknown> = {}
  if (data.name !== undefined) body.name = data.name
  if (data.category !== undefined) body.category = data.category
  if (data.unit !== undefined) body.unit = data.unit
  if (data.is_food !== undefined) body.is_food = data.is_food
  if (data.min_qty !== undefined) body.min_qty = String(data.min_qty)
  if (data.price_per_unit !== undefined) body.price_per_unit = String(data.price_per_unit)
  if (data.waste_percent !== undefined) body.waste_percent = String(data.waste_percent)
  await unwrap(api.PATCH('/api/v1/stock/ingredients/{id}', { params: { path: { id } }, body: body as any }))
  logAction('ingredient.edit', 'ingredient', id)
}

export async function fetchStockMovements(): Promise<StockMovement[]> {
  const res: any = await unwrap(api.GET('/api/v1/stock/movements', { params: { query: { limit: 1000 } } }))
  const rows: Record<string, unknown>[] = res?.data ?? []
  return rows.map(mapStockMovement) as StockMovement[]
}

export async function fetchReceipts(): Promise<StockReceipt[]> {
  const res: any = await unwrap(api.GET('/api/v1/stock/receipts', { params: { query: { limit: 1000, include: 'lines' } } }))
  const rows: Record<string, unknown>[] = res?.data ?? []
  return rows.map(mapStockReceipt) as StockReceipt[]
}

export async function createReceipt(receipt: Omit<StockReceipt, 'id'>) {
  const data: any = await unwrap(api.POST('/api/v1/stock/receipts', {
    body: {
      supplier_id: receipt.supplierId || null,
      supplier_name: receipt.supplierName || null,
      date: receipt.date,
      note: receipt.note || null,
      payment_type: receipt.paymentType,
      paid_amount: String(receipt.paidAmount ?? 0),
      due_date: receipt.dueDate || null,
      lines: (receipt.lines ?? []).map(l => ({
        ingredient_id: l.ingredientId,
        name: l.name,
        qty: String(l.qty),
        unit: l.unit,
        price_per_unit: String(l.pricePerUnit),
      })),
    } as any,
  }))
  logAction('receipt.create', 'receipt', data?.id as string | undefined)
  return data
}

export async function confirmReceipt(id: string, confirmedBy: string) {
  await unwrap(api.POST('/api/v1/stock/receipts/{id}/confirm', {
    params: { path: { id } },
    body: { confirmed_by: confirmedBy } as any,
  }))
  logAction('receipt.confirm', 'receipt', id)
}

export async function confirmReceiptFull(receiptId: string, confirmedBy: string, accountId?: string) {
  const result = await unwrap(api.POST('/api/v1/stock/receipts/{id}/confirm', {
    params: { path: { id: receiptId } },
    body: {
      confirmed_by: confirmedBy,
      account_id: accountId,
      payment_type: accountId ? 'paid' : 'credit',
    } as any,
  }))
  logAction('receipt.confirm', 'receipt', receiptId, 'Накладная подтверждена')
  await checkAndUpdateStopList()
  return result
}

export async function fetchWriteoffs(): Promise<StockWriteoff[]> {
  const res: any = await unwrap(api.GET('/api/v1/stock/writeoffs', { params: { query: { limit: 1000, include: 'lines' } } }))
  const rows: Record<string, unknown>[] = res?.data ?? []
  return rows.map(mapStockWriteoff)
}

export async function createWriteoff(data: {
  reason: WriteoffReason
  description?: string
  lines: { ingredientId: string; name: string; qty: number; unit: string; pricePerUnit: number }[]
  createdBy?: string
}) {
  const totalCost = dSum(data.lines.map(l => dMul(l.qty, l.pricePerUnit)))
  const wo: any = await unwrap(api.POST('/api/v1/stock/writeoffs', {
    body: {
      reason: data.reason,
      description: data.description || null,
      lines: data.lines.map(l => ({
        ingredient_id: l.ingredientId,
        name: l.name,
        qty: String(l.qty),
        unit: l.unit,
        cost: String(dMul(l.qty, l.pricePerUnit)),
      })),
    } as any,
  }))
  await checkAndUpdateStopList()
  logAction('writeoff.create', 'writeoff', wo?.id as string | undefined, `Списание: ${data.reason}`, { totalCost, lines: data.lines.length })
  return wo
}

// ─── Supply Expenses ──────────────────────────────────────────────────────

export async function fetchSupplyExpenses(opts?: {
  from?: string
  to?: string
  limit?: number
  ingredientId?: string
}): Promise<import('../types').SupplyExpense[]> {
  const query: { limit: number; from?: string; to?: string; ingredient_id?: string } = { limit: opts?.limit ?? 1000 }
  if (opts?.from) query.from = opts.from
  if (opts?.to) query.to = opts.to
  if (opts?.ingredientId) query.ingredient_id = opts.ingredientId
  const res: any = await unwrap(api.GET('/api/v1/supply-expenses', { params: { query } }))
  const rows: Record<string, unknown>[] = res?.data ?? []
  return rows.map(mapSupplyExpense)
}

export async function createSupplyExpense(data: {
  ingredientId: string
  ingredientName: string
  qty: number
  unit: string
  reason: string
  issuedTo?: string
  note?: string
}): Promise<void> {
  await unwrap(api.POST('/api/v1/supply-expenses', {
    body: {
      ingredient_id: data.ingredientId,
      qty: String(data.qty),
      unit: data.unit,
      reason: data.reason,
      issued_to: data.issuedTo || null,
      note: data.note || null,
    } as any,
  }))
  logAction('supply.expense', 'ingredient', data.ingredientId, data.ingredientName, { qty: data.qty, reason: data.reason })
}

// ─── Inventory Checks ─────────────────────────────────────────────────────

export interface InventoryCheckLine {
  ingredientId: string
  ingredientName: string
  unit: string
  systemQty: number
  actualQty: number
  diff: number
}

export interface InventoryCheck {
  id: string
  conductedBy: string
  conductedById?: string
  status: 'draft' | 'applied'
  totalItems: number
  itemsWithDiff: number
  note: string
  createdAt: string
  appliedAt?: string
  lines?: InventoryCheckLine[]
}

export async function fetchInventoryChecks(): Promise<InventoryCheck[]> {
  try {
    const res: any = await unwrap(api.GET('/api/v1/stock/inventory', { params: { query: { limit: 500 } } }))
    const rows: Record<string, unknown>[] = res?.data ?? []
    return rows.map(mapInventoryCheck)
  } catch {
    return []
  }
}

export async function fetchInventoryCheckLines(checkId: string): Promise<InventoryCheckLine[]> {
  const res: any = await unwrap(api.GET('/api/v1/stock/inventory/{id}/lines', { params: { path: { id: checkId } } }))
  const rows: Record<string, unknown>[] = res?.data ?? []
  return rows.map(mapInventoryCheckLine)
}

export async function applyInventoryCheck(
  lines: { ingredientId: string; ingredientName: string; unit: string; systemQty: number; actualQty: number }[],
  conductedBy: string,
  conductedById: string,
  note: string,
): Promise<string> {
  void conductedBy; void conductedById
  const created: any = await unwrap(api.POST('/api/v1/stock/inventory', {
    body: {
      note,
      lines: lines.map(l => ({
        ingredient_id: l.ingredientId,
        actual_qty: String(l.actualQty),
      })),
    } as any,
  }))
  const checkId = (created?.id as string) ?? ''
  if (!checkId) {
    logAction('inventory.check', 'inventory_checks', 'no-history', 'Инвентаризация (без id)', {
      totalItems: lines.length,
    })
    return ''
  }
  await unwrap(api.POST('/api/v1/stock/inventory/{id}/apply', { params: { path: { id: checkId } }, body: {} as any }))
  const withDiff = lines.filter(l => dSub(l.actualQty, l.systemQty) !== 0).length
  logAction('inventory.check', 'inventory_checks', checkId, `Инвентаризация: ${withDiff} расхождений`, {
    totalItems: lines.length,
    itemsWithDiff: withDiff,
  })
  return checkId
}

// ─── Stop list ────────────────────────────────────────────────────────────

export async function checkAndUpdateStopList(): Promise<{ disabled: string[]; restored: string[] }> {
  try { await unwrap(api.POST('/api/v1/stop-list/recompute', { body: {} as any })) } catch {}
  return { disabled: [], restored: [] }
}

export async function fetchStopList(): Promise<{ menuItemId: string; menuItemName: string; emoji: string; category: string; ingredients: { name: string; qty: number; minQty: number; unit: string }[]; manual: boolean }[]> {
  const res: any = await unwrap(api.GET('/api/v1/stop-list'))
  const rows: Record<string, unknown>[] = res?.data ?? []
  return rows.map(mapStopListRow)
}

export async function toggleStopListOverride(menuItemId: string, override: boolean) {
  await unwrap(api.POST('/api/v1/stop-list/{menu_item_id}/override', {
    params: { path: { menu_item_id: menuItemId } },
    body: { override } as any,
  }))
}

// ─── Mappers ──────────────────────────────────────────────────────────────

function mapIngredient(r: Record<string, unknown>): Ingredient {
  return {
    id: r.id as string,
    name: (r.name as string) ?? '',
    category: (r.category as string) ?? '',
    qty: Number(r.qty ?? 0),
    minQty: Number(r.min_qty ?? 0),
    unit: (r.unit as string) ?? '',
    pricePerUnit: Number(r.price_per_unit ?? 0),
    wastePercent: Number(r.waste_percent ?? 0),
    isFood: r.is_food !== false,
  } as Ingredient
}

function mapStockMovement(r: Record<string, unknown>): StockMovement {
  return {
    id: r.id as string,
    type: r.type as StockMovement['type'],
    ingredientId: (r.ingredient_id as string | null) ?? undefined,
    ingredientName: (r.ingredient_name as string) ?? '',
    description: (r.description as string) ?? '',
    qty: Number(r.qty ?? 0),
    unit: (r.unit as string) ?? '',
    timestamp: (r.created_at as string) ?? '',
    belowZero: (r.below_zero as boolean | null) ?? undefined,
  } as StockMovement
}

function mapStockReceiptLine(l: Record<string, unknown>) {
  return {
    ingredientId: (l.ingredient_id as string) ?? '',
    name: (l.name as string) ?? '',
    qty: Number(l.qty ?? 0),
    unit: (l.unit as string) ?? '',
    pricePerUnit: Number(l.price_per_unit ?? 0),
  }
}

function mapStockReceipt(r: Record<string, unknown>): StockReceipt {
  const linesRaw: Record<string, unknown>[] = Array.isArray(r.lines) ? (r.lines as Record<string, unknown>[]) : []
  return {
    id: r.id as string,
    supplierId: (r.supplier_id as string | null) ?? '',
    supplierName: (r.supplier_name as string) ?? '',
    date: (r.date as string) ?? '',
    note: (r.note as string | null) ?? undefined,
    totalAmount: Number(r.total_amount ?? 0),
    paymentType: (r.payment_type as ReceiptPaymentType) ?? 'paid',
    paidAmount: Number(r.paid_amount ?? 0),
    debtAmount: Number(r.debt_amount ?? 0),
    dueDate: (r.due_date as string | null) ?? undefined,
    confirmedAt: (r.confirmed_at as string | null) ?? undefined,
    confirmedBy: (r.confirmed_by as string | null) ?? undefined,
    lines: linesRaw.map(mapStockReceiptLine),
  } as StockReceipt
}

function mapStockWriteoffLine(l: Record<string, unknown>) {
  return {
    ingredientId: (l.ingredient_id as string) ?? '',
    name: (l.name as string) ?? '',
    qty: Number(l.qty ?? 0),
    unit: (l.unit as string) ?? '',
    cost: Number(l.cost ?? 0),
  }
}

function mapStockWriteoff(r: Record<string, unknown>): StockWriteoff {
  const linesRaw: Record<string, unknown>[] = Array.isArray(r.lines) ? (r.lines as Record<string, unknown>[]) : []
  return {
    id: r.id as string,
    reason: (r.reason as WriteoffReason),
    description: (r.description as string | null) ?? undefined,
    totalCost: Number(r.total_cost ?? 0),
    createdBy: (r.created_by as string | null) ?? undefined,
    createdByName: undefined,
    createdAt: (r.created_at as string) ?? '',
    lines: linesRaw.map(mapStockWriteoffLine),
  } as StockWriteoff
}

function mapSupplyExpense(r: Record<string, unknown>): import('../types').SupplyExpense {
  return {
    id: r.id as string,
    ingredientId: (r.ingredient_id as string | null) ?? '',
    ingredientName: (r.ingredient_name as string) ?? '',
    qty: Number(r.qty ?? 0),
    unit: (r.unit as string) ?? '',
    reason: (r.reason as string) ?? '',
    issuedTo: (r.issued_to as string | null) ?? undefined,
    note: (r.note as string | null) ?? undefined,
    createdBy: (r.created_by as string | null) ?? undefined,
    createdAt: (r.created_at as string) ?? '',
  }
}

function mapInventoryCheck(r: Record<string, unknown>): InventoryCheck {
  return {
    id: r.id as string,
    conductedBy: (r.conducted_by as string) ?? '',
    conductedById: (r.conducted_by_id as string | null) ?? undefined,
    status: (r.status as 'draft' | 'applied') ?? 'draft',
    totalItems: Number(r.total_items ?? 0),
    itemsWithDiff: Number(r.items_with_diff ?? 0),
    note: (r.note as string | null) ?? '',
    createdAt: (r.created_at as string) ?? '',
    appliedAt: (r.applied_at as string | null) ?? undefined,
  }
}

function mapInventoryCheckLine(r: Record<string, unknown>): InventoryCheckLine {
  return {
    ingredientId: (r.ingredient_id as string) ?? '',
    ingredientName: (r.ingredient_name as string) ?? '',
    unit: (r.unit as string) ?? '',
    systemQty: Number(r.system_qty ?? 0),
    actualQty: Number(r.actual_qty ?? 0),
    diff: Number(r.diff ?? 0),
  }
}

function mapStopListIngredient(i: Record<string, unknown>) {
  return {
    name: (i.name as string) ?? '',
    qty: Number(i.qty ?? 0),
    minQty: Number(i.min_qty ?? 0),
    unit: (i.unit as string) ?? '',
  }
}

function mapStopListRow(r: Record<string, unknown>) {
  return {
    menuItemId: (r.menu_item_id as string) ?? '',
    menuItemName: (r.menu_item_name as string) ?? '',
    emoji: (r.emoji as string) ?? '',
    category: (r.category as string) ?? '',
    ingredients: Array.isArray(r.ingredients)
      ? (r.ingredients as Record<string, unknown>[]).map(mapStopListIngredient)
      : [],
    manual: !!r.manual,
  }
}
