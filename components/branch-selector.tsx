'use client'

import { useState, useEffect } from 'react'
import { useAuth } from '@/lib/auth-store'
import { fetchBranches, type Branch } from '@/lib/queries/transfers'
import { Network } from 'lucide-react'

const KEY = 'restos-branch-view'

// BranchSelector — переключатель «смотреть как филиал» для владельца сети
// (ADR-003 Фаза 4). Ставит X-Branch-Id (через localStorage → api middleware),
// бэк валидирует и подменяет tenant для GET-отчётов. Виден только owner'у
// центрального узла (kind=central_warehouse) и только если ресторан в сети
// (>1 филиала).
//
// Строго НЕ для филиала: у него в его отдельной БД (ADR-003 — каждый
// филиал = своя Postgres) для «соседей» есть только заглушки-строки без
// реальных данных (нужны исключительно для cross-node ссылок типа
// to_restaurant_id) — переключение туда молча ломает отчёты и, что хуже,
// лицензионный статус (заглушка без license_expires_at → ложный экран
// активации, см. BranchOverride на бэке). Нашли вживую: владелец филиала
// случайно выбрал центральный узел в этом селекторе и попал в лок.
export function BranchSelector() {
  const { restaurantId, restaurant, canAccessRoles } = useAuth()
  const isOwner = canAccessRoles(['owner'])
  const isCentral = restaurant?.kind === 'central_warehouse'
  const canOverride = isOwner && isCentral
  const [branches, setBranches] = useState<Branch[]>([])
  const [selected, setSelected] = useState<string>('')

  useEffect(() => {
    if (!canOverride) {
      // Гигиена: снимаем случайно оставшийся override, если этому узлу он
      // больше не положен (не central_warehouse) — иначе X-Branch-Id
      // продолжает уходить на бэк без всякого смысла.
      if (typeof localStorage !== 'undefined' && localStorage.getItem(KEY)) {
        localStorage.removeItem(KEY)
      }
      return
    }
    fetchBranches().then(setBranches).catch(() => setBranches([]))
    if (typeof localStorage !== 'undefined') {
      setSelected(localStorage.getItem(KEY) || '')
    }
  }, [canOverride])

  // Только для владельца ЦЕНТРАЛЬНОГО узла сети с ≥2 филиалами.
  if (!canOverride || branches.length < 2) return null

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
