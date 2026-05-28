# 01 — Overview

## Контекст

Текущий проект `restos/` (v1, в проде) имеет архитектуру:

- **Frontend**: React + Vite + Capacitor (для официантов APK) + Electron (для кассира десктоп).
- **Backend**: внутри Electron, sidecar на Node.js: `desktop/api-server.js` (Express, 1526 строк) + `desktop/db.js` (PGlite, Postgres в WASM, 976 строк) + `desktop/sync.js` (репликация в Supabase, 646 строк).
- **Cloud**: Supabase используется в v1 как read-only зеркало для Owner Dashboard. **В v4 от Supabase отказываемся** — всё локально.

Node-бэк работает, но имеет проблемы:
- PGlite — медленная WASM-БД, в больших таблицах подтормаживает.
- Node + Electron — толстый инсталлятор (~300 МБ), высокое потребление RAM (~400 МБ).
- Express + ручной PostgREST-эмулятор — много кода, который сложно поддерживать (1500+ строк роутинга).
- Бизнес-логика дублируется между фронтом (`lib/supabase-queries.ts`, 5702 строки) и бэкэндом — нет единой точки правды.

## Цель v4

**Заменить весь backend** (Node + PGlite + Express + Supabase sync) на **Go (chi + GORM + PostgreSQL)**, оставаясь в той же модели «sidecar внутри Electron» (порт `127.0.0.1:3001`).

После завершения v4:
- инсталлятор Electron меньше на ~100 МБ (нет Node, нет PGlite; +80 МБ embedded-postgres);
- запуск кассира за <2 сек (Postgres стартует ~1–2 сек первый раз);
- RAM: Go-бэк ~80 МБ + Postgres ~50 МБ = ~130 МБ против 400 МБ у Node+PGlite;
- бизнес-логика **переезжает с фронта на бэк** (`lib/supabase-queries.ts` сжимается в 10 раз — фронт зовёт `POST /api/v1/orders/{id}/close`, а не пишет SQL);
- multi-tenant `tenant_id` фильтрация проверяется компилятором Go;
- настоящий Postgres вместо WASM-эмуляции → корректные индексы, FK, транзакции, типы;
- никакой облачной зависимости (Supabase убран);
- готовность к будущему embedding в Tauri вместо Electron.

## Out of scope (v4 НЕ делает)

1. Не переписывает React-UI. Дизайн `../restos/design/pos_cashier.pen` (остался в v1-репо, в v4 не копировался) — референс для UI на фазе 2.
2. Не трогает Capacitor APK официанта (`android/`) — только меняет endpoint, на который APK ходит.
3. Не меняет схему БД (схема портируется из `desktop/db.js` 1:1, только PG-диалект → PostgreSQL-диалект).
4. Не пишет Owner Dashboard заново — это отдельный путь, и в v4 он недоступен (нет cloud-зеркала).
5. Не делает sync с облаком. Возврат к cloud — отдельная фаза в будущем.

## Scope (v4 делает)

1. **Go-сервер** `restos-server` — один бинарь, слушает на `127.0.0.1:3001`.
2. **PostgreSQL 16** через **embedded-postgres** — Go-бинарь сам скачивает дистрибутив Postgres при первом запуске (~80 МБ, кладётся в `userData/postgres/`), стартует его как child-процесс. Данные в `userData/postgres-data/`.
3. **REST API** `/api/v1/...` (см. [04-API-CONTRACT.md](04-API-CONTRACT.md)).
4. **SSE** `/api/v1/events` для realtime-обновлений на KDS/кассире.
5. **ESC/POS печать** — порт `lib/print-service.ts` на Go.
6. **Background jobs** — печать, очистка `audit_log`, бэкапы БД.
7. **Single binary build** для Win/Mac/Linux x64+arm64.
8. **Sidecar protocol** — Electron запускает Go-бинарь, Go-бинарь запускает Postgres, Go завершает Postgres при выходе.

## Non-functional requirements

| NFR | Цель | Как меряем |
|---|---|---|
| Latency `GET /api/v1/orders` (50 заказов) | p99 < 50 мс | benchmark на M1, тест с 50 записями |
| Latency `POST /api/v1/orders` (новый заказ) | p99 < 100 мс (включая transaction commit) | benchmark |
| Throughput | 1000 RPS на CRUD (10× запаса от пик 10 RPS в ресторане) | wrk |
| RAM в покое | <100 МБ | `ps` после 1 ч простоя |
| RAM под нагрузкой (20 клиентов, 1 ч) | <200 МБ | `ps` после нагрузочного теста |
| Cold start | <500 мс от запуска до `/health` 200 OK | таймер |
| DB size after 6 мес работы среднего ресторана | <500 МБ | оценка по числу заказов |
| Сборка бинаря | <30 сек на M1 | `time go build` |
| Бинарь Go размер | <30 МБ | `ls -la` |
| Postgres дистрибутив (embedded) | ~80 МБ (скачивается при первом запуске) | `du -sh postgres/` |
| Cold start (Postgres уже инициализирован) | <2 сек до `/health` 200 OK | таймер |
| Cold start (первый запуск, init data dir) | <15 сек | таймер |

## Технологический стек

| Компонент | Выбор | Альтернатива (почему нет) |
|---|---|---|
| Язык | **Go 1.23+** | Rust (дольше писать), Python (тяжелее), Node (то, что уходим от) |
| HTTP роутер | **chi v5** | gin (избыточен), echo (ок, но chi проще), net/http (мало) |
| ORM | **GORM v2** | sqlc (статичный, неудобен на эволюции схемы), ent (Facebook-overkill) |
| БД | **PostgreSQL 16** | SQLite (хочется честный Postgres, FK, типы, future cloud-compat), PGlite (то, что уходим от), DuckDB (не подходит) |
| Postgres deploy | **embedded-postgres** (`fergusstrange/embedded-postgres`) | Docker (нужен Docker Desktop), native install (хрупко) |
| Postgres driver | **pgx/v5** + `gorm.io/driver/postgres` | lib/pq (deprecated) |
| SSE | стандартный `net/http` + chi | gorilla (deprecated), centrifugo (overkill) |
| Печать | **escpos-rs** через CGO? Нет — **чистый Go** порт `lib/print-service.ts` | shell к lp/lpr (хрупко) |
| Логи | **zerolog** | logrus (медленнее), slog (стандарт, ок, тоже допустим) |
| Конфиг | **viper** + env | flag-only (мало) |
| Тесты | стандартный `go test` + `testify/require` | ginkgo (избыточен) |
| Миграции | **goose** | migrate (ок, но goose проще на embed) |

## Риски

| Риск | Митигация |
|---|---|
| GORM на Postgres даёт N+1 в незаметных местах | Логировать все SQL в dev, ставить `Preload()` сразу. CI-тест на «не больше N SQL для эндпоинта X». |
| embedded-postgres падает или не стартует на пользовательской машине | Healthcheck в `main.go` ждёт `pg_isready` до 10 сек, fallback на retry. Логи Postgres redirect в `userData/logs/postgres.log`. Для саппорта — команда `restos-server doctor`. |
| Антивирус Windows блокирует скачивание Postgres-дистрибутива | Дистрибутив можно опционально вшить в инсталлятор (флаг `--bundle-postgres` при сборке), тогда embedded-postgres использует локальный путь вместо download. |
| Порт 5432 занят (у пользователя свой Postgres) | Embedded стартует на случайном порту из диапазона 49152–65535, бэк коннектится по этому порту. |
| Postgres data dir повреждён (сбой питания) | WAL и автоматический recovery Postgres. Бэкап `pg_dump` ежедневно в `userData/backups/`. |
| ESC/POS hex отличается на копейку → принтер пишет иероглифы | Snapshot-тесты hex-выводов чека: эталоны из Node-версии байт-в-байт. |
| `lib/supabase-queries.ts` (5702 строки) содержит бизнес-логику, которую забыли | Полный аудит файла с маркировкой: «логика → переезжает на Go» vs «вью-логика → остаётся в фронте». См. [03-INVENTORY.md](03-INVENTORY.md). |
| Фронт перестанет работать, пока не адаптируем API-клиент | v4 НЕ выключает Node-бэк сразу. Они работают **параллельно** на разных портах, фронт переключается флагом. См. [08-MIGRATION-PLAN.md](08-MIGRATION-PLAN.md). |

## Принципы

1. **Сохраняем поведение, меняем имплементацию.** Каждый эндпоинт Go должен возвращать то же, что текущий Node для тех же входов. Снапшот-тесты сравнения.
2. **Никаких новых фич в v4.** Если хочется добавить — после стабилизации, отдельной фазой.
3. **`tenant_id` фильтр — закон.** Каждый запрос обязан фильтроваться по `tenant_id` (на multi-tenant SaaS-сетку). Хелпер `repo.ForTenant(ctx)` обязателен, прямой `db.First()` без него — линтер-ошибка.
4. **Все мутации — в транзакции.** Если эндпоинт пишет в 2+ таблиц — обёртка `db.Transaction()` обязательна.
5. **Идемпотентность.** Каждая запись принимает `Idempotency-Key` header, хранит в `idempotency_keys` 24 ч.
6. **Audit log на каждой мутации.** GORM-hook `AfterCreate/AfterUpdate/AfterDelete` пишет в `audit_log` ту же транзакцию.
