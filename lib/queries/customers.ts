import { api, unwrap } from './_client'
import type { Customer } from '../types'
import { logAction } from './audit'
import { mapCustomer } from './_mappers'

export async function fetchCustomers(): Promise<Customer[]> {
  const res: any = await unwrap(api.GET('/api/v1/customers', { params: { query: { limit: 1000 } } }))
  const rows: any[] = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : []
  return rows.map(mapCustomer)
}

export async function searchCustomers(query: string): Promise<Customer[]> {
  const res: any = await unwrap(api.GET('/api/v1/customers', { params: { query: { q: query, limit: 100 } } }))
  const rows: any[] = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : []
  return rows.map(mapCustomer).slice(0, 10)
}

export async function createCustomer(data: {
  name: string
  phone?: string
  email?: string
  birthDate?: string
  notes?: string
}): Promise<Customer> {
  const row: any = await unwrap(api.POST('/api/v1/customers', {
    body: {
      name: data.name,
      phone: data.phone || null,
      email: data.email || null,
      birth_date: data.birthDate || null,
      notes: data.notes || null,
    } as any,
  }))
  logAction('customer.create', 'customer', row?.id, data.name)
  return mapCustomer(row)
}

export async function updateCustomer(id: string, data: Partial<{
  name: string
  phone: string
  email: string
  birthDate: string
  notes: string
}>): Promise<void> {
  const body: Record<string, unknown> = {}
  if (data.name !== undefined) body.name = data.name
  if (data.phone !== undefined) body.phone = data.phone || null
  if (data.email !== undefined) body.email = data.email || null
  if (data.birthDate !== undefined) body.birth_date = data.birthDate || null
  if (data.notes !== undefined) body.notes = data.notes || null
  await unwrap(api.PATCH('/api/v1/customers/{id}', { params: { path: { id } }, body: body as any }))
  logAction('customer.edit', 'customer', id)
}

export async function deleteCustomer(id: string): Promise<void> {
  await unwrap(api.DELETE('/api/v1/customers/{id}', { params: { path: { id } } }))
  logAction('customer.delete', 'customer', id)
}

export async function updateCustomerStats(customerId: string, orderTotal: number): Promise<void> {
  if (!customerId) return
  try {
    await unwrap(api.POST('/api/v1/customers/{id}/stats', {
      params: { path: { id: customerId } },
      body: { order_total: String(orderTotal) } as any,
    }))
  } catch {
    // best-effort — не валим UI закрытия заказа из-за CRM-метрики.
  }
}
