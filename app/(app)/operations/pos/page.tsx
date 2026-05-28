'use client'

import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAuth } from '@/lib/auth-store'
import { type User } from '@/lib/types'
import { PinLockScreen } from '@/components/pin-lock-screen'
import { useInactivityTimer } from '@/hooks/use-inactivity-timer'
import { OrderComposer } from '@/components/order/order-composer'

export default function POSPage() {
  const { user, restaurant, canAccessRoles, logout } = useAuth()
  const [params] = useSearchParams()
  // Когда кассир выбрал стол на /operations/table-map, тот редиректит сюда
  // с ?tableId=<id>. Передаём в OrderComposer как initialTableId, и тип
  // заказа автоматически становится 'hall'.
  const initialTableId = params.get('tableId') ?? undefined
  const initialOrderType = initialTableId ? ('hall' as const) : undefined

  const isCashier = user?.role === 'cashier'

  // PIN-lock & local nav are only relevant for non-cashier roles here.
  // For cashier, CashierShell (in layout) owns the chrome and PIN-lock.
  const pinEnabled = !isCashier && (restaurant?.pinLockEnabled ?? false)
  const pinTimeoutMs = (restaurant?.pinLockTimeoutMin ?? 5) * 60 * 1000
  const [locked, setLocked] = useState(false)
  const [activeUser, setActiveUser] = useState<User | null>(null)

  useInactivityTimer(pinTimeoutMs, () => {
    if (pinEnabled) setLocked(true)
  }, pinEnabled)

  const effectiveUser = activeUser || user

  if (!canAccessRoles(['manager', 'cashier', 'waiter'])) {
    return (
      <div className="p-6 flex items-center justify-center h-screen">
        <p className="text-muted-foreground">Нет доступа</p>
      </div>
    )
  }

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

  // Cashier: rendered inside CashierShell — just fill the available area.
  if (isCashier) {
    return (
      <div className="h-full min-h-0 flex flex-col">
        <OrderComposer effectiveUser={effectiveUser} initialTableId={initialTableId} initialOrderType={initialOrderType} />
      </div>
    )
  }

  // Manager / waiter: legacy fullscreen POS with its own top nav.
  return (
    <>
      {/* Mobile: fill the area between header and bottom nav */}
      <div className="md:hidden fixed inset-0 bottom-16 z-40 bg-background">
        <OrderComposer effectiveUser={effectiveUser} initialTableId={initialTableId} initialOrderType={initialOrderType} />
      </div>

      {/* Desktop: composer fills the main area next to the AppSidebar.
          The legacy in-page top nav (POS/Зал/Заказы/Кухня/Смены + user name +
          Выход) was removed — it duplicated routes already in the sidebar
          and showed a second copy of the cashier name. The PIN lock is
          still reachable from the sidebar / inactivity timer. */}
      <div className="hidden md:flex flex-col h-full min-h-0 bg-background">
        <div className="flex-1 min-h-0">
          <OrderComposer effectiveUser={effectiveUser} initialTableId={initialTableId} initialOrderType={initialOrderType} />
        </div>
      </div>
    </>
  )
}
