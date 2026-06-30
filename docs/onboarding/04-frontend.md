# 04 — Фронтенд (React, касса)

Референс по React-фронту (`src/`, `app/`, `components/`, `lib/`, `hooks/`). Один и тот же бандл
работает и в Electron (касса), и в браузере по LAN. Стек: React 19 + Vite, React Router 7,
`@tanstack/react-query`, Radix + Tailwind v4, `openapi-fetch` (типизированный клиент), `decimal.js`.

> ⚠️ **Состояние — на React Context + React Query, без Zustand** (несмотря на упоминание в
> `CLAUDE.md`, в коде его нет). Глобальное — `AuthContext`; данные — React Query; локальный UI — `useState`.

---

## 1. Точка входа и роутинг

**`src/main.tsx`** — порядок бутстрапа:

- **Выбор роутера** (`main.tsx:8-11`): Electron (`window.restosDesktop`) → `HashRouter` (`file://` без
  серверного фолбэка), браузер → `BrowserRouter`.
- **Sentry** (`main.tsx:29-51`) — если задан `VITE_SENTRY_DSN`; environment `desktop`/`web`.
- **Service Worker** (PWA), **детектор stale-чанков** с rate-limit (после деплоя перезагружает
  страницу при ошибке загрузки чанка, `main.tsx:58-100`), **white-screen-детектор** для desktop
  (если root пуст через 3 с — reload).
- **Композиция провайдеров** (`main.tsx:113-130`):
  ```
  ErrorBoundary → QueryClientProvider → Router → AuthProvider → AppRouter
  ```
  `AuthProvider` в **корне** (внутри Router, но над роутами) — чтобы навигация `/login → /operations/pos`
  не ремоунтила auth-стейт (иначе фоновый 401 мог разлогинить только что вошедшего; см. коммент в
  `lib/auth-store.tsx:118-122`).

**`src/router.tsx`** — дерево маршрутов; ленивые страницы через хелпер `L()` (`lazy + Suspense`,
fallback `null` — экраны рисуют свои скелетоны). Группы:
- `/login`, `/bootstrap` под `AuthLayout` (`src/layouts/AuthLayout.tsx` — просто `<Outlet/>`).
- защищённые `/dashboard`, `/operations/*` (pos, table-map, orders, kitchen, batch-cooking, shifts,
  showcase), `/waiter/*`, `/cashier/*`, warehouse/finance/analytics/settings под `AppLayout`.
- `/admin/*` (superadmin) под `AdminLayout`. Неизвестный путь → `/dashboard`.

### Layout-shell по роли — `src/layouts/AppLayout.tsx`

`AppLayout` оборачивает: `AuthGuard` → `LicenseGate` → `LicenseWarningBanner` → `AppContent`.
`AppContent` (`AppLayout.tsx:14-51`) выбирает оболочку:
- **WaiterShell** — если `user.role==='waiter'` или путь `/waiter/*`;
- **CashierShell** — если `user.role==='cashier'`;
- иначе — sidebar-навигация (admin/manager/owner).
Во всех оболочках монтируются `RealtimeCacheBridge` (SSE→DOM-события), `AutoReadyWatcher`, `Toaster`.

**`AuthGuard`** (`lib/auth-store.tsx:64-89`): ждёт гидрацию из localStorage; нет user → `/login`;
нет доступа к пути → `homeRoute`; пока грузится — спиннер.

### PIN-логин — `lib/auth-store.tsx:160-213`

`login(pin)`: берёт `restaurant_id` из localStorage → `POST /api/v1/auth/login {restaurant_id, pin}`
→ сохраняет токен (`setV4Token`) + базового user в localStorage → **в фоне** дотягивает полный
профиль (`/users/{id}`) и ресторан (`/restaurants/{id}`) с заголовком `X-Skip-Auth-Expire: 1`
(чтобы фоновый 401 не разлогинил). `/bootstrap` — отдельная страница: выбирает ресторан и пишет
`restaurant_id` в localStorage.

---

## 2. Слой данных

### Типизированный клиент — `lib/api/v4-typed.ts`

`getBaseURL()` (`v4-typed.ts:24-47`), приоритет:
1. `window.restosDesktop.v4ApiUrl` (Electron preload);
2. `localStorage['restos-v4-api-url']` (dev-override);
3. Vite dev `:5173`/`:3000` → форс `http://<host>:3002`;
4. иначе same-origin (относительные пути — для LAN-браузера на `:3002`);
5. SSR-fallback `http://127.0.0.1:3002`.

Три middleware (`v4-typed.ts:49-101`):
- **auth** — на каждый запрос читает `restos-v4-token` из localStorage → `Authorization: Bearer …`;
- **idempotency** — на не-GET добавляет `Idempotency-Key: <uuid>`;
- **authExpired** — на 401 (кроме `X-Skip-Auth-Expire:1` и если токен запроса ≠ текущему) шлёт
  `window` CustomEvent `restos:auth:expired` → `AuthProvider` делает `logout()`.

Клиент: `createClient<paths>({ baseUrl: getBaseURL() })` + `.use(...)`. Типы `paths` —
сгенерированы из `server/api/openapi.yaml` (`lib/api/generated.ts`, обновляется `make ts-client`).

### Ошибки и `unwrap` — `lib/api/index.ts`

- `V4Error{status, body}` + `v4ErrorMessage(e)` достаёт `message` из ErrorEnvelope.
- `unwrap(p)` — кидает `V4Error` при `error`, отдаёт `data` (или `undefined` на 204);
  `unwrapOr404` — `null` на 404; `unwrapRaw` — сырой ответ для ручной проверки статуса.
- Хранилища: `setV4Token/getV4Token/clearV4Token` (`restos-v4-token`),
  `setV4RestaurantId/getV4RestaurantId` (`restos-v4-restaurant-id` — **не** чистится при logout,
  нужен для следующего PIN-логина).

### React Query — `lib/query-client.ts`

Дефолты: `staleTime 30s`, `gcTime 5min`, `retry 1` (LAN стабилен), `refetchOnWindowFocus: false`
(Electron часто меняет фокус), мутации `retry: 0` (идемпотентность на бэке). Иерархия ключей
`queryKeys` (`orders.all/list/detail`, `tables`, `zones`, `menu.items/categories`, `shifts`, …) —
инвалидация по корню каскадирует на потомков.

### Запросы/мутации — `lib/queries/*` (пример `orders.ts`)

- `fetchOrders/fetchOrdersWithCursor` — собирают query, `?include=items` батч-грузит позиции
  (вместо 1+N запросов), маппят DTO → доменные типы.
- `createOrder` — собирает body (qty/price/unit_size как **строки**), `POST /api/v1/orders`,
  логирует `logAction('order.create', …)` (аудит-трейл на фронте).

---

## 3. Состояние и realtime

### AuthContext — `lib/auth-store.tsx`

`AuthProvider` хранит `user`/`restaurant`, гидрирует из localStorage на маунте, **в фоне** обновляет
ресторан (настройки могли поменять на другом терминале). Слушает `restos:auth:expired` → `logout()`
(чистит user/токен/кэш query, но **сохраняет** `restaurant_id`). Проверки прав:
`canDo(action)`, `hasAccess(path)`, `canAccessRoles(roles)` — из кастомных прав пользователя или
дефолтов роли (`ROLE_DEFAULT_PERMISSIONS`).

### SSE — `lib/realtime.ts`

`initRealtime()` открывает `EventSource` на `${baseURL}/api/v1/events?token=…` (токен в query —
EventSource не умеет заголовки). Слушает `hello`/`ping` (keep-alive) и типизированные события;
есть **watchdog** (реконнект, если 5 с нет событий) и реконнект по `visibilitychange`/`focus`
(мобильные WebView замораживают фон). Карта `EVENT_FANOUT` (`realtime.ts:65-76`) разворачивает
событие в набор «таблиц», напр. `order.created → ['orders','tables']`, и шлёт DOM-событие
`restos-data-updated`.

### Мост SSE → React Query — `hooks/use-query-sse-bridge.ts`

`useQuerySseBridge()` ловит `restos-data-updated`, мапит `table → queryKeys` (`TABLE_TO_KEYS`) и
делает **точечную** `invalidateQueries` (только затронутые ключи; `zones` инвалидирует и `tables`).
Принцип: stale-while-revalidate, без «инвалидировать всё».

> Легаси-экраны (ещё не на React Query) используют `hooks/use-data-sync.ts` — дебаунс 600 мс
> (кухня помечает 5 позиций за секунду → один `reload()`).

### Оптимистичные апдейты

Паттерн (напр. счётчик гостей в `table-detail-sheet.tsx:176-194`): сразу меняем локальный стейт →
`patchOrder(...)` → при ошибке откатываем + toast.

---

## 4. Доменные хелперы

### `lib/helpers.ts`

- `calcLineTotal(price, qty, unit, unitSize)` (`helpers.ts:155`) — **весовые**: `price × qty/unitSize`
  (g/kg), штучные: `price × qty`. `calcLineCogs` — то же для себестоимости. (Зеркало бэкового
  `effectivePortions`; см. [03 §2](03-backend-domain.md).)
- `voidedItemFlags` / `visibleReceiptItems` — какие позиции отменены/видимы (по `cancelledAt` и по
  `order_voids`, матч по `name|price` с «корзинами» qty).
- `calcOrderDisplayTotal(order, restaurantServicePercent)` — закрытый заказ → `totalWithService`;
  открытый зал → `subtotal + service%`; не-зал → без сервиса.
- Форматирование: `formatCurrency` (`"1 234,50 TJS"`), `formatCurrencyCompact` (без `.00` для целых),
  `formatQty` (`100г`/`1.5кг`/`×3`), `formatPriceLabel` (`… / 100г`), `getTimeSince`.

### `lib/decimal.ts`

`decimal.js` (precision 20, half-up). `dMul/dDiv/dSub/dAdd/dRound/dSum` + `safe()` (undefined→0).
Зачем: JS-флоат (`0.1+0.2!==0.3`). Все денежные вычисления на фронте — через эти функции.

### `lib/types.ts`

Доменные типы: `UserRole`, `Order` (статусы `new|cooking|ready|served|bill_requested|done|cancelled`),
`OrderItem` (`unit`, `unitSize`, `printedAt`, `servedAt`, `kitchenStatus`), `MenuItem` (`station`,
`techCard`, `isBatchCooking`, `preparedQty`, `unit/unitSize`), `Table` (`status`, `currentOrderIds`
для мульти-таба), `Restaurant` (`servicePercent`, `enforceStockCheck`, `pinLockEnabled`, …).

### Чек — `lib/receipt-data.ts` + `components/print-receipt.tsx`

`buildReceiptData(order, ctx, opts)` — **единый источник** контента чека: считает `subtotal` через
`calcLineTotal`, группирует одинаковые весовые порции (`groupWeightPortions` → «100г × 3»),
скидку/сервис/чаевые, мету (стол/зона/официант/кассир). `PrintReceipt` (`forwardRef`, шрифт Courier,
ширина 280px) рендерит ESC/POS-подобный HTML: заголовок ресторана, «ПРЕДВАРИТЕЛЬНЫЙ СЧЁТ»/«ГОСТЕВОЙ
СЧЁТ», позиции, подытог/скидка/обслуживание/чаевые, **ИТОГО**, оплата. Физическая печать — через бэк
(`print_jobs`), HTML — превью.

---

## 5. Ключевые экраны и компоненты

- **POS** — `app/(app)/operations/pos/page.tsx`: рендерит `OrderComposer` (+ `OnScreenKeyboard`),
  PIN-lock по неактивности для не-кассира; query-параметры `tableId`/`newGroup`/`orderId`.
- **OrderComposer** — `components/order/order-composer.tsx`: адаптивная сетка (`pickGridLayout` по
  числу плиток), `DishTile` (эмодзи/имя/цена, бейдж qty, «Стоп», batch-доступность), `TableTile`
  (цвет по статусу стола). Данные — через `useOrderData` (меню без тех-карт для скорости + tables/zones).
- **OrderActionsPanel** — `components/order/order-actions-panel.tsx`: оплата (в т.ч. смешанная),
  скидка (%/fixed, пресеты, причина, гейт одобрения), способ оплаты (Наличные/Безналичные),
  «Закрыть и оплатить», Пре-чек/Дополнительно (разделить/перенести), отмена. (Это «окно стола».)
- **TableDetailSheet** — `components/dialogs/table-detail-sheet.tsx`: открывается из table-map,
  мульти-таб (несколько заказов на столе), смена гостей/официанта, новая группа.
- **Shells** — `components/cashier-shell.tsx` (рейл слева + PIN-lock), `components/waiter/waiter-shell.tsx`
  (LAN-guard: на flow-экранах `/waiter/order/*` контент виден даже офлайн).
- Организация: **`components/`** — переиспользуемое (композер, оболочки, диалоги, `ui/` shadcn),
  **`app/.../page.tsx`** — страницы по роутам.

---

## 6. Производительность

- **Виртуализация** (`@tanstack/react-virtual`) для длинных списков, напр.
  `components/orders/virtual-order-card-grid.tsx` — рендерит только видимые карточки.
- **Мемоизация**: `useMemo` для производных списков (фильтрованное меню), `useCallback` для
  стабильных хендлеров; точные dependency-массивы.
- **Точечная инвалидация по SSE** (см. §3): обновляются только затронутые query-ключи, не «всё».
  `refetchOnWindowFocus: false` — чтобы Electron-фокусы не спамили refetch.
- **Батч-загрузка** `?include=items` вместо 1+N.

## Шпаргалка «куда смотреть»

| Тема | Файл |
|---|---|
| Бутстрап, провайдеры | `src/main.tsx` |
| Роуты, layout | `src/router.tsx`, `src/layouts/*`, `lib/auth-store.tsx` |
| API-клиент, baseURL, middleware | `lib/api/v4-typed.ts`, `lib/api/index.ts` |
| React Query, ключи | `lib/query-client.ts`, `lib/queries/*` |
| SSE → кэш | `lib/realtime.ts`, `hooks/use-query-sse-bridge.ts`, `hooks/use-data-sync.ts` |
| Деньги/хелперы | `lib/helpers.ts`, `lib/decimal.ts` |
| Типы | `lib/types.ts` |
| Чек | `lib/receipt-data.ts`, `components/print-receipt.tsx` |
| POS/композер/оплата | `app/(app)/operations/pos/page.tsx`, `components/order/*` |
