import { api, unwrap, V4Error } from './_client'
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
  const res: any = await unwrap(api.GET('/api/v1/finance/operations', { params: { query: { limit: 1000 } } }))
  const rows: any[] = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : []
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

export async function fetchMonthlyRevenue() {
  const res: any = await unwrap(api.GET('/api/v1/finance/monthly-revenue', { params: { query: { months: 12 } } }))
  const rows: any[] = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : []
  return rows.slice(-7).map(mapMonthlyRevenueRow)
}

// ─── Salary / Service charge ──────────────────────────────────────────────

export async function paySalaryFull(userId: string, amount: number, accountId: string, accountName: string, employeeName: string) {
  void accountName
  await unwrap(api.POST('/api/v1/finance/salary/pay', {
    body: {
      user_id: userId,
      amount: String(amount),
      account_id: accountId,
      employee_name: employeeName,
      description: `Зарплата ${employeeName}`,
    } as any,
  }))
  logAction('payroll.pay', 'payroll', userId, employeeName, { amount })
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
  void accountName; void shiftId
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
