// lib/server-mode.ts — minimal local-server-mode helpers for v4.
//
// In v4 there is no cloud / Supabase mode. The app always talks to the local
// Go-backend (Electron → 127.0.0.1:3001) or via LAN (Waiter APK → restos-server
// on the cashier machine). These helpers exist to keep legacy components that
// imported `{ isLocalMode, setLocalServerUrl } from '@/lib/supabase'` working
// without changes to their call-sites.

const STORAGE_KEY = 'restos-local-server-url'
const MODE_KEY = 'restos-active-mode'

export function setLocalServerUrl(url: string | null, noReload: boolean = false) {
  if (typeof window === 'undefined') return
  if (url) {
    localStorage.setItem(STORAGE_KEY, url)
    localStorage.setItem(MODE_KEY, 'local')
    // Mirror to v4 base URL so v4()-client picks it up on next instantiation.
    try { localStorage.setItem('restos-v4-api-url', url) } catch {}
  } else {
    localStorage.removeItem(STORAGE_KEY)
    localStorage.removeItem(MODE_KEY)
    try { localStorage.removeItem('restos-v4-api-url') } catch {}
  }
  if (!noReload) {
    window.location.reload()
  }
}

/** In v4 the app is always in local mode (Go-backend on 127.0.0.1 or LAN). */
export function isLocalMode(): boolean {
  return true
}
