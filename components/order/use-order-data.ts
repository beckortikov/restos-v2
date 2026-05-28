'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  fetchMenuItems,
  fetchTables,
  fetchZones,
  fetchUsers,
} from '@/lib/queries'
import { useDataSync } from '@/hooks/use-data-sync'
import type { MenuItem, Table, Zone, User } from '@/lib/types'

export interface OrderData {
  menuItems: MenuItem[]
  categories: string[]
  tables: Table[]
  zones: Zone[]
  users: User[]
  loading: boolean
  reload: () => void
}

function deriveCategories(items: MenuItem[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const it of items) {
    const c = it.category
    if (!c || seen.has(c)) continue
    seen.add(c)
    out.push(c)
  }
  return out.sort((a, b) => a.localeCompare(b, 'ru'))
}

/**
 * Loads the data the order composer needs (menu, tables, zones, users).
 * - Critical path: menuItems — UI gates `loading` on this alone.
 * - Categories: derived synchronously from menuItems (no extra network call).
 * - Secondary (tables/zones/users): loaded in parallel, do NOT block `loading`.
 */
export function useOrderData(enabled: boolean = true): OrderData {
  const [menuItems, setMenuItems] = useState<MenuItem[]>([])
  const [tables, setTables] = useState<Table[]>([])
  const [zones, setZones] = useState<Zone[]>([])
  const [users, setUsers] = useState<User[]>([])
  const [loading, setLoading] = useState(true)

  const categories = useMemo(() => deriveCategories(menuItems), [menuItems])

  const reload = useCallback(() => {
    if (!enabled) return
    // Critical path — gates UI rendering. На POS/waiter-форме нужны только
    // name/price/emoji/station/cogs (последний берётся из orders.cogs);
    // вложенные tech_card_lines нужны лишь редактору меню. Отключение
    // экономит ~65% payload и ускоряет ответ в 20× (см. menu-payload.spec).
    fetchMenuItems({ withTechCards: false })
      .then((mi) => { setMenuItems(mi); setLoading(false) })
      .catch(() => setLoading(false))
    // Secondary — populate when ready, do not block.
    fetchTables().then(setTables).catch(() => {})
    fetchZones().then(setZones).catch(() => {})
    fetchUsers().then(setUsers).catch(() => {})
  }, [enabled])

  useEffect(() => {
    if (enabled) reload()
  }, [enabled, reload])

  useDataSync(['menu_items', 'meta', 'tables', 'zones', 'users'], reload)

  return { menuItems, categories, tables, zones, users, loading, reload }
}
