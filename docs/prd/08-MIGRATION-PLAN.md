# 08 — Migration Plan

Цель: дойти до 100% паритета с текущим Node-бэком без даунтайма прода. Параллельная работа двух бэков, переключение фронта по флагу.

## Принципы

1. **Node-бэк не выключаем** до полного паритета.
2. **Schema параллельна:** Go-бэк работает на отдельной БД (`restos-v4.db`), чтобы не пересекаться с продом v1.
3. **Фронт переключается флагом** `VITE_API_URL` в build-time или env. Можно собрать «POS v4» как параллельную версию.
4. **Каждая фаза имеет acceptance criteria** — без них следующая не начинается.

## Phase 0 — Подготовка (1 неделя)

**Артефакты:**
- [x] PRD (этот документ и соседние).
- [ ] Скелет `server/` репо: `go mod init`, chi, GORM, SQLite, viper, базовая структура папок.
- [ ] CI: GitHub Actions — `go vet`, `go test`, `golangci-lint`, build для linux/mac/win.
- [ ] `openapi.yaml` skeleton + Swagger UI на `/docs`.
- [ ] `Makefile` с целями `run`, `build`, `build-sidecar`, `test`, `test-cover`, `lint`.

**Acceptance:**
- `make run` запускает сервер на 3001, `/health` отдаёт `{status:"ok"}`.
- CI зелёный.

## Phase 1 — Data layer (2 недели)

**Артефакты:**
- [ ] Миграция `001_init.sql` — все 40+ таблиц.
- [ ] GORM-модели для всех таблиц.
- [ ] Репозитории с `ForTenant(ctx)`.
- [ ] Линтер-правило / тест на запрет прямого `db.X()` без tenant.
- [ ] Audit-hook централизованный.
- [ ] Decimal-тип для денег.
- [ ] Pragma'ы SQLite (WAL и т.д.).
- [ ] Бэкап-job.

**Acceptance:**
- На пустой БД миграции прокатываются.
- На дампе с прода миграции прокатываются (тест).
- Unit-тесты репозиториев: CRUD orders, menu, stock работают.
- Тест на изоляцию tenant: запрос с tenantA не видит данные tenantB.

## Phase 2 — Read-only API (1 неделя)

Цель: фронт может **читать** данные из Go-бэка (параллельно с записью в Node-бэк).

**Артефакты:**
- [ ] `GET` endpoints для: orders, menu, tables, stock, shifts, finance, audit.
- [ ] Фильтры, сортировка, пагинация.
- [ ] Auth middleware (PIN-login → session token).
- [ ] OpenAPI описание для всех GET.
- [ ] SSE `/api/v1/events` (broadcaster пока без реальных событий, для проверки соединения).

**Acceptance:**
- Postman / curl: можно прочитать все данные ресторана через Go API.
- p99 latency `GET /api/v1/orders` < 50 мс на 10000 заказах.
- На фронте включается флаг «читать через v4», UI показывает данные.

## Phase 3 — Write API (3 недели)

Цель: полный CRUD + бизнес-логика.

**Артефакты:**
- [ ] Service layer: `OrderService`, `StockService`, `ShiftService`, `FinanceService`.
- [ ] Все POST/PUT/DELETE endpoints (см. [04-API-CONTRACT.md](04-API-CONTRACT.md)).
- [ ] Идемпотентность (Idempotency-Key middleware + таблица).
- [ ] Транзакции на каждой мутации.
- [ ] SSE-эвенты после commit.
- [ ] Snapshot-тесты для критичных flows: create_order, close_order, split_order.

**Acceptance:**
- Можно создать заказ, добавить позиции, закрыть, разделить, отменить — через Go API.
- На каждое мутирующее действие в `audit_log` запись.
- На `close_order` создаётся `financial_operations` (revenue) — то, чего нет в v1.
- Smoke-тест: 50 параллельных POST /orders без race conditions.

## Phase 4 — Печать (2 недели)

**Артефакты:**
- [ ] `escpos/` пакет с CP866, builder, layout.
- [ ] Golden tests с эталонами hex из Node-версии (минимум 10 кейсов).
- [ ] `printer/` драйверы: tcp, mock, virtual.
- [ ] `print_jobs` таблица + worker с retry.
- [ ] Endpoints: `/api/v1/printers/*`, `/api/v1/orders/{id}/print-receipt`.

**Acceptance:**
- Физический принтер печатает чек, неотличимый от v1 (визуально и hex).
- На отключенном принтере job помечается failed, retry проходит после включения.
- Печать асинхронная: `POST /print-receipt` возвращает 202 за <50 мс.

## ~~Phase 5 — Sync~~ (вырезана из v4)

В v4 cloud-sync **не делаем**. Всё локально. См. [07-FUTURE-CLOUD.md](07-FUTURE-CLOUD.md).

## Phase 6 — XLSX импорт/экспорт + отчёты (1 неделя)

**Артефакты:**
- [ ] Импорт меню/техкарт/ингредиентов.
- [ ] Экспорт смены, заказов, остатков.
- [ ] Отчёты: cashflow, P&L, balance, budget.

**Acceptance:**
- XLSX от текущего ресторана импортируется без потерь.
- Экспорт смены совпадает с v1 (визуально).

## Phase 7 — Лицензия, активация, sidecar (1 неделя)

**Артефакты:**
- [ ] License-сервис (7+7+lock).
- [ ] Activate endpoint + seed flow.
- [ ] Подписанный бинарь под Win/Mac.
- [ ] Sidecar-протокол в Electron `desktop/main.js` (spawn + healthcheck).
- [ ] Build-pipeline: `make build-sidecar` упаковывает бинарь в `desktop/resources/`.

**Acceptance:**
- Свежая установка Electron-app активируется ключом, тянет данные из cloud, работает.
- Quit Electron — Go-процесс корректно завершается.
- Cold start Electron-app < 2 сек (vs 3+ сейчас).

## Phase 8 — Параллельный прогон (2 недели)

Цель: фронт смотрит в Go-бэк, **но** Node-бэк всё ещё работает и пишет в свою БД. Сверяем поведение.

**Артефакты:**
- [ ] Запуск Go-бэка рядом с Node-бэком на одной машине (порты 3001 и 3002).
- [ ] Mirror-режим: ключевые POST на фронте дублируются в оба бэка (через middleware).
- [ ] Diff-job: сравнивает БД Node и Go раз в час, репортит расхождения.

**Acceptance:**
- 2 недели работы пилотного ресторана без расхождений.
- Все incident'ы (если были) разобраны и закрыты.

## Phase 9 — Cutover (1 неделя)

**Артефакты:**
- [ ] Фронт переключается на Go-бэк by default (флаг убирается).
- [ ] Node-бэк остаётся как fallback ещё на месяц.
- [ ] Документация для саппорта обновляется.

**Acceptance:**
- Все рестораны на v4.
- 1 неделя без P0/P1 инцидентов.

## Phase 10 — Cleanup (1 неделя)

**Артефакты:**
- [ ] Удалить `archive/legacy-node-backend/api-server.js`, `db.js`, `sync.js`, `standalone.js`.
- [ ] Удалить зависимости `@electric-sql/pglite`, `express` из `desktop/package.json`.
- [ ] Удалить дублирующую бизнес-логику из `lib/supabase-queries.ts`.
- [ ] Обновить CLAUDE.md.
- [ ] Archived в v1-репо: `../restos/docs/prd-v3/` (PySide/Django план отменён).

## Итого: ~15 недель full-time

| Phase | Недель | Что |
|---|---|---|
| 0 — Prep | 1 | Скелет, CI, OpenAPI |
| 1 — Data | 2 | Postgres+embedded, миграции, GORM, репозитории |
| 2 — Read API | 1 | GET endpoints |
| 3 — Write API | 3 | POST/PUT/DELETE + services + транзакции |
| 4 — Print | 2 | ESC/POS + queue + golden tests |
| ~~5 — Sync~~ | ~~0~~ | вырезано (нет cloud в v4) |
| 6 — XLSX | 1 | Импорт/экспорт |
| 7 — Sidecar | 1 | Sup process Postgres, build binary, упаковка в Electron |
| 8 — Parallel run | 2 | Mirror в v1+v4, сверка |
| 9 — Cutover | 1 | Переключение, флаги |
| 10 — Cleanup | 1 | Удаление Node-кода |
| **Total** | **15** | |

При part-time × 0.5 — умножать на 2, итого ~7 месяцев.

**Mirror-фаза (Phase 8) проще:** не нужно сверять с облаком, только локальную БД Go vs локальную БД Node на одной машине. Можно гонять оба сервера на dev-машине и сравнивать `pg_dump` vs `pg_dump` (от Node-PGlite — экспорт через тот же sync-механизм).

## Rollback план

На любом этапе можно вернуться к Node-бэку:
- В Phases 0–7 — Go-бэк не используется в проде, rollback = ничего не делать.
- В Phase 8 — переключить флаг на фронте → читает Node.
- В Phase 9 — то же, плюс восстановить Node-инсталлер из релиза.
- В Phase 10 — точка невозврата (после физического удаления Node-кода).

До Phase 9 включительно — rollback < 1 час. После Phase 10 — нужно делать релиз с возвратом Node-кода.
