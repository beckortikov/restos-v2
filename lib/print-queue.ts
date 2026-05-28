'use client'

import Dexie, { type Table } from 'dexie'
import type { ReceiptPrintData } from './print-service'
import type { RunnerData } from '@/components/print-runner'
import type { CancellationRunnerData } from './print-service'

// ─── Print Queue: persistent retry buffer for failed prints ─────────────────

export type PrintJobKind = 'receipt' | 'runner' | 'cancel-runner'

export type PrintJobStatus = 'pending' | 'retrying' | 'dead'

export interface PrintJob {
  id?: number
  kind: PrintJobKind
  status: PrintJobStatus
  printerName?: string
  printerIP?: string
  payload: ReceiptPrintData | RunnerData | CancellationRunnerData
  summary: string
  createdAt: string
  attemptCount: number
  nextAttemptAt: number
  lastError?: string
}

const MAX_QUEUE_SIZE = 200
const BACKOFF_MS = [10_000, 30_000, 60_000, 5 * 60_000, 15 * 60_000] // 10s 30s 1m 5m 15m

export function backoffForAttempt(attempt: number): number {
  if (attempt >= BACKOFF_MS.length) return -1 // dead
  return BACKOFF_MS[attempt]
}

// Local Dexie store, scoped to print-retry queue only. In v1 this lived
// alongside the offline data cache (lib/offline/db.ts); v4 removed that
// cache layer, so the print queue carries its own minimal schema here.
class PrintQueueDB extends Dexie {
  print_queue!: Table<PrintJob, number>
  constructor() {
    super('restos-print-queue')
    this.version(1).stores({
      print_queue: '++id, status, createdAt, nextAttemptAt',
    })
  }
}

let _db: PrintQueueDB | null = null
function getDb(): PrintQueueDB {
  if (!_db) _db = new PrintQueueDB()
  return _db
}

function table(): Table<PrintJob, number> {
  return getDb().print_queue
}

const QUEUE_EVENT = 'print-queue-changed'

function emitChange() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(QUEUE_EVENT))
  }
}

export function subscribeQueue(cb: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  window.addEventListener(QUEUE_EVENT, cb)
  return () => window.removeEventListener(QUEUE_EVENT, cb)
}

function fingerprint(kind: PrintJobKind, payload: PrintJob['payload']): string {
  // Identifies a logical job: same order + same item-set + same station(if any) =
  // same job. Used to dedup when AutoPrintRunner polls and reposts the same items.
  const orderId = (payload as { orderId?: string }).orderId ?? ''
  const station = (payload as { station?: string }).station ?? ''
  const items = ((payload as { items?: { menuItemId?: string; id?: string; qty?: number }[] }).items ?? [])
    .map(it => `${it.id ?? it.menuItemId ?? ''}:${it.qty ?? ''}`)
    .sort()
    .join('|')
  return `${kind}|${orderId}|${station}|${items}`
}

export async function enqueuePrintJob(
  kind: PrintJobKind,
  payload: PrintJob['payload'],
  summary: string,
  opts?: { printerName?: string; printerIP?: string; lastError?: string }
): Promise<number | null> {
  // Dedup: skip if an equivalent pending/retrying job already exists.
  const fp = fingerprint(kind, payload)
  const existing = await table().toArray()
  if (existing.some(j => (j.status === 'pending' || j.status === 'retrying') && fingerprint(j.kind, j.payload) === fp)) {
    return null
  }

  const now = Date.now()
  const job: PrintJob = {
    kind,
    status: 'pending',
    printerName: opts?.printerName,
    printerIP: opts?.printerIP,
    payload,
    summary,
    createdAt: new Date(now).toISOString(),
    attemptCount: 0,
    nextAttemptAt: now + BACKOFF_MS[0],
    lastError: opts?.lastError,
  }
  const id = await table().add(job)

  // Trim queue if oversized
  const count = await table().count()
  if (count > MAX_QUEUE_SIZE) {
    const oldest = await table().orderBy('createdAt').limit(count - MAX_QUEUE_SIZE).toArray()
    await table().bulkDelete(oldest.map((j) => j.id!).filter(Boolean))
  }

  emitChange()
  return id as number
}

export async function listPendingJobs(): Promise<PrintJob[]> {
  return await table().orderBy('createdAt').reverse().toArray()
}

export async function cancelJob(id: number): Promise<void> {
  await table().delete(id)
  emitChange()
}

export async function cancelAllPending(): Promise<number> {
  const all = await table().toArray()
  await table().clear()
  emitChange()
  return all.length
}

export async function markRetrying(id: number): Promise<void> {
  await table().update(id, { status: 'retrying' })
}

/** Returns true if job is now 'dead' (no more retries) — caller should release item claims. */
export async function markFailed(id: number, error: string): Promise<boolean> {
  const job = await table().get(id)
  if (!job) return false
  const nextAttempt = job.attemptCount + 1
  const wait = backoffForAttempt(nextAttempt)
  let isDead = false
  if (wait < 0) {
    await table().update(id, { status: 'dead', attemptCount: nextAttempt, lastError: error })
    isDead = true
  } else {
    await table().update(id, {
      status: 'pending',
      attemptCount: nextAttempt,
      nextAttemptAt: Date.now() + wait,
      lastError: error,
    })
  }
  emitChange()
  return isDead
}

export async function markSuccess(id: number): Promise<void> {
  await table().delete(id)
  emitChange()
}

export async function getDuePending(): Promise<PrintJob[]> {
  const now = Date.now()
  return await table()
    .where('status').equals('pending')
    .and((j) => j.nextAttemptAt <= now)
    .toArray()
}

export async function retryNow(id: number): Promise<void> {
  await table().update(id, { status: 'pending', nextAttemptAt: Date.now() })
  emitChange()
}

// ─── Virtual printer mode (test mode) ───────────────────────────────────────

const VIRTUAL_KEY = 'restos.virtualPrinter'
const VIRTUAL_EVENT = 'virtual-printer-changed'

export function isVirtualPrinterOn(): boolean {
  if (typeof window === 'undefined') return false
  return localStorage.getItem(VIRTUAL_KEY) === 'on'
}

export function setVirtualPrinterOn(on: boolean): void {
  if (typeof window === 'undefined') return
  if (on) localStorage.setItem(VIRTUAL_KEY, 'on')
  else localStorage.removeItem(VIRTUAL_KEY)
  window.dispatchEvent(new Event(VIRTUAL_EVENT))
  // Mirror to desktop's printer-config.json so phone clients pick up the
  // same flag at next bootstrap. No-op outside Electron desktop.
  void mirrorVirtualToDesktop(on)
}

async function mirrorVirtualToDesktop(virtual: boolean): Promise<void> {
  if (typeof window === 'undefined') return
  const isDesktop = !!(window as { restosDesktop?: { isDesktop?: boolean; printServerUrl?: string } }).restosDesktop?.isDesktop
  if (!isDesktop) return
  const url = (window as { restosDesktop?: { printServerUrl?: string } }).restosDesktop?.printServerUrl
  if (!url) return
  try {
    const res = await fetch(`${url}/printer-config`, { signal: AbortSignal.timeout(2000) })
    const cfg = res.ok ? await res.json() : { stations: [], receipt: null }
    await fetch(`${url}/printer-config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stations: cfg.stations ?? [], receipt: cfg.receipt ?? null, virtual }),
    })
  } catch (e) {
    console.warn('[virtual] mirror to desktop failed:', e)
  }
}

export function subscribeVirtualMode(cb: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  window.addEventListener(VIRTUAL_EVENT, cb)
  return () => window.removeEventListener(VIRTUAL_EVENT, cb)
}

// ─── History view: hide-before timestamp (audit_log immutable) ──────────────

const HIDDEN_BEFORE_KEY = 'restos.printQueue.hiddenBefore'

export function getHistoryHiddenBefore(): number {
  if (typeof window === 'undefined') return 0
  const v = localStorage.getItem(HIDDEN_BEFORE_KEY)
  return v ? Number(v) : 0
}

export function clearHistoryView(): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(HIDDEN_BEFORE_KEY, String(Date.now()))
}
