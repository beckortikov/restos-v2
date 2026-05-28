# server — Go backend RestOS v4

В этой папке будет жить Go-код бэка. На данный момент **папка пустая** — мы в PRD-фазе.

Структура (будет создана в Phase 0):

```
server/
├── cmd/restos-server/main.go
├── internal/
│   ├── config/
│   ├── pgsupervisor/         # embedded-postgres
│   ├── db/
│   │   ├── conn.go
│   │   ├── migrations/       # *.sql
│   │   └── models/
│   ├── repo/
│   ├── service/
│   ├── escpos/
│   ├── transport/http/
│   ├── printer/
│   ├── jobs/
│   ├── audit/
│   └── pkg/
├── migrations/
├── api/openapi.yaml
├── Makefile
├── go.mod
└── go.sum
```

См. [../docs/prd/02-ARCHITECTURE.md](../docs/prd/02-ARCHITECTURE.md) для деталей.

## Старт (после Phase 0)

```bash
make run            # запуск dev
make build          # бинарь в bin/
make build-sidecar  # копирует бинарь в ../restos/desktop/resources/
make test           # unit + integration
```

## Стек

- Go 1.23+
- chi v5
- GORM v2 + pgx/v5
- PostgreSQL 16 через `fergusstrange/embedded-postgres`
- goose миграции
- zerolog
- testify/require + golden tests на ESC/POS
