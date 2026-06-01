import { api, unwrap } from './_client'
import { base64ToHex } from '@/lib/cp866'

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
  /** Sequential order number (orders.order_number) for human-readable summary. */
  orderNumber?: number
}

export async function fetchPrintJobs(opts?: { limit?: number; sinceMs?: number }): Promise<PrintJournalEntry[]> {
  const limit = opts?.limit ?? 100
  // Источник: таблица print_jobs (бэк), а не audit_log. См. server/internal/printer/*.
  // sinceMs пока фильтруется на клиенте — серверный from-query в /print/jobs
  // отсутствует в Phase 4; OK для журнала в 200-500 записей.
  let rows: any[] = []
  try {
    const res: any = await unwrap(api.GET('/api/v1/print/jobs', { params: { query: { limit } as any } }))
    rows = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : []
  } catch {
    return []
  }
  if (opts?.sinceMs) {
    const cutoff = Date.now() - opts.sinceMs
    rows = rows.filter(r => {
      const t = r?.created_at ? Date.parse(r.created_at) : 0
      return t >= cutoff
    })
  }
  return rows.map(mapPrintJobEntry)
}

export async function fetchAuditLog(limit = 100, offset = 0): Promise<AuditLogEntry[]> {
  const res: any = await unwrap(api.GET('/api/v1/audit-log', { params: { query: { limit, offset } } }))
  const rows: any[] = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : []
  return rows.map(mapAuditLogEntry)
}

// ─── Mappers ──────────────────────────────────────────────────────────────

// mapPrintJobEntry — конвертирует row из /api/v1/print/jobs (PrintJob schema)
// в UI-shape PrintJournalEntry. Поля привычные для legacy UI-фильтров
// (action='print.runner|receipt|cancel') синтезируются из PrintJob.type.
function mapPrintJobEntry(r: any): PrintJournalEntry {
  const type = String(r?.type ?? '')
  const status = String(r?.status ?? '')
  let action: PrintJournalEntry['action'] = 'print.receipt'
  if (type === 'runner') action = 'print.runner'
  else if (type === 'cancel_runner') action = 'print.cancel'
  else if (type === 'receipt' || type === 'pre_bill' || type === 'test') action = 'print.receipt'

  let uiStatus: PrintJournalEntry['status'] = 'mock'
  if (status === 'done') uiStatus = 'success'
  else if (status === 'failed') uiStatus = 'failed'
  // pending|running остаются 'mock' (промежуточный визуальный статус,
  // UI не различает их в журнале).

  const orderId: string | undefined = r?.order_id ?? undefined
  const lastError: string | undefined = r?.last_error ?? undefined
  const orderNumber: number | undefined = typeof r?.order_number === 'number' ? r.order_number : undefined
  const orderLabel = orderNumber != null
    ? `Заказ №${orderNumber}`
    : `Заказ ${orderId ? String(orderId).slice(0, 8) : '—'}`
  const summary = uiStatus === 'failed' && lastError
    ? lastError
    : `${orderLabel} / type=${type || 'unknown'}`

  return {
    id: String(r?.id ?? ''),
    action,
    status: uiStatus,
    summary,
    orderId,
    printerName: undefined,
    printerIP: undefined,
    contentHex: r?.payload ? base64ToHex(String(r.payload)) : undefined,
    station: undefined,
    reason: lastError,
    virtual: false,
    itemsCount: undefined,
    total: undefined,
    userName: undefined,
    createdAt: String(r?.created_at ?? ''),
    attempts: typeof r?.attempts === 'number' ? r.attempts : undefined,
    maxAttempts: undefined,
    dismissed: false,
    orderNumber,
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
