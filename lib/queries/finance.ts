import { api, unwrap, V4Error } from './_client'
import { fetchAllPages } from './_paginate'
import type {
  FinancialAccount, FinancialOperation, BudgetLine,
  Asset, Liability, EquityEntry,
  AssetCategory, LiabilityCategory, EquityCategory,
  FinancialActivity,
} from '../types'
import { logAction } from './audit'

export async function fetchFinancialAccounts(): Promise<FinancialAccount[]> {
  const res: any = await unwrap(api.GET('/api/v1/finance/accounts'))
  const rows: any[] = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : []
  return rows.map(mapFinancialAccount) as FinancialAccount[]
}

export async function createFinancialAccount(data: { name: string; type: string }): Promise<FinancialAccount> {
  const row: any = await unwrap(api.POST('/api/v1/finance/accounts', {
    body: { name: data.name, type: data.type, balance: '0' } as any,
  }))
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    balance: Number(row.balance ?? 0),
  } as FinancialAccount
}

export async function updateFinancialAccount(id: string, patch: { name?: string; type?: string }): Promise<FinancialAccount> {
  const body: Record<string, unknown> = {}
  if (patch.name !== undefined) body.name = patch.name
  if (patch.type !== undefined) body.type = patch.type
  const row: any = await unwrap(api.PATCH('/api/v1/finance/accounts/{id}', {
    params: { path: { id } },
    body: body as any,
  }))
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    balance: Number(row.balance ?? 0),
  } as FinancialAccount
}

export async function deleteFinancialAccount(id: string): Promise<void> {
  try {
    await unwrap(api.DELETE('/api/v1/finance/accounts/{id}', { params: { path: { id } } }))
  } catch (e) {
    if (e instanceof V4Error && e.status === 409) {
      throw new Error('Счёт используется в операциях')
    }
    throw e
  }
}

export async function fetchCustomCategories(): Promise<{ id: string; name: string; type: string }[]> {
  const res: any = await unwrap(api.GET('/api/v1/finance/custom-categories'))
  const rows: any[] = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : []
  return rows.map(r => ({ id: r.id, name: r.name, type: r.type }))
}

export async function createCustomCategory(name: string, type: 'in' | 'out'): Promise<void> {
  await unwrap(api.POST('/api/v1/finance/custom-categories', { body: { name, type } as any }))
}

export async function fetchFinancialOperations(): Promise<FinancialOperation[]> {
  // Курсор: бэк капит limit до 200 — в ДДС/отчётах терялись операции >200.
  const rows = await fetchAllPages('/api/v1/finance/operations', {}, 5000)
  return rows.map(mapFinancialOperation) as FinancialOperation[]
}

export async function createFinancialOperation(op: Omit<FinancialOperation, 'id'>) {
  const row: any = await unwrap(api.POST('/api/v1/finance/operations', {
    body: {
      type: op.type,
      amount: String(op.amount),
      category: op.category,
      account_id: op.accountId,
      activity: op.activity,
      date: op.date,
      description: op.description,
      counterparty: op.counterparty || null,
      shift_id: op.shiftId || null,
    } as any,
  }))
  logAction('finance.create', 'finance', row?.id, op.category, { amount: op.amount })
  return row
}

export async function fetchBudgetLines(): Promise<BudgetLine[]> {
  const res: any = await unwrap(api.GET('/api/v1/budget', { params: { query: { limit: 500 } } }))
  const rows: any[] = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : []
  return rows.map(mapBudgetLine) as BudgetLine[]
}

export async function createBudgetLine(data: { category: string; type: 'in' | 'out'; plan_amount: number; fact_amount: number; period: string }) {
  await unwrap(api.POST('/api/v1/budget', {
    body: {
      category: data.category,
      type: data.type,
      plan_amount: String(data.plan_amount),
      fact_amount: String(data.fact_amount),
      period: data.period,
    } as any,
  }))
  logAction('budget.create', 'budget', '', data.category)
}

export async function updateBudgetLine(id: string, data: Partial<{ category: string; type: string; plan_amount: number; fact_amount: number; period: string }>) {
  const body: Record<string, unknown> = {}
  if (data.category !== undefined) body.category = data.category
  if (data.type !== undefined) body.type = data.type
  if (data.period !== undefined) body.period = data.period
  if (data.plan_amount !== undefined) body.plan_amount = String(data.plan_amount)
  if (data.fact_amount !== undefined) body.fact_amount = String(data.fact_amount)
  await unwrap(api.PATCH('/api/v1/budget/{id}', { params: { path: { id } }, body: body as any }))
  logAction('budget.edit', 'budget', id)
}

export async function deleteBudgetLine(id: string) {
  await unwrap(api.DELETE('/api/v1/budget/{id}', { params: { path: { id } } }))
  logAction('budget.delete', 'budget', id)
}

// ─── Aggregated reports (server-computed) ─────────────────────────────────

export type PnLReport = {
  period: { from?: string; to?: string }
  revenue: { total: number; by_method: { method: string; amount: number }[] }
  cogs: { total: number }
  writeoffs: number
  opex: { total: number; by_category: { category: string; amount: number }[] }
  gross_profit: number
  net_profit: number
  margin_percent: number
}

export type CashflowReport = {
  period: { from?: string; to?: string }
  by_activity: Record<string, { in: number; out: number; net: number }>
  net_total: number
  by_day: { date: string; in: number; out: number }[]
  /** v3.5.0 — расход по конкретным статьям, sorted desc. */
  out_by_category: { category: string; amount: number }[]
}

export type BalanceReport = {
  accounts: { id: string; name: string; amount: number }[]
  cash_total: number
  inventory_value: number
  assets: { id: string; name: string; amount: number }[]
  total_assets: number
  supplier_debt: number
  liabilities: { id: string; name: string; total: number; paid: number; remaining: number }[]
  total_liabilities: number
  equity: { id: string; name: string; amount: number }[]
  total_equity: number
  computed_equity: number
  grand_total_assets: number
  grand_total_liabilities: number
}

function isoOrDate(v: Date | string | undefined): string | undefined {
  if (v == null) return undefined
  if (v instanceof Date) return v.toISOString()
  return String(v)
}

export async function fetchPnLReport(opts: { from?: Date | string; to?: Date | string } = {}): Promise<PnLReport> {
  const query: Record<string, string> = {}
  const from = isoOrDate(opts.from); if (from) query.from = from
  const to = isoOrDate(opts.to); if (to) query.to = to
  const r: any = await unwrap(api.GET('/api/v1/finance/pnl', { params: { query: query as any } }))
  const revenue = r?.revenue ?? {}
  const cogs = r?.cogs ?? {}
  const opex = r?.opex ?? {}
  return {
    period: { from: r?.period?.from, to: r?.period?.to },
    revenue: {
      total: Number(revenue.total ?? 0),
      by_method: (revenue.by_method ?? []).map((x: any) => ({ method: String(x.method ?? ''), amount: Number(x.amount ?? 0) })),
    },
    cogs: { total: Number(cogs.total ?? 0) },
    writeoffs: Number(r?.writeoffs ?? 0),
    opex: {
      total: Number(opex.total ?? 0),
      by_category: (opex.by_category ?? []).map((x: any) => ({ category: String(x.category ?? ''), amount: Number(x.amount ?? 0) })),
    },
    gross_profit: Number(r?.gross_profit ?? 0),
    net_profit: Number(r?.net_profit ?? 0),
    margin_percent: Number(r?.margin_percent ?? 0),
  }
}

export async function fetchCashflowReport(opts: { from?: Date | string; to?: Date | string } = {}): Promise<CashflowReport> {
  const query: Record<string, string> = {}
  const from = isoOrDate(opts.from); if (from) query.from = from
  const to = isoOrDate(opts.to); if (to) query.to = to
  const r: any = await unwrap(api.GET('/api/v1/finance/cashflow', { params: { query: query as any } }))
  const byActivity: Record<string, { in: number; out: number; net: number }> = {}
  const ba = r?.by_activity ?? {}
  for (const k of Object.keys(ba)) {
    const v: any = ba[k] ?? {}
    byActivity[k] = { in: Number(v.in ?? 0), out: Number(v.out ?? 0), net: Number(v.net ?? 0) }
  }
  return {
    period: { from: r?.period?.from, to: r?.period?.to },
    by_activity: byActivity,
    net_total: Number(r?.net_total ?? 0),
    by_day: (r?.by_day ?? []).map((d: any) => ({
      date: String(d.date ?? ''),
      in: Number(d.in ?? 0),
      out: Number(d.out ?? 0),
    })),
    out_by_category: (r?.out_by_category ?? []).map((c: any) => ({
      category: String(c.category ?? ''),
      amount: Number(c.amount ?? 0),
    })),
  }
}

export async function fetchBalanceReport(): Promise<BalanceReport> {
  const r: any = await unwrap(api.GET('/api/v1/finance/balance'))
  return {
    accounts: (r?.accounts ?? []).map((x: any) => ({ id: String(x.id ?? ''), name: String(x.name ?? ''), amount: Number(x.amount ?? 0) })),
    cash_total: Number(r?.cash_total ?? 0),
    inventory_value: Number(r?.inventory_value ?? 0),
    assets: (r?.assets ?? []).map((x: any) => ({ id: String(x.id ?? ''), name: String(x.name ?? ''), amount: Number(x.amount ?? 0) })),
    total_assets: Number(r?.total_assets ?? 0),
    supplier_debt: Number(r?.supplier_debt ?? 0),
    liabilities: (r?.liabilities ?? []).map((x: any) => ({
      id: String(x.id ?? ''),
      name: String(x.name ?? ''),
      total: Number(x.total ?? 0),
      paid: Number(x.paid ?? 0),
      remaining: Number(x.remaining ?? 0),
    })),
    total_liabilities: Number(r?.total_liabilities ?? 0),
    equity: (r?.equity ?? []).map((x: any) => ({ id: String(x.id ?? ''), name: String(x.name ?? ''), amount: Number(x.amount ?? 0) })),
    total_equity: Number(r?.total_equity ?? 0),
    computed_equity: Number(r?.computed_equity ?? 0),
    grand_total_assets: Number(r?.grand_total_assets ?? 0),
    grand_total_liabilities: Number(r?.grand_total_liabilities ?? 0),
  }
}

export async function fetchMonthlyRevenue() {
  const res: any = await unwrap(api.GET('/api/v1/finance/monthly-revenue', { params: { query: { months: 12 } } }))
  const rows: any[] = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : []
  return rows.slice(-7).map(mapMonthlyRevenueRow)
}

// ─── Salary / Service charge ──────────────────────────────────────────────

// kind='advance' → проводка ляжет категорией «Аванс», иначе «Зарплата».
// Без этого отчёт не мог отделить авансы от расчёта: оба писались одной
// категорией и различались лишь текстом «(аванс)» в имени контрагента.
export async function paySalaryFull(
  userId: string,
  amount: number,
  accountId: string,
  accountName: string,
  employeeName: string,
  kind: 'salary' | 'advance' = 'salary',
) {
  void accountName
  const label = kind === 'advance' ? 'Аванс' : 'Зарплата'
  await unwrap(api.POST('/api/v1/finance/salary/pay', {
    body: {
      user_id: userId,
      amount: String(amount),
      account_id: accountId,
      employee_name: employeeName,
      kind,
      description: `${label} ${employeeName}`,
    } as any,
  }))
  logAction('payroll.pay', 'payroll', userId, employeeName, { amount, kind })
}

// ─── Остатки по счетам на дату ────────────────────────────────────────────

export interface AccountPeriodSummary {
  accountId: string
  accountName: string
  accountType: string
  currentBalance: number
  openingBalance: number
  in: number
  out: number
  closingBalance: number
}

export interface AccountBalanceDay {
  date: string
  in: number
  out: number
  closingBalance: number
  perAccount: Record<string, number>
}

export interface AccountBalanceHistory {
  from: string
  to: string
  accounts: AccountPeriodSummary[]
  days: AccountBalanceDay[]
}

// fetchAccountBalanceHistory — «сколько денег было на счетах в каждый день».
// Считает сервер: financial_accounts.balance — остаток «сейчас», истории в
// схеме нет, а список операций на клиенте обрезан лимитом выборки.
export async function fetchAccountBalanceHistory(from: string, to: string): Promise<AccountBalanceHistory> {
  const res: any = await unwrap(
    api.GET('/api/v1/finance/accounts/balance-history', { params: { query: { from, to } } as any }),
  )
  const num = (v: any) => Number(v ?? 0)
  return {
    from: res?.from ?? from,
    to: res?.to ?? to,
    accounts: (res?.accounts ?? []).map((a: any) => ({
      accountId: a.account_id ?? '',
      accountName: a.account_name ?? '',
      accountType: a.account_type ?? '',
      currentBalance: num(a.current_balance),
      openingBalance: num(a.opening_balance),
      in: num(a.in),
      out: num(a.out),
      closingBalance: num(a.closing_balance),
    })),
    days: (res?.days ?? []).map((d: any) => ({
      date: d.date ?? '',
      in: num(d.in),
      out: num(d.out),
      closingBalance: num(d.closing_balance),
      perAccount: Object.fromEntries(
        Object.entries(d.per_account ?? {}).map(([k, v]) => [k, num(v)]),
      ) as Record<string, number>,
    })),
  }
}

// ─── Начисления (оклад / дневная оплата) ──────────────────────────────────

export interface SalaryAccrualRow {
  userId: string
  userName: string
  position?: string
  role?: string
  payType: 'monthly' | 'daily'
  salary: number
  dailyRate: number
  /** Дней с отметкой в табеле за период. Для оклада не используется. */
  daysWorked: number
  /** Оклад или ставка × дни — в зависимости от payType. */
  accrued: number
  advance: number
  deductions: number
}

export async function fetchSalaryAccrual(from: string, to: string): Promise<SalaryAccrualRow[]> {
  const res: any = await unwrap(
    api.GET('/api/v1/finance/salary/accrual', { params: { query: { from, to } } as any }),
  )
  return (res?.data ?? []).map((r: any) => ({
    userId: r.user_id ?? '',
    userName: r.user_name ?? '',
    position: r.position || undefined,
    role: r.role || undefined,
    payType: r.pay_type === 'daily' ? 'daily' : 'monthly',
    salary: Number(r.salary ?? 0),
    dailyRate: Number(r.daily_rate ?? 0),
    daysWorked: Number(r.days_worked ?? 0),
    accrued: Number(r.accrued ?? 0),
    advance: Number(r.advance ?? 0),
    deductions: Number(r.deductions ?? 0),
  }))
}

// ─── Отчёт по зарплате ────────────────────────────────────────────────────

export interface SalaryPayoutRow {
  id: string
  date: string
  userId: string
  userName: string
  kind: 'salary' | 'advance' | 'service'
  amount: number
  accountId?: string
  accountName?: string
  description?: string
}

export interface SalaryReportRow {
  userId: string
  userName: string
  position?: string
  role?: string
  salary: number
  salaryPaid: number
  advancePaid: number
  servicePaid: number
  total: number
  payoutsCount: number
  lastPayoutAt?: string
}

export interface SalaryReport {
  from: string
  to: string
  rows: SalaryReportRow[]
  payouts: SalaryPayoutRow[]
  totals: {
    salaryPaid: number
    advancePaid: number
    servicePaid: number
    total: number
    employees: number
    payouts: number
  }
}

export async function fetchSalaryReport(from: string, to: string): Promise<SalaryReport> {
  const res: any = await unwrap(
    api.GET('/api/v1/finance/salary/report', { params: { query: { from, to } } as any }),
  )
  return {
    from: res?.from ?? from,
    to: res?.to ?? to,
    rows: (res?.rows ?? []).map((r: any) => ({
      userId: r.user_id ?? '',
      userName: r.user_name ?? '',
      position: r.position || undefined,
      role: r.role || undefined,
      salary: Number(r.salary ?? 0),
      salaryPaid: Number(r.salary_paid ?? 0),
      advancePaid: Number(r.advance_paid ?? 0),
      servicePaid: Number(r.service_paid ?? 0),
      total: Number(r.total ?? 0),
      payoutsCount: Number(r.payouts_count ?? 0),
      lastPayoutAt: r.last_payout_at || undefined,
    })),
    payouts: (res?.payouts ?? []).map((p: any) => ({
      id: p.id ?? '',
      date: p.date ?? '',
      userId: p.user_id ?? '',
      userName: p.user_name ?? '',
      kind: (p.kind ?? 'salary') as SalaryPayoutRow['kind'],
      amount: Number(p.amount ?? 0),
      accountId: p.account_id || undefined,
      accountName: p.account_name || undefined,
      description: p.description || undefined,
    })),
    totals: {
      salaryPaid: Number(res?.totals?.salary_paid ?? 0),
      advancePaid: Number(res?.totals?.advance_paid ?? 0),
      servicePaid: Number(res?.totals?.service_paid ?? 0),
      total: Number(res?.totals?.total ?? 0),
      employees: Number(res?.totals?.employees ?? 0),
      payouts: Number(res?.totals?.payouts ?? 0),
    },
  }
}

export interface ServiceAccrualByWaiter {
  waiterId: string | null
  accrued: number
  ordersCount: number
}

export async function fetchServiceAccrualByWaiter(periodFrom: string, periodTo: string): Promise<ServiceAccrualByWaiter[]> {
  const res: any = await unwrap(api.GET('/api/v1/finance/service-accrual/by-waiter', {
    params: { query: { from: periodFrom, to: periodTo } },
  }))
  const rows: any[] = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : []
  return rows.map(mapServiceAccrualByWaiter)
}

export async function fetchServicePayoutByWaiter(periodFrom: string, periodTo: string): Promise<Record<string, number>> {
  const res: any = await unwrap(api.GET('/api/v1/finance/service-payout/by-waiter', {
    params: { query: { from: periodFrom, to: periodTo } },
  }))
  const rows: any[] = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : []
  const out: Record<string, number> = {}
  for (const r of rows) {
    const wid = (r.waiter_id as string) || ''
    if (!wid) continue
    out[wid] = (out[wid] ?? 0) + Number(r.paid_amount ?? 0)
  }
  return out
}

export async function fetchServiceAccrualByShift(shiftId: string): Promise<ServiceAccrualByWaiter[]> {
  const res: any = await unwrap(api.GET('/api/v1/finance/service-accrual/by-shift/{shift_id}', {
    params: { path: { shift_id: shiftId } },
  }))
  const rows: any[] = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : []
  return rows.map(mapServiceAccrualByWaiter)
}

export async function fetchServicePayoutByShift(shiftId: string): Promise<Record<string, number>> {
  const res: any = await unwrap(api.GET('/api/v1/finance/service-payout/by-shift/{shift_id}', {
    params: { path: { shift_id: shiftId } },
  }))
  const rows: any[] = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : []
  const out: Record<string, number> = {}
  for (const r of rows) {
    const wid = (r.waiter_id as string) || ''
    if (!wid) continue
    out[wid] = (out[wid] ?? 0) + Number(r.paid_amount ?? 0)
  }
  return out
}

export async function payServiceCharge(args: {
  waiterId: string
  waiterName: string
  amount: number
  accountId: string
  accountName: string
  periodFrom: string
  periodTo: string
  shiftId?: string
}) {
  const { waiterId, waiterName, amount, accountId, accountName, periodFrom, periodTo, shiftId } = args
  void accountName
  const periodLabel = periodFrom.slice(0, 10) === periodTo.slice(0, 10)
    ? periodFrom.slice(0, 10)
    : `${periodFrom.slice(0, 10)}…${periodTo.slice(0, 10)}`
  const description = `Выплата обслуживания: ${waiterName} · ${periodLabel}`
  await unwrap(api.POST('/api/v1/finance/service-charge/pay', {
    body: {
      waiter_id: waiterId,
      amount: String(amount),
      account_id: accountId,
      period_from: periodFrom,
      period_to: periodTo,
      description,
      // Привязка к смене — иначе выплата не попадёт в отчёт по смене.
      shift_id: shiftId,
    } as any,
  }))
  logAction('payroll.service_pay', 'payroll', waiterId, waiterName, { amount, periodFrom, periodTo, shiftId })
}

export async function transferBetweenAccounts(fromId: string, toId: string, amount: number, fromName: string, toName: string) {
  await unwrap(api.POST('/api/v1/finance/accounts/transfer', {
    body: {
      from_id: fromId,
      to_id: toId,
      amount: String(amount),
      description: `Перевод ${fromName} → ${toName}`,
    } as any,
  }))
  logAction('finance.transfer', 'finance', fromId, '', { amount, from: fromName, to: toName })
}

// ─── Assets ───────────────────────────────────────────────────────────────

export async function fetchAssets(): Promise<Asset[]> {
  const res: any = await unwrap(api.GET('/api/v1/assets', { params: { query: { limit: 500 } } }))
  const rows: any[] = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : []
  return rows.map(mapAsset)
}

export async function createAsset(data: Omit<Asset, 'id'>) {
  await unwrap(api.POST('/api/v1/assets', {
    body: {
      name: data.name,
      category: data.category,
      amount: String(data.amount),
      purchase_date: data.purchaseDate || null,
      useful_life_months: data.usefulLifeMonths || null,
      note: data.note || null,
    } as any,
  }))
  logAction('asset.create', 'asset', '', data.name)
}

export async function updateAsset(id: string, data: Partial<Omit<Asset, 'id'>>) {
  const body: Record<string, unknown> = {}
  if (data.name !== undefined) body.name = data.name
  if (data.category !== undefined) body.category = data.category
  if (data.amount !== undefined) body.amount = String(data.amount)
  if (data.purchaseDate !== undefined) body.purchase_date = data.purchaseDate
  if (data.usefulLifeMonths !== undefined) body.useful_life_months = data.usefulLifeMonths
  if (data.note !== undefined) body.note = data.note
  await unwrap(api.PATCH('/api/v1/assets/{id}', { params: { path: { id } }, body: body as any }))
}

export async function deleteAsset(id: string) {
  await unwrap(api.DELETE('/api/v1/assets/{id}', { params: { path: { id } } }))
  logAction('asset.delete', 'asset', id)
}

// ─── Liabilities ──────────────────────────────────────────────────────────

export async function fetchLiabilities(): Promise<Liability[]> {
  const res: any = await unwrap(api.GET('/api/v1/liabilities', { params: { query: { limit: 500 } } }))
  const rows: any[] = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : []
  return rows.map(mapLiability)
}

export async function createLiability(data: Omit<Liability, 'id' | 'remainingAmount'>) {
  await unwrap(api.POST('/api/v1/liabilities', {
    body: {
      name: data.name,
      category: data.category,
      total_amount: String(data.totalAmount),
      paid_amount: String(data.paidAmount),
      creditor: data.creditor || null,
      due_date: data.dueDate || null,
      monthly_payment: data.monthlyPayment != null ? String(data.monthlyPayment) : null,
      interest_rate: data.interestRate != null ? String(data.interestRate) : null,
      note: data.note || null,
    } as any,
  }))
  logAction('liability.create', 'liability', '', data.name)
}

export async function updateLiability(id: string, data: Partial<Omit<Liability, 'id' | 'remainingAmount'>>) {
  const body: Record<string, unknown> = {}
  if (data.name !== undefined) body.name = data.name
  if (data.category !== undefined) body.category = data.category
  if (data.totalAmount !== undefined) body.total_amount = String(data.totalAmount)
  if (data.paidAmount !== undefined) body.paid_amount = String(data.paidAmount)
  if (data.creditor !== undefined) body.creditor = data.creditor
  if (data.dueDate !== undefined) body.due_date = data.dueDate
  if (data.monthlyPayment !== undefined) body.monthly_payment = data.monthlyPayment != null ? String(data.monthlyPayment) : null
  if (data.interestRate !== undefined) body.interest_rate = data.interestRate != null ? String(data.interestRate) : null
  if (data.note !== undefined) body.note = data.note
  await unwrap(api.PATCH('/api/v1/liabilities/{id}', { params: { path: { id } }, body: body as any }))
}

export async function deleteLiability(id: string) {
  await unwrap(api.DELETE('/api/v1/liabilities/{id}', { params: { path: { id } } }))
  logAction('liability.delete', 'liability', id)
}

// ─── Equity ───────────────────────────────────────────────────────────────

export async function fetchEquity(): Promise<EquityEntry[]> {
  const res: any = await unwrap(api.GET('/api/v1/equity', { params: { query: { limit: 500 } } }))
  const rows: any[] = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : []
  return rows.map(mapEquityEntry)
}

export async function createEquity(data: Omit<EquityEntry, 'id'>) {
  await unwrap(api.POST('/api/v1/equity', {
    body: {
      name: data.name,
      category: data.category,
      amount: String(data.amount),
      note: data.note || null,
    } as any,
  }))
  logAction('equity.create', 'equity', '', data.name)
}

export async function updateEquity(id: string, data: Partial<Omit<EquityEntry, 'id'>>) {
  const body: Record<string, unknown> = {}
  if (data.name !== undefined) body.name = data.name
  if (data.category !== undefined) body.category = data.category
  if (data.amount !== undefined) body.amount = String(data.amount)
  if (data.note !== undefined) body.note = data.note
  await unwrap(api.PATCH('/api/v1/equity/{id}', { params: { path: { id } }, body: body as any }))
}

export async function deleteEquity(id: string) {
  await unwrap(api.DELETE('/api/v1/equity/{id}', { params: { path: { id } } }))
  logAction('equity.delete', 'equity', id)
}

// ─── Mappers ──────────────────────────────────────────────────────────────

function mapFinancialAccount(r: any): FinancialAccount {
  return {
    id: r.id,
    name: r.name,
    type: r.type,
    balance: Number(r.balance ?? 0),
  } as FinancialAccount
}

function mapFinancialOperation(r: any): FinancialOperation {
  return {
    id: r.id,
    type: r.type,
    amount: Number(r.amount ?? 0),
    category: r.category,
    accountId: r.account_id,
    accountName: r.account_name ?? '',
    activity: r.activity as FinancialActivity,
    date: r.date,
    description: r.description,
    counterparty: r.counterparty ?? undefined,
    isAuto: r.is_auto,
    sourceRef: r.source_ref ?? undefined,
    shiftId: r.shift_id ?? undefined,
  } as FinancialOperation
}

function mapBudgetLine(r: any): BudgetLine {
  return {
    id: r.id,
    category: r.category,
    type: r.type,
    planAmount: Number(r.plan_amount ?? 0),
    factAmount: Number(r.fact_amount ?? 0),
  } as BudgetLine
}

const MONTHLY_REVENUE_MONTH_NAMES = ['Янв', 'Фев', 'Мар', 'Апр', 'Май', 'Июн', 'Июл', 'Авг', 'Сен', 'Окт', 'Ноя', 'Дек']

function mapMonthlyRevenueRow(r: any) {
  const key = String(r.month ?? '')
  const monthIdx = parseInt(key.split('-')[1] ?? '1', 10) - 1
  const revenue = Number(r.revenue ?? 0)
  const expenses = Number(r.expenses ?? 0)
  const profit = r.profit != null ? Number(r.profit) : revenue - expenses
  return {
    month: MONTHLY_REVENUE_MONTH_NAMES[monthIdx] ?? key,
    revenue,
    expenses,
    profit,
    ordersCount: Number(r.orders_count ?? 0),
    avgCheck: Number(r.avg_check ?? 0),
  }
}

function mapServiceAccrualByWaiter(r: any): ServiceAccrualByWaiter {
  return {
    waiterId: (r.waiter_id as string) || null,
    accrued: Number(r.accrued_amount ?? 0),
    ordersCount: Number(r.total_orders ?? 0),
  }
}

function mapAsset(r: any): Asset {
  return {
    id: r.id,
    name: r.name,
    category: r.category as AssetCategory,
    amount: Number(r.amount ?? 0),
    purchaseDate: r.purchase_date ?? undefined,
    usefulLifeMonths: r.useful_life_months ?? null,
    note: r.note ?? undefined,
  }
}

function mapLiability(r: any): Liability {
  return {
    id: r.id,
    name: r.name,
    category: r.category as LiabilityCategory,
    totalAmount: Number(r.total_amount ?? 0),
    paidAmount: Number(r.paid_amount ?? 0),
    remainingAmount: Number(r.remaining_amount ?? 0),
    creditor: r.creditor ?? undefined,
    dueDate: r.due_date ?? undefined,
    monthlyPayment: r.monthly_payment ? Number(r.monthly_payment) : undefined,
    interestRate: r.interest_rate ? Number(r.interest_rate) : undefined,
    note: r.note ?? undefined,
  }
}

function mapEquityEntry(r: any): EquityEntry {
  return {
    id: r.id,
    name: r.name,
    category: r.category as EquityCategory,
    amount: Number(r.amount ?? 0),
    note: r.note ?? undefined,
  }
}

// ─── Н13-ретро: разовая коррекция балансов под фикс кассовых расходов ────────

export interface ShiftBalanceFixLine {
  account_id: string
  account_name: string
  balance_now: number
  correction: number
  balance_after: number
  ops_count: number
}
export interface ShiftBalanceFixResult {
  already_applied: boolean
  applied_at?: string | null
  cutoff: string
  total_correction: number
  lines: ShiftBalanceFixLine[]
}

function mapShiftBalanceFix(r: any): ShiftBalanceFixResult {
  return {
    already_applied: !!r?.already_applied,
    applied_at: r?.applied_at ?? null,
    cutoff: String(r?.cutoff ?? ''),
    total_correction: Number(r?.total_correction ?? 0),
    lines: (r?.lines ?? []).map((x: any) => ({
      account_id: String(x.account_id ?? ''),
      account_name: String(x.account_name ?? ''),
      balance_now: Number(x.balance_now ?? 0),
      correction: Number(x.correction ?? 0),
      balance_after: Number(x.balance_after ?? 0),
      ops_count: Number(x.ops_count ?? 0),
    })),
  }
}

// Превью коррекции (без изменений). cutoff — дата установки фикса (YYYY-MM-DD).
export async function fetchShiftBalanceFixPreview(cutoff?: string): Promise<ShiftBalanceFixResult> {
  const query: any = cutoff ? { cutoff } : {}
  const r: any = await unwrap(api.GET('/api/v1/admin/maintenance/shift-balance-fix', { params: { query } }))
  return mapShiftBalanceFix(r)
}

// Применить коррекцию РОВНО ОДИН РАЗ (сервер ставит маркер, повтор → 409).
export async function applyShiftBalanceFix(cutoff?: string): Promise<ShiftBalanceFixResult> {
  const query: any = cutoff ? { cutoff } : {}
  const r: any = await unwrap(api.POST('/api/v1/admin/maintenance/shift-balance-fix', {
    params: { query },
    headers: { 'Idempotency-Key': crypto.randomUUID() },
  } as any))
  return mapShiftBalanceFix(r)
}
