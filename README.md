# RestOS v4 — монорепо

POS-система для ресторанов. **Один репозиторий**, два рантайма:

- **Фронт:** React 19 + Vite + Tailwind + Radix. Запускается как:
  - Electron-десктоп (кассир, кухня, менеджер).
  - Capacitor APK (официанты, по LAN).
- **Бэк:** Go (chi + GORM) + PostgreSQL 16 (embedded). Один статический бинарь, спавнится Electron'ом как sidecar.

В v4 **нет облака** — всё локально. Возврат к cloud-зеркалу — отдельная фаза (см. [docs/prd/07-FUTURE-CLOUD.md](docs/prd/07-FUTURE-CLOUD.md)).

## Структура

```
restos-v4/
├── CLAUDE.md                — гайдлайны для Claude (источник правды)
├── README.md
├── package.json             — фронт (Vite + Capacitor + Electron-builder)
├── pnpm-lock.yaml
├── tsconfig.json
├── vite.config.ts
├── capacitor.config.ts
├── postcss.config.mjs
├── components.json
├── index.html
├── playwright.config.ts
├── vercel.json
│
├── src/                     — Vite entry (main.tsx, router)
├── app/                     — экраны (по доменам: orders, kitchen, finance, ...)
├── components/              — UI-компоненты
├── lib/                     — клиент-логика (api/, helpers, decimal, types)
├── hooks/                   — React hooks
├── styles/
├── public/
├── tests/                   — Playwright e2e
│
├── desktop/                 — Electron-обёртка
│   ├── main.js              — спавнит restos-server (Go), открывает BrowserWindow
│   ├── preload.js
│   ├── package.json
│   ├── assets/
│   ├── activate.html
│   └── blocked.html
│
├── android/                 — Capacitor APK официанта
│
├── server/                  — Go-бэк (на момент PRD-фазы пустой; см. docs/prd/02)
│   └── README.md
│
├── docs/
│   ├── prd/                 — 11 документов (см. 00-INDEX.md)
│   └── decisions/           — ADR-001 (Go stack), ADR-002 (REST vs PostgREST)
│
└── archive/
    └── legacy-node-backend/ — старые api-server.js / db.js / sync.js из v1
                              для reference. На удаление после Phase 10.
```

## Команды (фронт)

```bash
pnpm install
pnpm dev                  # Vite dev-сервер
pnpm build                # production-бандл в dist/
pnpm preview              # локальный preview билда
pnpm waiter:apk           # сборка APK для официанта
pnpm waiter:apk-debug
pnpm desktop:standalone   # legacy: Electron поверх dist/ без Go-бэка (на период миграции)
pnpm test:perf            # Playwright performance тесты
```

## Команды (бэк, появятся в Phase 0)

```bash
cd server
make run                  # запуск с embedded Postgres
make build                # бинарь в bin/restos-server
make build-sidecar        # копирует бинарь в ../desktop/resources/
make test
make lint
```

## С чего начать

1. Прочитать [CLAUDE.md](CLAUDE.md) — гайдлайны и правила.
2. Прочитать [docs/prd/00-INDEX.md](docs/prd/00-INDEX.md) — план работ.
3. Изучить ADR в [docs/decisions/](docs/decisions/) — почему именно такой стек.
4. Phase 0 миграции — скелет `server/` (см. [docs/prd/08-MIGRATION-PLAN.md](docs/prd/08-MIGRATION-PLAN.md)).

## Что было скопировано из v1

Из `../restos/` сюда перенесено:
- весь React-код (`src/`, `app/`, `components/`, `lib/`, `hooks/`, `styles/`, `public/`, `tests/`) — **без изменений**;
- Electron-обёртка `desktop/main.js` + `preload.js` + assets — **в Phase 7 будет переписана** под спавн Go-бинаря;
- Capacitor APK официанта `android/` — без изменений, меняется только base URL во время Phase 2;
- конфиги фронта (Vite, Tailwind, TS, Capacitor) — без изменений.

Не скопировано (специально):
- `node_modules/`, `dist/`, `.next/`, `desktop/release/`, `android/build/` — мусор сборок (восстанавливается через `pnpm install`);
- Excel-файлы данных конкретных ресторанов (`.xlsx`) — не код;
- старый `desktop/api-server.js`, `desktop/db.js`, `desktop/sync.js`, `desktop/standalone.js` — **перенесены в `archive/legacy-node-backend/`** как reference на период портирования. Удалятся в Phase 10.
- `next-env.d.ts`, `next.config.mjs.bak` — Next.js в v4 не используется (см. PRD 10).

## v1 (`../restos/`) остаётся живым

Старый репо `../restos/` **не трогается** и продолжает крутиться в проде. v4 разрабатывается параллельно. Переключение на v4 — Phase 9 (см. PRD 08).
