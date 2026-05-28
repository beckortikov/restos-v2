# PRD RestOS v4 — индекс

**Цель v4:** перенести всю серверную логику из текущего `restos/` (Node.js + Express + PGlite) на **Go (chi + GORM + PostgreSQL)**, фронт временно не трогать. После готовности Go-бэка — отдельная фаза «адаптация фронт-клиента под новый REST».

**API-контракт:** чистый REST `/api/v1/...` (решено), **не** PostgREST. Это даёт чистую архитектуру, но требует переписать API-клиент во фронте на следующей фазе.

**БД:** PostgreSQL 16 через **embedded-postgres** — Go-бинарь сам скачивает и запускает Postgres, без ручной установки.

**Cloud / Supabase:** в v4 **не используется**. Всё локально. Возврат к облачному зеркалу — отдельная фаза в будущем (см. [07-FUTURE-CLOUD.md](07-FUTURE-CLOUD.md)).

| # | Документ | Что внутри |
|---|---|---|
| 01 | [Overview](01-OVERVIEW.md) | Цели v4, scope, NFR, риски |
| 02 | [Architecture](02-ARCHITECTURE.md) | Компоненты, как Go встраивается в Electron, диаграмма деплоя |
| 03 | [Inventory](03-INVENTORY.md) | Что именно переносим из `restos/` (файлы, строки, ответственности) |
| 04 | [API Contract](04-API-CONTRACT.md) | REST-эндпоинты `/api/v1/...` с request/response |
| 05 | [Data Model](05-DATA-MODEL.md) | 40+ таблиц, GORM-модели, индексы, PostgreSQL DDL |
| 06 | [Business Logic](06-BUSINESS-LOGIC.md) | Печать ESC/POS, заказы, склад, смены, финансы — портирование TS→Go |
| 07 | [Future Cloud](07-FUTURE-CLOUD.md) | Заметка про возможный cloud-sync в будущем (в v4 не делаем) |
| 08 | [Migration Plan](08-MIGRATION-PLAN.md) | Пошаговый план по фазам (с критериями приёмки) |
| 09 | [Deploy](09-DEPLOY.md) | Сборка бинаря, упаковка в Electron, обновления |
| 10 | [Frontend Adapter](10-FRONTEND-ADAPTER.md) | Что нужно изменить во фронте на фазе 2 |

ADR:
- [ADR-001 — выбор Go и SQLite](../decisions/ADR-001-go-stack.md)
- [ADR-002 — отказ от PostgREST-совместимости в пользу чистого REST](../decisions/ADR-002-rest-vs-postgrest.md)
