import { api, unwrap, unwrapOr404 } from './_client'
import { getBaseURL } from '../api/v4-typed'
import { randomId } from '../random-id'
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

// patchShiftAccount — recovery для legacy-смен, открытых без accountId.
// Без счёта createShiftExpense и payServiceCharge падают; этот endpoint
// позволяет привязать cash-счёт к уже открытой смене без её закрытия.
// OpenAPI-сгенерённый клиент пока не знает про PATCH /shifts/{id}, поэтому
// идём через прямой fetch на тот же baseURL что используют остальные api-вызовы.
export async function patchShiftAccount(shiftId: string, accountId: string): Promise<void> {
  // Прямой fetch — openapi-fetch не имеет PATCH /shifts/{id} в типах до regen.
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (typeof localStorage !== 'undefined') {
    const tok = localStorage.getItem('restos-v4-token')
    if (tok) headers['Authorization'] = `Bearer ${tok}`
  }
  // Idempotency-Key как и в остальных write-вызовах (middleware api-клиента ставит UUID).
  // randomId() безопасен по LAN (http) — crypto.randomUUID там недоступен.
  headers['Idempotency-Key'] = randomId()
  const res = await fetch(`${getBaseURL()}/api/v1/shifts/${encodeURIComponent(shiftId)}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ account_id: accountId }),
  })
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try {
      const body = await res.json()
      msg = body?.error?.message || body?.message || msg
    } catch { /* ignore */ }
    throw new Error(msg)
  }
  logAction('shift.account.attach', 'shift', shiftId, 'Привязка счёта к смене', { accountId })
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
  // created_by резолвится бэком из session token — не отправляем явно.
  void createdBy
  await unwrap(api.POST('/api/v1/shifts/{id}/operations', {
    params: { path: { id: shiftId } },
    body: {
      type,
      amount: String(amount),
      description: description || null,
    } as any,
  }))
  logAction(type === 'cash_in' ? 'shift.cash_in' : 'shift.cash_out', 'shift', shiftId, type === 'cash_in' ? 'Внесение наличных' : 'Изъятие наличных', { amount, description })
}

export async function createShiftExpense(shiftId: string, amount: number, category: string, description: string, accountId?: string) {
  await unwrap(api.POST('/api/v1/shifts/{id}/expenses', {
    params: { path: { id: shiftId } },
    body: {
      type: 'expense',
      amount: String(amount),
      // Категория — структурным полем (cash_shift_operations.category), а не
      // префиксом в description. Позволяет агрегировать в своде/экспорте/X-Z.
      category,
      description: description || null,
      // account_id — счёт расхода. Пусто → счёт смены (наличный). Банк-счёт →
      // безналичный расход: дебетует его, наличный ящик не трогает.
      ...(accountId ? { account_id: accountId } : {}),
    } as any,
  }))
  logAction('shift.expense', 'shift', shiftId, `Расход из смены: ${category}`, { amount, category, description, accountId })
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

export interface ShiftZReportPrevious {
  revenue: number
  ordersCount: number
  avgCheck: number
  guestsCount: number
  closedAt?: string | null
}

export interface ShiftZReport {
  cashRevenue: number
  cardRevenue: number
  ordersCount: number
  avgCheck: number
  guestsCount: number
  discrepancy: number
  revenueByMethod: { paymentMethod: string; accountId: string; accountName: string; accountType: string; ordersCount: number; total: number }[]
  salesByWaiter: { waiterId: string; name: string; ordersCount: number; total: number; avgCheck: number }[]
  salesByCategory: { name: string; qty: number; total: number }[]
  salesByItem: { name: string; qty: number; total: number }[]
  salesByOrderType: { type: string; ordersCount: number; total: number }[]
  // Движение денег по кассе (внесения/изъятия/расходы по категориям).
  cashIn: number
  withdrawals: number
  expensesTotal: number
  // expensesTotalAll — все расходы бизнеса (нал+безнал, кроме возврата-зеркала).
  // expensesTotal — только наличные (для кассовой панели «Ожидается в кассе»);
  // сводка «Расход»/«Итог» показывает все расходы независимо от счёта.
  expensesTotalAll: number
  expensesByCategory: { category: string; count: number; amount: number }[]
  // Возвраты покупателям за смену (нал+безнал). Показываются отдельной строкой;
  // кассовое зеркало возврата исключено из expensesTotal, чтобы не задваивать.
  refundsTotal: number
  refundsCount: number
  previous?: ShiftZReportPrevious | null
}

export async function fetchShiftZReport(shiftId: string): Promise<ShiftZReport> {
  const r: any = await unwrap(api.GET('/api/v1/shifts/{id}/zreport', { params: { path: { id: shiftId } } }))
  const shift = r?.shift ?? {}
  return {
    cashRevenue: Number(shift.cash_revenue ?? 0),
    cardRevenue: Number(shift.card_revenue ?? 0),
    ordersCount: Number(shift.orders_count ?? 0),
    avgCheck: Number(shift.avg_check ?? 0),
    guestsCount: Number(r?.guests_count ?? 0),
    discrepancy: Number(r?.discrepancy ?? 0),
    revenueByMethod: (r?.revenue_by_method ?? []).map((m: any) => ({
      paymentMethod: String(m.payment_method ?? ''),
      accountId: String(m.account_id ?? ''),
      accountName: String(m.account_name ?? ''),
      accountType: String(m.account_type ?? ''),
      ordersCount: Number(m.orders_count ?? 0),
      total: Number(m.total ?? 0),
    })),
    salesByWaiter: (r?.sales_by_waiter ?? []).map((w: any) => ({
      waiterId: String(w.waiter_id ?? ''),
      name: String(w.name ?? '—'),
      ordersCount: Number(w.orders_count ?? 0),
      total: Number(w.total ?? 0),
      avgCheck: Number(w.avg_check ?? 0),
    })),
    salesByCategory: (r?.sales_by_category ?? []).map((c: any) => ({
      name: String(c.name ?? '—'),
      qty: Number(c.qty ?? 0),
      total: Number(c.total ?? 0),
    })),
    salesByItem: (r?.sales_by_item ?? []).map((c: any) => ({
      name: String(c.name ?? '—'),
      qty: Number(c.qty ?? 0),
      total: Number(c.total ?? 0),
    })),
    salesByOrderType: (r?.sales_by_order_type ?? []).map((t: any) => ({
      type: String(t.type ?? 'hall'),
      ordersCount: Number(t.orders_count ?? 0),
      total: Number(t.total ?? 0),
    })),
    cashIn: Number(r?.cash_in ?? 0),
    withdrawals: Number(r?.withdrawals ?? 0),
    expensesTotal: Number(r?.expenses_total ?? 0),
    // Фолбэк на expenses_total (старый бэк без поля) — тогда безнал не выделится,
    // но поведение не хуже прежнего.
    expensesTotalAll: Number(r?.expenses_total_all ?? r?.expenses_total ?? 0),
    expensesByCategory: (r?.expenses_by_category ?? []).map((e: any) => ({
      category: String(e.category ?? '—'),
      count: Number(e.count ?? 0),
      amount: Number(e.amount ?? 0),
    })),
    refundsTotal: Number(r?.refunds_total ?? 0),
    refundsCount: Number(r?.refunds_count ?? 0),
    previous: r?.previous
      ? {
          revenue: Number(r.previous.revenue ?? 0),
          ordersCount: Number(r.previous.orders_count ?? 0),
          avgCheck: Number(r.previous.avg_check ?? 0),
          guestsCount: Number(r.previous.guests_count ?? 0),
          closedAt: r.previous.closed_at ?? null,
        }
      : null,
  }
}

// ─── Print Z/X-report (sends ESC/POS to default receipt printer) ──────────

export async function printShiftZ(shiftId: string): Promise<{ jobId: string; status: string }> {
  const res: any = await unwrap(
    api.POST('/api/v1/shifts/{id}/print-z', { params: { path: { id: shiftId } } }),
  )
  return { jobId: String(res?.job_id ?? ''), status: String(res?.status ?? 'pending') }
}

export async function printShiftX(shiftId: string): Promise<{ jobId: string; status: string }> {
  const res: any = await unwrap(
    api.POST('/api/v1/shifts/{id}/print-x', { params: { path: { id: shiftId } } }),
  )
  return { jobId: String(res?.job_id ?? ''), status: String(res?.status ?? 'pending') }
}

// printShiftService — чек «Обслуживание официантов» за смену (рядом с X/Z).
export async function printShiftService(shiftId: string): Promise<{ jobId: string; status: string }> {
  const res: any = await unwrap(
    api.POST('/api/v1/shifts/{id}/print-service' as any, { params: { path: { id: shiftId } } as any }),
  )
  return { jobId: String(res?.job_id ?? ''), status: String(res?.status ?? 'pending') }
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
    category: r.category ?? undefined,
    accountId: r.account_id ?? undefined,
    createdBy: r.created_by ?? undefined,
    createdByName: undefined,
    createdAt: r.created_at,
  }
}
