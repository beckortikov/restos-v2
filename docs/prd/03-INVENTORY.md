# 03 — Inventory: что переносим из restos/

Полный аудит файлов текущего проекта с маркировкой: **migrate** (переносим логику на Go), **adapt** (фронт-код, переписываем только клиент API), **keep** (не трогаем), **archive** (удаляем после v4).

## Backend Node (полностью на Go)

| Файл | Строк | Что внутри | Действие |
|---|---|---|---|
| `archive/legacy-node-backend/api-server.js` | 1526 | Express + PostgREST-эмулятор + 28 эндпоинтов | **migrate** → `server/internal/transport/http/*` |
| `archive/legacy-node-backend/db.js` | 976 | PGlite init + DDL всех таблиц + триггеры sync_log | **migrate** → `server/internal/db/migrations/*.sql` + `models/*.go` |
| `archive/legacy-node-backend/sync.js` | 646 | Двусторонний sync с Supabase, FK-self-healing | **archive** в v4 (cloud не делаем). При возврате к cloud — порт на Go, см. [07-FUTURE-CLOUD.md](07-FUTURE-CLOUD.md) |
| `desktop/main.js` | 363 | Electron lifecycle, spawn API server | **keep + edit** — заменить spawn Node на spawn Go binary |
| `archive/legacy-node-backend/standalone.js` | ~100 | Standalone Express запуск без Electron | **archive** (заменяет `restos-server --standalone`) |
| `desktop/preload.js` | ~40 | Electron preload bridge | **keep** — фронт-side, не меняется |

## Frontend бизнес-логика → переезжает на Go

Сейчас фронт хранит много бизнес-логики, которая должна жить на бэке (особенно мутации + расчёты, влияющие на финансы):

| Файл | Строк | Что внутри | Действие |
|---|---|---|---|
| `lib/supabase-queries.ts` | 5702 | **Каждая** мутация: создать заказ, закрыть, разделить, скидка, печать, склад, смена | **migrate** на Go (бизнес-логика) + **adapt** (тонкий API-клиент остаётся) |
| `lib/print-service.ts` | 1063 | CP866-кодировка, ESC/POS hex layout, чек, runner, отмена | **migrate** → `server/internal/escpos/*` |
| `lib/print-queue.ts` | 224 | Очередь печати, retry, mock-mode | **migrate** → `server/internal/printer/queue.go` |
| `lib/import-excel.ts` | 284 | Парсинг XLSX меню/техкарт/ингредиентов | **migrate** → `server/internal/service/import_excel.go` (Go xlsx) |
| `lib/export-excel.ts` | 171 | Экспорт XLSX | **migrate** → `server/internal/service/export_excel.go` |
| `lib/shift-export.ts` | 233 | Отчёт по смене XLSX | **migrate** |
| `lib/orders-export.ts` | 191 | Экспорт заказов | **migrate** |
| `lib/receipt-data.ts` | 96 | Подготовка данных чека (totals, items, modifiers) | **migrate** в `service/order_service.go:BuildReceiptData` |
| `lib/decimal.ts` | ~80 | Decimal-арифметика для денег | **migrate** → `server/internal/pkg/decimal/` |

## Frontend, который остаётся (только меняем API-клиент)

| Файл | Действие | Что меняется |
|---|---|---|
| `lib/supabase.ts` | **adapt** | Конструктор клиента: вместо Supabase URL — `http://127.0.0.1:3001/api/v1` |
| `lib/queries.ts` | **adapt** | Возможно переписываем под React Query с новыми endpoint'ами |
| `lib/realtime.ts` | **adapt** | Сейчас Supabase Realtime → переключаем на наш SSE `/api/v1/events` |
| `lib/auth-store.tsx` | **adapt** | PIN-логин: вместо локальной проверки → `POST /api/v1/auth/pin` |
| `lib/types.ts` | **keep** | TS-типы остаются, могут быть авто-генерены из `openapi.yaml` |
| `lib/helpers.ts`, `utils.ts` | **keep** | Утилиты UI |
| `lib/runtime-mode.ts` | **adapt** | Сейчас отличает local/cloud режим — упрощаем |
| `lib/local-server-health.ts` | **adapt** | Проверка `/health` — endpoint остаётся, формат тот же |
| `lib/bug-report.ts` | **keep** | Чисто фронт |
| `lib/random-id.ts` | **keep** | UUID на фронте для optimistic UI |
| `lib/offline/` | **adapt/archive** | Если решим оставить offline-режим — обсуждаем отдельно |
| `lib/waiter/` | **adapt** | Логика официанта — endpoint'ы меняются |

## Frontend UI — не трогаем

- `src/` — Vite entry
- `app/` — Next-style routing (или React Router в Vite)
- `components/` — все компоненты UI
- `hooks/` — React hooks (могут потребовать adapt если используют `lib/supabase-queries.ts` напрямую)
- `public/`, `styles/` — assets (внутри v4); `../restos/design/` — дизайн остался в v1

## Capacitor APK официанта

- `android/` — **keep**. Меняется только base URL в `capacitor.config.ts` или env.
- `lib/waiter/` — **adapt** аналогично десктоп-фронту.

## Конфиги — adapt

| Файл | Что |
|---|---|
| `package.json` | scripts: `pos:dev`, `waiter:apk` — оставляем; добавляем `server:dev`, `server:build` |
| `vite.config.ts` | env-переменная `VITE_API_URL` |
| `tsconfig.json` | без изменений |
| `capacitor.config.ts` | adapt server URL |
| `desktop/package.json` | убираем зависимости `@electric-sql/pglite`, `express` (после Phase 4) |

## Документация

| Папка | Действие |
|---|---|
| `../restos/docs/` | **keep как референс** (остаётся в v1-репо, не копируется в v4) |
| `../restos/docs/prd-v3/` | **deprecate** — план PySide+Django отменён, v4 заменяет |
| `../restos/docs/prd-v3/backend/` | **archive** — Django-описание не нужно |
| `/Users/behzod/Documents/projects/CLAUDE.md` | **update** — зафиксировать v4 как актуальный план |

## Эндпоинты текущего Node-бэка (28 штук) — все переезжают

Список из `desktop/api-server.js`:

### Connect / Diag (для официантов)
- `GET /connect/qr.png` — QR с URL для подключения
- `GET /connect/diag` — диагностика сети
- `GET /connect` — HTML-страница «как подключиться»

### Realtime
- `GET /events` — SSE поток обновлений

### PostgREST-эмулятор (главное)
- `GET /rest/v1/:table` — list with filters
- `POST /rest/v1/:table` — insert
- `PATCH /rest/v1/:table` — update by filter
- `DELETE /rest/v1/:table` — delete by filter

### Auth-stub
- `GET /auth/v1/user`
- `POST /auth/v1/token`
- `GET /auth/v1/settings`

### Status / Sync
- `GET /status`
- `GET /sync/status`
- `POST /sync/reconcile`

### Admin
- `POST /admin/clear-operations`
- `POST /admin/clear-menu`
- `POST /admin/cleanup-orphan-items`

### Print
- `POST /print`
- `GET /print/status`
- `GET /printer-config`
- `POST /printer-config`

### License & Activation
- `GET /license-check`
- `POST /activate`

### Desktop updates
- `GET /desktop/update-status`
- `POST /desktop/check-update`
- `POST /desktop/install-update`
- `POST /desktop/open-connect`

### Catch-all
- `GET *` — отдача SPA

## Маппинг старых → новых эндпоинтов

В v4 уходим от PostgREST-стиля. Маппинг см. [04-API-CONTRACT.md](04-API-CONTRACT.md).

Пример:
- `GET /rest/v1/orders?status=eq.open&order=created_at.desc` → `GET /api/v1/orders?status=open&order=created_at:desc`
- `POST /rest/v1/orders` (body) → `POST /api/v1/orders` (body, с валидацией)
- `PATCH /rest/v1/orders?id=eq.123` → `PUT /api/v1/orders/123` или `POST /api/v1/orders/123/close` (специализированный)
