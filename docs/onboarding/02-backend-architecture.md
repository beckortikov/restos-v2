# 02 — Бэкенд: архитектура и конвенции

Референс по Go-бэку (`server/`). Доменная логика (заказы/склад/финансы/печать) — отдельно
в [03-backend-domain.md](03-backend-domain.md).

Стек: Go 1.25+, chi v5, GORM v2 (pgx), PostgreSQL 16 через `embedded-postgres`,
миграции goose (embed.FS), zerolog, `shopspring/decimal`.

---

## 1. Bootstrap процесса

**`server/cmd/restos-server/main.go`** — последовательность старта:

1. **Конфиг** — `config.LoadFromFlags()` (`internal/config/config.go`). Приоритет: CLI-флаги
   > env > дефолты. Ключевое: `--http-addr` (env `RESTOS_HTTP_ADDR`, дефолт **`0.0.0.0:3002`**,
   `config.go:72`), `--external-pg-dsn`, `--license-public-key`, `--log-level`, `--desktop-dir`.
2. **Логгер** — zerolog (`setupLogger`). JSON при `RESTOS_LOG_JSON=1`, иначе pretty-console; дефолт `info`.
3. **Embedded Postgres** — если `ExternalPGDSN` пуст, поднимается child-процесс через
   `internal/pgsupervisor/supervisor.go` (`New()` → `Start()`). Postgres 16 на loopback
   **`:54330`**. Пароль берётся из keychain (с фолбэком на env/flags); при ошибке
   «password mismatch» — авто-вайп `pgdata/` и переинициализация (`supervisor.go:87+`).
4. **GORM + миграции** — `db.Open(cfg.ActiveDSN())` + `db.MigrateUp(ctx, gdb)` (goose, идемпотентно).
5. **Audit worker** — `audit.StartWorker(gdb)` запускается **до** первой мутации (см. §6).
6. **Фоновые сервисы** — SSE-hub (`sse.NewHub(30s)`), license-watcher (60s), NTP-checker (6 ч),
   print-queue worker, orders-cleanup watchdog (5 мин — чистит зомби-заказы и освобождает столы).
7. **HTTP-сервер** — слушает `cfg.HTTPAddr`, handler из `httpx.NewRouter()`, read-header-timeout 10 с.
8. **Graceful shutdown** — по `SIGINT/SIGTERM`: HTTP 10 с на доигрывание, audit-worker 5 с на flush,
   embedded-postgres останавливается через defer.

**Итог:** бэк слушает `0.0.0.0:3002` (LAN + localhost) или `127.0.0.1:3002` (если ограничить флагом).

---

## 2. HTTP-слой: роутер и middleware

**`server/internal/transport/http/router.go`** — chi v5.

Базовый стек (применяется ко всему): `RealIP` → `RequestID` → `Recoverer` → `CORS`.

**Цепочка middleware** (`internal/transport/http/middleware/`):

| Порядок | Middleware | Файл | Что делает |
|---|---|---|---|
| 1 | **CORS** | `cors.go` | dev-origins (`localhost:5173/3000` + `127.0.0.1`), Electron (`null`/`file://`) всегда; настраивается `RESTOS_CORS_ALLOWED_ORIGINS`. Разрешённые заголовки: `Authorization`, `Content-Type`, `Idempotency-Key`, `X-Requested-With` |
| 2 | **Maintenance guard** | `maintenance.go` | во время `pg_restore --clean` отдаёт 503 на всё, кроме `/backup/*` и `/events` |
| 3 | **Timeout** | (per-group) | public 10 с, protected 30 с, import/backup 5 мин, `/events` — без таймаута |
| 4 | **Auth** | `auth.go` | валидирует Bearer-токен (или `?token=` для SSE), кладёт в контекст `tenant.WithRestaurant` + `audit.WithActor` |
| 5 | **License** | `license.go` | только на write-эндпоинты: если ресторан залочен (просрочка/`is_blocked`) → 403 `LICENSE_LOCKED`; read и `/license/*` доступны |
| 6 | **Idempotency** | `idempotency.go` | только на write: кэширует ответ по `Idempotency-Key` + хэшу запроса (см. §7) |

**Группы маршрутов** (`router.go`):

- **Public** (без auth): `GET /healthz`, `GET /readyz`, `POST /api/v1/auth/login`,
  `GET /api/v1/bootstrap/status`, `POST /api/v1/bootstrap`, `GET /api/v1/public/machine-info`,
  `POST /api/v1/users/validate-pin`.
- **Protected read** (auth): меню, зоны/столы, склад, смены, заказы, отчёты (XLSX), license,
  finance, analytics, audit-log.
- **Import/Backup** (auth + license + 5 мин): импорт меню/ингредиентов, `backup/create|restore`.
- **Write** (auth + license + idempotency + 30 с): создание/закрытие/отмена/возврат/void/split
  заказов; смены; склад; меню; CRUD админки; finance; столы/зоны.
- **SSE** (auth, без таймаута): `GET /api/v1/events`.

**SPA и статика** — `spa.go`: React-бандл встроен через `//go:embed all:spa`; все не-API пути
фолбэчат на `index.html` (BrowserRouter-friendly), с защитой от перекрытия `/api/*`, `/docs/*`,
`/healthz`, `/readyz`. `index.html` отдаётся с `no-cache`. Подробнее про сборку SPA — [06](06-build-run-dev.md).

**Swagger UI** — `http://localhost:3002/docs` (см. `CLAUDE.md`).

---

## 3. SSE (realtime)

**`server/internal/transport/sse/hub.go`** — in-memory hub, один на процесс.

- `Event{ RestaurantID, Type, Data []byte }`. Подписчик — буферизованный канал (cap 64).
- Подписка: `GET /api/v1/events` → auth извлекает `restaurantID` → `hub.ServeHTTP(w, r, restaurantID)`:
  регистрирует подписчика, шлёт hello, дальше в select-цикле пишет события (`event: <T>\ndata: <json>\n\n`)
  и heartbeat `: ping` каждые 30 с; по отмене контекста — дерегистрация.
- Публикация: `pub.Publish(Event{...})` итерирует подписчиков, фильтрует по `restaurantID`;
  **медленные подписчики дропаются** (hub не блокируется), есть atomic-метрики.
- Типы событий — `internal/service/events.go`: `order.created/updated/closed/cancelled`,
  `order.item.added/voided`, `table.updated`, `stock.movement`, `shift.opened/closed`, `license.*`.
- **EventBuffer-паттерн:** сервис копит события в `EventBuffer` в транзакции, после commit
  `pub.Flush(ctx, restaurantID, buf)`. Откат транзакции → события не публикуются (атомарность).

---

## 4. Персистентность: пул, миграции, модели

**`server/internal/db/conn.go`:**

- Пул: `SetMaxOpenConns(50)`, `SetMaxIdleConns(10)`, `SetConnMaxLifetime(1h)`. 50 — запас под
  пиковые батч-создания заказов (десяток официантов × несколько мутаций) + фоновые воркеры.
- GORM: логгер на WARNING, `NowFunc` в UTC.
- Регистрация хуков: `audit.Register(gdb)` (audit-хуки) + `audit.RegisterStockDenorm(gdb)`
  (денормализация склада).

**Миграции** — `internal/db/migrations/*.sql`, goose v3, встроены через `embed.FS`,
применяются `goose.UpContext(...)` (идемпотентно, версии трекаются). `001_init.sql` — ядро схемы.

**Модели** — `internal/db/models/`: `core.go` (Restaurant, User, Session, Zone, Table, Shift,
MenuItem, MenuCategory), `orders.go` (Order, OrderItem, OrderItemModifier, OrderSplit, OrderVoid),
`stock.go` (Ingredient, StockMovement, TechCardLine, SemiFinishedType, SemiRecipeLine, …),
`menu.go`, `finance.go` (FinancialAccount, FinancialOperation, CashShift), `printer.go`
(Printer, PrintJob). Общие поля: UUID-PK, `restaurant_id` (кроме shared-таблиц),
`created_at`/`updated_at` (UTC), денежные поля — `decimal.Decimal` / NUMERIC(14,4).

---

## 5. Репозитории и `tenant_id` (закон №1)

**`server/internal/repo/base.go`.** Контракт: **каждый** запрос/мутация — через `ForTenant(ctx)`.
Прямой `r.db.Find(...)` без скоупа — баг (есть линт-тест `internal/repo/lint_test.go`).

- `ForTenant(ctx)` — извлекает `restaurant_id` из контекста (его кладёт auth-middleware), возвращает
  **свежую** GORM-сессию `db.Session(&gorm.Session{NewDB:true}).Where("restaurant_id = ?", rid)`
  (новая сессия — чтобы избежать багов кэширования statements в цепочках). Ошибка, если tenant нет.
- `ForTenantQualified(ctx, alias)` — то же, но `<alias>.restaurant_id` (для аналитических запросов с join'ами).
- `Raw()` — unscoped-доступ, **только** для: auth (логин до знания `restaurant_id`), shared-таблиц
  (`idempotency_keys`), миграций. Любое иное использование — повод для код-ревью.
- `Transaction(ctx, fn)` — оборачивает бизнес-функцию в GORM-транзакцию; внутри использовать
  `WithTx(tx)`. Audit-хуки и доменная логика делят одну транзакцию.

> ⚠️ `order_items` **не имеет** колонки `restaurant_id` — для проверки tenant там делается join
> на `orders` (см. `internal/service/orders.go`, чтения деталей заказа).

---

## 6. Audit-лог (хуки + async worker)

**`server/internal/audit/`:**

- **`hooks.go`** — `Register(db)` (вызывается в `main.go`) вешает callbacks на
  After Create/Update/Delete. Хук срабатывает **после** успешной мутации; пропускает: ошибочную
  транзакцию, skiplist-таблицы (`audit_log` — анти-цикл, `idempotency_keys`, `print_jobs`),
  dry-run, raw SQL. Извлекает актора из контекста (`audit.ActorFromContext`), формирует запись
  (action, entity_type, entity_id, entity_name, restaurant_id, user_id/name, details JSON).
- **`worker.go`** (v3.6.0+) — async: буфер на 10 000 записей, батч по 100, flush раз в 1 с.
  `StartWorker(db)` до первой мутации, `StopWorker(timeout)` — flush на shutdown. Плюсы: −~10 мс
  на мутацию, ×10 меньше нагрузки на Postgres. Минус: до 100 записей теряется при краше сервера.
- **`context.go`** — `Actor{UserID, UserName, Role}`, `WithActor`/`ActorFromContext`. Кладёт
  auth-middleware после валидации токена.

> Правило: **никакого ручного `audit_log.Insert()`** в сервисах — только централизованный хук.

---

## 7. Идемпотентность

**Сервис** `internal/service/idempotency.go` + **middleware** `.../middleware/idempotency.go`.

Поток (write-запросы):
1. Требуется заголовок `Idempotency-Key` (UUID v4); нет — 400.
2. Тело запроса читается в буфер; считается хэш `SHA256(method + path + body)`.
3. Lookup по ключу (`WHERE key=? AND expires_at>?`):
   - найден + хэш совпал → отдаём кэшированный ответ (`X-Idempotent-Replay: true`);
   - найден + хэш отличается → 409 (ключ переиспользован под другой запрос);
   - не найден → выполняем handler, **буферизуем** весь ответ, сохраняем в кэш (только 2xx), и
     **только потом** отдаём клиенту.
4. TTL — 24 ч.

> Инвариант: клиент получает ответ **только после** записи кэша — иначе ретрай мог бы прийти раньше
> вставки строки.

Кроме middleware, в домене есть **идемпотентность по `source_ref`**: при закрытии заказа выручка и
списание склада пишутся один раз на заказ (`source_ref="order:<id>"`). Подробнее — [03](03-backend-domain.md).

---

## 8. Деньги: `decimal`

**`server/internal/pkg/decimal/decimal.go`** — обёртка над `shopspring/decimal`, scale = 4 (под NUMERIC(14,4)).

- Парсинг: `FromString` (из строк клиента — float не используем!), `FromInt`, `MustFromString` (только константы).
- `Normalize(d)` — half-even округление до scale 4 (вызывать перед записью в БД).
- `Add/Sub/Mul` — точные; `DivRound(a,b)` — half-even, при делении на ноль → `Zero`;
  `DivRoundOr(a,b,fallback)` — при делении на ноль возвращает fallback; `Percent(total, pct)`.
- Сравнения: `IsPositive/IsZero/IsNegative`, `Cmp`, `Equal`.

> Никаких `float64`. Клиент шлёт деньги/qty строками, бэк парсит в `decimal`.

---

## 9. Ошибки и формат ответа

**`internal/pkg/errors/errors.go`** — `AppError{Code, Message, Cause}`, конструктор `Wrap(code, msg, cause)`.

**`internal/transport/http/respond/respond.go`** маппит `AppError.Code` → HTTP-статус:
`NOT_FOUND`→404, `FORBIDDEN`→403, `UNAUTHORIZED`→401, `CONFLICT`→409,
`VALIDATION`/`BAD_REQUEST`→400, `PRECONDITION(_FAILED)`→412, доменные
(`INSUFFICIENT_STOCK`, `ITEM_STOPPED`, `DISCOUNT_REQUIRES_APPROVAL`) → свои 4xx, остальное → 500.

Тело ошибки (ErrorEnvelope):
```json
{ "code": "NOT_FOUND", "message": "restaurant not found", "details": { } }
```
Утилиты: `respond.JSON(w, status, v)` (стрим-энкодер), `respond.Error(w, err)`, шорткаты
`BadRequest/Unauthorized/NotFound`.

---

## 10. Аутентификация и права

### Auth (PIN → session-токен)

**`internal/service/auth.go`** + middleware `auth.go`.

- Логин: `POST /api/v1/auth/login` с `{restaurant_id, pin}`. Сервис ищет пользователей ресторана,
  сверяет PIN **constant-time**; при коллизии PIN — `UNAUTHORIZED` (не раскрываем).
- Токен — **непрозрачная случайная строка**: `crypto/rand` 32 байта → `hex.EncodeToString`
  (`auth.go:187-190`). **Это не JWT.** Хранится в таблице `sessions`, валидируется запросом
  `WHERE token=? AND expires_at>?` (`auth.go:133`) + in-memory кэш (`sync.Map`).
- `SessionTTL` — 12 ч (смена + запас). `last_seen_at` обновляется не чаще раза в 30 с.
- Middleware кладёт в контекст `tenant.WithRestaurant(rid)` и `audit.WithActor({UserID,UserName,Role})`.
  Для SSE токен можно передать в `?token=` (EventSource не умеет заголовки).

### Права (RBAC)

**`internal/pkg/perms/perms.go`** — роли: owner, manager, cashier, waiter, cook, storekeeper, accountant.

- Дефолты по ролям (примеры): waiter — `orders.create`, `tables.reserve`, `menu.view`;
  cashier — `orders.create/close/void/refund/reprint`, `shifts.manage`, `pos.access`;
  manager/owner — все права.
- Кастомные права хранятся JSON-ом в `users.permissions_json` (`{"actions":{"orders.void":true,...}}`)
  и **переопределяют** дефолты роли (all-or-nothing).
- `Allow(role, permsJSON, action) bool` — проверка (owner/manager → всегда true; есть кастом →
  только кастом; иначе дефолты роли). `Effective(...)` — карта прав для клиента (прятать кнопки в UI).
- **Энфорс — на уровне сервиса** (handlers зовут `requirePerm`/`perms.Allow`), не в middleware.

### License

**`middleware/license.go`** — только write-эндпоинты. Состояния: active / grace (просрочка в
пределах grace-дней, запись разрешена с предупреждением) / locked (403 `LICENSE_LOCKED`; read и
`/license/*` доступны — владелец может управлять лицензией даже в lock).

---

## 11. Сервисы и handlers (паттерн)

**Сервис** (`internal/service/orders.go` и др.):
```go
type OrdersService struct { r *repo.Repo; pub *EventPublisher; stations StationResolver }
func NewOrdersService(r *repo.Repo) *OrdersService { return &OrdersService{r: r} }
func (s *OrdersService) WithPublisher(p *EventPublisher) *OrdersService { s.pub = p; return s } // builder
```
Транзакция + события:
```go
err := s.r.Transaction(ctx, func(r *repo.Repo) error {
    scoped, err := r.ForTenant(ctx); if err != nil { return err }
    // ... мутации ...
    buf.Add(EventOrderCreated, order)   // копим события
    return nil
})
if err == nil { s.publish(ctx, restaurantID, buf) }  // публикуем после commit
```

**Handler** (`internal/transport/http/handlers/`) — тонкий: распарсить query/body → вызвать
сервис → `respond.JSON` / `respond.Error`. Никакого доступа к БД из handler'а.

---

## Шпаргалка «куда смотреть»

| Тема | Файл |
|---|---|
| Старт процесса, порт, shutdown | `cmd/restos-server/main.go`, `internal/config/config.go` |
| Embedded Postgres | `internal/pgsupervisor/supervisor.go` |
| Роуты и middleware | `internal/transport/http/router.go`, `.../middleware/*` |
| SSE-hub | `internal/transport/sse/hub.go`, `internal/service/events.go` |
| Пул/миграции/модели | `internal/db/conn.go`, `internal/db/migrations/`, `internal/db/models/` |
| tenant/транзакции | `internal/repo/base.go` |
| Audit | `internal/audit/{hooks,worker,context}.go` |
| Идемпотентность | `internal/service/idempotency.go`, `.../middleware/idempotency.go` |
| Деньги | `internal/pkg/decimal/decimal.go` |
| Ошибки | `internal/pkg/errors/errors.go`, `.../respond/respond.go` |
| Auth/права | `internal/service/auth.go`, `internal/pkg/perms/perms.go`, `.../middleware/{auth,license}.go` |
