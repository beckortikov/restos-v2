# 10 — Frontend Adapter (фаза 2, после готовности бэка)

В v4 **бэк пишем заново на Go**, фронт **временно не трогаем** (он скопирован из v1 в корень репо: `src/`, `app/`, `components/`, `lib/`, `hooks/`, ...). Этот документ описывает, что нужно будет изменить во фронте, чтобы он переключился с PostgREST-эмулятора (старый Node-бэк) на чистый REST `/api/v1/...` (новый Go-бэк).

Это **отдельная фаза**, выполняется после того, как Go-бэк дойдёт хотя бы до Phase 3 (Write API).

## Принципы

1. **Один новый файл-клиент `lib/api/`** — вся работа с Go-бэком сосредоточена там. Существующие компоненты импортируют функции `api.orders.list(...)`, `api.orders.close(...)` вместо `supabase.from(...)`.
2. **Постепенная замена.** Можно адаптировать домен за доменом (сначала меню, потом заказы, потом склад). Пока часть фронта смотрит в Go, часть — в Node, и оба бэка работают.
3. **TS-типы авто-генерятся** из `openapi.yaml` через `openapi-typescript`. Команда `pnpm api:gen` создаёт `lib/api/generated.ts`. Не редактируем руками.
4. **React Query** для кэширования и инвалидации (если ещё не стоит). Эвенты SSE триггерят `queryClient.invalidateQueries()`.

## Что меняется во фронте

### Новый каталог `lib/api/`

```
lib/api/
├── client.ts              # fetch wrapper: base URL, auth header, error handling
├── generated.ts           # auto-generated types из openapi.yaml
├── orders.ts              # api.orders.list, get, create, close, split, ...
├── menu.ts
├── tables.ts
├── stock.ts
├── shifts.ts
├── finance.ts
├── printers.ts
├── auth.ts
├── events.ts              # SSE-клиент к /api/v1/events
└── index.ts               # export const api = { orders, menu, ... }
```

### Пример: `client.ts`

```ts
// lib/api/client.ts
const BASE_URL = import.meta.env.VITE_API_URL || 'http://127.0.0.1:3001/api/v1'

class ApiError extends Error {
  constructor(
    public code: string,
    public httpStatus: number,
    message: string,
    public details?: unknown,
    public traceId?: string,
  ) {
    super(message)
  }
}

export async function request<T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  opts: { body?: unknown; query?: Record<string, unknown>; idempotencyKey?: string } = {},
): Promise<T> {
  const url = new URL(BASE_URL + path)
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined) url.searchParams.set(k, String(v))
    }
  }
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  const token = getSessionToken()
  if (token) headers['Authorization'] = `Bearer ${token}`
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey

  const res = await fetch(url, {
    method,
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    const e = json.error || {}
    throw new ApiError(e.code || 'UNKNOWN', res.status, e.message || res.statusText, e.details, e.trace_id)
  }
  return json.data as T
}
```

### Пример: `orders.ts`

```ts
// lib/api/orders.ts
import { request } from './client'
import type { components } from './generated'
import { nanoid } from 'nanoid'

type Order = components['schemas']['Order']
type OrderCreate = components['schemas']['OrderCreate']

export const orders = {
  list: (filter: { status?: string; tableId?: string } = {}) =>
    request<Order[]>('GET', '/orders', { query: filter }),

  get: (id: string) => request<Order>('GET', `/orders/${id}`),

  create: (input: OrderCreate) =>
    request<Order>('POST', '/orders', { body: input, idempotencyKey: nanoid() }),

  addItem: (orderId: string, item: { menu_item_id: string; qty: number; modifiers?: string[] }) =>
    request<Order>('POST', `/orders/${orderId}/items`, { body: item, idempotencyKey: nanoid() }),

  close: (orderId: string) =>
    request<Order>('POST', `/orders/${orderId}/close`, { idempotencyKey: nanoid() }),

  split: (orderId: string, payload: { mode: 'equal' | 'by_items'; parts?: number; items?: string[] }) =>
    request<Order[]>('POST', `/orders/${orderId}/split`, { body: payload, idempotencyKey: nanoid() }),

  requestBill: (orderId: string) =>
    request<Order>('POST', `/orders/${orderId}/request-bill`, { idempotencyKey: nanoid() }),
}
```

### React Query интеграция

```ts
// hooks/use-orders.ts
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'

export function useOrders(filter = {}) {
  return useQuery({
    queryKey: ['orders', filter],
    queryFn: () => api.orders.list(filter),
  })
}

export function useCloseOrder() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (orderId: string) => api.orders.close(orderId),
    onSuccess: (order) => {
      qc.invalidateQueries({ queryKey: ['orders'] })
      qc.setQueryData(['orders', order.id], order)
    },
  })
}
```

### SSE подключение

```ts
// lib/api/events.ts
import { queryClient } from './query-client'

export function subscribeEvents(topics: string[]) {
  const url = new URL(import.meta.env.VITE_API_URL + '/events')
  url.searchParams.set('topics', topics.join(','))
  const es = new EventSource(url.toString())

  es.addEventListener('order.updated', (e) => {
    const data = JSON.parse(e.data)
    queryClient.invalidateQueries({ queryKey: ['orders'] })
    queryClient.invalidateQueries({ queryKey: ['orders', data.id] })
  })
  es.addEventListener('table.updated', () => {
    queryClient.invalidateQueries({ queryKey: ['tables'] })
  })
  // ... остальные эвенты

  es.onerror = () => {
    // EventSource сам делает reconnect; на всякий случай логируем
    console.warn('SSE error, will reconnect')
  }
  return () => es.close()
}
```

## Что выкидывается из фронта

### `lib/supabase.ts`
**deprecated** — больше не нужен `supabase-js`. Удаляется в конце фазы.

### `lib/supabase-queries.ts` (5702 строки)
Содержит:
- **Чистые запросы** (`SELECT ... WHERE ...`) → удаляются, заменяются на `api.<domain>.list/get`.
- **Бизнес-логику** (close_order с расчётом revenue, split, discount, deduct_stock) → удаляется полностью (логика теперь на бэке).
- **Хелперы для UI** (форматтеры, расчёты для отображения) → переезжают в `lib/helpers.ts`, остаются на фронте.

Целевой размер после рефакторинга: <500 строк (только то, что чисто фронт).

### `lib/realtime.ts`
**replace** — был оберткой над Supabase Realtime, заменяется на `subscribeEvents` из `lib/api/events.ts`.

### `lib/print-service.ts` (1063 строки)
**deprecate** — печать теперь на бэке. Фронт зовёт `api.orders.printReceipt(id)`, не строит hex сам. Файл удаляется.

Если фронт хочет показать preview чека — отдельный endpoint `GET /api/v1/orders/{id}/receipt-preview` возвращает уже отформатированный текст.

### `lib/print-queue.ts`
**deprecate** — очередь теперь на бэке. Фронт мониторит через `GET /api/v1/printers/queue` и SSE.

### `lib/import-excel.ts`, `export-excel.ts`, `shift-export.ts`, `orders-export.ts`
**replace** — на бэке. Фронт делает `POST /api/v1/menu/import` (multipart) и `GET /api/v1/shifts/{id}/report.xlsx` (download).

### `lib/decimal.ts`
**keep** — на фронте всё ещё нужен для отображения и optimistic UI. Сервер тоже использует свой decimal — это нормально, оба согласованы по правилам округления.

### `lib/auth-store.tsx`
**adapt** — вместо локальной проверки PIN зовёт `POST /api/v1/auth/pin`, кладёт session_token. Логика сторя (Zustand или Context) остаётся.

### `lib/runtime-mode.ts`
**delete** — нет больше «cloud-режима», только локальный.

### `lib/local-server-health.ts`
**adapt** — endpoint `/api/v1/health` остаётся, формат меняется (см. [09-DEPLOY.md](09-DEPLOY.md)).

## Конфиг

В `.env`:

```
VITE_API_URL=http://127.0.0.1:3001/api/v1
# для официантского APK в Capacitor:
# VITE_API_URL=http://<lan-ip>:3001/api/v1
```

В Capacitor: динамическое определение IP кассирской машины — есть уже сейчас (через QR-код `/connect`).

## Build pipeline

```bash
# package.json scripts
{
  "api:gen": "openapi-typescript server/api/openapi.yaml -o lib/api/generated.ts",
  "pos:dev": "VITE_API_URL=http://127.0.0.1:3001/api/v1 vite",
  "waiter:dev": "VITE_API_URL=http://192.168.1.10:3001/api/v1 vite --mode waiter",
  ...
}
```

CI прогоняет `pnpm api:gen` перед сборкой, чтобы типы всегда соответствовали актуальному openapi.

## Фронт-стек и производительность

UI-framework **не меняем** — остаёмся на React 19 + Vite + Radix Primitives + Tailwind. В Electron рендерит обычный Chromium, лаги приходят не от framework'а, а от паттернов работы с данными и списками. Поэтому фокус: правильные библиотеки данных + виртуализация + production-build без DevTools.

### Обязательные библиотеки (ставим, если ещё нет)

| Библиотека | Зачем | Заменяет |
|---|---|---|
| **`@tanstack/react-query` v5** | Кэш данных, дедупликация запросов, точечная инвалидация по SSE, optimistic updates | прямые вызовы `supabase.from(...)` в компонентах, ручное состояние «загрузка/ошибка» |
| **`@tanstack/react-virtual`** | Виртуализация всех списков >100 строк (история заказов, audit, журнал движений, меню) | — (сейчас нет вообще) |
| **`zustand`** | Лёгкий стор для PIN-сессии, открытой смены, выбранного стола, currentOrder draft | Context API для часто меняющихся данных, redux (если есть) |
| **`react-hook-form` + `zod`** | Uncontrolled inputs (нет ре-рендера на каждый символ), валидация схемами | Formik, ручные `useState` на каждое поле |
| **`lucide-react`** | Tree-shakable SVG-иконки | FontAwesome (если есть), inline SVG-копипасты |
| **`date-fns`** | Tree-shakable форматирование дат | `moment` (если есть) |
| **`dnd-kit`** | Drag-and-drop (для разделить счёт, KDS-колонки) | `react-dnd` (legacy, если есть) |
| **`recharts`** | Графики для отчётов (Phase 6) | Chart.js, ApexCharts |

### Библиотеки на УДАЛЕНИЕ из текущего фронта

| Что | Почему |
|---|---|
| **`next` / Next.js** | В Electron не нужен (нет SSR). Конфликтует с Vite. Убирается → бандл -100 КБ |
| **`moment`** | 70 КБ tree-shake невозможен. Заменить на `date-fns` или нативный `Intl` |
| **`lodash`** (если не `lodash-es`) | Тащит весь пакет. Заменить на `lodash-es` или нативный JS |
| **`redux`, `@reduxjs/toolkit`** | Тяжело и многословно для нашего размера. Zustand закрывает |
| **`axios`** | Нативный `fetch` достаточно для нашего API. Минус ~15 КБ |
| **`formik`** | Controlled inputs → ре-рендер на каждый символ. Заменить на RHF |
| **`@emotion/*`, `styled-components`** | Runtime CSS-in-JS. У нас Tailwind, дубль не нужен |
| **`@mui/*`, `antd`, `chakra-ui`, `react-bootstrap`, `reactstrap`** | Тяжёлые UI-киты. У нас Radix + Tailwind |
| **`@supabase/supabase-js`** | После Phase 2 — не нужен (новый Go-бэк) |

### Производительность: правила

В Electron производительность UI = производительность Chromium. Правила, без которых лагает на любом стеке:

1. **Production-build в release**, не dev-сервер. `vite build` обязателен.
2. **DevTools закрыты в проде.** В `desktop/main.js`: `openDevTools()` только при `NODE_ENV=development`.
3. **Виртуализация на любом списке >100 строк.** Без исключений.
4. **`React.memo` на «листовых» компонентах** внутри списков (карточка заказа, строка таблицы, ячейка KDS).
5. **`useCallback` на пропы-функциях**, которые передаются в memo-компоненты.
6. **`useMemo` только для тяжёлых вычислений** — не на каждый объект (вред больше пользы).
7. **Селекторы в Zustand:** `useStore(s => s.orders)`, не `const {orders} = useStore()`.
8. **Корректные `key` в списках** — id из БД, никогда не индекс массива.
9. **Нет inline-объектов в JSX** в горячих местах (`style={{margin: 8}}` → класс Tailwind).
10. **GPU-композитинг** на анимациях: только `transform` и `opacity`, не `top/left/width/height`.
11. **Лимит на `box-shadow` и `backdrop-filter: blur`** в overlay-модалках — убивают FPS на слабом GPU.
12. **Suspense + `React.lazy`** для редко открываемых экранов (отчёты, настройки) — ускоряет initial load на 30–50%.
13. **SSE-эвент → точечная инвалидация** через React Query, **не** глобальный refetch (см. `lib/api/events.ts`).
14. **Анимации Framer Motion** — точечно, не на каждой карточке заказа в KDS. Для простых переходов — Tailwind `transition-*`.

### Бенчмарки целевые (для приёмки в Phase 9)

| Сценарий | Целевой FPS / latency |
|---|---|
| Прокрутка истории заказов (5000 строк) | стабильно 60 FPS |
| Открытие экрана KDS с 40 активными заказами | <300 мс до интерактивности |
| Получение SSE-эвента `order.updated` → DOM обновлён | <50 мс |
| Открытие модалки «Разделить счёт» | <100 мс |
| Печать клика «Закрыть заказ» (optimistic) → UI меняется | <16 мс (один кадр) |
| Cold start Electron-app до интерактивности | <2 сек |
| Bundle размер (gzipped) основного чанка | <300 КБ |

### Что НЕ переписываем (миф «другая библиотека быстрее»)

- **Не переходим на Svelte/SolidJS/Vue/Qwik.** Они дают 5–10% выигрыш на рендере, но стоят 6–9 месяцев переписывания 24 экранов. Не окупается.
- **Не переходим на нативный UI (PySide/Qt).** Уже обсуждалось — UI с нуля + двойной стек с Capacitor-официантом. Нет.
- **Не выкидываем React 19.** Дожидаемся React Compiler (когда стабилизируется) — он авто-мемоизирует, убирая нужду в `useMemo`/`useCallback`.

## План адаптации (фаза 2 по доменам)

| Неделя | Домен | Файлы / задачи |
|---|---|---|
| 0 | **Зависимости и perf-фундамент** | Удалить `next`, `moment`, `redux`, `axios`, `formik`, `@emotion/*` (если есть). Поставить `@tanstack/react-query`, `@tanstack/react-virtual`, `zustand`, `react-hook-form`, `zod`, `date-fns`. Включить prod-build без DevTools. Поднять React Query Provider в `App.tsx` |
| 1 | API client + auth + types-gen | `lib/api/client.ts`, `auth.ts`, `generated.ts` |
| 2 | Menu (read) | компоненты меню, `hooks/use-menu.ts` |
| 3 | Tables + Orders (read) | KDS, экран столов, активные заказы. **Виртуализация истории заказов** |
| 4 | Orders mutations | create, addItem, close, split, transfer. Optimistic updates через React Query |
| 5 | Stock | приходы, списания, инвентаризация. **Виртуализация журнала движений** |
| 6 | Shifts + Finance | открытие/закрытие, операции. Формы через RHF + zod |
| 7 | Print + SSE | подписка на эвенты, печать чека/runner. Точечная инвалидация |
| 8 | XLSX, отчёты, polish | импорт/экспорт, графики через Recharts (lazy-loaded), корнер-кейсы |
| 9 | Cleanup | удаление `supabase-queries.ts`, `supabase.ts`, `print-service.ts`, `print-queue.ts`. Финальный perf-аудит по чек-листу |

Итого: ~10 недель на фронт (после готовности бэка).

## Capacitor APK официанта

Те же самые `lib/api/*` файлы (одна кодовая база). Меняется только runtime URL — на старте APK сканирует QR с `http://<ip>:3001`, сохраняет в `Preferences`, использует как `API_URL`.

## Тестирование

- **E2E** (Playwright) — против реального Go-бэка, поднятого в test-mode. Smoke-сценарии: создать заказ, добавить позицию, закрыть, распечатать (mock-принтер).
- **Snapshot-тесты** существующих React-компонентов — не должны меняться (UI не трогаем).
- **Diff-тесты** ответов API: gauge что Go-бэк возвращает то, что v1-фронт ждал. Зафиксировать в Phase 8 (Parallel run).

## Что НЕ ломается

- Все экраны дизайна `design/pos_cashier.pen`.
- Все existing-компоненты в `components/`, `app/`.
- Капасити-нативные плагины (камера, нотификации).
- Hot reload в dev.

Меняется только **слой обращения к данным**, всё остальное остаётся.
