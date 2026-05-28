'use client'

import { useEffect, useRef } from 'react'
import { useRegisterSW } from 'virtual:pwa-register/react'

export function PwaUpdater() {
  const reloadedRef = useRef(false)

  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisterError(err) {
      console.warn('[pwa] sw register error', err)
    },
    onRegisteredSW(_swUrl, registration) {
      // Periodically check for updates so kiosks/desktop pick up new bundles
      // without needing a manual restart.
      if (!registration) return
      const id = setInterval(() => {
        registration.update().catch(() => {})
      }, 60 * 60 * 1000)
      return () => clearInterval(id)
    },
  })

  useEffect(() => {
    if (!needRefresh || reloadedRef.current) return
    reloadedRef.current = true
    // Force-activate the new SW (clientsClaim + skipWaiting will swap it in)
    // and reload the page so the cashier always sees the latest UI.
    updateServiceWorker(true)
  }, [needRefresh, updateServiceWorker])

  // Reload once the new SW takes control.
  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.serviceWorker) return
    let reloaded = false
    const onChange = () => {
      if (reloaded) return
      reloaded = true
      window.location.reload()
    }
    navigator.serviceWorker.addEventListener('controllerchange', onChange)
    return () => navigator.serviceWorker.removeEventListener('controllerchange', onChange)
  }, [])

  return null
}
