'use client'

import type { CartLine } from '@/components/order/types'

export interface WaiterDraft {
  tableId: string
  tabLabel?: string
  guestsCount: number
  lines: CartLine[]
  updatedAt: number
  waiterId: string
}

const KEY = 'restos-waiter-drafts'
const EVT = 'restos-waiter-drafts'

function readAll(): Record<string, WaiterDraft> {
  if (typeof window === 'undefined') return {}
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? JSON.parse(raw) : {}
  } catch { return {} }
}

function writeAll(d: Record<string, WaiterDraft>) {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(KEY, JSON.stringify(d))
    window.dispatchEvent(new CustomEvent(EVT))
  } catch {}
}

export function getDraft(tableId: string): WaiterDraft | null {
  return readAll()[tableId] ?? null
}

export function listDrafts(waiterId?: string): WaiterDraft[] {
  const all = Object.values(readAll())
  const filtered = waiterId ? all.filter(d => d.waiterId === waiterId) : all
  return filtered.sort((a, b) => b.updatedAt - a.updatedAt)
}

export function saveDraft(d: Omit<WaiterDraft, 'updatedAt'>): WaiterDraft {
  const all = readAll()
  const next: WaiterDraft = { ...d, updatedAt: Date.now() }
  all[d.tableId] = next
  writeAll(all)
  return next
}

export function deleteDraft(tableId: string) {
  const all = readAll()
  if (tableId in all) {
    delete all[tableId]
    writeAll(all)
  }
}

export function onDraftsChange(cb: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const handler = () => cb()
  window.addEventListener(EVT, handler)
  return () => window.removeEventListener(EVT, handler)
}
