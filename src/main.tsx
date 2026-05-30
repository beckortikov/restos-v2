import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, HashRouter } from 'react-router-dom'

// В Electron index.html грузится через file:// — BrowserRouter не работает
// (нет server-side fallback). Используем HashRouter (#/dashboard) в desktop.
// Detect: window.restosDesktop exposed by preload.js means we're in Electron.
const Router: typeof BrowserRouter =
  (typeof window !== 'undefined' && (window as { restosDesktop?: unknown }).restosDesktop)
    ? (HashRouter as unknown as typeof BrowserRouter)
    : BrowserRouter
import * as Sentry from '@sentry/react'
import { AppRouter } from './router'
import { ErrorBoundary } from '@/components/error-boundary'
import './index.css'
// Bundle Inter font locally — works offline, more readable
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'

// ── Sentry ──────────────────────────────────────────────────────────────────
if (import.meta.env.VITE_SENTRY_DSN) {
  try {
    console.log('[sentry] Initializing Sentry with DSN:', import.meta.env.VITE_SENTRY_DSN)
    Sentry.init({
      dsn: import.meta.env.VITE_SENTRY_DSN,
      environment: (window as any).restosDesktop?.isDesktop ? 'desktop' : 'web',
      release: (window as any).restosDesktop?.version || 'unknown',
      integrations: [
        Sentry.browserTracingIntegration(),
        Sentry.replayIntegration({ maskAllText: false, blockAllMedia: false }),
      ],
      tracesSampleRate: 0.2,
      replaysSessionSampleRate: 0,
      replaysOnErrorSampleRate: 1.0,
    })
    console.log('[sentry] Sentry initialized successfully')
  } catch (err) {
    console.error('[sentry] Failed to initialize Sentry:', err)
  }
} else {
  console.warn('[sentry] VITE_SENTRY_DSN is undefined, Sentry will not be initialized')
}

// Register service worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {})
}

// Detect stale chunks after deploy (user has cached index.html but chunk hashes changed).
// Error: "Importing a module script failed" / "Failed to fetch dynamically imported module"
function isChunkLoadError(err: unknown): boolean {
  const msg = String((err as Error)?.message || err || '')
  return (
    msg.includes('Importing a module script failed') ||
    msg.includes('Failed to fetch dynamically imported module') ||
    msg.includes('Loading chunk') && msg.includes('failed') ||
    msg.includes('Unable to preload CSS')
  )
}

function handleChunkError() {
  // Rate-limit reloads to avoid infinite loop while still allowing recovery from
  // a later deploy in the same session. Previously used a one-shot sessionStorage
  // flag — which stuck forever after the first stale-chunk reload, so a second
  // deploy mid-session left users with broken lazy imports until manual refresh.
  const RELOAD_KEY = 'restos-chunk-reload-ts'
  const COOLDOWN_MS = 30_000
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) || '0')
    if (Date.now() - last < COOLDOWN_MS) return false
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()))
  } catch { /* ignore storage errors */ }
  console.warn('[chunk-error] stale bundle detected — reloading')
  // Bypass bfcache/HTTP cache for index.html so we definitely fetch the new one
  const url = new URL(window.location.href)
  url.searchParams.set('_r', String(Date.now()))
  window.location.replace(url.toString())
  return true
}

// Global error handler — catch unhandled errors that escape React
window.addEventListener('error', (e) => {
  console.error('[global] unhandled error:', e.error)
  if (isChunkLoadError(e.error) && handleChunkError()) return
  Sentry.captureException(e.error)
})
window.addEventListener('unhandledrejection', (e) => {
  console.error('[global] unhandled promise rejection:', e.reason)
  if (isChunkLoadError(e.reason) && handleChunkError()) return
  Sentry.captureException(e.reason)
})

// White screen detector for desktop — if #root is empty after 3s, reload
if ((window as any).restosDesktop?.isDesktop) {
  setTimeout(() => {
    const root = document.getElementById('root')
    if (root && root.children.length === 0) {
      console.error('[white-screen-detector] root is empty — reloading')
      window.location.reload()
    }
  }, 3000)
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <Router>
        <AppRouter />
      </Router>
    </ErrorBoundary>
  </StrictMode>
)
