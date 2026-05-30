// RestOS v4 Electron main process.
//
// Architecture:
//   [Electron main] spawns Go-binary as sidecar child process →
//   Go-server embeds Postgres 16 + serves http://127.0.0.1:3001 →
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

const API_PORT = 3001
const API_BASE = `http://127.0.0.1:${API_PORT}`

let mainWindow = null
let tray = null
let goProc = null
let goReady = false

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
//   3. Fallback: если postmaster.pid не существует, но порт 54329 занят —
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

  // 3) Fallback: kill процесса на порту 54329 если lock-файл отсутствует
  //    или kill по pid не сработал.
  if (!killedByLock) {
    try {
      if (isWin) {
        const out = execSync('netstat -ano | findstr :54329', { encoding: 'utf8' })
        const pids = new Set()
        for (const line of out.split('\n')) {
          const m = line.trim().match(/\s+(\d+)\s*$/)
          if (m) pids.add(m[1])
        }
        for (const pid of pids) {
          try { execSync(`taskkill /F /PID ${pid} /T 2>nul`, { stdio: 'ignore' }) } catch {}
        }
        if (pids.size > 0) console.log('[sidecar] killed port:54329 holders', [...pids].join(','))
      } else {
        execSync('lsof -ti:54329 | xargs -r kill -9 2>/dev/null || true', { stdio: 'ignore' })
      }
    } catch {}
  }

  console.log('[sidecar] cleanup done')
}

// Проверка что порт 3001 свободен. Если занят — пробуем убить владельца.
function ensurePortFree(port) {
  return new Promise((resolve) => {
    const tester = net.createServer()
    tester.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.log(`[sidecar] port ${port} is busy — attempting to free`)
        killStaleSidecars()
        // Дать ОС время освободить порт.
        setTimeout(() => resolve(false), 1500)
      } else {
        resolve(true)
      }
    })
    tester.once('listening', () => {
      tester.close(() => resolve(true))
    })
    tester.listen(port, '127.0.0.1')
  })
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
    RESTOS_HTTP_ADDR: `127.0.0.1:${API_PORT}`,
    // Cache PG binary so embedded-postgres reuses it across runs.
    RESTOS_PG_CACHE: path.join(app.getPath('userData'), 'pg-cache'),
    // Ed25519 public key для verify license-токенов. Вшит в installer.
    // Меняется ТОЛЬКО при ротации keypair (см. restos-admin/README).
    // Соответствующий PRIVATE_KEY хранится в Vercel env вашей админки.
    RESTOS_LICENSE_PUBLIC_KEY: 'NNsxnnh+jyMTw6GvrhfkbWTwMueYzG6zQ7RCN4x7qjM=',
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
      // Restart after a short delay.
      setTimeout(() => { if (!app.isQuitting) startSidecar() }, 2000)
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
  if (!goProc) return
  console.log('[sidecar] sending SIGTERM')
  try {
    if (process.platform === 'win32') {
      // On Windows there's no SIGTERM; use taskkill /T to kill tree (includes postgres child).
      const pid = goProc.pid
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'])
    } else {
      goProc.kill('SIGTERM')
    }
  } catch (e) {
    console.error('[sidecar] stop error:', e)
  }
  goProc = null
}

// Wait for backend /healthz to respond OK before showing window.
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
      setTimeout(poll, 500)
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
    // 1) Убить zombie sidecar'ы (restos-server + postgres) от прошлого crash,
    //    освободить порты 3001 (HTTP API) и 54329 (embedded PG).
    killStaleSidecars()
    await ensurePortFree(API_PORT)
    await ensurePortFree(54329)
    // 2) Стартуем sidecar.
    startSidecar()
    try {
      await waitForBackend(90000)
    } catch (e) {
      console.error('[main] backend failed to start:', e.message)
      Sentry.captureMessage('Backend failed to start within timeout')
      dialog.showErrorBox(
        'RestOS — Сервер не отвечает',
        `Бэкенд не запустился за 60 секунд.\n\nВозможные причины:\n• Не хватает интернета для скачивания PostgreSQL (~80 МБ) при первом запуске\n• Антивирус блокирует embedded-postgres\n• Порт ${API_PORT} занят другой программой\n\nЛог: ${path.join(app.getPath('userData'), 'logs', 'main.log')}`,
      )
    }
    createWindow()
    setupTray()
    setupAutoUpdater()
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
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'RestOS',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      webSecurity: false,
      backgroundThrottling: false,
    },
    autoHideMenuBar: true,
    show: false,
  })

  // Load the bundled SPA from disk (file://). The SPA fetches API from 127.0.0.1:3001.
  const indexPath = path.join(__dirname, 'frontend', 'index.html')
  mainWindow.loadFile(indexPath).catch((e) => {
    console.error('[main] loadFile error:', e)
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
    mainWindow.maximize()
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
  })

  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) {
      console.log(`[renderer ${level >= 3 ? 'ERR' : 'WARN'}] ${message} (${sourceId}:${line})`)
    }
  })

  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.log(`[renderer] did-fail-load: ${code} ${desc} ${url}`)
    setTimeout(() => {
      try { mainWindow?.loadFile(indexPath) } catch {}
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
  autoUpdater.checkForUpdatesAndNotify().catch(() => {})
}

ipcMain.on('install-update', () => {
  try { autoUpdater.quitAndInstall() } catch (e) { console.error('install-update:', e) }
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
// Возвращает первый non-internal IPv4 адрес — это адрес который видят
// другие устройства в той же WiFi-сети (телефон официанта).
ipcMain.handle('get-lan-ip', () => {
  try {
    const os = require('os')
    const ifs = os.networkInterfaces()
    for (const name of Object.keys(ifs)) {
      for (const addr of ifs[name] || []) {
        if (addr.family === 'IPv4' && !addr.internal) {
          return addr.address
        }
      }
    }
  } catch (e) {
    console.error('[get-lan-ip] error:', e)
  }
  return '127.0.0.1'
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
