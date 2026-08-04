import { api, unwrap } from './_client'
import type { Supplier } from '../types'
import { logAction } from './audit'

export async function fetchSuppliers(): Promise<Supplier[]> {
  const res: any = await unwrap(api.GET('/api/v1/suppliers', { params: { query: { limit: 500 } } }))
  const rows: Record<string, unknown>[] = res?.data ?? []
  return rows.map(mapSupplier) as Supplier[]
}

export async function createSupplier(sup: Omit<Supplier, 'id'>) {
  const data: any = await unwrap(api.POST('/api/v1/suppliers', {
    body: {
      name: sup.name,
      contact_person: sup.contactPerson,
      phone: sup.phone,
      categories: sup.categories,
      payment_terms_days: sup.paymentTermsDays,
      credit_limit: String(sup.creditLimit ?? 0),
    } as any,
  }))
  logAction('supplier.create', 'supplier', data?.id as string | undefined, sup.name)
  return data
}

// Примечание: current_debt НЕ редактируется вручную — он управляется приёмками
// (кредит/частично → долг растёт), paySupplierDebt (гашение) и
// createSupplierOpeningDebt (перенос долга без накладной, ниже). Раньше страница
// пыталась слать current_debt сюда, но поле молча отбрасывалось (no-op).
export async function updateSupplier(id: string, data: Partial<{ name: string; contact_person: string; phone: string; categories: string[]; payment_terms_days: number; credit_limit: number }>) {
  const body: Record<string, unknown> = {}
  if (data.name !== undefined) body.name = data.name
  if (data.contact_person !== undefined) body.contact_person = data.contact_person
  if (data.phone !== undefined) body.phone = data.phone
  if (data.categories !== undefined) body.categories = data.categories
  if (data.payment_terms_days !== undefined) body.payment_terms_days = data.payment_terms_days
  if (data.credit_limit !== undefined) body.credit_limit = String(data.credit_limit)
  await unwrap(api.PATCH('/api/v1/suppliers/{id}', { params: { path: { id } }, body: body as any }))
  logAction('supplier.edit', 'supplier', id)
}

// paySupplierDebt — гашение долга поставщику: атомарно списывает amount со счёта
// accountId, уменьшает current_debt и создаёт financial_operation. Возвращает
// обновлённого поставщика.
export async function paySupplierDebt(id: string, amount: number, accountId: string): Promise<Supplier> {
  const data: any = await unwrap(api.POST('/api/v1/suppliers/{id}/pay-debt', {
    params: { path: { id } },
    body: { amount: String(amount), account_id: accountId } as any,
  }))
  logAction('supplier.pay_debt', 'supplier', id)
  return mapSupplier(data)
}

// createSupplierOpeningDebt — долг поставщику БЕЗ накладной (067): перенос
// задолженности с момента до перехода на эту систему. Склад не трогает —
// синтетическая строка stock_receipts без товарных позиций, увеличивает
// current_debt. Гасится обычным paySupplierDebt, переживает «Пересчитать долги».
export async function createSupplierOpeningDebt(id: string, amount: number, note?: string, date?: string): Promise<void> {
  await unwrap(api.POST('/api/v1/suppliers/{id}/opening-debt', {
    params: { path: { id } },
    body: { amount: String(amount), note: note || undefined, date: date || undefined } as any,
  }))
  logAction('supplier.opening_debt', 'supplier', id, undefined, { amount })
}

// recomputeSupplierDebts — пересчёт current_debt всех поставщиков из накладных
// (Σ debt_amount − Σ оплат долга). Нужен, когда поле разошлось: бэкфилл-миграция
// не отработала после восстановления/обновления. Возвращает число обновлённых.
export async function recomputeSupplierDebts(): Promise<number> {
  const data: any = await unwrap((api.POST as any)('/api/v1/suppliers/recompute-debts', { body: {} }))
  logAction('supplier.recompute_debts', 'supplier', undefined)
  return Number(data?.updated ?? 0)
}

export async function deleteSupplier(id: string) {
  await unwrap(api.DELETE('/api/v1/suppliers/{id}', { params: { path: { id } } }))
  logAction('supplier.delete', 'supplier', id)
}

// ─── Mappers ──────────────────────────────────────────────────────────────

function mapSupplier(r: Record<string, unknown>): Supplier {
  return {
    id: r.id as string,
    name: (r.name as string) ?? '',
    contactPerson: (r.contact_person as string) ?? '',
    phone: (r.phone as string) ?? '',
    categories: Array.isArray(r.categories) ? (r.categories as string[]) : [],
    paymentTermsDays: Number(r.payment_terms_days ?? 0),
    creditLimit: Number(r.credit_limit ?? 0),
    currentDebt: Number(r.current_debt ?? 0),
  } as Supplier
}
