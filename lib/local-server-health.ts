import { isLocalMode } from '@/lib/server-mode'

const PROBE_INTERVAL_MS = 2 * 1000
const TIMEOUT_MS = 2500

let started = false
let timer: ReturnType<typeof setInterval> | null = null
let isReachable = true
const listeners = new Set<(reachable: boolean) => void>()

const PRIVATE_HOST_RE = /^(localhost|127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/i

function getLocalUrl(): string | null {
  if (typeof window === 'undefined') return null
  if ((window as any).restosDesktop?.apiUrl) return (window as any).restosDesktop.apiUrl
  if (PRIVATE_HOST_RE.test(window.location.hostname)) return window.location.origin
  return localStorage.getItem('restos-local-server-url')
}

export async function checkLocalServer(url?: string): Promise<boolean> {
  const target = url ?? getLocalUrl()
  if (!target) return false
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
    const res = await fetch(`${target}/status`, { signal: ctrl.signal, cache: 'no-store' })
    clearTimeout(t)
    return res.ok
  } catch {
    return false
  }
}

export function isLocalServerReachable(): boolean {
  return isReachable
}

/**
 * Принудительно пометить сервер недоступным (например, после сетевой ошибки
 * мутации). Баннер «Нет связи» появится сразу, не дожидаясь следующего
 * probe-tick'а (15 сек). Следующий tick подтвердит/опровергнет состояние.
 */
export function markLocalServerUnreachable() {
  if (!isReachable) return
  isReachable = false
  for (const cb of listeners) { try { cb(false) } catch {} }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('restos-local-server-health', { detail: { reachable: false } }))
  }
  // Через короткое время сделаем повторную проверку — если связь вернулась,
  // tick поднимет isReachable обратно в true.
  setTimeout(tick, 3000)
}

export function onLocalServerHealthChange(cb: (reachable: boolean) => void) {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

async function tick() {
  if (!isLocalMode()) return
  const ok = await checkLocalServer()
  if (ok !== isReachable) {
    isReachable = ok
    for (const cb of listeners) { try { cb(ok) } catch {} }
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('restos-local-server-health', { detail: { reachable: ok } }))
    }
  }
}

export function startLocalServerHealthProbe() {
  if (started || typeof window === 'undefined') return
  started = true
  if (!isLocalMode()) return
  timer = setInterval(tick, PROBE_INTERVAL_MS)
  setTimeout(tick, 2000)
}

export function stopLocalServerHealthProbe() {
  if (timer) { clearInterval(timer); timer = null }
  started = false
  isReachable = true
}
