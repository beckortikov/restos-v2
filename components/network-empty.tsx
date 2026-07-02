'use client'

import { useNavigate } from 'react-router-dom'
import { Network } from 'lucide-react'
import { V4Error } from '@/lib/api'

/**
 * isNotInNetwork — распознаёт ошибку бэка «ресторан не в сети»
 * (apperrors VALIDATION "restaurant is not part of a network").
 * Сетевые эндпоинты (номенклатура, меню сети, сводка) возвращают её,
 * когда у ресторана нет account_id.
 */
export function isNotInNetwork(e: unknown): boolean {
  if (!(e instanceof V4Error)) return false
  const msg = e.envelope()?.message ?? e.message ?? ''
  return msg.toLowerCase().includes('not part of a network')
}

/**
 * NotInNetwork — единый дружелюбный пустой экран для сетевых разделов,
 * когда ресторан ещё не в сети. Ведёт в Настройки → Филиалы.
 */
export function NotInNetwork({ what }: { what?: string }) {
  const navigate = useNavigate()
  return (
    <div className="rounded-xl border border-dashed border-border p-8 text-center">
      <Network className="mx-auto mb-3 size-8 text-muted-foreground opacity-50" />
      <p className="text-sm text-muted-foreground">
        Ресторан не в сети. Чтобы использовать {what ?? 'этот раздел'}, создайте сеть в{' '}
        <button
          onClick={() => navigate('/settings/branches')}
          className="font-medium text-primary hover:underline"
        >
          Настройки → Филиалы
        </button>
        .
      </p>
    </div>
  )
}
