import { api, unwrap } from './_client'
import type { RecurringPayment, FinancialActivity } from '../types'
import { logAction } from './audit'

function mapRecurringPayment(r: any): RecurringPayment {
  return {
    id: r.id,
    name: r.name ?? '',
    category: r.category ?? '',
    amount: Number(r.amount ?? 0),
    accountId: r.account_id ?? undefined,
    activity: (r.activity ?? 'operational') as FinancialActivity,
    counterparty: r.counterparty ?? undefined,
    dayOfMonth: Number(r.day_of_month ?? 1),
    nextDue: r.next_due ?? undefined,
    lastPaidAt: r.last_paid_at ?? undefined,
    lastPaidAmount: r.last_paid_amount != null ? Number(r.last_paid_amount) : undefined,
    remainingAmount: r.remaining_amount != null ? Number(r.remaining_amount) : undefined,
    active: r.active ?? true,
    note: r.note ?? undefined,
  }
}

export async function fetchRecurringPayments(): Promise<RecurringPayment[]> {
  const res: any = await unwrap(api.GET('/api/v1/finance/recurring-payments'))
  const rows: any[] = res?.data ?? []
  return rows.map(mapRecurringPayment)
}

export interface RecurringPaymentDraft {
  name: string
  category?: string
  amount: number
  accountId?: string
  activity?: FinancialActivity
  counterparty?: string
  dayOfMonth: number
  active?: boolean
  note?: string
}

function toBody(d: Partial<RecurringPaymentDraft>): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  if (d.name !== undefined) body.name = d.name
  if (d.category !== undefined) body.category = d.category
  if (d.amount !== undefined) body.amount = String(d.amount)
  if (d.accountId !== undefined) body.account_id = d.accountId
  if (d.activity !== undefined) body.activity = d.activity
  if (d.counterparty !== undefined) body.counterparty = d.counterparty
  if (d.dayOfMonth !== undefined) body.day_of_month = d.dayOfMonth
  if (d.active !== undefined) body.active = d.active
  if (d.note !== undefined) body.note = d.note
  return body
}

export async function createRecurringPayment(d: RecurringPaymentDraft): Promise<RecurringPayment> {
  const data: any = await unwrap(api.POST('/api/v1/finance/recurring-payments', { body: toBody(d) as any }))
  logAction('recurring_payment.create', 'recurring_payment', data?.id, d.name)
  return mapRecurringPayment(data)
}

export async function updateRecurringPayment(id: string, d: Partial<RecurringPaymentDraft>): Promise<RecurringPayment> {
  const data: any = await unwrap(api.PATCH('/api/v1/finance/recurring-payments/{id}', {
    params: { path: { id } }, body: toBody(d) as any,
  }))
  logAction('recurring_payment.edit', 'recurring_payment', id)
  return mapRecurringPayment(data)
}

export async function deleteRecurringPayment(id: string): Promise<void> {
  await unwrap(api.DELETE('/api/v1/finance/recurring-payments/{id}', { params: { path: { id } } }))
  logAction('recurring_payment.delete', 'recurring_payment', id)
}

// payRecurringPayment — провести платёж. amount/accountId необязательны (по
// умолчанию из шаблона). idempotencyKey — один на попытку (второй клик не
// спишет дважды).
export async function payRecurringPayment(input: {
  id: string
  amount?: number
  accountId?: string
  idempotencyKey?: string
}): Promise<RecurringPayment> {
  const body: Record<string, unknown> = {}
  if (input.amount !== undefined) body.amount = String(input.amount)
  if (input.accountId !== undefined) body.account_id = input.accountId
  const data: any = await unwrap(api.POST('/api/v1/finance/recurring-payments/{id}/pay', {
    params: { path: { id: input.id } },
    ...(input.idempotencyKey ? { headers: { 'Idempotency-Key': input.idempotencyKey } } : {}),
    body: body as any,
  }))
  logAction('recurring_payment.pay', 'recurring_payment', input.id, 'Платёж')
  return mapRecurringPayment(data)
}
