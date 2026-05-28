'use client'

import { useState, useEffect } from 'react'
import { useAuth } from '@/lib/auth-store'
import { useInactivityTimer } from '@/hooks/use-inactivity-timer'
import { PinLockScreen } from '@/components/pin-lock-screen'
import { CashierRail } from '@/components/cashier-rail'
import { type User } from '@/lib/types'

export function CashierShell({ children }: { children: React.ReactNode }) {
  const { user, restaurant } = useAuth()

  const pinEnabled = restaurant?.pinLockEnabled ?? false
  const pinTimeoutMs = (restaurant?.pinLockTimeoutMin ?? 5) * 60 * 1000
  const [locked, setLocked] = useState(false)
  const [activeUser, setActiveUser] = useState<User | null>(null)

  useInactivityTimer(pinTimeoutMs, () => {
    if (pinEnabled) setLocked(true)
  }, pinEnabled)

  // Allow settings page to request lock screen
  useEffect(() => {
    if (!pinEnabled) return
    const onRequest = () => setLocked(true)
    window.addEventListener('cashier:lock-request', onRequest)
    return () => window.removeEventListener('cashier:lock-request', onRequest)
  }, [pinEnabled])

  const effectiveUser = activeUser || user
  const { logout } = useAuth()

  if (locked && pinEnabled && restaurant) {
    return (
      <PinLockScreen
        restaurantId={restaurant.id}
        restaurantName={restaurant.name}
        onUnlock={(u) => { setActiveUser(u); setLocked(false) }}
        onLogout={() => { logout() /* auth-store SPA-navigates to /login */ }}
      />
    )
  }

  return (
    <div className="flex h-[100dvh] bg-background overflow-hidden">
      <CashierRail effectiveUser={effectiveUser} />
      <main className="flex-1 min-w-0 flex flex-col overflow-y-auto overflow-x-hidden pb-[68px] md:pb-0">
        {children}
      </main>
    </div>
  )
}
