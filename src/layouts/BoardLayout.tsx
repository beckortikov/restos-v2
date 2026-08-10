import { Navigate, Outlet } from 'react-router-dom'
import { useAuth } from '@/lib/auth-store'
import { RealtimeCacheBridge } from '@/components/realtime-cache-bridge'
import { useQuerySseBridge } from '@/hooks/use-query-sse-bridge'

// BoardLayout — минимальная обёртка для ТВ-табло выдачи (/board).
//
// Лёгкий guard: только «залогинен ли» (вход один раз PIN'ом, токен держится в
// браузере) — как PosV2Guard. БЕЗ сайдбара, БЕЗ PIN-лока по бездействию (табло
// пассивно светится и НЕ должно само блокироваться) и без license-gate-модалок.
// RealtimeCacheBridge открывает SSE и форвардит события; useQuerySseBridge ловит
// kds.item.updated (per-dish статус из кухонного приложения) и инвалидит ['kds'] —
// табло подтягивает свежие статусы мгновенно, поллинг лишь страховка.
export function BoardLayout() {
  const { user, loading } = useAuth()
  // Точечная инвалидация ['kds'] по SSE-событию kds.item.updated (см. EVENT_FANOUT
  // → kds_items → ['kds']). Хук должен стоять ДО любых ранних return (правила hooks).
  useQuerySseBridge()
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
