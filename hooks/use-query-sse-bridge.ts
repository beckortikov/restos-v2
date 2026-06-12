import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '@/lib/query-client'

// TABLE_TO_KEYS — маппинг имени таблицы из SSE-эвента бэка на ключи кэша
// React Query, которые надо инвалидировать. Один SSE = точечная
// инвалидация ровно тех доменов, что изменились (а не полный refetch всего).
//
// Имена таблиц — те же, что эмитит RealtimeCacheBridge / Go SSE-hub.
const TABLE_TO_KEYS: Record<string, readonly (readonly string[])[]> = {
  orders: [queryKeys.orders.all],
  order_items: [queryKeys.orders.all],
  order_splits: [queryKeys.orders.all],
  order_voids: [queryKeys.orders.all],
  tables: [queryKeys.tables.all],
  zones: [queryKeys.zones.all, queryKeys.tables.all],
  shifts: [queryKeys.shifts.all],
  menu_items: [queryKeys.menu.items],
  menu_categories: [queryKeys.menu.categories],
  ingredients: [queryKeys.stock.ingredients],
  stock_movements: [queryKeys.stock.ingredients],
  users: [queryKeys.users.all],
}

/**
 * useQuerySseBridge — монтируется один раз у корня приложения. Слушает
 * `restos-data-updated` DOM-эвенты (форвард SSE) и точечно инвалидирует
 * соответствующие query-кэши. Экраны на useQuery автоматически
 * перезапросят только затронутые данные.
 *
 * Старые экраны на use-data-sync продолжают работать независимо — оба
 * слоя слушают тот же эвент. Это позволяет мигрировать инкрементально.
 */
export function useQuerySseBridge() {
  const qc = useQueryClient()
  useEffect(() => {
    const handler = (e: Event) => {
      const table = (e as CustomEvent<{ table: string }>).detail?.table
      if (!table) return
      const keys = TABLE_TO_KEYS[table]
      if (!keys) return
      for (const key of keys) {
        qc.invalidateQueries({ queryKey: key })
      }
    }
    window.addEventListener('restos-data-updated', handler as EventListener)
    return () => window.removeEventListener('restos-data-updated', handler as EventListener)
  }, [qc])
}
