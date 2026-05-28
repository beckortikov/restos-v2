import { api, unwrap } from './_client'
import type { Reservation, ReservationStatus } from '../types'
import { logAction } from './audit'
import { _mapV4Reservation } from './_mappers'

export async function fetchReservations(dateFrom?: string, dateTo?: string): Promise<Reservation[]> {
  const query: { from?: string; to?: string; limit: number } = { limit: 500 }
  if (dateFrom) query.from = dateFrom
  if (dateTo) query.to = dateTo
  const res: any = await unwrap(api.GET('/api/v1/reservations', { params: { query } }))
  const rows: any[] = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : []
  return rows
    .filter(r => r.status === 'active' || r.status === 'seated')
    .map(_mapV4Reservation)
}

export async function fetchReservationForTable(tableId: string): Promise<Reservation | null> {
  const res: any = await unwrap(api.GET('/api/v1/reservations/for-table/{table_id}', { params: { path: { table_id: tableId } } }))
  const rows: any[] = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : []
  const active = rows.find(r => r.status === 'active') ?? rows[0]
  if (!active) return null
  return _mapV4Reservation(active)
}

export async function createReservation(data: {
  tableId: string
  guestName: string
  guestPhone?: string
  guestsCount: number
  reservedAt: string
  durationMin?: number
  note?: string
  createdBy?: string
}) {
  await unwrap(api.POST('/api/v1/reservations', {
    body: {
      table_id: data.tableId,
      guest_name: data.guestName,
      guest_phone: data.guestPhone || null,
      guests_count: data.guestsCount,
      reserved_at: data.reservedAt,
      duration_min: data.durationMin ?? 120,
      note: data.note || null,
      status: 'active',
    } as any,
  }))
  logAction('reservation.create', 'reservation', data.tableId, data.guestName, { guestsCount: data.guestsCount, reservedAt: data.reservedAt })
}

export async function updateReservationStatus(id: string, status: ReservationStatus, tableId?: string) {
  const body: Record<string, unknown> = { status }
  if (tableId) body.table_id = tableId
  await unwrap(api.PATCH('/api/v1/reservations/{id}', { params: { path: { id } }, body: body as any }))
  logAction('reservation.' + status, 'reservation', id)
}
