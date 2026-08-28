import { api, unwrap, unwrapOr404 } from './_client'
import { getBaseURL } from '../api/v4-typed'
import { randomId } from '../random-id'
import type { CashShift, CashShiftOperation } from '../types'
import { logAction } from './audit'
import { _mapV4Shift } from './_mappers'
import { startOfToday } from '../helpers'

export async function fetchActiveShift(): Promise<CashShift | null> {
  const r: any = await unwrapOr404(api.GET('/api/v1/shifts/active'))
  if (!r) return null
  return _mapV4Shift(r)
}

// ordersFromBoundary — нижняя граница «from» для списков активных заказов
// (касса/официант/кухня). Раньше везде брали startOfToday() — полночь по
// часам БРАУЗЕРА. Если смена идёт через полночь, любой ещё не закрытый заказ,
// созданный ДО полуночи, пропадал из выборки в момент, когда часы её
// пересекали — хотя смена не закрыта.
//
// Возвращает момент открытия текущей смены (заказ точно не мог появиться
// раньше) — если смены нет, откатывается на startOfToday() (прежнее
// поведение). Специально БЕЗ shiftId-фильтра на вызывающей стороне: заказы
// официанта с Kotlin-планшета создаются без привязки к кассовой смене,
// жёсткий фильтр по shift_id уже один раз терял такие заказы (см. комментарий
// в app/pos2/order/page.tsx openOrders()) — эта граница только РАСШИРЯЕТ окно
// (никогда не уже startOfToday), поэтому не может повторить ту же ошибку.
export async function ordersFromBoundary(): Promise<Date> {
  try {
    const sh = await fetchActiveShift()
    if (sh?.openedAt) return new Date(sh.openedAt)
  } catch { /* нет открытой смены или сбой запроса — используем календарный день */ }
  return startOfToday()
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

// confirmOpenOrders — «закрыть всё равно», когда в ресторане есть незакрытые
// заказы (068). Требует права shifts.close_with_open_orders — без него бэк
// всё равно вернёт CONFLICT, даже если флаг передан.
export async function closeShift(shiftId: string, closedBy: string, closingBalance: number, confirmOpenOrders?: boolean): Promise<CashShift> {
  const r: any = await unwrap(api.POST('/api/v1/shifts/{id}/close', {
    params: { path: { id: shiftId } },
    body: { closing_balance: String(closingBalance), confirm_open_orders: confirmOpenOrders || undefined } as any,
  }))
  void closedBy
  logAction('shift.close', 'shift', shiftId, 'Смена закрыта', { closingBalance, confirmOpenOrders })
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
  /** Только у central (095): сама секция для обычного ресторана всегда
   *  отсутствует (delivery_relay_orders за смену — 0 строк). Central сам не
   *  торгует локально, поэтому все sales-секции выше для него нули — сколько
   *  он реально отправил филиалам за эту смену видно только тут. */
  dispatchSummary?: { sent: number; delivered: number; failed: number; closed: number; revenue: number } | null
}

export async function fetchShiftZReport(shiftId: string): Promise<ShiftZReport> {
  const r: any = await unwrap(api.GET('/api/v1/shifts/{id}/zreport', { params: { path: { id: shiftId } } }))
  return mapZReport(r)
}

// mapZReport — общий маппер для /shifts/{id}/zreport И /network/shifts/{id}/zreport:
// формат ответа идентичен (NetworkService.ShiftZReport делегирует в тот же
// ShiftsService.ZReport, просто с подменённым tenant филиала).
function mapZReport(r: any): ShiftZReport {
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
    dispatchSummary: r?.dispatch_summary
      ? {
          sent: Number(r.dispatch_summary.sent ?? 0),
          delivered: Number(r.dispatch_summary.delivered ?? 0),
          failed: Number(r.dispatch_summary.failed ?? 0),
          closed: Number(r.dispatch_summary.closed ?? 0),
          revenue: Number(r.dispatch_summary.revenue ?? 0),
        }
      : null,
  }
}

// ─── Смены сети (владелец: «Операции» скрыты на central, единственный ────
// способ увидеть смены филиалов из центра) ─────────────────────────────────

export interface NetworkShiftRow {
  id: string
  restaurantId: string
  restaurantName: string
  status: 'open' | 'closed'
  openedAt: string
  closedAt?: string
  openedByName: string
  closedByName?: string
  accountName: string
  openingBalance: number
  closingBalance?: number
  expectedCash?: number
  /** closing_balance − expected_cash, только у закрытых смен. */
  discrepancy?: number
  cashRevenue: number
  cardRevenue: number
  ordersCount: number
}

export interface NetworkShiftsTotals {
  openCount: number
  closedCount: number
  revenue: number
  ordersCount: number
  discrepancyCount: number
}

export interface NetworkShiftsResult {
  shifts: NetworkShiftRow[]
  totals: NetworkShiftsTotals
}

export async function fetchNetworkShifts(opts?: {
  from?: string; to?: string; branchId?: string; status?: 'open' | 'closed'
}): Promise<NetworkShiftsResult> {
  const query: Record<string, string> = {}
  if (opts?.from) query.from = opts.from
  if (opts?.to) query.to = opts.to
  if (opts?.branchId) query.branch_id = opts.branchId
  if (opts?.status) query.status = opts.status
  const r: any = await unwrap(api.GET('/api/v1/network/shifts', { params: { query } }))
  return {
    shifts: (r?.shifts ?? []).map((s: any) => ({
      id: String(s.id ?? ''),
      restaurantId: String(s.restaurant_id ?? ''),
      restaurantName: String(s.restaurant_name ?? '—'),
      status: (s.status ?? 'open') as 'open' | 'closed',
      openedAt: String(s.opened_at ?? ''),
      closedAt: s.closed_at || undefined,
      openedByName: String(s.opened_by_name ?? '—'),
      closedByName: s.closed_by_name || undefined,
      accountName: String(s.account_name ?? ''),
      openingBalance: Number(s.opening_balance ?? 0),
      closingBalance: s.closing_balance != null ? Number(s.closing_balance) : undefined,
      expectedCash: s.expected_cash != null ? Number(s.expected_cash) : undefined,
      discrepancy: s.discrepancy != null ? Number(s.discrepancy) : undefined,
      cashRevenue: Number(s.cash_revenue ?? 0),
      cardRevenue: Number(s.card_revenue ?? 0),
      ordersCount: Number(s.orders_count ?? 0),
    })),
    totals: {
      openCount: Number(r?.totals?.open_count ?? 0),
      closedCount: Number(r?.totals?.closed_count ?? 0),
      revenue: Number(r?.totals?.revenue ?? 0),
      ordersCount: Number(r?.totals?.orders_count ?? 0),
      discrepancyCount: Number(r?.totals?.discrepancy_count ?? 0),
    },
  }
}

/** Z-отчёт ОДНОЙ смены сети — тот же формат, что у fetchShiftZReport. */
export async function fetchNetworkShiftZReport(shiftId: string): Promise<ShiftZReport> {
  const r: any = await unwrap(api.GET('/api/v1/network/shifts/{id}/zreport', { params: { path: { id: shiftId } } }))
  return mapZReport(r)
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
