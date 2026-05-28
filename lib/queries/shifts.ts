import { api, unwrap, unwrapOr404 } from './_client'
import type { CashShift, CashShiftOperation } from '../types'
import { logAction } from './audit'
import { _mapV4Shift } from './_mappers'

export async function fetchActiveShift(): Promise<CashShift | null> {
  const r: any = await unwrapOr404(api.GET('/api/v1/shifts/active'))
  if (!r) return null
  return _mapV4Shift(r)
}

export async function fetchShifts(limit = 20): Promise<CashShift[]> {
  const env: any = await unwrap(api.GET('/api/v1/shifts', { params: { query: { limit } } }))
  const arr: any[] = Array.isArray(env?.data) ? env.data : Array.isArray(env) ? env : []
  return arr.map(_mapV4Shift)
}

export async function openShift(openedBy: string, openingBalance: number, accountId?: string): Promise<CashShift> {
  const r: any = await unwrap(api.POST('/api/v1/shifts', {
    body: {
      opening_balance: String(openingBalance),
      account_id: accountId ?? null,
    } as any,
  }))
  void openedBy
  logAction('shift.open', 'shift', r?.id, 'Смена открыта', { openingBalance, accountId })
  return _mapV4Shift(r)
}

export async function closeShift(shiftId: string, closedBy: string, closingBalance: number): Promise<CashShift> {
  const r: any = await unwrap(api.POST('/api/v1/shifts/{id}/close', {
    params: { path: { id: shiftId } },
    body: { closing_balance: String(closingBalance) } as any,
  }))
  void closedBy
  logAction('shift.close', 'shift', shiftId, 'Смена закрыта', { closingBalance })
  return _mapV4Shift(r)
}

export async function addShiftOperation(shiftId: string, type: 'cash_in' | 'cash_out', amount: number, description: string, createdBy?: string) {
  await unwrap(api.POST('/api/v1/shifts/{id}/operations', {
    params: { path: { id: shiftId } },
    body: {
      type,
      amount: String(amount),
      description: description || null,
      created_by: createdBy ?? null,
    } as any,
  }))
  logAction(type === 'cash_in' ? 'shift.cash_in' : 'shift.cash_out', 'shift', shiftId, type === 'cash_in' ? 'Внесение наличных' : 'Изъятие наличных', { amount, description })
}

export async function createShiftExpense(shiftId: string, amount: number, category: string, description: string, createdBy?: string) {
  await unwrap(api.POST('/api/v1/shifts/{id}/expenses', {
    params: { path: { id: shiftId } },
    body: {
      type: 'expense',
      amount: String(amount),
      description: `${category}: ${description}`,
      created_by: createdBy ?? null,
    } as any,
  }))
  logAction('shift.expense', 'shift', shiftId, `Расход из смены: ${category}`, { amount, category, description })
}

export async function deleteShiftExpense(opId: string) {
  // Сервер сам резолвит shift_id из самой операции и проверяет tenant + статус смены.
  await unwrap(api.DELETE('/api/v1/cash-shift-operations/{op_id}', { params: { path: { op_id: opId } } }))
  logAction('shift.expense.delete', 'shift', '', 'Удалён расход', { opId })
}

export async function fetchShiftRevenue(shiftId: string): Promise<{ cashRevenue: number; cardRevenue: number; ordersCount: number; avgCheck: number }> {
  const r: any = await unwrap(api.GET('/api/v1/shifts/{id}/revenue', { params: { path: { id: shiftId } } }))
  return {
    cashRevenue: Number(r?.cash_revenue ?? 0),
    cardRevenue: Number(r?.card_revenue ?? 0),
    ordersCount: Number(r?.orders_count ?? 0),
    avgCheck: Number(r?.avg_check ?? 0),
  }
}

export async function fetchShiftOperations(shiftId: string): Promise<CashShiftOperation[]> {
  const env: any = await unwrap(api.GET('/api/v1/shifts/{id}/operations', { params: { path: { id: shiftId } } }))
  const arr: any[] = Array.isArray(env?.data) ? env.data : Array.isArray(env) ? env : []
  return arr.map(r => mapShiftOperation(r, shiftId))
}

// ─── Mappers ──────────────────────────────────────────────────────────────

function mapShiftOperation(r: any, fallbackShiftId: string): CashShiftOperation {
  return {
    id: r.id,
    shiftId: r.shift_id ?? fallbackShiftId,
    type: r.type as CashShiftOperation['type'],
    amount: Number(r.amount ?? 0),
    description: r.description ?? undefined,
    createdBy: r.created_by ?? undefined,
    createdByName: undefined,
    createdAt: r.created_at,
  }
}
