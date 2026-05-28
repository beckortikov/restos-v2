# 02 — Architecture

## Высокоуровневая схема

```
┌─────────────────────────────────────────────────────────────────┐
│                  МАШИНА КАССИРА (мини-ПК / ноут)                │
│                                                                  │
│  ┌──────────────────────────────────────────────────────┐      │
│  │ Electron app (frontend wrapper)                       │      │
│  │  - BrowserWindow → React-bundle из dist/       │      │
│  │  - main.js спавнит restos-server как child_process    │      │
│  │  - на quit() убивает child                            │      │
│  └─────────────────┬────────────────────────────────────┘      │
│                    │ HTTP/SSE на 127.0.0.1:3001                 │
│  ┌─────────────────▼────────────────────────────────────┐      │
│  │ restos-server (Go single binary, ~25 МБ)              │      │
│  │  - chi router → handlers/                              │      │
│  │  - GORM → repositories/                                │      │
│  │  - print engine (ESC/POS → TCP/USB)                    │      │
│  │  - SSE hub /api/v1/events                              │      │
│  │  - background jobs (cron-style)                        │      │
│  │  - spawns Postgres child process at startup            │      │
│  └─────────────────┬────────────────────────────────────┘      │
│                    │ libpq (loopback)                            │
│  ┌─────────────────▼────────────────────────────────────┐      │
│  │ PostgreSQL 16 (embedded-postgres, child process)      │      │
│  │  - listens on 127.0.0.1:<random-port>                  │      │
│  │  - data dir: userData/postgres-data/                   │      │
│  │  - logs: userData/logs/postgres.log                    │      │
│  └──────────────────────────────────────────────────────┘      │
│                    │                                              │
│                    ▼                                              │
│            ┌──────────────┐                                       │
│            │ ESC/POS      │                                       │
│            │ Printer(s)   │                                       │
│            │ TCP/USB      │                                       │
│            └──────────────┘                                       │
└──────────────┬───────────────────────────────────────────────────┘
               │ Wi-Fi LAN
               │
   ┌───────────▼────────────┐
   │ Capacitor APK          │   Официанты, ходят на http://<ip>:3001
   │ (до 20 устройств)      │
   └────────────────────────┘
```

**В v4 нет cloud-зеркала.** Owner Dashboard для отчётов будет доступен только когда добавится cloud (отдельная фаза, не в v4).

## Компоненты Go-бэка

```
server/
├── cmd/
│   └── restos-server/
│       └── main.go              # точка входа, флаги, graceful shutdown
├── internal/
│   ├── config/                  # viper + env + CLI flags
│   ├── pgsupervisor/            # embedded-postgres: spawn, healthcheck, shutdown
│   ├── db/
│   │   ├── conn.go              # pgx + GORM, pool настройки
│   │   ├── migrations/          # *.sql, embedded через embed.FS
│   │   └── models/              # GORM-модели по таблицам
│   ├── repo/                    # репозитории (ForTenant обязателен)
│   │   ├── orders.go
│   │   ├── menu.go
│   │   ├── stock.go
│   │   └── ...
│   ├── service/                 # бизнес-логика
│   │   ├── order_service.go     # CreateOrder, CloseOrder, SplitOrder
│   │   ├── stock_service.go     # DeductForOrder, AdjustOnInventory
│   │   ├── shift_service.go     # OpenShift, CloseShift
│   │   ├── finance_service.go   # CreateRevenueEntry на закрытии
│   │   └── print_service.go     # BuildReceipt, BuildRunner
│   ├── escpos/                  # CP866, layout, hex builder
│   │   ├── encode.go
│   │   ├── layout.go
│   │   └── snapshot_test.go     # эталоны байт-в-байт из Node-версии
│   ├── transport/
│   │   ├── http/
│   │   │   ├── router.go        # chi
│   │   │   ├── middleware/      # tenant, idempotency, logger, recover
│   │   │   └── handlers/        # по доменам
│   │   └── sse/                 # /api/v1/events hub
│   ├── printer/                 # драйверы: tcp, usb, mock, virtual
│   ├── jobs/                    # background scheduler (robfig/cron)
│   ├── audit/                   # GORM-хуки → audit_log
│   └── pkg/
│       ├── idempotency/
│       ├── tenant/              # ctx ↔ tenant_id helpers
│       ├── decimal/             # порт lib/decimal.ts
│       └── errors/              # ErrorEnvelope формат
├── migrations/                  # для goose
├── api/openapi.yaml             # источник правды для REST-контракта
├── Makefile                     # run, build, build-sidecar, test
├── go.mod
└── go.sum
```

## Embedded Postgres — как это работает

Библиотека `github.com/fergusstrange/embedded-postgres`:

```go
// server/internal/pgsupervisor/supervisor.go
package pgsupervisor

import (
    embeddedpostgres "github.com/fergusstrange/embedded-postgres"
)

type Supervisor struct {
    pg *embeddedpostgres.EmbeddedPostgres
    cfg Config
}

func New(cfg Config) *Supervisor {
    pg := embeddedpostgres.NewDatabase(embeddedpostgres.DefaultConfig().
        Version(embeddedpostgres.V16).
        Port(cfg.Port).               // например 54817 (случайный из 49152–65535)
        Database("restos").
        Username("restos").
        Password(cfg.Password).        // генерится при init, хранится в userData/.pg-secret
        DataPath(cfg.DataDir).          // userData/postgres-data/
        BinariesPath(cfg.BinariesDir).  // userData/postgres-bin/  (~80 МБ)
        Logger(pgLogWriter(cfg.LogPath)),
    )
    return &Supervisor{pg: pg, cfg: cfg}
}

func (s *Supervisor) Start(ctx context.Context) error {
    if err := s.pg.Start(); err != nil {
        return fmt.Errorf("postgres start: %w", err)
    }
    return s.waitReady(ctx, 15*time.Second)
}

func (s *Supervisor) Stop() error { return s.pg.Stop() }

func (s *Supervisor) DSN() string {
    return fmt.Sprintf("postgres://%s:%s@127.0.0.1:%d/%s?sslmode=disable",
        s.cfg.User, s.cfg.Password, s.cfg.Port, s.cfg.Database)
}
```

**Первый запуск:**
1. Библиотека качает Postgres 16 дистрибутив (~80 МБ) в `userData/postgres-bin/`. URL зашит, можно подменить на собственное зеркало.
2. Запускает `initdb` → создаётся `userData/postgres-data/`.
3. Стартует `postgres` процесс на `127.0.0.1:<port>`.
4. Go-бэк делает `pg_isready` опрос → когда отвечает, открывает GORM-коннект.
5. Прокатываются миграции (goose).

**Последующие запуски:**
1. Postgres-бинарь уже есть, data dir есть.
2. Стартует postgres → ~1 сек.
3. Прокатываются новые миграции (если есть).
4. Сервер слушает.

**Завершение:**
- Electron посылает SIGTERM Go-бэку.
- Go: `Supervisor.Stop()` → `pg_ctl stop -m fast` → дожидаемся остановки → выходим.

**Восстановление после краша:**
- Если Postgres не стартует (lock-файл от прошлой сессии) — Supervisor удаляет stale lock и повторяет.
- WAL recovery встроен в Postgres, при следующем старте автоматом.

## Запросный путь (пример: «закрыть заказ»)

```
POST /api/v1/orders/{id}/close
Idempotency-Key: 5f3a...
Authorization: Bearer <session_token>

[chi router]
  → middleware.Recover
  → middleware.RequestLogger (zerolog)
  → middleware.Tenant (читает session, кладёт tenant_id в ctx)
  → middleware.Idempotency (проверяет ключ → возвращает кэш если был)
  → middleware.Auth (проверяет роль cashier)
  → handlers.Orders.Close
      ↓
  service.OrderService.Close(ctx, orderID)
      ↓
  db.Transaction(func(tx) {
      order = repo.Orders.GetByIDForUpdate(tx, ctx, orderID)  // SELECT ... FOR UPDATE
      order.Status = "closed"
      repo.Orders.Update(tx, ctx, order)

      service.Finance.CreateRevenueEntry(tx, ctx, order)
      service.Stock.DeductForOrder(tx, ctx, order)
      service.Print.EnqueueReceipt(tx, ctx, order)  // job, не блокирует
  })
      ↓
  audit.Log(ctx, "order.close", orderID)            // в той же tx через hook
      ↓
  sse.Broadcast("order.updated", {id, status})      // после commit
      ↓
  return JSON { ...order, items: [...] }
```

## Realtime (SSE)

- `GET /api/v1/events?topics=orders,tables,prints,kitchen` — Server-Sent Events.
- После commit'а транзакции сервис шлёт в SSE-hub event с `{type, entity, id, ts}`.
- Postgres LISTEN/NOTIFY **не используем в MVP** — все события идут через in-memory hub в Go (один процесс, один источник). Это проще и быстрее. LISTEN/NOTIFY понадобится только если будет multi-instance (не в v4).
- Фронт подписан, обновляет local state (React Query invalidation).

## Sidecar протокол (Electron → Go → Postgres)

Три уровня процессов:

```
Electron (PID 1000)
└── restos-server (PID 1001)        ← Go, спавнится Electron'ом
    └── postgres (PID 1002, 1003, ...) ← спавнится Go-бэком
```

Запуск:
1. Electron `app.whenReady()` → `spawn('restos-server', [...args])`.
2. Electron ждёт `GET /api/v1/health` → 200.
3. Внутри: `restos-server` стартует embedded-postgres, ждёт `pg_isready`, прокатывает миграции, открывает HTTP.
4. Electron открывает `BrowserWindow.loadURL('http://localhost:3001/app/')` (или раздаётся из dist/).

Shutdown:
1. Electron `before-quit` → `serverProcess.kill('SIGTERM')`.
2. Go ловит SIGTERM → `httpServer.Shutdown(ctx)` (с таймаутом 10 сек) → `pgSupervisor.Stop()` (с таймаутом 10 сек) → `os.Exit(0)`.
3. Если Go не вышел за 15 сек — Electron шлёт SIGKILL (Postgres крашится, WAL recovery при следующем старте).

## Multi-tenancy

- `restaurants` — таблица тенантов.
- Каждая операционная таблица содержит `restaurant_id` (FK, NOT NULL).
- В Go: `context.Context` несёт `TenantID` (положен middleware из session).
- Репозитории: `repo.Orders.List(ctx)` → внутри `tx.Where("restaurant_id = ?", tenant.From(ctx))`.
- **Прямой `db.Find(&orders)` без `ForTenant` запрещён** — линтер на base AST'е (или goimports-rule).

## Deploy-варианты

| Вариант | Когда | Как |
|---|---|---|
| **Sidecar в Electron** | Текущий план v4 | Go-бинарь рядом с Electron, спавн при старте |
| Standalone бинарь | Отладка, dev | `./restos-server --port=3001 --data-dir=./data` |
| **Sidecar в Tauri** | Будущее (v5) | `tauri.conf.json:externalBin` — то же самое, но Tauri |
| External Postgres | Опц.: подключиться к существующему Postgres | `--external-pg-dsn=postgres://...` отключает embedded |

## Что меняется на стороне Electron

Файл `desktop/main.js` (365 строк) **остаётся**, но:
- Удаляются `require('./db')`, `require('./api-server')`, `require('./sync')`.
- Добавляются ~30 строк spawn + healthcheck Go-сервера.
- `desktop/api-server.js`, `desktop/db.js`, `desktop/sync.js`, `desktop/standalone.js` — **в архив**, на удаление после Phase 4.

См. [09-DEPLOY.md](09-DEPLOY.md) подробнее.
