'use client'

import { useState, useEffect } from 'react'
import { useAuth } from '@/lib/auth-store'
import { fetchBranches, type Branch } from '@/lib/queries/transfers'
import { Network } from 'lucide-react'

const KEY = 'restos-branch-view'

// BranchSelector — переключатель «смотреть как филиал» для владельца сети
// (ADR-003 Фаза 4). Ставит X-Branch-Id (через localStorage → api middleware),
// бэк валидирует и подменяет tenant для GET-отчётов. Виден только owner'у
// и только если ресторан в сети (>1 филиала).
export function BranchSelector() {
  const { restaurantId, canAccessRoles } = useAuth()
  const isOwner = canAccessRoles(['owner'])
  const [branches, setBranches] = useState<Branch[]>([])
  const [selected, setSelected] = useState<string>('')

  useEffect(() => {
    if (!isOwner) return
    fetchBranches().then(setBranches).catch(() => setBranches([]))
    if (typeof localStorage !== 'undefined') {
      setSelected(localStorage.getItem(KEY) || '')
    }
  }, [isOwner])

  // Только для владельца сети с ≥2 филиалами.
  if (!isOwner || branches.length < 2) return null

  const onChange = (value: string) => {
    if (!value || value === restaurantId) localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, value)
    // Перезагрузка — простой и надёжный способ перечитать все отчёты с новым
    // заголовком (без react-query точечная инвалидация сложнее).
    window.location.reload()
  }

  return (
    <div className="flex items-center gap-1.5 text-sm">
      <Network className="size-4 text-muted-foreground" />
      <select
        value={selected || restaurantId || ''}
        onChange={e => onChange(e.target.value)}
        className="rounded-lg border border-border bg-background px-2 py-1 text-sm"
        title="Смотреть отчёты как филиал"
      >
        {branches.map(b => (
          <option key={b.id} value={b.id}>
            {b.id === restaurantId ? `${b.name} (мой)` : b.name}
          </option>
        ))}
      </select>
    </div>
  )
}
