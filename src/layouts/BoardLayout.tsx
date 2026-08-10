import { Navigate, Outlet } from 'react-router-dom'
import { useAuth } from '@/lib/auth-store'
import { RealtimeCacheBridge } from '@/components/realtime-cache-bridge'

// BoardLayout — минимальная обёртка для ТВ-табло выдачи (/board).
//
// Лёгкий guard: только «залогинен ли» (вход один раз PIN'ом, токен держится в
// браузере) — как PosV2Guard. БЕЗ сайдбара, БЕЗ PIN-лока по бездействию (табло
// пассивно светится и НЕ должно само блокироваться) и без license-gate-модалок.
// RealtimeCacheBridge монтируем — по SSE (order.*, kds.item.updated) инвалидит
// ['orders'], и табло само подтягивает свежие статусы без поллинга.
export function BoardLayout() {
  const { user, loading } = useAuth()
  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen" style={{ background: '#0b0e13' }}>
        <div className="size-8 border-4 border-white/20 border-t-white rounded-full animate-spin" />
      </div>
    )
  }
  if (!user) return <Navigate to="/login" replace />
  return (
    <>
      <RealtimeCacheBridge />
      <Outlet />
    </>
  )
}
