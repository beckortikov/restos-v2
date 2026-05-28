# archive/

Сюда складываются файлы из v1, которые **больше не используются в v4**, но нужны как reference на период портирования.

## `legacy-node-backend/`

Старый Node.js + Express + PGlite бэк из `restos/desktop/`:

| Файл | Что | Замена в v4 |
|---|---|---|
| `api-server.js` | Express + PostgREST-эмулятор + 28 эндпоинтов | `server/internal/transport/http/` (Go, chi) |
| `db.js` | PGlite инициализация + DDL всех таблиц | `server/internal/db/migrations/*.sql` + GORM-модели |
| `sync.js` | Sync с Supabase (one-way push) | **Не портируется в v4** — нет облака. См. [../docs/prd/07-FUTURE-CLOUD.md](../docs/prd/07-FUTURE-CLOUD.md) |
| `standalone.js` | Standalone-запуск без Electron | `restos-server --port=...` (Go-бинарь) |

## Когда удалять

После **Phase 10 (Cleanup)** в [../docs/prd/08-MIGRATION-PLAN.md](../docs/prd/08-MIGRATION-PLAN.md). До этого момента полезно сверяться с поведением v1 при портировании.
