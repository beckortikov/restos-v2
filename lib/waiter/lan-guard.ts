'use client'

import { getRuntimeMode } from '@/lib/runtime-mode'
import { isLocalServerReachable, checkLocalServer, onLocalServerHealthChange, markLocalServerUnreachable } from '@/lib/local-server-health'

/** Принудительно пометить сервер недоступным после сетевой ошибки мутации. */
export function markLanUnreachable() {
  markLocalServerUnreachable()
}

// Waiter app is LAN-only: it must be on the local restaurant network and the
// local server must be reachable. No offline queueing. This module wraps the
// existing runtime-mode + health-probe primitives with waiter-specific logic.

export function isLanRuntime(): boolean {
  const m = getRuntimeMode()
  return m === 'local-pwa' || m === 'desktop'
}

export function isLanReachable(): boolean {
  // Desktop is always reachable (same process); only PWA polls the server.
  if (getRuntimeMode() === 'desktop') return true
  return isLocalServerReachable()
}

export async function probeLan(): Promise<boolean> {
  if (getRuntimeMode() === 'desktop') return true
  return checkLocalServer()
}

export function onLanReachableChange(cb: (ok: boolean) => void): () => void {
  return onLocalServerHealthChange(cb)
}
