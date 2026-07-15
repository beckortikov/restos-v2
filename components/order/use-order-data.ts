'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  fetchMenuItems,
  fetchMenuCategoriesFull,
  fetchTables,
  fetchZones,
  fetchUsers,
  type MenuCategory,
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
 * Порядок вкладок категорий в POS. Источник правды — таблица menu_categories
 * (её и редактирует «Управление меню»): показываем ВСЕ её категории в порядке
 * sortOrder, ВКЛЮЧАЯ пустые (без блюд) — раньше POS выводил категории только из
 * загруженных блюд, поэтому только что добавленная (ещё пустая) категория в
 * кассе не появлялась. Категории, встречающиеся у блюд, но отсутствующие в
 * таблице (меню импортировано без записей-категорий), добавляем в конец —
 * чтобы ничего не пропало.
 */
export function mergeCategories(tableCats: MenuCategory[], items: MenuItem[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const push = (name: string | null | undefined) => {
    const n = (name ?? '').trim()
    if (!n) return
    const key = n.toLocaleLowerCase('ru-RU')
    if (seen.has(key)) return
    seen.add(key)
    out.push(n)
  }
  for (const c of [...tableCats].sort((a, b) => a.sortOrder - b.sortOrder)) push(c.name)
  for (const n of deriveCategories(items)) push(n)
  return out
}

/**
 * Loads the data the order composer needs (menu, categories, tables, zones, users).
 * - Critical path: menuItems — UI gates `loading` on this alone.
 * - Categories: таблица menu_categories (порядок + пустые) ∪ выведенные из блюд.
 * - Secondary (categories/tables/zones/users): loaded in parallel, do NOT block `loading`.
 */
export function useOrderData(enabled: boolean = true): OrderData {
  const [menuItems, setMenuItems] = useState<MenuItem[]>([])
  const [menuCategories, setMenuCategories] = useState<MenuCategory[]>([])
  const [tables, setTables] = useState<Table[]>([])
  const [zones, setZones] = useState<Zone[]>([])
  const [users, setUsers] = useState<User[]>([])
  const [loading, setLoading] = useState(true)

  const categories = useMemo(
    () => mergeCategories(menuCategories, menuItems),
    [menuCategories, menuItems],
  )

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
    fetchMenuCategoriesFull().then(setMenuCategories).catch(() => {})
    fetchTables().then(setTables).catch(() => {})
    fetchZones().then(setZones).catch(() => {})
    fetchUsers().then(setUsers).catch(() => {})
  }, [enabled])

  useEffect(() => {
    if (enabled) reload()
  }, [enabled, reload])

  // Включаем 'orders' в watch list, чтобы POS-плитки столов перекрашивались
  // (free → occupied → free) в тот же момент, что и /table-map. Backend
  // эмитит order.created/closed, lib/realtime.ts фанаутит на 'tables' и
  // 'orders' — оба триггерят reload здесь.
  useDataSync(['menu_items', 'meta', 'tables', 'zones', 'users', 'orders'], reload)

  return { menuItems, categories, tables, zones, users, loading, reload }
}
