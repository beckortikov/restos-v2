# ADR-001 — Выбор Go + PostgreSQL для бэка v4

**Status:** Accepted
**Date:** 2026-05-25
**Deciders:** owner

## Контекст

RestOS v1 использует Node.js + Express + PGlite (Postgres в WASM) внутри Electron-sidecar. Проблемы:
- PGlite — WASM, тормозит на больших таблицах, ограниченные индексы.
- Node + Electron = ~400 МБ RAM, тяжёлый инсталлятор.
- Бизнес-логика дублирована между фронтом (`lib/supabase-queries.ts`, 5702 строки) и бэком — две точки правды.
- 1500+ строк ручного PostgREST-эмулятора в `desktop/api-server.js` тяжело поддерживать.

Рассматривались варианты замены бэка:
1. Django (Python) + PostgreSQL
2. Node (NestJS/Fastify) + PostgreSQL
3. **Go (chi + GORM) + PostgreSQL** ← выбран
4. PySide (Qt) — full rewrite UI + Python backend

## Решение

**Go 1.23+ с chi v5 + GORM v2 + PostgreSQL 16 (через embedded-postgres).**

## Обоснование

### Почему Go (vs Django/Node/PySide)

- **Sidecar-friendly:** один статический бинарь 20–30 МБ. Python таскать в Electron — боль (PyInstaller хрупкий). Node — то, от чего уходим.
- **Перформанс на сетях:** для будущей сети ресторанов (multi-tenant SaaS, edge-first) Go экономит RAM × N точек.
- **Tauri-готовность:** если будет миграция Electron → Tauri (v5), Go-sidecar встаёт буквально как есть.
- **Типобезопасность:** компилятор ловит `tenant_id`-утечки между ресторанами (через дженерики и линтер).
- **Cross-compile:** `GOOS=...` без gcc — собираем под Win/Mac/Linux × amd64/arm64 в одной команде.

Альтернатива Django была близка по скорости разработки (admin, ORM из коробки), но проиграла по:
- упаковка Python в Electron-sidecar нестабильна,
- толще на машине ресторана (Python+Postgres+Celery+gunicorn vs один Go-бинарь),
- сложнее обновление (CI деплой на N ресторанов).

PySide отброшен сразу: переписывание UI 24 экранов с React на Qt = 6–9 месяцев впустую, плюс двойной UI-стек с Capacitor-официантом.

### Почему PostgreSQL (vs SQLite)

Рассматривался SQLite (`modernc.org/sqlite`) — простейший вариант, без процессов, файл и всё. Отброшен потому что:

1. **FK constraints в SQLite слабые** — некоторые сценарии (ON UPDATE CASCADE) глючат.
2. **Concurrent writes**: SQLite держит писательскую блокировку всей БД. На 20 официантов + кассир + KDS периодически будут конфликты.
3. **NUMERIC точность:** SQLite не имеет настоящего decimal-типа — всё хранится как TEXT/REAL. На Postgres — нативный `NUMERIC(p,s)`.
4. **Будущая cloud-совместимость:** если когда-то решим вернуть Supabase-зеркало (см. ADR соответственно), схема уже Postgres-родная — миграция cloud-side тривиальна.
5. **JSONB + GIN-индексы:** полезно для `Order.meta`, поиска по меню.
6. **Триггеры/функции:** на случай, если понадобятся (например, `pg_notify` для cross-process events).

Стоимость Postgres вместо SQLite:
- +80 МБ дистрибутив (терпимо).
- +50 МБ RAM (терпимо).
- +1–2 сек cold start (терпимо).

Выгода покрывает издержки.

### Почему embedded-postgres (vs Docker/native)

- **Docker Desktop требует лицензию для коммерческого использования** и весит сотни МБ. Не годится для ресторана.
- **Native install** требует от пользователя действий — не подходит для kiosk-mode.
- **Embedded** — самый user-friendly: один Electron-инсталлятор тянет всё.

Библиотека `fergusstrange/embedded-postgres` зрелая (4k stars, активна с 2020), используется в проде у множества проектов. Работает на Win/Mac/Linux, скачивает официальный Postgres из Maven Central. Опция bundle (вшить дистрибутив в инсталлятор) поддерживается.

## Последствия

### Положительные

- Один бинарь Go-бэка.
- Настоящий Postgres локально — все возможности RDBMS.
- Cross-compile простой.
- Память и старт лучше Node+PGlite.
- Будущий путь в Tauri/cloud не блокируется.

### Отрицательные

- Cold start чуть медленнее SQLite (1–2 сек на Postgres init).
- Размер инсталлятора +80 МБ из-за Postgres.
- Сложнее sidecar-протокол (3 уровня процессов: Electron → Go → Postgres).
- Нужно следить за version-pin Postgres-дистрибутива в `embedded-postgres`.

### Что отказались делать

- Не используем сырой `database/sql`. GORM, несмотря на overhead, ускоряет разработку на 2× и удобнее в эволюции схемы.
- Не используем sqlc/ent. Возможен пересмотр, если GORM подведёт на горячих путях (тогда — sqlc для топ-5 запросов).

## Открытые вопросы

- Когда сеть ресторанов вырастет до 10+ точек — пересмотреть нужду в cloud-зеркале (см. [07-FUTURE-CLOUD.md](../prd/07-FUTURE-CLOUD.md)).
- Если GORM окажется узким горлом на отчётах — селективно перейти на raw SQL через `db.Raw()`.
