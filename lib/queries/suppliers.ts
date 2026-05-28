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

export async function updateSupplier(id: string, data: Partial<{ name: string; contact_person: string; phone: string; categories: string[]; payment_terms_days: number; credit_limit: number; current_debt: number }>) {
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
