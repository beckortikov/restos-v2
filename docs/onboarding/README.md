# RestOS v4 — Onboarding для инженеров

Эта папка — точка входа для стажёров и новых инженеров. Цель: за день понять, **как
устроена кодовая база**, где что лежит, как запустить и куда смотреть при доработке.

Документы написаны **строго по коду** (со ссылками `file:line`). Если код разошёлся с
текстом — побеждает код; присылайте правку в этот файл.

> Источник правды по правилам разработки — корневой [`CLAUDE.md`](../../CLAUDE.md).
> Продуктовые спеки и схема БД — [`docs/prd/`](../prd/00-INDEX.md). Архитектурные
> решения (почему Go, почему REST) — [`docs/decisions/`](../decisions/).
> Эта папка их **дополняет** (как устроен код), а не дублирует.

## Что это за продукт

**RestOS v4** — POS-система для ресторанов (касса, кухня, склад, финансы), работающая
**локально** на машине кассира. Архитектура sidecar:

```
Electron (UI кассира)  ──http──▶  Go-бэк (restos-server)  ──▶  embedded PostgreSQL 16
        ▲                              │  (слушает 0.0.0.0:3002)        (child-процесс)
        │ грузит React SPA             │
        │                             отдаёт ту же React SPA по LAN
Планшет официанта (Kotlin APK) ──http/SSE по LAN──▶  http://<ip-кассы>:3002
Браузер в LAN ────────────────────────────────────▶  http://<ip-кассы>:3002
```

- **Облака нет.** Всё локально (см. ADR-001/002). Возврат к cloud — отдельная фаза.
- **Один Postgres-процесс** на машину кассира, его спавнит сам Go-бинарь.
- **Порт бэка — `3002`** (не 3001 — тот занят старой v1; см. `server/internal/config/config.go:72`).

## Карта документации

| Файл | Уровень | О чём |
|---|---|---|
| [01-architecture.md](01-architecture.md) | онбординг | Общая архитектура, рантайм-топология, потоки данных, порты |
| [02-backend-architecture.md](02-backend-architecture.md) | референс | Go-бэк: bootstrap, chi+middleware, SSE, репозитории/tenant/транзакции, audit, идемпотентность, decimal, ошибки, права/auth |
| [03-backend-domain.md](03-backend-domain.md) | референс | Доменная логика: жизненный цикл заказа, деньги/весовые, склад через `stock_movements`, финансы/смены, печать ESC/POS |
| [04-frontend.md](04-frontend.md) | референс | React-фронт: роутинг, типизированный API-клиент, react-query + SSE-синк, доменные хелперы, ключевые экраны, perf |
| [05-waiter-android.md](05-waiter-android.md) | референс | Нативный Kotlin/Compose-апп официанта: Hilt, Retrofit + HostRedirect, онбординг по хосту, SSE, экраны |
| [06-build-run-dev.md](06-build-run-dev.md) | онбординг | Как собрать и запустить всё (бэк, фронт, Electron, APK), Makefile/скрипты, тесты |
| [07-glossary.md](07-glossary.md) | референс | Доменный глоссарий: заказ, смена, void/split/refund, тех-карты, batch-cooking, весовые позиции |

Рекомендуемый порядок для первого дня: **01 → 06 → (твоя область) 02/03/04/05 → 07**.

## Быстрый старт (TL;DR)

```bash
# 1. Бэкенд (внутри server/) — поднимает embedded Postgres сам
cd server && make run                 # http://localhost:3002, Swagger UI: /docs

# 2. Фронт в dev-режиме (из корня репо) — Vite на :5173, API форсится на :3002
pnpm dev

# 3. Полное приложение кассира (Electron спавнит Go-бинарь)
cd desktop && npm start

# 4. APK официанта
pnpm waiter:apk                       # release → android-kotlin/app/build/outputs/apk/release/
```

Подробности, переменные окружения и кросс-сборка — в [06-build-run-dev.md](06-build-run-dev.md).

## Стек (зафиксирован)

| Слой | Технологии |
|---|---|
| **Бэкенд** | Go 1.25+, chi v5, GORM v2, pgx, PostgreSQL 16 (`fergusstrange/embedded-postgres`), goose-миграции, zerolog, `shopspring/decimal` |
| **Фронт** | React 19 + Vite, React Router 7, `@tanstack/react-query`, zustand, Radix + Tailwind v4, `openapi-fetch` (типизированный клиент), `decimal.js` |
| **Десктоп** | Electron (обёртка, спавнит Go-сайдкар), electron-builder |
| **Официант** | Нативный Kotlin 2.1 + Jetpack Compose, Hilt, Retrofit/OkHttp (+SSE), kotlinx.serialization, CameraX + ML Kit (QR), DataStore |
| **Realtime** | SSE (`GET /api/v1/events`), in-memory hub в одном процессе |
| **Печать** | ESC/POS + CP866, очередь `print_jobs`, fire-and-forget worker |

## Десять правил, которые ломают всё, если их не знать

(полностью — в [`CLAUDE.md`](../../CLAUDE.md), детали — в [02](02-backend-architecture.md)/[03](03-backend-domain.md))

1. **`tenant_id`-фильтр обязателен** — каждый запрос через `repo.ForTenant(ctx)`.
2. **Все мутации — в транзакции** (`repo.Transaction`), audit-хуки в той же транзакции.
3. **Идемпотентность** — все write-эндпоинты принимают `Idempotency-Key` (UUID), кэш 24 ч.
4. **Деньги — только `decimal.Decimal`** (NUMERIC(14,4)), никакого float.
5. **`ingredients.qty` — только через event-stream `stock_movements`**, не прямым UPDATE.
6. **Audit на каждой мутации** — централизованный GORM-хук (async worker).
7. **Печать — fire-and-forget** — в транзакции только ставим job в `print_jobs`.
8. **Весовые блюда** считаются через `effectivePortions` (`qty/unitSize`), а не `price*qty` (см. [03](03-backend-domain.md)).
9. **OpenAPI — источник правды** — правим `server/api/openapi.yaml`, затем `make api-gen` / `make ts-client`.
10. **Порт `3002`**, бэк слушает `0.0.0.0:3002` (LAN + localhost).
