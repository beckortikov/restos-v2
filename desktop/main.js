// RestOS v4 Electron main process.
//
// Architecture:
//   [Electron main] spawns Go-binary as sidecar child process →
//   Go-server embeds Postgres 16 + serves http://127.0.0.1:3002 →
//   BrowserWindow loads bundled frontend (file://) which fetches API.
//
// On quit: kill Go child cleanly (Postgres stops gracefully via Go).

const Sentry = require('@sentry/node')
Sentry.init({
  dsn: 'https://0791a2aaef3fddc828f697fa2728033f@o4511224163270656.ingest.de.sentry.io/4511224183259216',
  environment: 'desktop-main',
  release: require('./package.json').version,
})

const { app, BrowserWindow, Tray, Menu, nativeImage, shell, ipcMain, dialog } = require('electron')
const path = require('path')
const fs = require('fs')
const net = require('net')
const http = require('http')
const { spawn, execSync } = require('child_process')
const { autoUpdater } = require('electron-updater')

// ─── Тайминги старта ───────────────────────────────────────────────────────
// Кассиры жалуются на долгий запуск, а причин может быть три разных (холодная
// распаковка PG, парсинг SPA, зомби-процессы от прошлой версии) — по «долго
// грузится» их не различить. Пишем контрольные точки в main.log, чтобы по
// логу с любой кассы было видно, ЧТО именно тормозит.
const T0 = Date.now()
const ms = () => `+${((Date.now() - T0) / 1000).toFixed(2)}s`
function timing(stage) {
  console.log(`[timing] ${ms()} ${stage}`)
}

// v3.8.0: было 3001 — конфликт с v1 (старая restos слушает 3001).
// Теперь v2 на 3002 чтобы обе версии могли работать одновременно
// на одной машине.
const API_PORT = 3002
const API_BASE = `http://127.0.0.1:${API_PORT}`

let mainWindow = null
let tray = null
let goProc = null
let goReady = false

// ─── Windows Firewall rule (idempotent, best-effort) ──────────────────────
//
// v3.8.4: бэк слушает 0.0.0.0:3002, но Windows Firewall блокирует входящие
// от других IP пока правило не создано. Installer (installer.nsh)
// добавляет его при установке, но если юзер выключал firewall, потом
// включил, или правило случайно удалили — добавим повторно при старте.
//
// `nsExec/cmd /c netsh` — best-effort, без elevation; если netsh
// требует админ-прав и не получает, тихо игнорируем (не блокируем старт).
function ensureWindowsFirewallRule() {
  if (process.platform !== 'win32') return
  try {
    // Try add (silently). Если правило уже есть — добавит ещё одно с тем же
    // именем, что не вредит (Windows их объединит).
    //
    // АСИНХРОННО (spawn, не execSync): netsh на части конфигов Windows тормозит
    // до нескольких секунд, а execSync блокировал старт (и сплэш) синхронно до
    // 5с КАЖДЫЙ запуск. Правило нужно только когда планшет официанта
    // подключится (секунды/минуты спустя), installer его уже добавил — это
    // best-effort повтор, блокировать им старт незачем. Fire-and-forget, shell
    // разбирает кавычки в name как раньше execSync.
    const cmd = `netsh advfirewall firewall add rule name="RestOS v2 HTTP" dir=in action=allow protocol=TCP localport=${API_PORT} profile=any`
    const child = spawn(cmd, { stdio: 'ignore', windowsHide: true, shell: true })
    child.on('error', (e) => console.log('[firewall] netsh spawn error:', e.message || ''))
    child.unref()
    console.log('[firewall] rule add (async) for port', API_PORT)
  } catch (e) {
    // Молча — без админских прав netsh может не сработать. Installer уже
    // покрыл этот случай при установке.
    console.log('[firewall] could not add rule (likely needs admin):', e.message || '')
  }
}

// ─── Migration from shared restos-desktop userData ─────────────────────────
//
// v3.8.3 fix: до v3.8.2 поле `name` в package.json было "restos-desktop" —
// то же что у v1. Electron использует name для app.getPath('userData'), так
// что v1 и v2 писали в одну папку %APPDATA%\restos-desktop\, перетирая друг
// друга (v2 wipe'нул PGlite-данные v1 при первом запуске, v1 потом не
// стартовал — WASM crash).
//
// Чиним: name теперь "restos-desktop-v2" → userData = %APPDATA%\restos-desktop-v2\.
// При старте проверяем — если в новой папке пусто, но в старой есть наши
// данные (Postgres-формат, не PGlite), переносим их.
function migrateUserDataFromSharedDir() {
  try {
    const newDir = app.getPath('userData')  // restos-desktop-v2
    const oldDir = path.join(path.dirname(newDir), 'restos-desktop')  // shared с v1
    if (!fs.existsSync(oldDir)) return
    if (oldDir === newDir) return

    // В старой папке должны быть НАШИ файлы (pgdata = Postgres-формат).
    // pglite v1 НЕ создаёт pgdata — у него pglite/* подпапки. Этим
    // отличаем «наши данные» от «чужих v1».
    const oldPgData = path.join(oldDir, 'pgdata')
    if (!fs.existsSync(oldPgData)) return  // нет нашего pgdata → ничего двигать

    // Если в новой папке уже что-то есть — не трогаем.
    const newPgData = path.join(newDir, 'pgdata')
    if (fs.existsSync(newPgData)) return

    console.log('[migration] v2 data found in shared restos-desktop dir, moving to', newDir)
    // Создаём новую папку и переносим только наши подпапки.
    fs.mkdirSync(newDir, { recursive: true })
    const ourDirs = ['pgdata', 'pg-cache', 'pg-runtime', 'backups', 'logs']
    for (const sub of ourDirs) {
      const src = path.join(oldDir, sub)
      const dst = path.join(newDir, sub)
      if (fs.existsSync(src) && !fs.existsSync(dst)) {
        try {
          fs.renameSync(src, dst)
          console.log('[migration]   moved', sub)
        } catch (e) {
          console.error('[migration]   FAILED to move', sub, e.message)
        }
      }
    }
    console.log('[migration] v1 data (если была — pglite/*) осталась в', oldDir)
  } catch (e) {
    console.error('[migration] error:', e)
  }
}

// ─── Logger ────────────────────────────────────────────────────────────────
function setupFileLogger() {
  try {
    const logsDir = path.join(app.getPath('userData'), 'logs')
    if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true })
    const logFile = path.join(logsDir, 'main.log')
    try { if (fs.statSync(logFile).size > 5 * 1024 * 1024) fs.renameSync(logFile, logFile + '.old') } catch {}
    const stream = fs.createWriteStream(logFile, { flags: 'a' })
    stream.write(`\n=== ${new Date().toISOString()} app start v${require('./package.json').version} ===\n`)
    const origLog = console.log.bind(console)
    const origErr = console.error.bind(console)
    console.log = (...a) => { try { stream.write(a.map(String).join(' ') + '\n') } catch {} ; origLog(...a) }
    console.error = (...a) => { try { stream.write('[ERR] ' + a.map(String).join(' ') + '\n') } catch {} ; origErr(...a) }
    console.log('[logger] writing to', logFile)
  } catch (e) {
    console.error('[logger] init failed:', e.message)
  }
}

// ─── Sidecar (Go backend) ──────────────────────────────────────────────────
function sidecarPath() {
  // In production (packaged): resources/restos-server[.exe] (electron-builder extraResources)
  // In dev: ../server/bin/restos-server[-windows-amd64.exe]
  const exeName = process.platform === 'win32' ? 'restos-server.exe' : 'restos-server'
  if (app.isPackaged) {
    return path.join(process.resourcesPath, exeName)
  }
  // Dev: try desktop/resources first, then server/bin
  const local = path.join(__dirname, 'resources', exeName)
  if (fs.existsSync(local)) return local
  return path.join(__dirname, '..', 'server', 'bin', 'restos-server')
}

// Kill leftover processes from previous crashed sessions.
//
// СТРАТЕГИЯ: точечный kill только НАШИХ процессов, не трогать чужой Postgres
// (юзер может иметь свой PG на 5432 для других проектов).
//
//   1. taskkill restos-server.exe — наш бинарь, всегда безопасно.
//   2. Читаем pgdata/postmaster.pid → берём PID нашего embedded-postgres
//      → kill только этот PID. Не трогаем чужие postgres.exe.
//   3. Fallback: если postmaster.pid не существует, но порт 54330 занят —
//      kill процесса именно на этом порту (а не всех postgres.exe).
function killStaleSidecars() {
  const isWin = process.platform === 'win32'

  // 1) Наш бинарь — всегда таскилл по имени, безопасно.
  try {
    if (isWin) execSync('taskkill /F /IM restos-server.exe /T 2>nul', { stdio: 'ignore' })
    else execSync('pkill -9 -f restos-server || true', { stdio: 'ignore' })
  } catch {}

  // 2) Embedded-postgres по pid из postmaster.pid (только НАША инстанция).
  const pgLock = path.join(app.getPath('userData'), 'pgdata', 'postmaster.pid')
  let killedByLock = false
  try {
    if (fs.existsSync(pgLock)) {
      const content = fs.readFileSync(pgLock, 'utf8')
      const pgPid = parseInt(content.split('\n')[0], 10)
      if (pgPid > 0) {
        try {
          if (isWin) execSync(`taskkill /F /PID ${pgPid} /T 2>nul`, { stdio: 'ignore' })
          else process.kill(pgPid, 'SIGKILL')
          console.log('[sidecar] killed embedded-pg pid', pgPid)
          killedByLock = true
        } catch {}
      }
      try { fs.unlinkSync(pgLock) } catch {}
    }
  } catch {}

  // 3) Fallback: kill процесса на порту 54330 если lock-файл отсутствует
  //    или kill по pid не сработал.
  if (!killedByLock) {
    try {
      if (isWin) {
        const out = execSync('netstat -ano | findstr :54330', { encoding: 'utf8' })
        const pids = new Set()
        for (const line of out.split('\n')) {
          const m = line.trim().match(/\s+(\d+)\s*$/)
          if (m) pids.add(m[1])
        }
        for (const pid of pids) {
          try { execSync(`taskkill /F /PID ${pid} /T 2>nul`, { stdio: 'ignore' }) } catch {}
        }
        if (pids.size > 0) console.log('[sidecar] killed port:54330 holders', [...pids].join(','))
      } else {
        execSync('lsof -ti:54330 | xargs -r kill -9 2>/dev/null || true', { stdio: 'ignore' })
      }
    } catch {}
  }

  console.log('[sidecar] cleanup done')
}

// Проверка что порт свободен (одна попытка bind).
function isPortFree(port) {
  return new Promise((resolve) => {
    const tester = net.createServer()
    tester.once('error', () => resolve(false))
    tester.once('listening', () => tester.close(() => resolve(true)))
    tester.listen(port, '127.0.0.1')
  })
}

// Освобождаем порт (3002 API или 54330 PG), удерживаемый зомби-инстансом v2 после
// апдейта/краша. Раньше была ОДНА попытка kill + ожидание 1.5 с без проверки —
// если ОС не успевала освободить порт (форс-килл PG оставляет сокет в TIME_WAIT,
// дерево умирает не мгновенно), новый сервер стартовал в занятый порт и падал.
// Теперь — цикл: kill стейл-процессов + ждём + перепроверяем, пока порт реально
// не освободится (до ~18 с). v1 на 3001 не конфликтует.
async function ensurePortFree(port, attempts = 12) {
  for (let i = 0; i < attempts; i++) {
    if (await isPortFree(port)) return true
    console.log(`[sidecar] port ${port} busy (попытка ${i + 1}/${attempts}) — kill stale + wait`)
    killStaleSidecars()
    await new Promise((r) => setTimeout(r, 1500))
  }
  const free = await isPortFree(port)
  if (!free) console.error(`[sidecar] port ${port} ВСЁ ЕЩЁ занят после ${attempts} попыток`)
  return free
}

function startSidecar() {
  const exe = sidecarPath()
  if (!fs.existsSync(exe)) {
    console.error('[sidecar] binary not found:', exe)
    dialog.showErrorBox(
      'RestOS — Ошибка запуска',
      `Файл сервера не найден:\n${exe}\n\nВозможные причины:\n• Антивирус удалил restos-server.exe из карантина\n• Установка повреждена — переустановите RestOS\n\nЛог: ${path.join(app.getPath('userData'), 'logs', 'main.log')}`,
    )
    return
  }
  console.log('[sidecar] starting:', exe)

  const env = {
    ...process.env,
    RESTOS_DATA_DIR: app.getPath('userData'),
    // v3.9.2: путь к рабочему столу — бэк копирует туда бэкапы (RestOS-Backups/)
    // чтобы владелец легко находил и скидывал на флешку. Electron знает
    // локализованный путь (Рабочий стол / Desktop).
    RESTOS_DESKTOP_DIR: app.getPath('desktop'),
    // Bind on 0.0.0.0 so the waiter's Kotlin APK can reach the sidecar over
    // LAN (e.g. http://192.168.x.y:3002). Electron itself fetches via
    // http://127.0.0.1:3002 which works identically.
    RESTOS_HTTP_ADDR: `0.0.0.0:${API_PORT}`,
    // Cache PG binary so embedded-postgres reuses it across runs.
    RESTOS_PG_CACHE: path.join(app.getPath('userData'), 'pg-cache'),
    // Ed25519 public key для verify license-токенов. Вшит в installer.
    // Меняется ТОЛЬКО при ротации keypair (см. restos-admin/README).
    // Соответствующий PRIVATE_KEY хранится в Vercel env вашей админки.
    RESTOS_LICENSE_PUBLIC_KEY: 'NNsxnnh+jyMTw6GvrhfkbWTwMueYzG6zQ7RCN4x7qjM=',
  }

  // Resolve pg_dump and pg_restore paths in resources and pass as environment variables
  const pgDumpName = process.platform === 'win32' ? 'pg_dump.exe' : 'pg_dump'
  const pgRestoreName = process.platform === 'win32' ? 'pg_restore.exe' : 'pg_restore'
  let pgDumpPath = ''
  let pgRestorePath = ''
  if (app.isPackaged) {
    pgDumpPath = path.join(process.resourcesPath, pgDumpName)
    pgRestorePath = path.join(process.resourcesPath, pgRestoreName)
  } else {
    const localDump = path.join(__dirname, 'resources', pgDumpName)
    const localRestore = path.join(__dirname, 'resources', pgRestoreName)
    if (fs.existsSync(localDump)) pgDumpPath = localDump
    if (fs.existsSync(localRestore)) pgRestorePath = localRestore
  }
  if (pgDumpPath && fs.existsSync(pgDumpPath)) {
    env.RESTOS_PG_DUMP_PATH = pgDumpPath
  }
  if (pgRestorePath && fs.existsSync(pgRestorePath)) {
    env.RESTOS_PG_RESTORE_PATH = pgRestorePath
  }

  goProc = spawn(exe, [], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })

  goProc.stdout.on('data', (b) => {
    const s = String(b).trim()
    if (s) console.log('[go]', s)
  })
  goProc.stderr.on('data', (b) => {
    const s = String(b).trim()
    if (s) console.log('[go-err]', s)
  })
  goProc.on('exit', (code, signal) => {
    console.log('[sidecar] exited code=', code, 'signal=', signal)
    goProc = null
    goReady = false
    if (!app.isQuitting) {
      Sentry.captureMessage(`Go sidecar exited unexpectedly: code=${code} signal=${signal}`)
      // Перед рестартом освобождаем порт PG. Если бэк упал ПОСЛЕ старта
      // embedded-postgres (напр., на миграции), PG мог осиротеть и держать 54330
      // — тогда каждый следующий старт падает с «process already listening on
      // port 54330», и касса не поднимается никогда (инцидент 22.07.2026).
      // ensurePortFree добьёт зомби-PG перед новым стартом. Стартовый cleanup в
      // app.on('ready') такой рестарт-путь не покрывал.
      setTimeout(async () => {
        if (app.isQuitting) return
        await ensurePortFree(54330)
        if (!app.isQuitting) startSidecar()
      }, 2000)
    }
  })
  goProc.on('error', (err) => {
    console.error('[sidecar] spawn error:', err)
    Sentry.captureException(err)
    dialog.showErrorBox(
      'RestOS — Невозможно запустить сервер',
      `Ошибка запуска бинаря:\n${err.message}\n\nОбычно это значит что антивирус заблокировал restos-server.exe.\n\nДобавьте в исключения Windows Defender:\n${exe}`,
    )
  })
}

function stopSidecar() {
  const isWin = process.platform === 'win32'
  const pid = goProc?.pid
  goProc = null
  goReady = false
  // СИНХРОННО (execSync), а не async spawn: к моменту установки обновления и
  // выхода дерево процессов (Go + embedded Postgres) должно быть УЖЕ мертво.
  // Раньше был fire-and-forget spawn('taskkill') — не успевал отработать до
  // quitAndInstall, старый PG выживал, держал порт 3002/54330 и pgdata-lock →
  // новый сервер после апдейта не стартовал («Сервер не отвечает»).
  console.log('[sidecar] stopping (sync)')
  try {
    if (pid) {
      if (isWin) execSync(`taskkill /F /PID ${pid} /T 2>nul`, { stdio: 'ignore', timeout: 8000 })
      else { try { process.kill(pid, 'SIGTERM') } catch {} }
    }
  } catch (e) { console.error('[sidecar] stop error:', e.message || e) }
  // Добиваем embedded Postgres по postmaster.pid — taskkill /T мог его не
  // захватить, если PG отвязался от дерева процессов.
  try {
    const pgLock = path.join(app.getPath('userData'), 'pgdata', 'postmaster.pid')
    if (fs.existsSync(pgLock)) {
      const pgPid = parseInt(fs.readFileSync(pgLock, 'utf8').split('\n')[0], 10)
      if (pgPid > 0) {
        if (isWin) execSync(`taskkill /F /PID ${pgPid} /T 2>nul`, { stdio: 'ignore', timeout: 5000 })
        else { try { process.kill(pgPid, 'SIGKILL') } catch {} }
      }
    }
  } catch {}
}

// Ждём healthz OK перед подменой сплэша на SPA (окно со сплэшем уже показано).
function waitForBackend(timeoutMs = 90000) {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    function poll() {
      const req = http.get(`${API_BASE}/healthz`, (res) => {
        if (res.statusCode === 200) {
          goReady = true
          resolve()
          return
        }
        retry()
      })
      req.on('error', retry)
      req.setTimeout(1500, () => { try { req.destroy() } catch {} ; retry() })
    }
    function retry() {
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`backend not ready within ${timeoutMs}ms`))
        return
      }
      // 150мс вместо 500мс: бэк после разведения PG-бинарей поднимается ~250мс,
      // и на 500мс-гранулярности мы до полсекунды зря ждём следующего пинга.
      // healthz дешёвый, лишние пинги при старте ничего не стоят.
      setTimeout(poll, 150)
    }
    poll()
  })
}

// ─── Single instance + lifecycle ───────────────────────────────────────────
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.on('ready', async () => {
    setupFileLogger()
    timing('electron ready')
    // 0) v3.8.3: перенос данных из shared restos-desktop dir (было общим с v1).
    migrateUserDataFromSharedDir()
    // 0.5) v3.8.4: best-effort добавление firewall rule (installer его уже
    //      добавил, но если юзер выключал firewall — restore при старте).
    ensureWindowsFirewallRule()

    // 1) Окно со СПЛЭШЕМ показываем СРАЗУ — не ждём бэк. Иначе пользователь весь
    //    холодный старт (очистка портов + подъём embedded-PG, 15-40с, а при
    //    первой распаковке дольше) видит пустоту и думает, что касса не
    //    запускается. Сплэш живёт до loadApp() — то есть до конца очистки портов.
    createWindow()
    setupTray()
    setupAutoUpdater()

    // 2) Убить zombie sidecar'ы (restos-server + postgres) от прошлого crash,
    //    освободить порты 3002 (HTTP API) и 54330 (embedded PG). Идёт под сплэшем.
    killStaleSidecars()
    await ensurePortFree(API_PORT)
    await ensurePortFree(54330)
    timing('порты свободны (cleanup завершён)')
    // 3) Стартуем sidecar.
    startSidecar()

    // 4) SPA грузим СРАЗУ, параллельно со стартом бэка — не дожидаясь healthz.
    //
    // Раньше здесь стоял `await waitForBackend()`, и Chromium начинал грузить
    // бандл только после подъёма Postgres. Две самые долгие стадии старта шли
    // строго друг за другом, хотя SPA лежит локально и бэк ему для загрузки не
    // нужен: пока сервер поднимается, окно вполне может парсить JS.
    //
    // Экраны, которым нужен бэк, ждут его сами: LicenseGate крутит спиннер,
    // пока соединение не установится (см. components/license-gate.tsx), а
    // sidecar при падении авто-рестартует (goProc.on('exit')).
    loadApp()

    // 130 с > 90 с StartTimeout embedded-postgres: холодный старт / WAL-recovery
    // после апдейта должен успеть завершиться до показа ошибки.
    const BACKEND_TIMEOUT_MS = 130000
    try {
      await waitForBackend(BACKEND_TIMEOUT_MS)
      timing('бэкенд ответил healthz')
    } catch (e) {
      console.error('[main] backend failed to start:', e.message)
      Sentry.captureMessage('Backend failed to start within timeout')
      dialog.showErrorBox(
        'RestOS — Сервер не отвечает',
        `Бэкенд не запустился за ${Math.round(BACKEND_TIMEOUT_MS / 1000)} секунд.\n\nВозможные причины:\n• Не хватает интернета для скачивания PostgreSQL (~80 МБ) при первом запуске\n• Антивирус блокирует embedded-postgres или restos-server.exe\n• Порт ${API_PORT} занят другой программой\n\nЧто попробовать: закройте RestOS полностью и запустите заново (или перезагрузите ПК) — это освободит зависшие процессы прошлой версии.\n\nЛог: ${path.join(app.getPath('userData'), 'logs', 'main.log')}`,
      )
    }
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })

  app.on('before-quit', () => {
    app.isQuitting = true
    try { tray?.destroy() } catch {}
    stopSidecar()
  })
}

// ─── Window ────────────────────────────────────────────────────────────────
const SPLASH_PATH = path.join(__dirname, 'splash.html')
const INDEX_PATH = path.join(__dirname, 'frontend', 'index.html')
// Что перезагружать при did-fail-load / крэше рендерера: до готовности бэка —
// сплэш, после loadApp() — реальный SPA. Иначе ретрай грузил бы SPA поверх
// сплэша ещё до подъёма бэка.
let currentLoadTarget = SPLASH_PATH

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'RestOS',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    // Фон окна = фон сплэша: пока сплэш/SPA рисуются (и в момент подмены сплэша
    // на SPA) не мелькает белый прямоугольник.
    backgroundColor: '#f5f3f0',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      webSecurity: false,
      backgroundThrottling: false,
    },
    autoHideMenuBar: true,
    // По умолчанию окно maximize'ится (панель задач видна). Полноэкранный режим
    // включается ТОЛЬКО в новом POS (/pos2) через IPC 'set-fullscreen' (см.
    // ниже и PosV2Layout). F11 — ручной тумблер.
    show: false,
  })

  // Полноэкранный режим по запросу рендерера (новый POS включает на входе,
  // выключает на выходе). Гардим mainWindow — окно может быть уже закрыто.
  ipcMain.on('set-fullscreen', (_e, on) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setFullScreen(!!on)
  })

  // Сплэш грузим СРАЗУ (локальный файл, бэк не нужен) — окно появляется мгновенно.
  // Реальный SPA подменяет loadApp() по готовности бэка. did-fail-load ниже
  // перезагружает currentLoadTarget (сплэш до готовности, SPA после).
  mainWindow.loadFile(SPLASH_PATH).catch((e) => {
    console.error('[main] splash load error:', e)
  })

  mainWindow.once('ready-to-show', () => {
    timing('окно показано (сплэш)')
    mainWindow.show()
    mainWindow.maximize()
  })

  // Ключевая точка: SPA догрузился и отрисовался — это момент, когда кассир
  // реально видит рабочий экран. Сплэш игнорируем, он дешёвый.
  mainWindow.webContents.on('did-finish-load', () => {
    if (currentLoadTarget === INDEX_PATH) timing('SPA отрисован — ГОТОВО')
  })

  // Ctrl+Shift+I / Cmd+Opt+I — DevTools для дебага в проде.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'I' && (input.control || input.meta) && input.shift) {
      mainWindow.webContents.openDevTools({ mode: 'detach' })
    }
    if (input.type === 'keyDown' && input.key === 'F12') {
      mainWindow.webContents.openDevTools({ mode: 'detach' })
    }
    if (input.type === 'keyDown' && input.key === 'F5') {
      mainWindow.reload()
    }
    // F11 — тумблер полноэкранного режима (выход/вход, если нужно к панели задач).
    if (input.type === 'keyDown' && input.key === 'F11') {
      mainWindow.setFullScreen(!mainWindow.isFullScreen())
    }
  })

  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) {
      console.log(`[renderer ${level >= 3 ? 'ERR' : 'WARN'}] ${message} (${sourceId}:${line})`)
    }
  })

  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.log(`[renderer] did-fail-load: ${code} ${desc} ${url}`)
    setTimeout(() => {
      try { mainWindow?.loadFile(currentLoadTarget) } catch {}
    }, 1500)
  })

  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.log(`[renderer] crashed:`, details)
    setTimeout(() => { try { mainWindow?.reload() } catch {} }, 500)
  })

  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault()
      mainWindow.hide()
    }
  })
}

// loadApp — подменяет сплэш реальным SPA. Вызывается из app.ready по готовности
// бэка (healthz OK). Окно уже показано (ready-to-show на сплэше), поэтому подмена
// бесшовна: backgroundColor окна = фон сплэша, белого мелькания нет.
function loadApp() {
  currentLoadTarget = INDEX_PATH
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadFile(INDEX_PATH).catch((e) => {
      console.error('[main] app load error:', e)
    })
  }
}

// ─── Tray ──────────────────────────────────────────────────────────────────
function setupTray() {
  try {
    const iconPath = path.join(__dirname, 'assets', 'icon.png')
    const trayIcon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 })
    tray = new Tray(trayIcon)
    tray.setToolTip('RestOS')
    const ctxMenu = Menu.buildFromTemplate([
      { label: 'Открыть RestOS', click: () => { mainWindow?.show(); mainWindow?.focus() } },
      { label: 'Показать логи', click: () => shell.openPath(path.join(app.getPath('userData'), 'logs')) },
      { type: 'separator' },
      { label: 'Выход', click: () => { app.isQuitting = true; app.quit() } },
    ])
    tray.setContextMenu(ctxMenu)
    tray.on('click', () => { mainWindow?.show(); mainWindow?.focus() })
  } catch (e) {
    console.error('[tray] init failed:', e)
  }
}

// ─── Auto-updater ──────────────────────────────────────────────────────────
//
// State machine, exposed to renderer через IPC:
//   idle           — нет проверок
//   checking       — checkForUpdates() в полёте
//   available      — есть новая версия, скачивается
//   downloading    — есть % прогресса
//   ready          — скачано, можно installUpdate()
//   not-available  — уже последняя
//   error          — что-то пошло не так
let updateState = { status: 'idle', version: null, percent: 0, error: null }

function setUpdateState(patch) {
  updateState = { ...updateState, ...patch }
  try {
    mainWindow?.webContents.send('update-status', updateState)
  } catch {}
}

function setupAutoUpdater() {
  if (!app.isPackaged) {
    // В dev — auto-updater отключён, но IPC всё равно работает (вернёт not-available).
    setUpdateState({ status: 'not-available' })
    return
  }
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('error', (err) => {
    console.log('[updater] error:', err?.message ?? err)
    setUpdateState({ status: 'error', error: String(err?.message ?? err) })
  })
  autoUpdater.on('checking-for-update', () => {
    setUpdateState({ status: 'checking', error: null })
  })
  autoUpdater.on('update-available', (info) => {
    console.log('[updater] update-available:', info?.version)
    setUpdateState({ status: 'available', version: info?.version, percent: 0 })
  })
  autoUpdater.on('update-not-available', () => {
    setUpdateState({ status: 'not-available' })
  })
  autoUpdater.on('download-progress', (p) => {
    setUpdateState({ status: 'downloading', percent: Math.round(p?.percent || 0) })
  })
  autoUpdater.on('update-downloaded', (info) => {
    console.log('[updater] update-downloaded:', info?.version)
    setUpdateState({ status: 'ready', version: info?.version, percent: 100 })
  })
  // Не в момент старта: autoDownload=true и проверка сразу тянула инсталлятор
  // (десятки МБ) параллельно с распаковкой Postgres и парсингом SPA — на HDD и
  // слабом канале кассы это отнимало ровно тот ресурс, которого не хватает.
  // Полминуты роли не играют: обновление ставится при следующем выходе.
  setTimeout(() => {
    autoUpdater.checkForUpdatesAndNotify().catch(() => {})
  }, 30_000)
}

ipcMain.on('install-update', () => {
  try {
    // isQuitting=true ДО stopSidecar — иначе goProc.on('exit') перезапустит
    // sidecar прямо во время установки. Затем СИНХРОННО валим Go+PG, чтобы
    // installer не столкнулся с занятыми портами/локом, а новая версия
    // стартовала с чистого листа.
    app.isQuitting = true
    stopSidecar()
    autoUpdater.quitAndInstall()
  } catch (e) { console.error('install-update:', e) }
})

ipcMain.handle('check-update', async () => {
  if (!app.isPackaged) {
    setUpdateState({ status: 'not-available' })
    return updateState
  }
  try {
    setUpdateState({ status: 'checking', error: null })
    await autoUpdater.checkForUpdates()
    return updateState
  } catch (e) {
    setUpdateState({ status: 'error', error: String(e?.message ?? e) })
    return updateState
  }
})

ipcMain.handle('get-update-status', () => updateState)

// ─── LAN IP detection ──────────────────────────────────────────────────────
// Возвращает «лучший» (для backward compat) и весь список non-internal IPv4
// адресов — каждый соответствует одному из сетевых интерфейсов кассы.
//
// На кассе часто несколько IP:
//   - WiFi (192.168.1.X) — на нём сидят телефоны официантов
//   - Ethernet (10.0.0.X) — кабель в роутер
//   - Hyper-V/Docker (172.16.X.X) — виртуальные интерфейсы, бесполезны для LAN
//   - VPN (10.8.0.X, 100.64.X.X) — Tailscale/WireGuard, тоже бесполезны
//
// Раньше брали ПЕРВЫЙ попавшийся — если первым был Ethernet а телефон на WiFi,
// QR показывал неверный URL → телефон не подключался. v3.8.5: UI выводит
// список и юзер выбирает.
function detectLanIps() {
  const os = require('os')
  const ifs = os.networkInterfaces()
  const candidates = []
  for (const name of Object.keys(ifs)) {
    for (const addr of ifs[name] || []) {
      if (addr.family !== 'IPv4' || addr.internal) continue
      candidates.push({ iface: name, address: addr.address })
    }
  }
  const isWifi = (iface) => /wi-?fi|wlan|wireless|802\.11/i.test(iface)
  const isVirtual = (iface) => /v(ethernet|switch)|virtual|hyper-?v|docker|virtualbox|wsl|tailscale|wireguard|loopback/i.test(iface)

  // v3.8.6: возвращаем ТОЛЬКО WiFi-адаптеры (телефон официанта почти всегда
  // на WiFi). Если у кассы нет WiFi-адаптера вообще (редкость — только
  // Ethernet или кабельная-only касса) — fallback к обычным Ethernet,
  // отсеивая виртуальные (Hyper-V/Docker/VPN).
  const wifi = candidates.filter((c) => isWifi(c.iface))
  if (wifi.length > 0) return wifi
  return candidates.filter((c) => !isVirtual(c.iface))
}

ipcMain.handle('get-lan-ip', () => {
  const list = detectLanIps()
  return list[0]?.address || '127.0.0.1'
})

// v3.8.5: для UI который хочет показать ВСЕ интерфейсы (например, страница QR
// предлагает юзеру выбрать какой IP вшить в QR).
ipcMain.handle('get-lan-ips', () => {
  return detectLanIps()
})

ipcMain.handle('capture-screenshot', async () => {
  try {
    const img = await mainWindow.webContents.capturePage()
    return img.toDataURL()
  } catch (e) {
    console.error('screenshot:', e)
    return null
  }
})
