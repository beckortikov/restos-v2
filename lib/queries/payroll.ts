import { api, unwrap, unwrapRaw, V4Error } from './_client'
import type { TimeEntry } from '../types'
import { logAction } from './audit'
import { mapTimeEntry } from './_mappers'

export interface WaiterTodayStats {
  ordersCount: number
  serviceEarned: number
}

export async function fetchWaiterTodayStats(waiterId: string): Promise<WaiterTodayStats> {
  const row: any = await unwrap(api.GET('/api/v1/waiters/{id}/today-stats', { params: { path: { id: waiterId } } }))
  return {
    ordersCount: Number(row?.orders_count ?? 0),
    serviceEarned: Number(row?.service_earned ?? 0),
  }
}

export async function fetchTimeEntries(dateFrom?: string, dateTo?: string): Promise<TimeEntry[]> {
  const query: { from?: string; to?: string; limit: number } = { limit: 1000 }
  if (dateFrom) query.from = dateFrom
  if (dateTo) query.to = dateTo
  const res: any = await unwrap(api.GET('/api/v1/time-entries', { params: { query } }))
  const rows: any[] = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : []
  return rows.map(mapTimeEntry)
}

export async function fetchActiveClockIn(userId: string): Promise<TimeEntry | null> {
  const res = await unwrapRaw(api.GET('/api/v1/time-entries/active', { params: { query: { user_id: userId } } }))
  if (res.response.status === 404) return null
  if (res.error) throw new V4Error(res.response.status, res.error)
  const row: any = res.data
  if (!row || !row.id) return null
  return mapTimeEntry(row)
}

export async function clockIn(userId: string): Promise<TimeEntry> {
  const row: any = await unwrap(api.POST('/api/v1/time-entries', { body: { user_id: userId } as any }))
  logAction('timetrack.clock_in', 'user', userId, 'Начал смену')
  return mapTimeEntry(row)
}

export async function clockOut(entryId: string): Promise<TimeEntry> {
  const row: any = await unwrap(api.PATCH('/api/v1/time-entries/{id}/clock-out', {
    params: { path: { id: entryId } },
    body: {} as any,
  }))
  logAction('timetrack.clock_out', 'user', row?.user_id, 'Завершил смену', { totalHours: Number(row?.total_hours ?? 0) })
  return mapTimeEntry(row)
}

export async function updateTimeEntry(id: string, updates: Partial<{
  clockIn: string
  clockOut: string
  breakMinutes: number
  note: string
}>): Promise<void> {
  const body: Record<string, unknown> = {}
  if (updates.clockIn !== undefined) body.clock_in = updates.clockIn
  if (updates.clockOut !== undefined) body.clock_out = updates.clockOut
  if (updates.note !== undefined) body.note = updates.note
  if (updates.breakMinutes !== undefined) body.break_minutes = updates.breakMinutes
  await unwrap(api.PATCH('/api/v1/time-entries/{id}', { params: { path: { id } }, body: body as any }))
}

export async function deleteTimeEntry(id: string): Promise<void> {
  await unwrap(api.DELETE('/api/v1/time-entries/{id}', { params: { path: { id } } }))
}
