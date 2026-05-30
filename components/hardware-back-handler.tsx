'use client'

import { useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

// Capacitor дропнут — нативный Kotlin Android-клиент теперь в android-kotlin/.
// React-фронт живёт только в Electron, где isNativePlatform=false и весь
// этот хук — no-op. Оставляем stub чтобы не править ApLayout.
const Capacitor = { isNativePlatform: () => false }

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
        const { App } = await import(/* @vite-ignore */ '@capacitor/app' as any) /* dead branch */
        if (cancelled) return
        const handle = await App.addListener('backButton', ({ canGoBack }: { canGoBack: boolean }) => {
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
