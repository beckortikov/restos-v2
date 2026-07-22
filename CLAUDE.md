# RestOS v4 — гайдлайны для Claude

Этот файл — **источник правды** для работы в репо `restos-v4/`. Если что-то здесь противоречит документам в `../restos/` или старым PRD (v2/v3) — **этот файл побеждает**.

## Что это за проект

**RestOS v4 — монорепо** с React-фронтом и новым Go-бэком. Фронт скопирован из v1 (`../restos/`) **без изменений** в подпапки `src/`, `app/`, `components/`, `lib/`, `hooks/`, `styles/`, `public/`, `tests/`. Electron-обёртка в `desktop/`. Capacitor APK официанта в `android/`. Go-бэк будет в `server/`.

Старый Node.js-бэк (api-server.js, db.js, sync.js) **выведен из обращения и удалён** из репо (раньше лежал в `archive/legacy-node-backend/` как reference). При необходимости сверяться с поведением v1 — исходники в `../restos/`.

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
└── docs/
    ├── prd/                 — PRD 00–10
    └── decisions/           — ADR-001, ADR-002
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

### Обновления и миграции — НЕ ломать кассу

Живые кассы (Electron + embedded-postgres, Windows) обновляются авто-апдейтом, часто **перепрыгивая** версии (напр. v3.16.130 → v3.16.148). Каждый пункт — след реального инцидента, когда касса встала или потеряла данные после обновления; нарушение = ресторан без кассы. **Проверять на каждом релизе, трогающем миграции, схему БД, старт бэка, порты или Electron-обёртку.** Полный разбор каждого — в git по указанной версии.

**Миграции (goose)**
1. **Номера строго монотонны по времени добавления.** Новая миграция — номер выше любой уже задеплоенной. Номер ниже накатанного на кассах → strict-goose `missing migrations before current version` → рестарт-луп. `goose.WithAllowMissing()` в [conn.go](server/internal/db/conn.go) подстраховывает, но нумеруем дисциплинированно. *(057 после 059 — v3.16.149.)*
2. **Ветку с миграциями, ответвлённую до новых миграций на main, перед мержем перенумеровать.** Иначе два файла с одним номером (Git конфликта не видит, goose нумерует по версии) → duplicate version → бэк не стартует. *(дубли 035/036 — v3.16.62.)*
3. **Идемпотентный DDL + верные типы + CHECK.** `CREATE ... / ADD COLUMN ... / DROP ... IF [NOT] EXISTS`. Type-mismatch (`text = uuid`) уронил миграцию → краш. *(035 — 14.07.2026.)* Тестировать миграцию на реальных данных, не только на пустой БД.
4. **Тестировать апдейт с ПЕРЕПРЫГОМ версий.** Свежая установка накатывает по порядку и прячет out-of-order баги — видно только на «прыжке». Воспроизвести `goose_db_version` кассы, затем прогнать новый бинарь против неё.
5. **Критичную drift-опасную схему до-гарантировать на каждом старте** через `EnsureCriticalSchema` ([selfheal.go](server/internal/db/selfheal.go)), независимо от `goose_db_version` — кассы дрейфуют (goose «применено», а колонок нет). *(нет `ingredients.warehouse_id` при goose=36 — 15.07.2026.)*

**Данные — не терять никогда**
6. **pgdata НЕ удаляется автоматически ни при какой ошибке старта** (auth / занятый порт / упавшая миграция). Авто-wipe (введён в v2.7.2 под password-mismatch) сработал на упавшей миграции → стёр всю базу ресторану. Реальный reset — только вручную и с бэкапом. *(14.07.2026 — v3.16.62.)*
7. **Бэкап перед деструктивом; restore — через maintenance-режим** (чтобы `DROP` взял блокировки). Ежедневный `pg_dump` уже есть — `userData/backups` + `Рабочий стол/RestOS-Backups`.

**Старт бэка / embedded-PG / порты**
8. **После успешного старта PG любой фатал сначала `sup.Stop()`** (`fatalStopPG` в [main.go](server/cmd/restos-server/main.go)). `log.Fatal`→`os.Exit` пропускает `defer` → PG сиротеет на 54330 → каждый рестарт падает `process already listening on port 54330`. *(22.07.2026.)*
9. **Зомби-PG/sidecar после апдейта чистим до старта.** `killStaleSidecars` + `ensurePortFree` (цикл) в `app.on('ready')` **и** на рестарт-пути `goProc.on('exit')`; `stopSidecar` синхронно перед `quitAndInstall`; `clearStaleLock` снимает `postmaster.pid`. Иначе старый PG держит порт/лок → «Сервер не отвечает». *(v3.16.58.)* Диагностика: **reboot логическую ошибку старта не лечит** — нужен фикс-бинарь или откат.
10. **Порты — API `3002`, PG `54330` — менять синхронно во всех местах** (main.js, preload.js, firewall-rule, cleanup). Сдвиг без обновления cleanup → зомби ищут не на том порту. *(cleanup остался на 54329 — v3.8.2.)*

**Сосуществование с v1 на одной машине**
11. **v2-порты `3002`/`54330` фиксированы** (v1 на `3001`/`54329`) — не коллизить. *(v3.8.0.)*
12. **userData только `name:"restos-desktop-v2"`.** Общий с v1 каталог `restos-desktop` → v2 затёр PGlite-базу v1, v1 крашнулся. Никогда не шарить userData между приложениями; перенос — только через `migrateUserDataFromSharedDir`. *(v3.8.3.)*

**Работа кассы (LAN / вход)**
13. **По LAN (`http://<ip>:3002`, не secure context) `crypto.randomUUID` недоступен** — только UUID-хелпер с фолбэком. Иначе загрузка APK / импорт / бэкап / возврат падают. *(v3.15.55, v3.16.135.)*
14. **Один `AuthProvider` в корне** — два провайдера → первый PIN не входит / белый экран (лечился только ctrl+shift+r). *(v3.9.37.)*
15. **Зависшие заказы прошлой смены блокируют закрытие** — orders-cleanup watchdog + UI-гвард, чтобы их находить и гасить. *(v3.15.21, v2.1.2.)*

### Что НЕ трогаем (до Phase 2)

- `src/`, `components/`, `app/` — React-UI **компоненты и экраны**.
- `android/` — Capacitor APK официанта (меняется только base URL в Phase 2).
- Capacitor-плагины — не трогаем.
- Дизайн (`../restos/design/pos_cashier.pen` — лежит в исходном репо, в v4 не копировали как .pen-файл; см. при необходимости).

### Что трогаем в Phase 7

- `desktop/main.js` — переписывается под spawn Go-бинаря и удаление `require('./api-server')` и т.п. (их и так уже нет — старый Node-бэк удалён из репо).

### Фронт-стек (для фазы 2 адаптации)

UI-framework **не меняем** — остаёмся на React 19 + Vite + Radix Primitives + Tailwind. В Electron рендерит Chromium; лаги приходят не от framework'а, а от data-слоя и нелинейных списков. См. [docs/prd/10-FRONTEND-ADAPTER.md](docs/prd/10-FRONTEND-ADAPTER.md) раздел «Фронт-стек и производительность».

**Ставим:** `@tanstack/react-query`, `@tanstack/react-virtual`, `zustand`, `react-hook-form` + `zod`, `lucide-react`, `date-fns`, `dnd-kit`, `recharts`.

**Удаляем (если есть):** `next` (не нужен в Electron), `moment`, `redux`, `axios`, `formik`, `@emotion/*`, `styled-components`, тяжёлые UI-киты (`@mui`, `antd`, `chakra-ui`, `react-bootstrap`), `@supabase/supabase-js` (после Phase 2).

**Не переходим:** на Svelte/Solid/Vue/Qwik (не окупается переписыванием 24 экранов), на PySide (отброшено в ADR-001).

**Perf-правила (обязательные):** prod-build без DevTools, виртуализация всех списков >100 строк, `React.memo` на листовых компонентах, Zustand-селекторы, точечная инвалидация React Query на SSE-эвенты, GPU-композитинг для анимаций. Полный чек-лист и целевые бенчмарки — в PRD 10.

## LAN Web Access (v2.5.0+)

Go-бэк отдаёт React SPA на том же порту 3001. Любое устройство в LAN ресторана может открыть `http://<ip-кассы>:3001` в браузере — UI грузится полностью, Electron не нужен.

Реализация:
- `server/internal/transport/http/spa.go` — `//go:embed all:spa` → `SPAHandler()` отдаёт ассеты + index.html fallback (для React Router F5 на `/operations/pos`).
- В роутере: `r.NotFound(SPAHandler().ServeHTTP)` после всех `/api/v1/*` и `/sse`.
- Build pipeline: `make embed-spa` (vite build → `cp dist → server/internal/transport/http/spa/`) → `make build`. Цели `build-sidecar`/`build-sidecar-all` уже включают `embed-spa`.
- `server/internal/transport/http/spa/` — gitignore (кроме `.gitkeep` + placeholder `index.html`).

Для чего полезно:
- Owner/manager смотрит отчёты с ноутбука в офисе.
- Официант на планшете через обычный браузер (помимо Capacitor APK).
- Диагностика с любого устройства.

Ограничения:
- Касса (Electron) должна быть запущена — Go-sidecar живёт внутри .dmg/.exe.
- Лицензия привязана к MachineID кассы, не браузера.
- Vite dev (порт 5173) → frontend форсирует API на `:3001` (см. `lib/api/v4-typed.ts` `getBaseURL`).

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

## Источники для портирования

Старый Node-бэк удалён из этого репо — исходники для сверки лежат в v1-репо `../restos/desktop/`.

| Где | Что | Куда переезжает |
|---|---|---|
| `../restos/desktop/db.js` | Исходная схема БД (PGlite) | `server/internal/db/migrations/001_init.up.sql` (1:1, PG-нативно) |
| `../restos/desktop/api-server.js` | Исходные 28 эндпоинтов | `server/internal/transport/http/handlers/` (чистый REST) |
| `../restos/desktop/sync.js` | Sync с Supabase | **Не портируем** (см. PRD 07 Future-Cloud) |
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
