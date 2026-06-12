// lib/query-client.ts — singleton QueryClient для React Query.
//
// Зачем: умный кэш между UI и Go-бэком. Дедупликация запросов, точечная
// инвалидация по SSE-эвентам (а не полный refetch всего), stale-while-
// revalidate (мгновенный показ из кэша + фон-обновление), авто-ретрай.
//
// Раскатываем инкрементально: новые/переписанные экраны используют
// useQuery/useMutation, старые продолжают работать на use-live-data до
// миграции. Оба слоя сосуществуют.

import { QueryClient } from '@tanstack/react-query'

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // staleTime: данные считаются свежими 30с — в это окно переходы между
      // экранами берут из кэша без запроса. SSE-инвалидация всё равно
      // обновит раньше при реальном изменении.
      staleTime: 30_000,
      // gcTime: сколько держать неиспользуемый кэш в памяти (5 мин).
      gcTime: 5 * 60_000,
      // Касса в LAN — сеть стабильная; 1 ретрай достаточно (не задерживаем
      // UI длинными бэкоффами при реальном падении сидекара).
      retry: 1,
      retryDelay: 800,
      // refetchOnWindowFocus выключен: Electron-окно фокусится часто
      // (модалки, печать) — не хотим лишних запросов. Свежесть держим
      // через SSE-инвалидацию + staleTime.
      refetchOnWindowFocus: false,
    },
    mutations: {
      retry: 0, // мутации не ретраим автоматически — идемпотентность на бэке
    },
  },
})

// queryKeys — централизованный реестр ключей кэша. Один источник правды,
// чтобы инвалидация по SSE и хуки запросов ссылались на одни и те же ключи.
// Иерархия: ['domain'] инвалидирует весь домен, ['domain', id] — одну запись.
export const queryKeys = {
  orders: {
    all: ['orders'] as const,
    list: (filters?: unknown) => ['orders', 'list', filters] as const,
    detail: (id: string) => ['orders', 'detail', id] as const,
  },
  tables: { all: ['tables'] as const },
  zones: { all: ['zones'] as const },
  menu: {
    items: ['menu', 'items'] as const,
    categories: ['menu', 'categories'] as const,
  },
  shifts: {
    all: ['shifts'] as const,
    current: ['shifts', 'current'] as const,
    detail: (id: string) => ['shifts', 'detail', id] as const,
  },
  stock: { ingredients: ['stock', 'ingredients'] as const },
  users: { all: ['users'] as const },
} as const
