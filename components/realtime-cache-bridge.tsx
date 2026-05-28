'use client'

import { useEffect } from 'react'
import { initRealtime, onDataChange } from '@/lib/realtime'

// SSE events from the local Go API server (table change notifications) are
// re-broadcast as a `restos-data-updated` DOM event. Every useDataSync hook
// in the app listens to that event and triggers its loader — so any change
// on the desktop (cook puts a dish on stop, cashier closes an order, etc.)
// propagates live to all connected clients without per-page wiring.
//
// In v1 this also invalidated a Dexie cache layer; v4 hits the Go backend
// directly, so we just forward the table-name signal.
export function RealtimeCacheBridge() {
  useEffect(() => {
    initRealtime()
    return onDataChange((table) => {
      try {
        window.dispatchEvent(new CustomEvent('restos-data-updated', { detail: { table } }))
      } catch { /* SSR / no window */ }
    })
  }, [])
  return null
}
