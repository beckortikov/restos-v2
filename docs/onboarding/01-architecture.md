# 01 — Архитектура и потоки данных

Онбординг-уровень: общая картина системы. Детали по слоям — в [02](02-backend-architecture.md)–[05](05-waiter-android.md).

## 1. Рантайм-топология

На машине кассира одновременно живут три процесса:

```
┌──────────────────────────────────────────────────────────────────┐
│  Машина кассира (Windows/macOS)                                    │
│                                                                    │
│   ┌────────────┐   spawn child    ┌──────────────────────────┐     │
│   │  Electron  │ ───────────────▶ │  restos-server (Go)      │     │
│   │  (main.js) │                  │  слушает 0.0.0.0:3002    │     │
│   │            │  грузит SPA из   │                          │     │
│   │ Browser-   │  frontend/ (file)│  spawn child ──▶ Postgres│     │
│   │ Window     │ ◀──http :3002──▶ │  16 (loopback :54330)    │     │
│   └────────────┘   REST + SSE     │  + отдаёт ту же SPA по   │     │
│                                   │    HTTP (embed FS)       │     │
│                                   └──────────────────────────┘     │
└───────────────────────────────────────────┬──────────────────────┘
                                             │ LAN (Wi-Fi)
                  ┌──────────────────────────┼───────────────────────┐
                  ▼                          ▼                        ▼
        Планшет официанта           Браузер в LAN            Любое устройство
        (Kotlin APK)                http://<ip>:3002         для диагностики
        http/SSE → <ip>:3002
```

Ключевые факты (проверено по коду):

- **Go-бинарь спавнит Postgres сам** через `embedded-postgres` (`server/internal/pgsupervisor/supervisor.go`). Внешних БД нет (кроме dev-флага `--external-pg-dsn`).
- **HTTP-порт `3002`** — `server/internal/config/config.go:72` (`0.0.0.0:3002`). Был 3001, сдвинули из-за конфликта со старой v1.
- **Embedded Postgres — `127.0.0.1:54330`** (только loopback), пользователь/пароль `restos` (не критично, т.к. loopback).
- **Electron** ходит на `http://127.0.0.1:3002`; **официант и браузеры** — на `http://<ip-кассы>:3002` (тот же бэк, привязан к `0.0.0.0`). См. `desktop/main.js:28` (`API_PORT = 3002`).
- **Один и тот же React-бандл** грузится двумя способами: Electron — из файла (`desktop/frontend/`), LAN-клиенты — по HTTP с того же Go (`//go:embed all:spa`, `server/internal/transport/http/spa.go`).

## 2. Монорепо: где что лежит

```
restos-v4/
├── src/, app/, components/, lib/, hooks/, styles/, public/  — React-фронт (касса)
├── server/            — Go-бэк (chi + GORM + embedded Postgres)
├── desktop/           — Electron-обёртка (spawn Go-сайдкара) + main.js/preload.js
├── android-kotlin/    — нативный Kotlin/Compose апп официанта
├── tests/             — Playwright e2e
├── docs/prd/          — продуктовые спеки (схема БД, контракт API)
├── docs/decisions/    — ADR (почему Go, почему REST)
└── docs/onboarding/   — этот набор
```

| Папка | Слой | Подробно |
|---|---|---|
| `app/` | экраны React по доменам (orders, kitchen, finance, operations/pos, …) | [04](04-frontend.md) |
| `components/` | переиспользуемые UI-компоненты (Radix + Tailwind) | [04](04-frontend.md) |
| `lib/` | клиент-логика: `api/` (типизированный клиент), `queries/`, `helpers.ts`, `decimal.ts`, `types.ts` | [04](04-frontend.md) |
| `server/cmd/restos-server/` | точка входа бэка (`main.go`) | [02](02-backend-architecture.md) |
| `server/internal/transport/http/` | chi-роутер, middleware, handlers, SPA | [02](02-backend-architecture.md) |
| `server/internal/service/` | вся бизнес-логика (заказы, склад, финансы, печать) | [03](03-backend-domain.md) |
| `server/internal/db/` | conn-пул, миграции (goose+embed), GORM-модели | [02](02-backend-architecture.md) |
| `server/internal/repo/` | репозитории, `ForTenant`, `Transaction` | [02](02-backend-architecture.md) |
| `server/internal/escpos/` | ESC/POS + CP866 + golden-тесты | [03](03-backend-domain.md) |
| `android-kotlin/app/src/main/java/com/restos/waiter/` | UI/data/net/di официанта | [05](05-waiter-android.md) |

## 3. Слои бэкенда (поток одного запроса)

```
HTTP-запрос
  │
  ▼
chi router  (server/internal/transport/http/router.go)
  │  middleware-цепочка: RealIP → RequestID → Recoverer → CORS → Maintenance
  │  → Timeout → Auth → License(write) → Idempotency(write)
  ▼
handler  (internal/transport/http/handlers/) — тонкий: парсит → зовёт сервис → respond
  │
  ▼
service  (internal/service/) — бизнес-логика, открывает транзакцию
  │  repo.Transaction(ctx, func(tx){ ... })
  ▼
repo  (internal/repo/) — ForTenant(ctx) добавляет WHERE restaurant_id = ?
  │
  ▼
GORM → Postgres        + audit-хук (After Create/Update/Delete) → audit_log (async)
  │
  ▼
после commit: service публикует доменные события в SSE-хаб
```

Подробный разбор middleware, репозиториев и конвенций — в [02-backend-architecture.md](02-backend-architecture.md).

## 4. Realtime (SSE)

- Клиенты подписываются на `GET /api/v1/events` (токен в `Authorization` или `?token=` — EventSource не умеет заголовки).
- В процессе один in-memory **hub** (`server/internal/transport/sse/hub.go`), события фильтруются по `restaurant_id`. Медленные подписчики — события **дропаются** (hub не блокируется).
- Сервисы копят события в `EventBuffer` внутри транзакции и публикуют **после commit** (если транзакция откатилась — события не уходят).
- Основные типы: `order.created/updated/closed/cancelled`, `order.item.added/voided`, `table.updated`, `stock.movement`, `shift.opened/closed`, `license.*`.
- **Фронт** (касса и официант) по этим событиям точечно инвалидирует/перезагружает кэш (react-query на кассе, EventBus → ViewModels у официанта). См. [04](04-frontend.md) и [05](05-waiter-android.md).

## 5. Поток «жизнь заказа» (сверхкратко)

```
Официант/кассир создаёт заказ (стол занят)
   → POST /orders            → order(status=open) + items + runner-печать на кухню
Дозаказ
   → POST /orders/{id}/items → iiko-merge с непечатанными строками + delta-печать
Закрытие/оплата
   → POST /orders/{id}/close → выручка (financial_operation) + списание склада
                               (stock_movements по тех-картам) + чек в print_jobs
                               + апдейт смены + освобождение стола
```

Полный конечный автомат, инварианты, деньги и склад — в [03-backend-domain.md](03-backend-domain.md).

## 6. Принципы, которые формируют код

- **Локальность.** Нет облака, нет сети наружу. Всё в одном процессе + один Postgres.
- **Мультиарендность в коде.** Один Postgres обслуживает один ресторан, но `restaurant_id`-фильтр обязателен везде (защита и инвариант на будущее).
- **Транзакционность + события.** Мутация и её доменные события атомарны: события публикуются только после успешного commit.
- **Append-only там, где важна история.** Склад — через `stock_movements`; финансы — через `financial_operations`; аудит — `audit_log`. Денормализованные поля (`ingredients.qty`, `account.balance`, `orders.total`) пересчитываются/обновляются отдельно.
- **Тонкий транспорт, толстый сервис.** Handlers только парсят и отвечают; вся логика — в `internal/service`.
