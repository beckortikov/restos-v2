import { api, unwrap } from './_client'

export async function logAction(action: string, entityType: string, entityId?: string, entityName?: string, details?: Record<string, unknown>): Promise<void> {
  // No-op in v4: server-side GORM hooks (internal/audit/hooks.go) write
  // audit_log rows automatically inside the same transaction as the mutation.
  void action; void entityType; void entityId; void entityName; void details
}

export interface AuditLogEntry {
  id: string
  userId?: string
  userName?: string
  action: string
  entityType: string
  entityId?: string
  entityName?: string
  details?: Record<string, unknown>
  createdAt: string
}

export interface PrintJournalEntry {
  id: string
  action: 'print.runner' | 'print.receipt' | 'print.cancel'
  status: 'success' | 'failed' | 'mock'
  summary: string
  orderId?: string
  printerName?: string
  printerIP?: string
  contentHex?: string
  station?: string
  reason?: string
  virtual?: boolean
  itemsCount?: number
  total?: number
  userName?: string
  createdAt: string
  /** Server-driven kitchen prints track retry count in details.attempts. */
  attempts?: number
  /** Server-driven kitchen prints carry max-attempts in details.max_attempts. */
  maxAttempts?: number
  /** Cashier dismissed from POS drawer — hide from active failure list. */
  dismissed?: boolean
}

export async function fetchPrintJobs(opts?: { limit?: number; sinceMs?: number }): Promise<PrintJournalEntry[]> {
  const limit = opts?.limit ?? 100
  const query: { limit: number; entity_type: string; from?: string } = {
    limit,
    entity_type: 'print',
  }
  if (opts?.sinceMs) query.from = new Date(Date.now() - opts.sinceMs).toISOString()
  let rows: any[] = []
  try {
    const res: any = await unwrap(api.GET('/api/v1/audit-log', { params: { query } }))
    rows = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : []
  } catch {
    return []
  }
  return rows.map(mapPrintJournalEntry)
}

export async function fetchAuditLog(limit = 100, offset = 0): Promise<AuditLogEntry[]> {
  const res: any = await unwrap(api.GET('/api/v1/audit-log', { params: { query: { limit, offset } } }))
  const rows: any[] = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : []
  return rows.map(mapAuditLogEntry)
}

// ─── Mappers ──────────────────────────────────────────────────────────────

function mapPrintJournalEntry(r: any): PrintJournalEntry {
  const details = (r.details as Record<string, unknown>) ?? {}
  return {
    id: r.id,
    action: r.action as PrintJournalEntry['action'],
    status: (details.status as PrintJournalEntry['status']) ?? 'mock',
    summary: r.entity_name ?? '',
    orderId: r.entity_id ?? undefined,
    printerName: (details.printer_name as string | null) ?? undefined,
    printerIP: (details.printer_ip as string | null) ?? undefined,
    contentHex: (details.content_hex as string | undefined),
    station: details.station as string | undefined,
    reason: (details.reason ?? details.reason_no_print) as string | undefined,
    virtual: details.virtual === true,
    itemsCount: details.items_count as number | undefined,
    total: details.total as number | undefined,
    userName: r.user_name ?? undefined,
    createdAt: r.created_at,
    attempts: typeof details.attempts === 'number' ? details.attempts : undefined,
    maxAttempts: typeof details.max_attempts === 'number' ? details.max_attempts : undefined,
    dismissed: details.dismissed === true,
  }
}

function mapAuditLogEntry(r: any): AuditLogEntry {
  return {
    id: r.id,
    userId: r.user_id ?? undefined,
    userName: r.user_name ?? undefined,
    action: r.action,
    entityType: r.entity_type,
    entityId: r.entity_id ?? undefined,
    entityName: r.entity_name ?? undefined,
    details: r.details ?? undefined,
    createdAt: r.created_at,
  }
}
