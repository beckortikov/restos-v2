// hooks/queries.ts — React Query хуки поверх существующих fetch-функций.
//
// Это ЭТАЛОННЫЙ слой миграции: оборачиваем уже готовые fetchX из
// lib/queries в useQuery с централизованными ключами. Экраны переходят
// с use-live-data на эти хуки по одному.
//
// Что даёт vs use-live-data:
//   - дедупликация: N компонентов с useTables() → 1 сетевой запрос
//   - кэш + stale-while-revalidate: мгновенный показ при переходе
//   - точечная инвалидация по SSE (useQuerySseBridge) вместо refetchAll
//   - встроенные isLoading/isError/retry
//
// Старые fetchX остаются — хуки лишь обёртки, никакой логики не дублируем.

import { useQuery } from '@tanstack/react-query'
import { queryKeys } from '@/lib/query-client'
import { fetchMenuItems, fetchMenuCategoriesFull, type FetchMenuItemsOptions } from '@/lib/queries/menu'
import { fetchTables, fetchZones } from '@/lib/queries/tables'

// QueryOpts — опции, которые экраны переопределяют. Главное —
// refetchInterval для waiter-экранов на Android Capacitor, где SSE может
// «замёрзнуть» в фоне (поллинг как страховка).
type QueryOpts = { refetchInterval?: number; staleTime?: number; enabled?: boolean }

// useMenuItems — меню с кэшем. Меню меняется редко → длинный staleTime.
export function useMenuItems(opts?: FetchMenuItemsOptions, q?: QueryOpts) {
  return useQuery({
    queryKey: [...queryKeys.menu.items, opts ?? null],
    queryFn: () => fetchMenuItems(opts),
    staleTime: 5 * 60_000, // меню стабильно — 5 мин свежесть
    ...q,
  })
}

export function useMenuCategories(q?: QueryOpts) {
  return useQuery({
    queryKey: queryKeys.menu.categories,
    queryFn: fetchMenuCategoriesFull,
    staleTime: 5 * 60_000,
    ...q,
  })
}

// useTables — столы. Меняются часто (статусы) → SSE-инвалидация важна.
export function useTables(q?: QueryOpts) {
  return useQuery({
    queryKey: queryKeys.tables.all,
    queryFn: fetchTables,
    ...q,
  })
}

export function useZones(q?: QueryOpts) {
  return useQuery({
    queryKey: queryKeys.zones.all,
    queryFn: fetchZones,
    staleTime: 5 * 60_000, // зоны меняются редко
    ...q,
  })
}
