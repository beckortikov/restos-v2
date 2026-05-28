/**
 * Standalone-обёртка для desktop/api-server.js без Electron.
 *
 * Назначение: для дев-машины без Electron (например, mac разработчика без
 * сборки) поднять тот же Express :3001 + PGlite, что у кассира на проде.
 * Используется perf-тестами для измерения реальных цифр (loopback latency,
 * PGlite быстродействие) — облачный Supabase не репрезентативен.
 *
 * Хитрость: api-server.js делает `require('electron').app.getPath('userData')`
 * без try/catch (см. строку ~1073). Подменяем модуль `electron` на shim,
 * возвращающий путь внутри desktop/data/, ДО первой загрузки api-server.
 *
 * НЕ ТРОГАЕМ production-файлы api-server.js / db.js / sync.js — мок живёт
 * только в этом скрипте.
 */
const path = require('path')
const fs = require('fs')
const Module = require('module')

const FAKE_USER_DATA = path.join(__dirname, 'data')
if (!fs.existsSync(FAKE_USER_DATA)) fs.mkdirSync(FAKE_USER_DATA, { recursive: true })

const electronShim = {
  app: {
    getPath(name) {
      // Electron поддерживает разные ключи: userData, logs, temp, …
      // Все мапим в один dev-каталог.
      const sub = name === 'userData' ? '' : name
      const p = sub ? path.join(FAKE_USER_DATA, sub) : FAKE_USER_DATA
      if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true })
      return p
    },
    getVersion: () => require('./package.json').version,
    getName: () => 'restos-desktop-standalone',
  },
  dialog: {
    showErrorBox(title, content) {
      console.error(`[electron-shim dialog] ${title}: ${content}`)
    },
  },
  BrowserWindow: class {},
  Tray: class {},
  Menu: { buildFromTemplate: () => ({}) },
  nativeImage: { createFromPath: () => ({}) },
  shell: { openExternal: (url) => console.log('[shim] openExternal', url) },
  ipcMain: { on() {}, handle() {} },
}

// Перехватываем require('electron') до его первой загрузки.
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === 'electron') return require.resolve('./standalone.js')
  return origResolve.call(this, request, parent, ...rest)
}
const origLoad = Module._load
Module._load = function (request, parent, ...rest) {
  if (request === 'electron') return electronShim
  return origLoad.call(this, request, parent, ...rest)
}

// Теперь подгружаем api-server.js — он увидит наш shim вместо Electron.
const { startAPIServer } = require('./api-server')
const { DB_PATH } = require('./db')

const PORT = Number(process.env.PORT) || 3001

startAPIServer(PORT)
  .then(() => {
    console.log(`[standalone] listening :${PORT}`)
    console.log(`[standalone] data dir: ${DB_PATH}`)
    console.log(`[standalone] curl http://localhost:${PORT}/rest/v1/restaurants`)
  })
  .catch((err) => {
    console.error('[standalone] startup failed:', err)
    process.exit(1)
  })

// Graceful shutdown
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`\n[standalone] received ${sig}, exiting`)
    process.exit(0)
  })
}
