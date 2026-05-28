// Runtime mode detection for the unified frontend.
//
// Three places the same SPA bundle runs from:
//
// - Electron desktop  → window.restosDesktop is set, full read-write access
//   to local PGlite-backed PostgREST.
//
// - PWA on phone connected to LAN local server (e.g. via QR onboarding)
//   → restos-active-mode === 'local'. Full read-write through desktop API.
//
// - Browser hitting Vercel cloud (v0-restos.vercel.app) → no Electron flag,
//   no local-mode flag. This is the **owner dashboard** view: read-only.
//   All mutations are blocked with a clear toast — they have to be done on
//   the desktop to keep desktop PGlite as the single source of truth.

export type RuntimeMode = 'desktop' | 'local-pwa' | 'cloud-readonly'

export function getRuntimeMode(): RuntimeMode {
  if (typeof window === 'undefined') return 'cloud-readonly'
  if ((window as unknown as { restosDesktop?: { isDesktop?: boolean } }).restosDesktop) {
    return 'desktop'
  }
  // SPA served from a private LAN host (e.g. http://192.168.x.y/...)
  // → desktop API on same origin → treat as local PWA.
  try {
    const host = window.location.hostname
    if (/^(localhost|127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/i.test(host)) {
      return 'local-pwa'
    }
  } catch {}
  // Browser explicitly switched to local-mode via the connect QR flow.
  try {
    if (localStorage.getItem('restos-active-mode') === 'local' && localStorage.getItem('restos-local-server-url')) {
      return 'local-pwa'
    }
  } catch {}
  return 'cloud-readonly'
}

export function isReadOnlyCloudMode(): boolean {
  return getRuntimeMode() === 'cloud-readonly'
}

// LAN-only mode: waiter on a phone/desktop talking to the local PGlite server.
// Mutations must NOT be queued for later replay — if the local server is down,
// throw immediately so the waiter sees a clear error instead of a "ghost"
// order arriving on the kitchen printer minutes later.
export function isLanOnlyMode(): boolean {
  if (typeof window === 'undefined') return false
  const mode = getRuntimeMode()
  if (mode === 'cloud-readonly') return false
  try {
    const stored = localStorage.getItem('restos-auth-user')
    if (!stored) return false
    const u = JSON.parse(stored) as { role?: string }
    return u?.role === 'waiter'
  } catch {
    return false
  }
}

export class CloudReadOnlyError extends Error {
  constructor(message = 'Это действие выполняется только на компьютере ресторана. В облачном режиме доступен просмотр данных без редактирования.') {
    super(message)
    this.name = 'CloudReadOnlyError'
  }
}
