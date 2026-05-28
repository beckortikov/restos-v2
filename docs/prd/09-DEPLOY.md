# 09 — Deploy

## Сборка бинаря

```makefile
# server/Makefile

GO_VERSION := 1.23
BINARY := restos-server
VERSION := $(shell git describe --tags --always --dirty)
LDFLAGS := -s -w -X main.version=$(VERSION) -X main.buildTime=$(shell date -u +%Y-%m-%dT%H:%M:%SZ)

.PHONY: build
build:
	CGO_ENABLED=0 go build -ldflags "$(LDFLAGS)" -o bin/$(BINARY) ./cmd/restos-server

.PHONY: build-all
build-all:
	GOOS=darwin  GOARCH=arm64 go build -ldflags "$(LDFLAGS)" -o bin/$(BINARY)-darwin-arm64  ./cmd/restos-server
	GOOS=darwin  GOARCH=amd64 go build -ldflags "$(LDFLAGS)" -o bin/$(BINARY)-darwin-amd64  ./cmd/restos-server
	GOOS=windows GOARCH=amd64 go build -ldflags "$(LDFLAGS)" -o bin/$(BINARY)-windows-amd64.exe ./cmd/restos-server
	GOOS=linux   GOARCH=amd64 go build -ldflags "$(LDFLAGS)" -o bin/$(BINARY)-linux-amd64   ./cmd/restos-server

.PHONY: build-sidecar
build-sidecar: build-all
	cp bin/$(BINARY)-$(shell go env GOOS)-$(shell go env GOARCH) desktop/resources/$(BINARY)
```

CGO=0 + `pgx/v5` (pure-Go Postgres-драйвер) → cross-compile тривиален, не нужен gcc.

## Postgres-дистрибутив

Используем `github.com/fergusstrange/embedded-postgres`. Два режима:

### A) On-demand download (по умолчанию)

При первом запуске библиотека скачивает Postgres 16 (~80 МБ) с зеркала Maven Central в `userData/postgres-bin/`. Плюсы: маленький инсталлятор. Минусы: первый запуск требует интернета.

### B) Bundled (для оффлайн-инсталляции)

При сборке Electron-инсталлятора кладём Postgres-бинарь в `resources/postgres/<os>-<arch>/`. Передаём флаг `--bundle-postgres` Go-бэку → `embedded-postgres` берёт оттуда, не скачивает.

Скачать заранее можно командой:

```bash
# server/scripts/fetch-postgres.sh
mkdir -p desktop/resources/postgres
go run ./cmd/fetch-postgres --target=desktop/resources/postgres --os=darwin --arch=arm64
# повторить для всех целевых платформ
```

Размер инсталлятора растёт на 80 МБ, но устанавливается полностью offline.

**Рекомендация:** в dev — режим A, в release-build — режим B (надёжнее для ресторанов, где интернет может быть из мобильника).

## Бинарь размер

Целевой <30 МБ:
- стрипаем символы (`-s -w`)
- UPX (опционально, +30 сек на сборку, -50% size)

## Sidecar в Electron

`desktop/main.js` после v4:

```js
const { app, BrowserWindow } = require('electron')
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const log = require('electron-log')

let serverProcess = null
const SERVER_PORT = 3001

function getServerBinaryPath() {
  const exe = process.platform === 'win32' ? 'restos-server.exe' : 'restos-server'
  return app.isPackaged
    ? path.join(process.resourcesPath, exe)
    : path.join(__dirname, 'resources', exe)
}

function startServer() {
  const bin = getServerBinaryPath()
  if (!fs.existsSync(bin)) {
    log.error('Server binary not found:', bin)
    app.quit()
    return
  }
  const dataDir = app.getPath('userData')
  serverProcess = spawn(bin, [
    `--port=${SERVER_PORT}`,
    `--data-dir=${dataDir}`,
    `--log-level=info`,
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  serverProcess.stdout.on('data', (d) => log.info('[server]', d.toString().trim()))
  serverProcess.stderr.on('data', (d) => log.error('[server]', d.toString().trim()))
  serverProcess.on('exit', (code) => {
    log.warn(`Server exited with code ${code}`)
    if (!app.isQuitting) {
      app.quit()  // если сервер упал — закрываем app, пусть user перезапустит
    }
  })
}

async function waitForHealth(timeoutMs = 5000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/v1/health`)
      if (res.ok) return true
    } catch {}
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error('Server did not start in time')
}

app.whenReady().then(async () => {
  startServer()
  await waitForHealth()
  createWindow()
})

app.on('before-quit', () => {
  app.isQuitting = true
  if (serverProcess) {
    serverProcess.kill('SIGTERM')
    // Даём 2 сек на graceful, потом SIGKILL
    setTimeout(() => serverProcess && serverProcess.kill('SIGKILL'), 2000)
  }
})
```

## Упаковка в Electron-builder

`desktop/package.json` (или `electron-builder.yml`):

```yaml
extraResources:
  - from: "resources/restos-server${env.EXE_EXT}"
    to: "restos-server${env.EXE_EXT}"
```

Под каждую платформу подкладываем правильный бинарь:

```bash
# Перед electron-builder
case "$TARGET" in
  win32)  cp ../server/bin/restos-server-windows-amd64.exe resources/restos-server.exe ;;
  darwin) cp ../server/bin/restos-server-darwin-arm64    resources/restos-server ;;
  linux)  cp ../server/bin/restos-server-linux-amd64     resources/restos-server ;;
esac
```

## Подпись и нотарификация

### Windows
- EV Code Signing Certificate.
- `signtool sign /a /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 restos-server.exe`
- Подписываем и Go-бинарь, и Electron-exe.

### macOS
- Developer ID Application certificate.
- `codesign --options runtime --sign "Developer ID Application: ..." restos-server`
- Notarization через `xcrun notarytool submit ... --wait`.
- Stapling через `xcrun stapler staple`.
- Entitlements: ничего особенного, базовый набор для child-процессов.

### Linux
- Опционально AppImage с подписью или .deb/.rpm.

## Standalone режим (без Electron)

Для дебага или серверной установки (если решим вынести бэк на отдельный мини-ПК):

```bash
./restos-server --port=3001 --data-dir=/var/lib/restos
```

Systemd unit:

```ini
# /etc/systemd/system/restos-server.service
[Unit]
Description=RestOS v4 server
After=network.target

[Service]
Type=simple
User=restos
ExecStart=/usr/local/bin/restos-server --port=3001 --data-dir=/var/lib/restos
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

## Конфиг

Приоритет: CLI flags > env vars > `config.yaml` > defaults.

```yaml
# config.yaml (опционально, для standalone)
port: 3001
data_dir: ./data
log_level: info
postgres:
  mode: embedded           # embedded | external
  bundled_path: ""         # путь к pre-bundled бинарю, если есть; иначе скачаем
  port: 0                  # 0 = случайный из 49152–65535
  shared_buffers: 128MB
  external_dsn: ""         # used when mode=external
backup:
  enabled: true
  retain_daily: 7
  retain_weekly: 4
license:
  key_file: ./license.key
```

ENV варианты: `RESTOS_PORT`, `RESTOS_DATA_DIR`, `RESTOS_POSTGRES_MODE`, `RESTOS_POSTGRES_EXTERNAL_DSN`, etc.

## Auto-update

Используем `electron-updater` как сейчас. Релизы Electron-app содержат **обновлённый Go-бинарь** в `resources/`. То есть один канал обновления — на Electron-релиз обновляется и фронт, и бэк атомарно.

Альтернатива (отложенная): Go-бэк сам себя обновляет через свой канал. Не нужно в v4, оставляем на v5.

## Health monitoring

Endpoint `/api/v1/health` возвращает:

```json
{
  "status": "ok",
  "version": "4.0.1",
  "uptime_sec": 3600,
  "db": {
    "status": "ok",
    "size_mb": 42,
    "connections_active": 3,
    "connections_idle": 5
  },
  "printer_queue": {
    "pending": 0,
    "failed": 0
  }
}
```

Electron `main.js` опрашивает каждые 30 сек, если 3 раза подряд `status != "ok"` — показывает уведомление пользователю.

## Логирование

- Уровень `info` по умолчанию.
- Файл логов в `userData/logs/restos-server.log`, ротация 10 МБ × 5 файлов.
- В dev — stdout, цветной (zerolog console writer).
- В prod — JSON в файл.
- Каждый запрос: `level=info method=POST path=/api/v1/orders status=200 dur_ms=18 tenant=...`.

## Метрики (опционально)

Endpoint `/api/v1/metrics` в Prometheus-формате. Сейчас не нужно (один ресторан = одна машина), но заложить можно.

## Развёртывание новой версии

1. CI собирает релиз: Go binaries + Electron app.
2. Electron-app публикуется в GitHub Releases (или свой update server).
3. Установленные кассиры через `electron-updater` ловят обновление, скачивают, ставят на перезапуск.
4. При следующем запуске:
   - Electron спавнит **новый** `restos-server`.
   - Go-сервер прокатывает миграции (forward-only).
   - Если миграция упала — Electron показывает ошибку и не открывает UI.

## DR / восстановление

- Бэкап `restos.db.bak` в `userData/backups/`.
- Cloud-snapshot из Supabase (Supabase сам бэкапит) — для крайних случаев пересборки локальной БД.
- Команда `restos-server restore --from=backup.db.bak` (CLI) для саппорта.
