'use client'

import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '@/lib/auth-store'
import { OwnerPinGate } from '@/components/owner-pin-gate'

/**
 * Гейт ПИН владельца для защищённых разделов /pos2 (смена, обслуживание,
 * закрытые заказы/история). Владелец/superadmin проходят без запроса; остальные
 * (кассир/менеджер) вводят ПИН владельца, после чего раздел открыт до ухода со
 * страницы (per-page unlock — как старый CashierShell).
 *
 * `gateWhen=false` временно отключает гейт (нужно для смены: форму ОТКРЫТИЯ
 * смены кассир видит без ПИН, а управление активной сменой — под ПИН).
 *
 * Безопасность: если restaurantId ещё не загружен — не гейтим (иначе экран
 * залипнет с пустым ПИН-гейтом, который никогда не проверится).
 */
export function PinSection({ label, gateWhen = true, children }: { label: string; gateWhen?: boolean; children: React.ReactNode }) {
  const { user, restaurantId } = useAuth()
  const navigate = useNavigate()
  const isOwnerRole = user?.role === 'owner' || user?.role === 'superadmin'
  const [unlocked, setUnlocked] = useState(false)

  if (gateWhen && !isOwnerRole && !unlocked && restaurantId) {
    return (
      <OwnerPinGate
        restaurantId={restaurantId}
        sectionLabel={label}
        onSuccess={() => setUnlocked(true)}
        onBack={() => navigate('/pos2')}
      />
    )
  }
  return <>{children}</>
}
