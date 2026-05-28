# RestOS v4 — гайдлайны для Claude

Этот файл — **источник правды** для работы в репо `restos-v4/`. Если что-то здесь противоречит документам в `../restos/` или старым PRD (v2/v3) — **этот файл побеждает**.

## Что это за проект

**RestOS v4 — монорепо** с React-фронтом и новым Go-бэком. Фронт скопирован из v1 (`../restos/`) **без изменений** в подпапки `src/`, `app/`, `components/`, `lib/`, `hooks/`, `styles/`, `public/`, `tests/`. Electron-обёртка в `desktop/`. Capacitor APK официанта в `android/`. Go-бэк будет в `server/`.

Старый Node.js-бэк (api-server.js, db.js, sync.js) **выведен из обращения** и лежит в `archive/legacy-node-backend/` как reference (удалится в Phase 10).

Цель — заменить рабочий Node.js + PGlite + Express на **Go (chi + GORM + PostgreSQL 16)**, фронт-код останется на месте (адаптация API-слоя — Phase 2, см. PRD 10).

Полный PRD: [docs/prd/00-INDEX.md](docs/prd/00-INDEX.md).

## Стек (фиксирован)

| Слой | Технология |
|---|---|
| Язык | **Go 1.23+** |
| HTTP роутер | **chi v5** |
| ORM | **GORM v2** |
| Postgres driver | **pgx/v5** + `gorm.io/driver/postgres` |
| БД | **PostgreSQL 16** через `fergusstrange/embedded-postgres` (Go-бэк сам запускает Postgres как child-процесс) |
| Миграции | **goose** (embedded в бинарь через `embed.FS`) |
| Логи | **zerolog** |
| Конфиг | viper + env + CLI flags |
| Тесты | стандартный `go test` + `testify/require` + golden tests для ESC/POS |
| Realtime | SSE через стандартный `net/http` + chi |
| Печать | чистый Go-порт `../restos/lib/print-service.ts` (ESC/POS + CP866) |

**Никакого** Django, Node, PySide, SQLite, Docker для Postgres, Supabase, Electron-внутренней БД. Это всё отброшено в ADR — см. [docs/decisions/](docs/decisions/).

## Структура репо

```
restos-v4/
├── CLAUDE.md
├── README.md
├── package.json             — фронт (Vite + Capacitor + Electron-builder)
├── pnpm-lock.yaml
├── tsconfig.json, vite.config.ts, capacitor.config.ts, postcss.config.mjs, etc.
│
├── src/                     — Vite entry (main.tsx, router)
├── app/                     — экраны по доменам (orders, kitchen, finance, ...)
├── components/              — UI-компоненты (Radix + Tailwind)
├── lib/                     — клиент-логика (api/, helpers, decimal, types)
├── hooks/                   — React hooks
├── styles/, public/, tests/
│
├── desktop/                 — Electron-обёртка
│   ├── main.js              — Phase 7: переписывается под spawn Go-бинаря
│   ├── preload.js, assets/, activate.html, blocked.html
│   └── package.json
│
├── android/                 — Capacitor APK официанта (без изменений)
│
├── server/                  — Go-бэк (структура ниже)
│
├── docs/
│   ├── prd/                 — PRD 00–10
│   └── decisions/           — ADR-001, ADR-002
│
└── archive/
    └── legacy-node-backend/ — старые api-server.js / db.js / sync.js / standalone.js
                              на reference. На удаление после Phase 10.
```

Внутри `server/` (создаётся в Phase 0):

```
server/
├── cmd/restos-server/main.go
├── internal/
│   ├── config/
│   ├── pgsupervisor/    — embedded-postgres lifecycle
│   ├── db/
│   │   ├── conn.go
│   │   ├── migrations/  — *.sql (embedded через embed.FS)
│   │   └── models/      — GORM-модели
│   ├── repo/            — репозитории (ForTenant обязателен)
│   ├── service/         — бизнес-логика
│   ├── escpos/          — CP866 + layout + golden tests
│   ├── transport/
│   │   ├── http/        — chi router, middleware, handlers
│   │   └── sse/         — /api/v1/events hub
│   ├── printer/         — драйверы: tcp, usb, mock, virtual
│   ├── jobs/            — cron (бэкапы, retry печати)
│   ├── audit/           — GORM-хуки → audit_log
│   └── pkg/             — idempotency, tenant, decimal, errors
├── api/openapi.yaml     — источник правды для REST-контракта
├── migrations/          — для goose CLI
├── Makefile
├── go.mod
└── go.sum
```

## Связанные проекты (вне этого репо)

- `../restos/` — **исходный v1**, остаётся в проде до Phase 9. **Не трогаем** во время разработки v4.
- `../restos-local-server/`, `../restos-print-server/` — старые экспериментальные сервера, **игнорируем**.

## Критичные правила разработки

### Архитектура

1. **Sidecar-протокол:** `Electron → restos-server (Go) → postgres (child)`. Go-бинарь спавнит Postgres через `embedded-postgres` на старте, останавливает на graceful shutdown.
2. **Один Postgres-процесс на машину кассира.** Никаких внешних БД (если не указан `--external-pg-dsn` для dev).
3. **Бэк слушает на `127.0.0.1:3001`** (localhost для Electron, и доступен по LAN для официантов APK).
4. **Cloud / Supabase в v4 НЕТ.** Всё локально. Возврат к cloud — отдельная фаза (см. [docs/prd/07-FUTURE-CLOUD.md](docs/prd/07-FUTURE-CLOUD.md)).

### Код — обязательные правила

1. **`tenant_id` фильтр — закон.** Каждый репозиторий обязан использовать `r.ForTenant(ctx)`. Прямой `r.db.Find(...)` без tenant — запрещён (CI-линтер). Это защита от утечки данных между ресторанами.
2. **Все мутации — в транзакции.** Если эндпоинт пишет в 2+ таблиц — обёртка `db.Transaction(func(tx) {...})` обязательна. GORM-хуки на `AfterCreate/AfterUpdate/AfterSave/AfterDelete` для `audit_log` и domain-эвентов — выполняются **в той же транзакции**.
3. **Идемпотентность.** Все write-эндпоинты (`POST/PUT/DELETE`) принимают `Idempotency-Key` header (UUID), хранится в таблице `idempotency_keys` 24 ч. Middleware возвращает кэшированный ответ при повторе.
4. **Деньги — только `decimal.Decimal`** (`github.com/shopspring/decimal`). Никакого float. В БД — `NUMERIC(14,4)`. Округление — half-even, явно.
5. **`ingredients.qty`** обновляется **только через event-stream** `stock_movements`. Прямой UPDATE запрещён. Денормализация qty — через GORM-хук `AfterCreate StockMovement` (см. PRD 06).
6. **Audit-log на каждой мутации.** Централизованный GORM-хук в `internal/audit/hooks.go`. Никакого ручного `audit_log.Insert()` в сервисах.
7. **Печать ESC/POS — fire-and-forget.** Внутри транзакции `close_order` мы **только** ставим job в `print_jobs`. Отправка на физический принтер — асинхронным worker'ом, ретраи + backoff.
8. **Snapshot-тесты hex-выводов ESC/POS** обязательны для каждого типа чека/runner'а. Эталоны — байт-в-байт из текущей Node-версии (`../restos/lib/print-service.ts`).

### API

1. **Чистый REST `/api/v1/...`** (см. ADR-002). Никакого PostgREST-совместимого слоя.
2. **OpenAPI — источник правды.** Каждый новый эндпоинт сразу описывается в `server/api/openapi.yaml` и параллельно реализуется. CI прогоняет `oapi-codegen --validate`. Swagger UI на `http://localhost:3001/docs`.
3. **ErrorEnvelope единый формат** — см. [docs/prd/04-API-CONTRACT.md](docs/prd/04-API-CONTRACT.md) раздел Error codes.
4. **Specialized endpoints** предпочтительнее «изменить любое поле»: `POST /orders/{id}/close` лучше, чем `PATCH /orders/{id}`.
5. **Realtime — через SSE `/api/v1/events`**, в-памяти hub (один процесс). LISTEN/NOTIFY Postgres не используем в MVP.

### Платформенные ограничения

- Owner-роль в v4 — нет (Owner Dashboard живёт в облаке, которого в v4 нет). Если придёт запрос с ролью `owner` локально — `403 ROLE_NOT_AVAILABLE_LOCALLY`.
- Waiter APK ходит на бэк по LAN на `http://<lan-ip>:3001`. Вне сети ресторана не работает.
- Cashier/Cook — внутри Electron, через `http://127.0.0.1:3001`.

### БД

- **PostgreSQL 16, всегда.** Локально через `embedded-postgres`, в dev можно подключить external через `--external-pg-dsn`.
- **UUID-первичные ключи** (`gen_random_uuid()`). Без autoincrement.
- **`updated_at` колонка** на каждой таблице — для будущей дельта-логики.
- **CHECK-constraints** на всех enum-полях. Дублируется валидацией через `go-playground/validator`.
- **GIN-индексы** на ILIKE-поиск (`pg_trgm` extension).
- **Connection pool**: 25 max open, 5 idle, 1 ч lifetime.
- **WAL recovery встроен в Postgres** — на сбой питания полагаемся.
- **Backup**: `pg_dump --format=custom` ежедневно в 3:00, ротация 7+4+12, лежит в `userData/backups/`.

### Что НЕ трогаем (до Phase 2)

- `src/`, `components/`, `app/` — React-UI **компоненты и экраны**.
- `android/` — Capacitor APK официанта (меняется только base URL в Phase 2).
- Capacitor-плагины — не трогаем.
- Дизайн (`../restos/design/pos_cashier.pen` — лежит в исходном репо, в v4 не копировали как .pen-файл; см. при необходимости).

### Что трогаем в Phase 7

- `desktop/main.js` — переписывается под spawn Go-бинаря и удаление `require('./api-server')` и т.п. (их и так уже нет — они в archive/).

### Фронт-стек (для фазы 2 адаптации)

UI-framework **не меняем** — остаёмся на React 19 + Vite + Radix Primitives + Tailwind. В Electron рендерит Chromium; лаги приходят не от framework'а, а от data-слоя и нелинейных списков. См. [docs/prd/10-FRONTEND-ADAPTER.md](docs/prd/10-FRONTEND-ADAPTER.md) раздел «Фронт-стек и производительность».

**Ставим:** `@tanstack/react-query`, `@tanstack/react-virtual`, `zustand`, `react-hook-form` + `zod`, `lucide-react`, `date-fns`, `dnd-kit`, `recharts`.

**Удаляем (если есть):** `next` (не нужен в Electron), `moment`, `redux`, `axios`, `formik`, `@emotion/*`, `styled-components`, тяжёлые UI-киты (`@mui`, `antd`, `chakra-ui`, `react-bootstrap`), `@supabase/supabase-js` (после Phase 2).

**Не переходим:** на Svelte/Solid/Vue/Qwik (не окупается переписыванием 24 экранов), на PySide (отброшено в ADR-001).

**Perf-правила (обязательные):** prod-build без DevTools, виртуализация всех списков >100 строк, `React.memo` на листовых компонентах, Zustand-селекторы, точечная инвалидация React Query на SSE-эвенты, GPU-композитинг для анимаций. Полный чек-лист и целевые бенчмарки — в PRD 10.

## Команды (после Phase 0)

```bash
# Backend dev (внутри server/)
make run                            # запуск с авто-embedded Postgres
make run-external PG_DSN=...        # с external Postgres (для dev)
make build                          # бинарь в bin/restos-server
make build-all                      # cross-compile под все платформы
make build-sidecar                  # копирует бинарь в ../restos/desktop/resources/
make test                           # unit + integration
make test-cover                     # с покрытием
make lint                           # golangci-lint
make api-gen                        # генерация OpenAPI и проверка
make update-golden                  # обновить snapshot-эталоны ESC/POS (явно)
```

## Версии и зависимости

- **Go 1.23+** (toolchain до 1.26 OK)
- **PostgreSQL 16** (через embedded-postgres, дистрибутив качается на первый запуск ~80 МБ)
- **Node 20+** — только для фронта в `../restos/` (не нужен в самом v4-репо)

## Workflow (по правилам пользователя)

- **Коммитим напрямую в `main`**, без PR. Один линейный поток коммитов.
- Работаем в основном worktree `/Users/behzod/Documents/projects/restos-v4`, **не** через `.claude/worktrees`.
- В коммит-сообщении при работе над фичами писать, какая Phase + что внутри (например: `feat(orders): close_order service with revenue entry — Phase 3`).

## Источники для портирования (внутри этого репо)

| Где | Что | Куда переезжает |
|---|---|---|
| `archive/legacy-node-backend/db.js` | Исходная схема БД (PGlite) | `server/internal/db/migrations/001_init.up.sql` (1:1, PG-нативно) |
| `archive/legacy-node-backend/api-server.js` | Исходные 28 эндпоинтов | `server/internal/transport/http/handlers/` (чистый REST) |
| `archive/legacy-node-backend/sync.js` | Sync с Supabase | **Не портируем** (см. PRD 07 Future-Cloud) |
| `lib/supabase-queries.ts` | 5702 строки бизнес-логики на фронте | `server/internal/service/` (бэк-логика) + `lib/api/` (тонкий клиент) |
| `lib/print-service.ts` | ESC/POS layout (1063 строки) | `server/internal/escpos/` + golden tests |
| `lib/print-queue.ts` | Очередь печати | `server/internal/printer/queue.go` |
| `lib/decimal.ts` | Decimal-арифметика | `server/internal/pkg/decimal/` + остаётся на фронте для optimistic UI |

## Внешние документы

- `/Users/behzod/Documents/projects/CLAUDE.md` (глобальный) — гайдлайны v2 (Tauri+Go+SQLite+Supabase). **Устарел для v4**, см. ADR-001/002. Не следовать.
- `../restos/docs/prd-v3/` — план PySide+Django. **Отменён**. См. ADR-001.

## Что устарело и НЕ применяется в v4

- ❌ Tauri 2.0 (план v2). Возможен возврат как v5, но в v4 — Electron-обёртка существующего фронта.
- ❌ SQLite (план v2). В v4 — PostgreSQL.
- ❌ Supabase sync (v1, план v2). В v4 — нет облака.
- ❌ Django (план v3). См. ADR-001.
- ❌ PySide-кассир (план v3). См. ADR-001.
- ❌ PostgREST-совместимый API (v1). См. ADR-002.

## Контакты ответственности (для self-recall)

- **Архитектура и стек:** ADR-001, ADR-002. Изменения только через новый ADR.
- **Бизнес-правила** (close_order создаёт revenue, deduct stock на cooking→ready, etc.): PRD 06.
- **Список таблиц и индексы:** PRD 05.
- **Список REST-эндпоинтов:** PRD 04 + `server/api/openapi.yaml`.
- **План работы по фазам:** PRD 08.
- **Как собирать и упаковывать:** PRD 09.
- **Фронт-адаптация (фаза 2):** PRD 10.
