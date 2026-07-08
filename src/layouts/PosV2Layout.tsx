import { Navigate, Outlet } from 'react-router-dom'
import { useAuth } from '@/lib/auth-store'
import { LicenseGate } from '@/components/license-gate'
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

/**
 * Layout параллельного нового POS (`/pos2/*`). Иммерсивная оболочка без рейла;
 * навигация — через лаунчер и кнопки «Меню». Полностью изолирован от старого POS.
 */
export function PosV2Layout() {
  return (
    <PosV2Guard>
      <LicenseGate>
        <div className="pos-v2 h-[100dvh] w-full overflow-hidden">
          <Outlet />
        </div>
      </LicenseGate>
    </PosV2Guard>
  )
}
