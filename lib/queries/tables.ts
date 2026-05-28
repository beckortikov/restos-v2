import { api, unwrap, V4Error } from './_client'
import type { Zone, Table, TableStatus } from '../types'
import { logAction } from './audit'
import { ACTIVE_ORDER_STATUSES } from './_mappers'

export async function fetchZones(): Promise<Zone[]> {
  const res: any = await unwrap(api.GET('/api/v1/zones'))
  const rows: any[] = Array.isArray(res?.data) ? res.data : (Array.isArray(res) ? res : [])
  return rows
    .slice()
    .sort((a, b) => Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0))
    .map(r => ({ id: r.id, name: r.name }))
}

export async function fetchTables(): Promise<Table[]> {
  const [tablesRes, ordersRes] = await Promise.all([
    unwrap(api.GET('/api/v1/tables')),
    unwrap(api.GET('/api/v1/orders', { params: { query: { limit: 1000 } } })),
  ]) as [any, any]
  const tableRows: any[] = Array.isArray(tablesRes?.data) ? tablesRes.data : (Array.isArray(tablesRes) ? tablesRes : [])
  const orderRows: any[] = Array.isArray(ordersRes?.data) ? ordersRes.data : (Array.isArray(ordersRes) ? ordersRes : [])

  const idsByTable = new Map<string, string[]>()
  const activeSet = new Set(ACTIVE_ORDER_STATUSES)
  orderRows
    .filter(o => o.table_id && activeSet.has(o.status))
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
    .forEach(o => {
      const arr = idsByTable.get(o.table_id) ?? []
      arr.push(o.id)
      idsByTable.set(o.table_id, arr)
    })

  return tableRows
    .slice()
    .sort((a, b) => {
      const na = Number(a.number ?? 0)
      const nb = Number(b.number ?? 0)
      if (na !== nb) return na - nb
      return String(a.id).localeCompare(String(b.id))
    })
    .map(r => mapTable(r, idsByTable.get(r.id) ?? [])) as Table[]
}

export async function updateTableStatus(id: string, status: TableStatus, extra?: Partial<{ current_order_id: string | null; waiter_id: string | null; opened_at: string | null }>) {
  await unwrap(api.PATCH('/api/v1/tables/{id}/status', {
    params: { path: { id } },
    body: {
      status,
      current_order_id: extra?.current_order_id ?? null,
      waiter_id: extra?.waiter_id ?? null,
      opened_at: extra?.opened_at ?? null,
    } as any,
  }))
}

export async function createZone(name: string) {
  try {
    const data: any = await unwrap(api.POST('/api/v1/zones', { body: { name } as any }))
    logAction('zone.create', 'zone', data?.id, name)
    return data ? { id: data.id, name: data.name, sortOrder: data.sort_order ?? 0 } : data
  } catch (e) {
    if (e instanceof V4Error) throw new Error(e.envelope()?.message || 'Ошибка создания зоны')
    throw e
  }
}

export async function updateZone(id: string, name: string) {
  await unwrap(api.PATCH('/api/v1/zones/{id}', { params: { path: { id } }, body: { name } as any }))
  logAction('zone.edit', 'zone', id, name)
}

export async function deleteZone(id: string) {
  try {
    await unwrap(api.DELETE('/api/v1/zones/{id}', { params: { path: { id } } }))
  } catch (e) {
    if (e instanceof V4Error && e.status === 409) {
      throw new Error('Невозможно удалить: зона используется столами')
    }
    throw e
  }
  logAction('zone.delete', 'zone', id)
}

export async function createTable(data: { name: string; number: number; capacity: number; zone_id: string }) {
  try {
    const row: any = await unwrap(api.POST('/api/v1/tables', {
      body: {
        name: data.name,
        number: data.number,
        capacity: data.capacity,
        zone_id: data.zone_id,
      } as any,
    }))
    logAction('table.create', 'table', row?.id, data.name)
    return row
  } catch (e) {
    if (e instanceof V4Error) throw new Error(e.envelope()?.message || 'Ошибка создания стола')
    throw e
  }
}

export async function updateTableData(id: string, data: { name?: string; capacity?: number; zone_id?: string }) {
  const body: Record<string, unknown> = {}
  if (data.name !== undefined) body.name = data.name
  if (data.capacity !== undefined) body.capacity = data.capacity
  if (data.zone_id !== undefined) body.zone_id = data.zone_id
  if (Object.keys(body).length > 0) {
    await unwrap(api.PATCH('/api/v1/tables/{id}', { params: { path: { id } }, body: body as any }))
  }
  logAction('table.edit', 'table', id)
}

export async function deleteTable(id: string) {
  await unwrap(api.DELETE('/api/v1/tables/{id}', { params: { path: { id } } }))
  logAction('table.delete', 'table', id)
}

export async function assignWaiter(tableId: string, waiterId: string | null) {
  if (!tableId) throw new Error('Не указан стол')
  await unwrap(api.POST('/api/v1/tables/{id}/assign-waiter', {
    params: { path: { id: tableId } },
    body: { waiter_id: waiterId } as any,
  }))
  logAction('table.assign_waiter', 'table', tableId, undefined, {
    newTableWaiterId: waiterId,
  })
}

export async function quickUpdateCapacity(tableId: string, capacity: number) {
  await unwrap(api.PATCH('/api/v1/tables/{id}', { params: { path: { id: tableId } }, body: { capacity } as any }))
}

export async function mergeTables(primaryId: string, secondaryId: string) {
  const out: any = await unwrap(api.POST('/api/v1/tables/merge', {
    body: { primary_id: primaryId, secondary_id: secondaryId } as any,
  }))
  const totalCapacity = Number(out?.primary?.capacity ?? 0)
  logAction('table.merge', 'table', primaryId, '', { secondaryId, totalCapacity })
}

export async function unmergeTables(primaryId: string) {
  await unwrap(api.POST('/api/v1/tables/{id}/unmerge', { params: { path: { id: primaryId } }, body: {} as any }))
  logAction('table.unmerge', 'table', primaryId)
}

export async function openTableForOrder(tableId: string, orderId: string, waiterId?: string) {
  try {
    await unwrap(api.POST('/api/v1/tables/{id}/open-for-order', {
      params: { path: { id: tableId } },
      body: { order_id: orderId, waiter_id: waiterId } as any,
    }))
  } catch (e) {
    if (e instanceof V4Error) {
      throw new Error(`openTableForOrder failed: ${e.envelope()?.message || e.message}`)
    }
    throw e
  }
}

export async function cleanupStuckTables(): Promise<number> {
  const out: any = await unwrap(api.POST('/api/v1/admin/cleanup/stuck-tables', { body: {} as any }))
  const freed = Number(out?.cleaned ?? 0)
  if (freed > 0) console.log(`[cleanupStuckTables] freed ${freed} table(s)`)
  return freed
}

// ─── Mappers ──────────────────────────────────────────────────────────────

function mapTable(r: any, ids: string[]): Table {
  return {
    id: r.id,
    number: r.number,
    name: r.name == null ? '' : String(r.name),
    capacity: r.capacity,
    zone: r.zone_id,
    status: r.status as TableStatus,
    currentOrderId: ids[0] ?? r.current_order_id ?? undefined,
    currentOrderIds: ids,
    waiterId: r.waiter_id ?? undefined,
    openedAt: r.opened_at ?? undefined,
    mergedWith: r.merged_with ?? undefined,
  } as Table
}
