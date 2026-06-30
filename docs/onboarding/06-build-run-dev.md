# 06 — Сборка, запуск, dev-workflow

Онбординг-уровень: как всё собрать и запустить. Команды выверены по `server/Makefile`, корневому
`package.json` и `desktop/package.json`.

> Версии: **Go 1.25.7** (`server/go.mod`), Node 20+ / pnpm, PostgreSQL 16 (тянется
> `embedded-postgres` на первый запуск). Порт бэка **3002**, embedded Postgres **54330** (loopback).

---

## 1. Что где запускается (карта портов)

| Что | Команда | Порт |
|---|---|---|
| Go-бэк (embedded PG) | `cd server && make run` | HTTP `0.0.0.0:3002`, PG `127.0.0.1:54330` |
| Фронт dev (Vite) | `pnpm dev` | `http://localhost:3000` (API форсится на `:3002`) |
| Касса целиком (Electron) | `cd desktop && npm start` | UI грузит SPA, бьёт в `127.0.0.1:3002` |
| LAN-доступ к UI | браузер | `http://<ip-кассы>:3002` |
| Swagger UI | — | `http://localhost:3002/docs` |
| APK официанта | `pnpm waiter:apk` | — |

---

## 2. Бэкенд (`server/Makefile`)

**Запуск (dev):**
```bash
cd server
make run            # embedded Postgres (качает PG16 на первый запуск ~80 МБ), HTTP :3002
make run-dev        # против локального Postgres (DEV_PG_DSN из Makefile)
make run-external PG_DSN="host=127.0.0.1 port=5432 user=restos dbname=restos_v4 sslmode=disable"
```

**Сборка:**
```bash
make build              # bin/restos-server (SPA уже должна быть встроена)
make embed-spa          # vite build → копирует dist/ в server/internal/transport/http/spa/
make build-with-spa     # embed-spa + build (полный web-enabled бинарь)
make build-all          # кросс-компиляция под darwin/linux/windows × amd64/arm64
make build-sidecar      # бинарь под текущую ОС → desktop/resources/restos-server (для Electron)
make build-sidecar-all  # все платформы → desktop/resources/
make build-license-gen  # CLI license-gen
make license-keypair    # генерация Ed25519-пары для лицензий
```

**Тесты и качество:**
```bash
make test             # unit (без БД)
make test-integration # против тестовой БД
make test-all         # unit + integration (RESTOS_TEST_DSN override)
make test-cover       # покрытие
make bench            # бенч (≈10k заказов)
make update-golden    # обновить эталоны ESC/POS (явно!)
make lint | vet | fmt # golangci-lint / go vet / gofmt -s -w
make api-validate     # валидация server/api/openapi.yaml
make api-gen          # генерация типов (oapi-codegen)
make ts-client        # генерация TS-типов в ../lib/api/generated.ts
make tidy | clean | help
```

**Полезные env/флаги бэка:** `--http-addr`/`RESTOS_HTTP_ADDR` (`0.0.0.0:3002`),
`--external-pg-dsn`/`RESTOS_EXTERNAL_PG_DSN`, `--pg-port`/`RESTOS_PG_PORT` (54330),
`RESTOS_DATA_DIR`, `RESTOS_LOG_JSON`, `--license-public-key`. Подробности bootstrap — [02 §1](02-backend-architecture.md).

---

## 3. Фронтенд (корневой `package.json`)

```bash
pnpm dev            # Vite dev на :3000 (API → :3002 через getBaseURL)
pnpm build          # прод-бандл → dist/
pnpm preview        # локальный предпросмотр прод-бандла
pnpm build-desktop  # vite build + бамп версии desktop + копия dist → desktop/frontend/
pnpm typecheck      # tsc --noEmit
pnpm test           # vitest run        (юнит)
pnpm test:watch | test:ui
pnpm test:e2e       # playwright --project=chromium
pnpm test:perf      # playwright --project=perf
pnpm waiter:apk | waiter:apk-debug   # см. §5
```

В dev `getBaseURL()` (`lib/api/v4-typed.ts`) видит порт `3000`/`5173` и форсит API на `:3002` —
поэтому **бэк должен быть запущен** (`make run`) параллельно с `pnpm dev`.

---

## 4. Десктоп (Electron, `desktop/`)

`desktop/main.js` спавнит Go-бинарь (`resources/restos-server[.exe]`), ждёт `/healthz`, затем грузит
`frontend/index.html`. Ключевое: `API_PORT = 3002`, env для бинаря (`RESTOS_DATA_DIR=userData`,
`RESTOS_HTTP_ADDR=0.0.0.0:3002`, `RESTOS_PG_CACHE`, лицензионный ключ); kill stale-процессов и
освобождение портов 3002/54330 при старте; graceful shutdown (SIGTERM / `taskkill /T` на Windows);
детект LAN-IP для QR официанту.

```bash
cd desktop
npm start                 # dev-запуск (electron .) — спавнит Go-сайдкар
npm run build-frontend    # vite build + копия dist → desktop/frontend/
npm run embed-spa         # копия dist → server/internal/transport/http/spa/ (LAN web)
npm run build-sidecar-win # embed-spa + кросс-сборка Go под Windows → resources/restos-server.exe
npm run pack              # electron-builder --dir (без инсталлятора)
npm run dist              # electron-builder (инсталлятор)
npm run dist:win          # build-frontend + build-sidecar-win + electron-builder --win
```

**Пайплайн релиза кассы (общая идея):** `build-frontend` (UI) → `embed-spa`/`build-sidecar-*`
(встроить SPA + собрать Go-бинарь в `resources/`) → `electron-builder` (упаковать).

---

## 5. APK официанта

```bash
pnpm waiter:apk        # assembleRelease → android-kotlin/app/build/outputs/apk/release/app-release.apk
pnpm waiter:apk-debug  # assembleDebug   → .../apk/debug/app-debug.apk
```
`JAVA_HOME` по умолчанию — JBR из Android Studio. Release подписывается **debug-ключом** (LAN-сайдлоад),
иначе `assembleRelease` даёт неустанавливаемый неподписанный APK. Установка:
`adb install -r <apk>` или копированием на планшет (см. [05](05-waiter-android.md)).

---

## 6. LAN web-доступ

Go-бэк отдаёт ту же React-SPA на `:3002` (`//go:embed all:spa` в
`server/internal/transport/http/spa.go`). Любое устройство в сети ресторана открывает
`http://<ip-кассы>:3002` — UI грузится полностью, Electron не нужен (отчёты с ноутбука, планшет в
браузере, диагностика). Сборка SPA в бинарь — `make embed-spa` → `make build` (или
`build-sidecar*`, которые включают embed-spa). Ограничение: касса (Electron с Go-сайдкаром) должна
быть запущена.

---

## 7. Тесты

- **Бэк:** `make test` (unit), `make test-integration` (БД), `make test-cover`. ESC/POS — **golden**
  (байт-в-байт) в `server/internal/escpos/`, эталоны обновляются только `make update-golden`.
- **Фронт:** `pnpm test` (vitest), `pnpm test:e2e` / `pnpm test:perf` (Playwright, `tests/`).

---

## 8. Первый запуск (чек-лист)

1. `cd server && make run` — дождаться скачивания PG16 и `HTTP listening on 0.0.0.0:3002`.
2. Открыть `http://localhost:3002/docs` — Swagger жив → бэк ок.
3. В другом терминале из корня: `pnpm dev` → `http://localhost:3000`.
4. Первый вход: страница `/bootstrap` создаёт ресторан и владельца → затем `/login` с PIN.
5. (Опц.) `cd desktop && npm start` — проверить полный сценарий кассы (Electron + сайдкар).

---

## 9. Существующие документы (не дублируем — ссылаемся)

- `docs/prd/` — продуктовые спеки: `04-API-CONTRACT.md` (эндпоинты), `05-DATA-MODEL.md` (схема БД,
  таблицы/индексы), `06-BUSINESS-LOGIC.md` (правила), `09-DEPLOY.md` (упаковка).
- `docs/decisions/` — ADR-001 (почему Go), ADR-002 (почему чистый REST).
- `CLAUDE.md` — правила разработки (источник правды). ⚠️ В нём встречаются устаревшие места: порт
  **3002** (не 3001), и **zustand фактически не используется** на фронте.
