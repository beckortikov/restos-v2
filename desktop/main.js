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

const { app, BrowserWindow, Tray, Menu, nativeImage, shell, ipcMain } = require('electron')
const path = require('path')
const fs = require('fs')
const http = require('http')
const { spawn } = require('child_process')
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

function startSidecar() {
  const exe = sidecarPath()
  if (!fs.existsSync(exe)) {
    console.error('[sidecar] binary not found:', exe)
    return
  }
  console.log('[sidecar] starting:', exe)

  const env = {
    ...process.env,
    RESTOS_DATA_DIR: app.getPath('userData'),
    RESTOS_HTTP_ADDR: `127.0.0.1:${API_PORT}`,
    // Cache PG binary so embedded-postgres reuses it across runs.
    RESTOS_PG_CACHE: path.join(app.getPath('userData'), 'pg-cache'),
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
function waitForBackend(timeoutMs = 60000) {
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
    startSidecar()
    try {
      await waitForBackend()
    } catch (e) {
      console.error('[main] backend failed to start:', e.message)
      Sentry.captureMessage('Backend failed to start within timeout')
      // Open window anyway — user will see error from frontend.
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
function setupAutoUpdater() {
  if (!app.isPackaged) return
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('error', (err) => console.log('[updater] error:', err?.message ?? err))
  autoUpdater.on('update-available', (info) => console.log('[updater] update-available:', info?.version))
  autoUpdater.on('update-downloaded', (info) => {
    console.log('[updater] update-downloaded:', info?.version)
    mainWindow?.webContents.send('update-status', { type: 'downloaded', version: info?.version })
  })
  autoUpdater.checkForUpdatesAndNotify().catch(() => {})
}

ipcMain.on('install-update', () => {
  try { autoUpdater.quitAndInstall() } catch (e) { console.error('install-update:', e) }
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
