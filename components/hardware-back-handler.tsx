'use client'

import { useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Capacitor } from '@capacitor/core'

// Android hardware back button: navigate within the app instead of exiting it.
// Only at the root waiter screen (/waiter/tables) the back button can exit;
// everywhere else we navigate(-1) so users can step back through their flow.
export function HardwareBackHandler() {
  const navigate = useNavigate()
  const { pathname } = useLocation()

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return
    let off: { remove: () => void } | null = null
    let cancelled = false

    ;(async () => {
      try {
        const { App } = await import('@capacitor/app')
        if (cancelled) return
        const handle = await App.addListener('backButton', ({ canGoBack }) => {
          // At /waiter/tables (root) the only sensible action is to background
          // the app — let the platform handle it.
          if (pathname === '/waiter/tables' || pathname === '/waiter') {
            App.minimizeApp().catch(() => {})
            return
          }
          if (canGoBack && window.history.length > 1) {
            navigate(-1)
          } else {
            navigate('/waiter/tables')
          }
        })
        off = handle
      } catch { /* plugin not available */ }
    })()

    return () => { cancelled = true; off?.remove() }
  }, [navigate, pathname])

  return null
}
