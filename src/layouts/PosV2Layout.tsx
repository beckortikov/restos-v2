import { useState } from 'react'
import { Navigate, Outlet } from 'react-router-dom'
import { useAuth } from '@/lib/auth-store'
import { LicenseGate } from '@/components/license-gate'
import { useInactivityTimer } from '@/hooks/use-inactivity-timer'
import { PinLockScreen } from '@/components/pin-lock-screen'
// Скоуп-токены нового интерфейса (только под `.pos-v2`).
import '../../styles/pos-v2.css'

// Лёгкий guard: только «залогинен ли», БЕЗ проверки path-permission.
// Обычный AuthGuard отбросил бы кассира с /pos2 (маршрут не в его nav-правах);
// новый POS — опциональная параллельная ветка, доступ по факту аутентификации.
// Лицензия по-прежнему энфорсится через LicenseGate.
function PosV2Guard({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth()
  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-background">
        <div className="size-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" />
      </div>
    )
  }
  if (!user) return <Navigate to="/login" replace />
  return <>{children}</>
}

// PIN-лок по бездействию — как в CashierShell. Блокирует новый POS при простое,
// PIN для возобновления. Включается настройкой ресторана pinLockEnabled.
function LockGate({ children }: { children: React.ReactNode }) {
  const { restaurant, logout } = useAuth()
  const pinEnabled = restaurant?.pinLockEnabled ?? false
  const timeoutMs = (restaurant?.pinLockTimeoutMin ?? 5) * 60 * 1000
  const [locked, setLocked] = useState(false)
  useInactivityTimer(timeoutMs, () => { if (pinEnabled) setLocked(true) }, pinEnabled)

  if (locked && pinEnabled && restaurant) {
    return (
      <PinLockScreen
        restaurantId={restaurant.id}
        restaurantName={restaurant.name}
        onUnlock={() => setLocked(false)}
        onLogout={() => logout()}
      />
    )
  }
  return <>{children}</>
}

/**
 * Layout параллельного нового POS (`/pos2/*`). Иммерсивная оболочка без рейла;
 * навигация — через лаунчер и кнопки «Меню». Полностью изолирован от старого POS.
 */
export function PosV2Layout() {
  return (
    <PosV2Guard>
      <LicenseGate>
        <LockGate>
          <div className="pos-v2 h-[100dvh] w-full overflow-hidden">
            <Outlet />
          </div>
        </LockGate>
      </LicenseGate>
    </PosV2Guard>
  )
}
