const express = require('express')
const cors = require('cors')
const os = require('os')
const path = require('path')
const fs = require('fs')
const { initDB, getDB, DB_PATH } = require('./db')

// HTTPS / self-signed cert stack removed (Этап 7-Light): the native waiter
// app uses WebView with cleartext HTTP traffic and doesn't need PWA-grade
// secure-origin. QR on /connect now encodes plain http://<ip>:3001.
//
// ─── PostgREST-compatible API ───────────────────────────────────────────────

// Build a single WHERE expression for one (key, val) PostgREST filter pair.
// Returns { sql, params, nextIdx } where sql may be empty if unsupported.
function buildFilter(key, val, startIdx) {
  if (typeof val !== 'string') return { sql: '', params: [], nextIdx: startIdx }
  // Single-param helpers
  const param1 = (sql, value) => ({
    sql: sql.replace('$?', `$${startIdx}`),
    params: [value],
    nextIdx: startIdx + 1,
  })
  const noParam = (sql) => ({ sql, params: [], nextIdx: startIdx })

  if (val.startsWith('eq.')) {
    const v = val.slice(3)
    if (v === 'true')  return noParam(`"${key}" = true`)
    if (v === 'false') return noParam(`"${key}" = false`)
    if (v === 'null')  return noParam(`"${key}" IS NULL`)
    return param1(`"${key}" = $?`, v)
  }
  if (val.startsWith('neq.')) return param1(`"${key}" != $?`, val.slice(4))
  if (val.startsWith('gt.'))  return param1(`"${key}" > $?`,  val.slice(3))
  if (val.startsWith('gte.')) return param1(`"${key}" >= $?`, val.slice(4))
  if (val.startsWith('lt.'))  return param1(`"${key}" < $?`,  val.slice(3))
  if (val.startsWith('lte.')) return param1(`"${key}" <= $?`, val.slice(4))
  // PostgREST uses `*` as wildcard instead of `%`. Translate.
  // Explicit ::text cast prevents PG 'could not determine data type of parameter' errors.
  if (val.startsWith('like.'))  return param1(`"${key}" LIKE $?::text`,  val.slice(5).replace(/\*/g, '%'))
  // Use LOWER() instead of ILIKE because PGlite's default collation doesn't
  // fold Unicode (Cyrillic) characters case-insensitively in ILIKE.
  if (val.startsWith('ilike.')) return param1(`LOWER("${key}"::text) LIKE LOWER($?::text)`, val.slice(6).replace(/\*/g, '%'))
  if (val.startsWith('in.')) {
    let raw = val.slice(3)
    if (raw.startsWith('(') && raw.endsWith(')')) raw = raw.slice(1, -1)
    const values = raw.split(',').filter(v => v.length > 0)
    if (values.length === 0) return noParam('FALSE')
    let idx = startIdx
    const placeholders = values.map(() => `$${idx++}`).join(',')
    return { sql: `"${key}" IN (${placeholders})`, params: values, nextIdx: idx }
  }
  if (val.startsWith('is.')) {
    const v = val.slice(3)
    if (v === 'null')  return noParam(`"${key}" IS NULL`)
    if (v === 'true')  return noParam(`"${key}" = true`)
    if (v === 'false') return noParam(`"${key}" = false`)
    return noParam('')
  }
  if (val.startsWith('not.is.')) {
    const v = val.slice(7)
    if (v === 'null')  return noParam(`"${key}" IS NOT NULL`)
    if (v === 'true')  return noParam(`"${key}" != true`)
    if (v === 'false') return noParam(`"${key}" != false`)
    return noParam('')
  }
  if (val.startsWith('not.eq.'))   return param1(`"${key}" != $?`, val.slice(7))
  if (val.startsWith('not.like.')) return param1(`"${key}" NOT LIKE $?::text`,  val.slice(9).replace(/\*/g, '%'))
  if (val.startsWith('not.ilike.'))return param1(`LOWER("${key}"::text) NOT LIKE LOWER($?::text)`, val.slice(10).replace(/\*/g, '%'))
  return noParam('')
}

// Parse PostgREST `or=(filter1,filter2,...)` into a single SQL OR expression.
// filters look like `col.eq.value` or `col.is.null` or `col.ilike.*foo*`.
function parseOrFilter(orVal, startIdx) {
  let raw = orVal
  if (raw.startsWith('(') && raw.endsWith(')')) raw = raw.slice(1, -1)
  const parts = []
  // Split on commas that are not inside parentheses (to be safe with in.(a,b))
  let depth = 0, buf = ''
  for (const ch of raw) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) { if (buf) parts.push(buf); buf = ''; continue }
    buf += ch
  }
  if (buf) parts.push(buf)

  const sqls = []
  const params = []
  let i = startIdx
  for (const p of parts) {
    // Each part is "col.op.value" possibly with 'not.' prefix
    const dotIdx = p.indexOf('.')
    if (dotIdx < 0) continue
    const col = p.slice(0, dotIdx)
    const opVal = p.slice(dotIdx + 1)
    const f = buildFilter(col, opVal, i)
    if (f.sql) {
      sqls.push(f.sql)
      params.push(...f.params)
      i = f.nextIdx
    }
  }
  return {
    sql: sqls.length > 0 ? '(' + sqls.join(' OR ') + ')' : '',
    params,
    nextIdx: i,
  }
}

function parseFilters(query) {
  const filters = []
  const params = []
  let paramIdx = 1
  for (const [key, val] of Object.entries(query)) {
    if (['select', 'order', 'limit', 'offset', 'on_conflict'].includes(key)) continue
    if (typeof val !== 'string') continue

    // Handle PostgREST 'or=(...)' compound filter
    if (key === 'or') {
      const r = parseOrFilter(val, paramIdx)
      if (r.sql) { filters.push(r.sql); params.push(...r.params); paramIdx = r.nextIdx }
      continue
    }
    // Handle PostgREST 'and=(...)' compound filter
    if (key === 'and') {
      const r = parseOrFilter(val, paramIdx)
      // Same parsing, but join with AND. parseOrFilter currently joins with OR;
      // for AND we replicate the loop:
      const sqls = []
      let raw = val
      if (raw.startsWith('(') && raw.endsWith(')')) raw = raw.slice(1, -1)
      let i = paramIdx
      for (const p of raw.split(',')) {
        const dotIdx = p.indexOf('.')
        if (dotIdx < 0) continue
        const f = buildFilter(p.slice(0, dotIdx), p.slice(dotIdx + 1), i)
        if (f.sql) { sqls.push(f.sql); params.push(...f.params); i = f.nextIdx }
      }
      if (sqls.length) { filters.push('(' + sqls.join(' AND ') + ')'); paramIdx = i }
      continue
    }

    const f = buildFilter(key, val, paramIdx)
    if (f.sql) {
      filters.push(f.sql)
      params.push(...f.params)
      paramIdx = f.nextIdx
    }
  }
  return { where: filters.length > 0 ? ' WHERE ' + filters.join(' AND ') : '', params }
}

function parseOrder(query) {
  if (!query.order) return ''
  return ' ORDER BY ' + query.order.split(',').map(p => {
    const [col, dir] = p.trim().split('.')
    return `"${col}" ${dir === 'desc' ? 'DESC' : 'ASC'}`
  }).join(', ')
}

const TABLES = [
  'restaurants', 'users', 'zones', 'tables', 'menu_items', 'tech_card_lines',
  'ingredients', 'orders', 'order_items', 'order_item_modifiers',
  'financial_accounts', 'financial_operations', 'stock_movements',
  'suppliers', 'stock_receipts', 'stock_receipt_lines',
  'cash_shifts', 'cash_shift_operations', 'reservations', 'customers',
  'order_voids', 'order_splits', 'modifier_groups', 'modifiers',
  'semi_finished_types', 'semi_recipe_lines', 'semi_finished_stock',
  'stock_writeoffs', 'stock_writeoff_lines', 'batch_cooking_logs',
  'supply_expenses', 'time_entries', 'assets', 'liabilities', 'equity_entries',
  'budget_lines', 'audit_log', 'menu_categories', 'custom_categories',
  'inventory_checks', 'inventory_check_lines',
]

// Desktop control state — populated by main.js via setDesktopHandlers
let desktopHandlers = {
  checkUpdate: null,
  installUpdate: null,
  openConnect: null,
}
let updateState = { status: 'idle', version: null, percent: 0, error: null }

// Most recent SyncEngine instance — set on activation or boot, used by the
// manual /sync/reconcile endpoint.
let activeSyncEngine = null

async function startAPIServer(port = 3001) {
  const app = express()
  app.use(cors())
  app.use(express.json({ limit: '10mb' }))

  // Per-request log of every incoming hit so we can debug "Cannot GET /connect"
  // and similar reports from waiter phones.
  app.use((req, _res, next) => {
    if (req.path === '/connect' || req.path.startsWith('/connect/')) {
      console.log(`[REQ] ${req.method} ${req.path} from ${req.ip || req.headers['x-forwarded-for'] || 'unknown'}`)
    }
    next()
  })

  // ─── /connect routes — registered FIRST so nothing (static middleware,
  // catch-all, anything) can shadow them. The waiter app reads this URL
  // by scanning the QR — see components/native-connect-screen.tsx.
  function buildWaiterUrl(ip) {
    return `http://${ip}:${port}`
  }

  // Diagnostic ring buffer — last 50 requests to /connect*. Surfaced via
  // /connect/diag and live-streamed in the /connect HTML page so a manager
  // can confirm in real time whether the phone reached the server.
  const recentConnectRequests = []
  function recordConnectRequest(req) {
    const ip = req.ip || req.headers['x-forwarded-for'] || req.connection?.remoteAddress || 'unknown'
    recentConnectRequests.push({
      ts: Date.now(),
      ip: String(ip).replace(/^::ffff:/, ''),
      method: req.method,
      path: req.path,
      ua: String(req.headers['user-agent'] || '').slice(0, 200),
    })
    while (recentConnectRequests.length > 50) recentConnectRequests.shift()
  }

  app.get('/connect/qr.png', async (req, res) => {
    recordConnectRequest(req)
    try {
      const QRCode = require('qrcode')
      const ipQuery = String(req.query.ip || '').trim()
      const ip = ipQuery && /^\d{1,3}(\.\d{1,3}){3}$/.test(ipQuery) ? ipQuery : (getLocalIP() || '127.0.0.1')
      const url = buildWaiterUrl(ip)
      const buf = await QRCode.toBuffer(url, { width: 240, margin: 1, errorCorrectionLevel: 'M' })
      res.type('png').set('Cache-Control', 'no-store').send(buf)
    } catch (e) {
      console.error('[qr] generation failed:', e && e.message)
      res.status(500).send('qr generation failed')
    }
  })

  app.get('/connect/diag', (req, res) => {
    const ips = getLocalIPs()
    res.json({
      version: require('./package.json').version,
      uptime_sec: Math.round(process.uptime()),
      port,
      lan_ips: ips,
      primary_ip: ips[0] || '127.0.0.1',
      waiter_url: buildWaiterUrl(ips[0] || '127.0.0.1'),
      recent_connect_requests: recentConnectRequests.slice().reverse(),
    })
  })

  app.get('/connect', (req, res) => {
    recordConnectRequest(req)
    try {
      const ips = getLocalIPs()
      const primaryIp = ips[0] || '127.0.0.1'
      const url = buildWaiterUrl(primaryIp)

      // Render one card per detected IP with its own QR — the manager can
      // pick the network the waiter phone is actually on.
      const qrCards = ips.map((ip, i) => `
<div class="qr-card${i === 0 ? ' primary' : ''}">
  <div class="qr"><img src="/connect/qr.png?ip=${ip}" width="180" height="180" alt="QR ${ip}"></div>
  <div class="url">http://${ip}:${port}</div>
  ${i === 0 ? '<div class="badge">Основной</div>' : ''}
</div>`).join('')

      res.type('html').send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>RestOS — Подключение официантов</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui;background:#0a0a0a;color:#fff;min-height:100vh;padding:24px;display:flex;justify-content:center}
.wrap{max-width:720px;width:100%}
h1{font-size:22px;margin-bottom:6px}p.sub{color:#a1a1aa;font-size:14px;margin-bottom:24px}
.qr-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin-bottom:20px}
.qr-card{background:#18181b;border:1px solid #27272a;border-radius:14px;padding:18px;text-align:center;position:relative}
.qr-card.primary{border-color:#3b82f6}
.qr-card .badge{position:absolute;top:8px;right:8px;background:#3b82f6;color:#fff;font-size:10px;font-weight:600;padding:2px 8px;border-radius:999px}
.qr-card .qr img{display:block;margin:0 auto 10px;border-radius:6px;background:#fff;padding:6px}
.qr-card .url{font-family:monospace;font-size:13px;color:#3b82f6;word-break:break-all}
.steps{background:#18181b;border:1px solid #27272a;border-radius:12px;padding:16px;margin-bottom:16px;font-size:13px;color:#d4d4d8}
.steps b{color:#fff;display:block;margin-bottom:6px}
.steps ol{padding-left:18px}.steps li{margin:3px 0}
.log{background:#0f0f10;border:1px solid #27272a;border-radius:10px;padding:12px;font-family:monospace;font-size:11px;color:#a1a1aa;max-height:160px;overflow-y:auto;margin-top:14px}
.log-title{font-size:12px;color:#71717a;margin-bottom:6px;font-family:system-ui}
.log .row{padding:2px 0;border-bottom:1px solid #1a1a1c}.log .row:last-child{border:none}
.hint{color:#52525b;font-size:12px;text-align:center;margin-top:18px}</style></head>
<body><div class="wrap">
<h1>Подключение официантов</h1>
<p class="sub">Откройте RestOS Waiter на телефоне → «Сканировать QR» → наведите на нужный код ниже.</p>

<div class="qr-grid">${qrCards}</div>

<div class="steps">
<b>Если у вас несколько Wi-Fi-сетей:</b>
<ol>
<li>Убедитесь, что телефон в той же сети, что и компьютер ресторана</li>
<li>Сканируйте QR-код, помеченный как «Основной»</li>
<li>Если не открылось — попробуйте другой QR из списка</li>
</ol>
</div>

<div class="log">
  <div class="log-title">Лог подключений (обновляется каждые 2 сек):</div>
  <div id="log"></div>
</div>

<p class="hint">Версия ${require('./package.json').version} · Порт ${port}</p>
</div>
<script>
async function tick() {
  try {
    const r = await fetch('/connect/diag', { cache: 'no-store' })
    const d = await r.json()
    const el = document.getElementById('log')
    el.innerHTML = (d.recent_connect_requests || []).slice(0, 20).map(e => {
      const t = new Date(e.ts).toLocaleTimeString('ru')
      const ua = (e.ua || '').includes('iPhone') ? 'iPhone' : (e.ua || '').includes('Android') ? 'Android' : ''
      return '<div class="row">' + t + ' · ' + e.method + ' ' + e.path + ' ← ' + e.ip + (ua ? ' (' + ua + ')' : '') + '</div>'
    }).join('') || '<div class="row" style="color:#52525b">— ожидаем запросы от телефонов —</div>'
  } catch {}
}
tick(); setInterval(tick, 2000)
</script>
</body></html>`)
    } catch (e) {
      console.error('[connect] handler error:', e && e.message)
      res.status(500).type('text').send('connect page error: ' + (e && e.message || 'unknown'))
    }
  })

  await initDB()

  // ─── SSE: real-time notifications to all connected clients ────────────
  const sseClients = new Set()

  app.get('/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    })
    res.write('data: {"type":"connected"}\n\n')
    sseClients.add(res)

    // Keep-alive ping каждые 2 секунды. Клиент-watchdog (lib/realtime.ts)
    // проверяет lastEventAt каждые 2с с порогом 5с — если ping не дошёл
    // (screen-sleep на Android Capacitor → зомби-сокет) reconnect отрабатывает
    // в пределах 5с. Трафик минимальный (~50 байт/2с/клиент).
    const pingInterval = setInterval(() => {
      try {
        res.write(`data: {"type":"ping","ts":${Date.now()}}\n\n`)
      } catch {
        clearInterval(pingInterval)
      }
    }, 2_000)

    req.on('close', () => {
      clearInterval(pingInterval)
      sseClients.delete(res)
    })
  })

  function notifyClients(tableName, action) {
    const msg = `data: ${JSON.stringify({ type: 'change', table: tableName, action, ts: Date.now() })}\n\n`
    for (const client of sseClients) {
      try { client.write(msg) } catch { sseClients.delete(client) }
    }
  }

  // Single source of SSE truth — every write that fires the sync_log trigger
  // pg_notify's the 'restos_change' channel. Listen here and forward to LAN
  // clients. Catches writes that came from the REST handlers, the sync pull,
  // direct cleanup queries, anything that mutates a tracked table.
  try {
    const db = getDB()
    if (db && typeof db.listen === 'function') {
      await db.listen('restos_change', (payload) => {
        try {
          const data = JSON.parse(payload)
          if (data && data.table) notifyClients(data.table, data.op || 'change')
        } catch { /* malformed payload — ignore */ }
      })
      console.log('[sse] subscribed to PGlite NOTIFY restos_change')
    } else {
      console.warn('[sse] PGlite listen() not available — relying on per-handler notifyClients only')
    }
  } catch (e) {
    console.warn('[sse] LISTEN setup failed:', e && e.message)
  }

  // Serve frontend static assets (JS, CSS, images) but NOT index.html
  // index.html is handled by the SPA fallback which checks activation status
  const frontendDir = path.join(__dirname, 'frontend')
  if (fs.existsSync(frontendDir)) {
    app.use(express.static(frontendDir, { index: false }))
  }

  // ─── PostgREST embed resolver ─────────────────────────────────────────────
  // Maps known FK relationships that the default `table.replace(/s$/,'')+'_id'`
  // rule can't infer (prefixed table names, group_id, etc.).
  const FK_MAP = {
    // parent → { child → fk_column_in_child }
    stock_writeoffs:     { stock_writeoff_lines: 'writeoff_id' },
    stock_receipts:      { stock_receipt_lines: 'receipt_id' },
    semi_finished_types: { semi_recipe_lines: 'semi_type_id', semi_finished_stock: 'semi_type_id' },
    cash_shifts:         { cash_shift_operations: 'shift_id' },
    modifier_groups:     { modifiers: 'group_id' },
    order_items:         { order_item_modifiers: 'order_item_id' },
  }

  function getChildFk(parent, child) {
    if (FK_MAP[parent]?.[child]) return FK_MAP[parent][child]
    return parent.replace(/s$/, '') + '_id'
  }

  // Lift numeric strings to numbers (PGlite returns NUMERIC as string).
  function liftNumerics(row) {
    const r = { ...row }
    for (const [k, v] of Object.entries(r)) {
      if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)
          && !k.endsWith('_id') && k !== 'id' && k !== 'phone' && k !== 'password' && k !== 'restaurant_id') {
        r[k] = Number(v)
      }
    }
    return r
  }

  // Parse a PostgREST select string into an array of embed specs.
  // Examples it handles:
  //   `*`
  //   `*, child(*)`
  //   `*, child(*), parent(name)`
  //   `*, alias:parent!fk_constraint(name)`
  //   `id, name, total`     (column list — also returned)
  function parseSelect(selectStr) {
    if (!selectStr) selectStr = '*'
    const embeds = []
    const cols = []
    // Split top-level by commas (respecting parentheses)
    let depth = 0, buf = ''
    const parts = []
    for (const ch of selectStr) {
      if (ch === '(') depth++
      if (ch === ')') depth--
      if (ch === ',' && depth === 0) { parts.push(buf.trim()); buf = ''; continue }
      buf += ch
    }
    if (buf.trim()) parts.push(buf.trim())

    for (const p of parts) {
      // alias:table!fk_constraint(cols)  OR  table!fk_constraint(cols)  OR  table(cols)
      const m = p.match(/^(?:(\w+):)?(\w+)(?:!(\w+))?\((.*)\)$/)
      if (m) {
        embeds.push({ alias: m[1] || m[2], table: m[2], fkConstraint: m[3], cols: m[4].trim() })
      } else if (p === '*') {
        cols.push('*')
      } else {
        cols.push(p)
      }
    }
    return { cols, embeds }
  }

  // Try to find the FK column in `parent` table that links to `child` (an aliased embed).
  // Uses the explicit constraint name when present (e.g., cash_shifts_opened_by_fkey → opened_by).
  async function findParentFkCol(db, parentTable, childTable, fkConstraint) {
    if (fkConstraint) {
      // Constraint name pattern: <parentTable>_<col>_fkey
      const m = fkConstraint.match(new RegExp(`^${parentTable}_(.+)_fkey$`))
      if (m) return m[1]
    }
    // Common candidates
    const candidates = [
      `${childTable.replace(/s$/, '')}_id`,    // user_id
      'created_by', 'user_id', 'opened_by', 'closed_by', 'cashier_id', 'waiter_id',
      'approved_by', 'paid_by', 'confirmed_by', 'discount_approved_by',
    ]
    try {
      const cc = await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name = $1`, [parentTable])
      const existing = new Set(cc.rows.map(r => r.column_name))
      for (const c of candidates) if (existing.has(c)) return c
    } catch {}
    return null
  }

  async function resolveEmbeds(db, table, rows, embeds) {
    for (const embed of embeds) {
      // Determine if this is a child embed (array, FK in child) or parent embed (single, FK in parent)
      // Heuristic: if the child table has an FK that points to the parent table,
      // it's a child-of-parent (1:N). Otherwise it's a parent-of-this (N:1) lookup.
      const childTable = embed.table
      // Try child-of-parent first
      const childFk = getChildFk(table, childTable)
      let isChildEmbed = false
      try {
        const cc = await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`, [childTable, childFk])
        if (cc.rows.length > 0) isChildEmbed = true
      } catch {}

      // Pick which columns to select (PostgREST cols are within the parens)
      const colList = (embed.cols && embed.cols !== '*')
        ? embed.cols.split(',').map(c => `"${c.trim()}"`).join(',')
        : '*'

      if (isChildEmbed) {
        // 1:N — array of children
        for (const row of rows) {
          try {
            const r = await db.query(`SELECT ${colList} FROM "${childTable}" WHERE "${childFk}" = $1`, [row.id])
            row[embed.alias] = r.rows.map(liftNumerics)
          } catch { row[embed.alias] = [] }
        }
      } else {
        // N:1 — find FK in parent table
        const parentFkCol = await findParentFkCol(db, table, childTable, embed.fkConstraint)
        for (const row of rows) {
          if (!parentFkCol || row[parentFkCol] == null) { row[embed.alias] = null; continue }
          try {
            const r = await db.query(`SELECT ${colList} FROM "${childTable}" WHERE id = $1 LIMIT 1`, [row[parentFkCol]])
            row[embed.alias] = r.rows.length > 0 ? liftNumerics(r.rows[0]) : null
          } catch { row[embed.alias] = null }
        }
      }
    }
    return rows
  }

  // Tables that use soft-delete via is_deleted. Cloud queries hide is_deleted=true
  // rows by default (lib/supabase-queries.ts fetchMenuItems uses
  // .or('is_deleted.is.null,is_deleted.eq.false')). The PGlite emulator must
  // do the same so desktop / waiter PWA see the same set as web.
  const SOFT_DELETE_TABLES = new Set(['menu_items'])

  // GET
  async function handleGet(req, res, headOnly = false) {
    const table = req.params.table
    if (!TABLES.includes(table)) return res.status(404).json({ error: 'Not found' })
    try {
      const db = getDB()
      let { where, params } = parseFilters(req.query)
      const order = parseOrder(req.query)

      // Auto-hide soft-deleted rows unless the caller explicitly filtered on
      // is_deleted (or used or/and compound that may already cover it).
      if (SOFT_DELETE_TABLES.has(table) && !req.query.is_deleted && !req.query.or && !req.query.and) {
        const clause = `"${table}"."is_deleted" IS NOT TRUE`
        where = where ? `${where} AND ${clause}` : ` WHERE ${clause}`
      }

      // Range header support: "Range: 0-49" + "Range-Unit: items"
      let rangeFrom = null, rangeTo = null
      if (req.headers.range) {
        const m = req.headers.range.match(/^(\d+)-(\d+)$/)
        if (m) { rangeFrom = parseInt(m[1]); rangeTo = parseInt(m[2]) }
      }

      let limit = ''
      let offset = ''
      if (rangeFrom !== null && rangeTo !== null) {
        limit = ` LIMIT ${rangeTo - rangeFrom + 1}`
        offset = ` OFFSET ${rangeFrom}`
      } else {
        if (req.query.limit) limit = ` LIMIT ${parseInt(req.query.limit)}`
        if (req.query.offset) offset = ` OFFSET ${parseInt(req.query.offset)}`
      }

      // Parse select for partial columns + embeds
      const { cols: selectCols, embeds } = parseSelect(req.query.select)
      const wantCount = (req.headers.prefer || '').includes('count=exact')

      // Build the SELECT clause. Если клиент явно указал список колонок —
      // уважаем его и при наличии embeds: FK-колонка для 1:N embeds — это
      // всегда `id` основной таблицы (resolveEmbeds джойнит по orders.id =
      // order_items.order_id), поэтому добавляем `id` если её не было.
      // Без этого фикса фронт не мог сэкономить payload на «slim»-списках.
      let selectClause = '*'
      if (selectCols.length > 0 && !selectCols.includes('*')) {
        const cols = new Set(selectCols.map(c => c.trim()))
        if (embeds.length > 0) cols.add('id')
        selectClause = Array.from(cols).map(c => `"${c}"`).join(',')
      }

      // For HEAD requests with count=exact, we only need the count.
      let totalCount = null
      if (wantCount || headOnly) {
        try {
          const cr = await db.query(`SELECT COUNT(*) AS c FROM "${table}"${where}`, params)
          totalCount = Number(cr.rows[0]?.c || 0)
        } catch {}
      }

      let rows = []
      if (!headOnly) {
        const sql = `SELECT ${selectClause} FROM "${table}"${where}${order}${limit}${offset}`
        const result = await db.query(sql, params)
        rows = result.rows.map(liftNumerics)
        if (embeds.length > 0) {
          await resolveEmbeds(db, table, rows, embeds)
        }
      }

      if (totalCount !== null) {
        const from = rangeFrom ?? 0
        const to = rows.length > 0 ? from + rows.length - 1 : 0
        res.setHeader('Content-Range', `${from}-${to}/${totalCount}`)
      }

      // .single() — Accept: application/vnd.pgrst.object+json
      if ((req.headers.accept || '').includes('vnd.pgrst.object')) {
        res.setHeader('Content-Type', 'application/vnd.pgrst.object+json; charset=utf-8')
        if (rows.length === 0) return res.status(406).json({ message: 'Not found' })
        return res.send(JSON.stringify(rows[0]))
      }

      if (headOnly) {
        return res.status(rangeFrom !== null ? 206 : 200).end()
      }
      res.status(rangeFrom !== null ? 206 : 200).json(rows)
    } catch (err) {
      console.error(`[GET] ${table} error:`, err.message)
      res.status(500).json({ error: err.message })
    }
  }

  // Express routes HEAD requests through the GET handler automatically.
  // We detect the method inside the handler instead of registering a separate route.
  app.get('/rest/v1/:table', (req, res) => handleGet(req, res, req.method === 'HEAD'))

  // Helper: ensure all columns from `row` exist on `table`. Auto-creates missing
  // columns with a type matching the JS value (boolean/number/string/json).
  // Previously defaulted to TEXT — breaks when a later PATCH sends a boolean
  // value for a column that was auto-created as TEXT (PGlite: "Invalid input for string type").
  function inferPgType(v) {
    if (v === null || v === undefined) return 'TEXT'
    if (typeof v === 'boolean') return 'BOOLEAN'
    if (typeof v === 'number') return Number.isInteger(v) ? 'NUMERIC' : 'NUMERIC'
    if (typeof v === 'object') return 'JSONB'
    return 'TEXT'
  }
  async function getColumnTypes(db, table) {
    try {
      const r = await db.query(
        `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1`,
        [table]
      )
      const map = {}
      for (const row of r.rows) map[row.column_name] = row.data_type
      return map
    } catch { return {} }
  }
  // If a PATCH/POST sends a boolean to a TEXT column (legacy bug — older builds
  // auto-created columns as TEXT), heal the schema in place so PGlite doesn't
  // reject the insert with "Invalid input for string type". Same for numbers
  // going into TEXT columns.
  async function alignColumnTypes(db, table, row) {
    const types = await getColumnTypes(db, table)
    for (const [col, value] of Object.entries(row)) {
      if (value === null || value === undefined) continue
      const dbType = types[col]
      if (!dbType) continue
      if (dbType === 'text' && typeof value === 'boolean') {
        try {
          await db.query(
            `ALTER TABLE "${table}" ALTER COLUMN "${col}" TYPE BOOLEAN USING (
              CASE
                WHEN "${col}"::text IN ('true','t','1','yes') THEN true
                WHEN "${col}"::text IN ('false','f','0','no') THEN false
                WHEN "${col}" IS NULL THEN NULL
                ELSE false
              END)`
          )
          console.log(`[schema] ${table}.${col}: TEXT -> BOOLEAN`)
        } catch (e) { console.warn(`[schema] align ${table}.${col} bool failed:`, e.message) }
      } else if (dbType === 'text' && typeof value === 'number') {
        try {
          await db.query(
            `ALTER TABLE "${table}" ALTER COLUMN "${col}" TYPE NUMERIC USING (
              CASE WHEN "${col}" IS NULL OR "${col}"::text = '' THEN NULL
              ELSE "${col}"::text::NUMERIC END)`
          )
          console.log(`[schema] ${table}.${col}: TEXT -> NUMERIC`)
        } catch (e) { console.warn(`[schema] align ${table}.${col} num failed:`, e.message) }
      }
    }
  }
  async function ensureColumns(db, table, row) {
    try {
      const colCheck = await db.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
        [table]
      )
      const existing = new Set(colCheck.rows.map(r => r.column_name))
      for (const col of Object.keys(row)) {
        if (!existing.has(col)) {
          const type = inferPgType(row[col])
          try {
            await db.query(`ALTER TABLE "${table}" ADD COLUMN "${col}" ${type}`)
            console.log(`[schema] +${table}.${col} ${type}`)
          } catch (e) { /* ignore */ }
        }
      }
    } catch {}
  }

  // POST
  app.post('/rest/v1/:table', async (req, res) => {
    const table = req.params.table
    if (!TABLES.includes(table)) return res.status(404).json({ error: 'Not found' })
    try {
      const db = getDB()
      const data = Array.isArray(req.body) ? req.body : [req.body]
      // Auto-create missing columns based on first row keys
      if (data.length > 0) {
        await ensureColumns(db, table, data[0])
        await alignColumnTypes(db, table, data[0])
      }
      // Check if table has updated_at column
      let hasUpdatedAt = false
      try {
        const colCheck = await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name = $1 AND column_name = 'updated_at'`, [table])
        hasUpdatedAt = colCheck.rows.length > 0
      } catch {}
      const now = new Date().toISOString()
      const results = []
      for (const row of data) {
        if (!row.id) row.id = require('crypto').randomUUID()
        if (hasUpdatedAt && row.updated_at === undefined) row.updated_at = now
        const cols = Object.keys(row)
        const vals = cols.map((_, i) => `$${i + 1}`)
        const sql = `INSERT INTO "${table}" (${cols.map(c => `"${c}"`).join(',')}) VALUES (${vals.join(',')}) RETURNING *`
        const result = await db.query(sql, cols.map(c => row[c] ?? null))
        results.push(result.rows[0])
      }
      notifyClients(table, 'insert')
      // PostgREST shape contract:
      //  - Default `Accept` (or */*): always array, even for 1 row.
      //  - Accept `application/vnd.pgrst.object+json` (added by supabase-js
      //    when caller uses `.single()`): single object.
      // Our previous "always array" broke `.single()` callers — `data.id`
      // came back as `undefined`, then subsequent inserts wrote NULL into
      // FK columns (e.g. order_items.order_id) → cloud rejects with 23502.
      if ((req.headers.prefer || '').includes('return=representation')) {
        const wantsObject = (req.headers.accept || '').includes('application/vnd.pgrst.object+json')
        res.status(201).json(wantsObject ? (results[0] ?? null) : results)
      } else {
        res.status(201).json(Array.isArray(req.body) ? results : results[0])
      }
    } catch (err) {
      console.error(`[POST] ${table} error:`, err.message)
      res.status(400).json({ error: err.message })
    }
  })

  // PATCH
  app.patch('/rest/v1/:table', async (req, res) => {
    const table = req.params.table
    if (!TABLES.includes(table)) return res.status(404).json({ error: 'Not found' })
    try {
      const db = getDB()
      const { where, params } = parseFilters(req.query)
      const data = { ...req.body }
      // Auto-create missing columns + heal legacy TEXT columns when sending bool/number
      await ensureColumns(db, table, data)
      await alignColumnTypes(db, table, data)
      // Auto-set updated_at if table has it (for sync conflict resolution)
      try {
        const colCheck = await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name = $1 AND column_name = 'updated_at'`, [table])
        if (colCheck.rows.length > 0 && data.updated_at === undefined) {
          data.updated_at = new Date().toISOString()
        }
      } catch {}
      const cols = Object.keys(data)
      const setClause = cols.map((c, i) => `"${c}" = $${params.length + i + 1}`).join(', ')
      const sql = `UPDATE "${table}" SET ${setClause}${where} RETURNING *`
      const result = await db.query(sql, [...params, ...cols.map(c => data[c] ?? null)])
      notifyClients(table, 'update')
      if ((req.headers.prefer || '').includes('return=representation')) {
        // PostgREST shape: array unless `Accept: application/vnd.pgrst.object+json`
        // (which supabase-js adds when caller uses `.single()`).
        const wantsObject = (req.headers.accept || '').includes('application/vnd.pgrst.object+json')
        res.json(wantsObject ? (result.rows[0] ?? null) : result.rows)
      } else {
        res.json({ count: result.rows.length })
      }
    } catch (err) {
      console.error(`[PATCH] ${table} error:`, err.message)
      res.status(400).json({ error: err.message })
    }
  })

  // DELETE
  app.delete('/rest/v1/:table', async (req, res) => {
    const table = req.params.table
    if (!TABLES.includes(table)) return res.status(404).json({ error: 'Not found' })
    try {
      const db = getDB()
      const { where, params } = parseFilters(req.query)
      // sync_log trigger now captures deletes automatically — no need to record
      // them in a separate sync_deletions table anymore.
      await db.query(`DELETE FROM "${table}"${where}`, params)
      notifyClients(table, 'delete')
      res.json({ count: 1 })
    } catch (err) {
      console.error(`[DELETE] ${table} error:`, err.message)
      res.status(400).json({ error: err.message })
    }
  })

  // Fake auth
  app.get('/auth/v1/user', (req, res) => res.json(null))
  app.post('/auth/v1/token', (req, res) => res.json({ access_token: 'local', token_type: 'bearer' }))
  app.get('/auth/v1/settings', (req, res) => res.json({ external: {}, disable_signup: true }))

  // (Waiter /connect routes are registered at the very top of startAPIServer
  // so static middleware and catch-all can never shadow them.)

  // Status
  app.get('/status', async (req, res) => {
    const db = getDB()
    const r = await db.query('SELECT COUNT(*) as c FROM orders')
    res.json({ status: 'running', uptime: Math.round(process.uptime()), ordersCount: Number(r.rows[0]?.c || 0) })
  })

  // Sync queue health — for diagnostics + the network-status panel widget.
  app.get('/sync/status', async (req, res) => {
    const db = getDB()
    try {
      const r = await db.query(`
        SELECT
          (SELECT COUNT(*) FROM sync_log WHERE pushed_at IS NULL) AS unpushed,
          (SELECT COUNT(*) FROM sync_log WHERE pushed_at IS NULL AND push_attempts >= 5) AS errors,
          (SELECT MAX(pushed_at) FROM sync_log) AS last_pushed_at,
          (SELECT EXTRACT(EPOCH FROM (now() - MIN(created_at)))::int FROM sync_log WHERE pushed_at IS NULL) AS oldest_unpushed_age_sec
      `)
      const row = r.rows[0] || {}
      // Pull a few representative errors so the UI can show something
      // actionable instead of just a count.
      let topErrors = []
      try {
        const er = await db.query(`
          SELECT table_name, operation, push_attempts, last_error
            FROM sync_log
           WHERE pushed_at IS NULL AND last_error IS NOT NULL
           ORDER BY push_attempts DESC, id DESC
           LIMIT 3
        `)
        topErrors = (er.rows || []).map(x => ({
          table: x.table_name,
          op: x.operation,
          attempts: Number(x.push_attempts || 0),
          error: String(x.last_error || '').slice(0, 240),
        }))
      } catch {}
      res.json({
        unpushed: Number(row.unpushed || 0),
        errors: Number(row.errors || 0),
        lastPushedAt: row.last_pushed_at,
        oldestUnpushedAgeSec: row.oldest_unpushed_age_sec ?? null,
        topErrors,
      })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // Manual reconcile trigger — desktop only (localhost guard). One-way:
  // PGlite is truth, cloud orphans get DELETEd, missed pushes get requeued.
  // See SyncEngine.reconcileCloud() for the full diff logic.
  app.post('/sync/reconcile', async (req, res) => {
    if (!isLocalhost(req)) return res.status(403).json({ error: 'forbidden' })
    if (!activeSyncEngine) return res.status(503).json({ error: 'sync engine not started' })
    try {
      const summary = await activeSyncEngine.reconcileCloud()
      res.json({ ok: true, ...summary })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // ─── Admin: clear operational data for one restaurant ───────────────────
  // Wipes orders/shifts/financial_operations/stock_movements/audit_log/etc.
  // Preserves menu, ingredients, users, tables, zones, suppliers, customers,
  // financial_accounts, assets/liabilities/equity. Resets derived state
  // (visits_count, current_debt, balance, table.status) so stats match the
  // empty history. Intended for superadmin use after a trial period or
  // before handing a clean install to a customer.
  app.post('/admin/clear-operations', async (req, res) => {
    if (!isLocalhost(req)) return res.status(403).json({ error: 'forbidden' })
    const { restaurantId } = req.body || {}
    if (!restaurantId || typeof restaurantId !== 'string') {
      return res.status(400).json({ error: 'restaurantId (string) required' })
    }
    const db = getDB()
    const counts = {}
    try {
      await db.exec('BEGIN')
      const del = async (label, sql, params) => {
        const r = await db.query(sql, params)
        counts[label] = r.affectedRows ?? r.rows?.length ?? 0
      }

      // Layer 1 — children (delete via parent FK)
      await del('order_item_modifiers',
        `DELETE FROM order_item_modifiers WHERE order_item_id IN (
           SELECT id FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE restaurant_id = $1)
         )`, [restaurantId])
      await del('order_items',
        `DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE restaurant_id = $1)`, [restaurantId])
      await del('order_voids', `DELETE FROM order_voids WHERE restaurant_id = $1`, [restaurantId])
      await del('order_splits', `DELETE FROM order_splits WHERE restaurant_id = $1`, [restaurantId])
      await del('cash_shift_operations',
        `DELETE FROM cash_shift_operations WHERE shift_id IN (SELECT id FROM cash_shifts WHERE restaurant_id = $1)`, [restaurantId])
      await del('stock_writeoff_lines',
        `DELETE FROM stock_writeoff_lines WHERE writeoff_id IN (SELECT id FROM stock_writeoffs WHERE restaurant_id = $1)`, [restaurantId])
      await del('stock_receipt_lines',
        `DELETE FROM stock_receipt_lines WHERE receipt_id IN (SELECT id FROM stock_receipts WHERE restaurant_id = $1)`, [restaurantId])
      await del('inventory_check_lines',
        `DELETE FROM inventory_check_lines WHERE check_id IN (SELECT id FROM inventory_checks WHERE restaurant_id = $1)`, [restaurantId])

      // Layer 2 — operational parents
      await del('orders', `DELETE FROM orders WHERE restaurant_id = $1`, [restaurantId])
      await del('cash_shifts', `DELETE FROM cash_shifts WHERE restaurant_id = $1`, [restaurantId])
      await del('stock_writeoffs', `DELETE FROM stock_writeoffs WHERE restaurant_id = $1`, [restaurantId])
      await del('stock_receipts', `DELETE FROM stock_receipts WHERE restaurant_id = $1`, [restaurantId])
      await del('inventory_checks', `DELETE FROM inventory_checks WHERE restaurant_id = $1`, [restaurantId])
      await del('financial_operations', `DELETE FROM financial_operations WHERE restaurant_id = $1`, [restaurantId])
      await del('stock_movements', `DELETE FROM stock_movements WHERE restaurant_id = $1`, [restaurantId])
      await del('reservations', `DELETE FROM reservations WHERE restaurant_id = $1`, [restaurantId])
      await del('audit_log', `DELETE FROM audit_log WHERE restaurant_id = $1`, [restaurantId])
      await del('batch_cooking_logs', `DELETE FROM batch_cooking_logs WHERE restaurant_id = $1`, [restaurantId])
      await del('supply_expenses', `DELETE FROM supply_expenses WHERE restaurant_id = $1`, [restaurantId])
      await del('time_entries', `DELETE FROM time_entries WHERE restaurant_id = $1`, [restaurantId])

      // Layer 3 — reset derived state
      await db.query(
        `UPDATE customers SET visits_count = 0, total_spent = 0, avg_check = 0, last_visit_at = NULL WHERE restaurant_id = $1`,
        [restaurantId])
      await db.query(`UPDATE suppliers SET current_debt = 0 WHERE restaurant_id = $1`, [restaurantId])
      await db.query(`UPDATE financial_accounts SET balance = 0 WHERE restaurant_id = $1`, [restaurantId])
      // budget_lines.fact_amount may not exist on older installs — best-effort.
      try {
        await db.query(`UPDATE budget_lines SET fact_amount = 0 WHERE restaurant_id = $1`, [restaurantId])
      } catch {}
      await db.query(
        `UPDATE tables SET status = 'free', current_order_id = NULL, waiter_id = NULL, opened_at = NULL WHERE restaurant_id = $1`,
        [restaurantId])

      await db.exec('COMMIT')
      res.json({ ok: true, counts })
    } catch (e) {
      try { await db.exec('ROLLBACK') } catch {}
      res.status(500).json({ error: e.message, counts })
    }
  })

  // Clear all menu data for a restaurant: menu_items, tech_card_lines,
  // menu_categories, custom_categories, modifier_groups, modifiers,
  // semi-finished types/recipes/stock. Does NOT touch ingredients (those
  // are stock-side, не относятся к меню). Owner-only action; chains FK
  // deletions in the right order to respect ON DELETE constraints.
  app.post('/admin/clear-menu', async (req, res) => {
    if (!isLocalhost(req)) return res.status(403).json({ error: 'forbidden' })
    const { restaurantId } = req.body || {}
    if (!restaurantId || typeof restaurantId !== 'string') {
      return res.status(400).json({ error: 'restaurantId (string) required' })
    }
    const db = getDB()
    const counts = {}
    try {
      await db.exec('BEGIN')
      const del = async (label, sql, params) => {
        const r = await db.query(sql, params)
        counts[label] = r.affectedRows ?? r.rows?.length ?? 0
      }

      // Detach menu items from any open order_items (so deleting menu_items
      // doesn't violate FK on existing order history). Old orders keep
      // their item names — they were copied at insert time.
      await db.query(
        `UPDATE order_items SET menu_item_id = NULL
           WHERE menu_item_id IN (SELECT id FROM menu_items WHERE restaurant_id = $1)`,
        [restaurantId]
      )

      // Tech card lines reference both menu_items and ingredients/semi_fab.
      await del('tech_card_lines',
        `DELETE FROM tech_card_lines WHERE menu_item_id IN
           (SELECT id FROM menu_items WHERE restaurant_id = $1)`,
        [restaurantId])

      // Modifiers: delete child rows before groups.
      await del('modifiers',
        `DELETE FROM modifiers WHERE group_id IN
           (SELECT id FROM modifier_groups WHERE restaurant_id = $1)`,
        [restaurantId])
      await del('modifier_groups',
        `DELETE FROM modifier_groups WHERE restaurant_id = $1`,
        [restaurantId])

      // Semi-finished products: stock → recipe lines → types.
      try {
        await del('semi_finished_stock',
          `DELETE FROM semi_finished_stock WHERE semi_type_id IN
             (SELECT id FROM semi_finished_types WHERE restaurant_id = $1)`,
          [restaurantId])
      } catch {}
      try {
        await del('semi_recipe_lines',
          `DELETE FROM semi_recipe_lines WHERE semi_type_id IN
             (SELECT id FROM semi_finished_types WHERE restaurant_id = $1)`,
          [restaurantId])
      } catch {}
      try {
        await del('semi_finished_types',
          `DELETE FROM semi_finished_types WHERE restaurant_id = $1`,
          [restaurantId])
      } catch {}

      // Finally — the menu items themselves and category metadata.
      await del('menu_items',
        `DELETE FROM menu_items WHERE restaurant_id = $1`,
        [restaurantId])
      try {
        await del('menu_categories',
          `DELETE FROM menu_categories WHERE restaurant_id = $1`,
          [restaurantId])
      } catch {}
      try {
        await del('custom_categories',
          `DELETE FROM custom_categories WHERE restaurant_id = $1`,
          [restaurantId])
      } catch {}

      await db.exec('COMMIT')
      res.json({ ok: true, counts })
    } catch (e) {
      try { await db.exec('ROLLBACK') } catch {}
      res.status(500).json({ error: e.message, counts })
    }
  })

  // Cleanup orphan order_items (order_id IS NULL) + their failed sync_log
  // entries. Used to recover from a regression where .insert(...).select()
  // .single() returned the wrong shape, causing FK columns to be inserted as
  // null. Runs locally — no auth needed.
  app.post('/admin/cleanup-orphan-items', async (req, res) => {
    if (!isLocalhost(req)) return res.status(403).json({ error: 'forbidden' })
    const db = getDB()
    try {
      const r1 = await db.query(`DELETE FROM order_items WHERE order_id IS NULL`)
      const r2 = await db.query(
        `DELETE FROM sync_log
          WHERE table_name = 'order_items'
            AND pushed_at IS NULL
            AND (payload->>'order_id' IS NULL OR payload->>'order_id' = '')`
      )
      res.json({
        ok: true,
        orderItemsDeleted: r1.rowCount ?? r1.affectedRows ?? 0,
        syncLogDeleted: r2.rowCount ?? r2.affectedRows ?? 0,
      })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // Printer config — JSON file in Electron userData. Read by waiter PWA on
  // phones (which have no localStorage of their own with printer settings).
  // Written by Settings → Printers UI on the desktop after the user saves.
  // This is a config-only file — no PGlite, no cloud sync. Localhost AND LAN
  // peers can read; only localhost can write (so a waiter phone can't change
  // printer config remotely).
  const PRINTER_CONFIG_FILE = path.join(
    require('electron').app.getPath('userData'),
    'printer-config.json'
  )

  app.get('/printer-config', async (req, res) => {
    try {
      if (!fs.existsSync(PRINTER_CONFIG_FILE)) {
        return res.json({ stations: [], receipt: null, virtual: false })
      }
      const raw = fs.readFileSync(PRINTER_CONFIG_FILE, 'utf8')
      const cfg = JSON.parse(raw)
      res.json({
        stations: Array.isArray(cfg.stations) ? cfg.stations : [],
        receipt: cfg.receipt && typeof cfg.receipt === 'object' ? cfg.receipt : null,
        virtual: !!cfg.virtual,
      })
    } catch (e) {
      console.warn('[printer-config] read failed:', e.message)
      res.json({ stations: [], receipt: null, virtual: false })
    }
  })

  app.post('/printer-config', async (req, res) => {
    if (!isLocalhost(req)) return res.status(403).json({ error: 'forbidden' })
    try {
      const stations = Array.isArray(req.body?.stations) ? req.body.stations : []
      const receipt = req.body?.receipt && typeof req.body.receipt === 'object' ? req.body.receipt : null
      const virtual = !!req.body?.virtual
      const payload = JSON.stringify({ stations, receipt, virtual }, null, 2)
      fs.writeFileSync(PRINTER_CONFIG_FILE, payload, 'utf8')
      res.json({ ok: true })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // Config
  const configPath = path.join(path.dirname(DB_PATH), 'config.json')
  function loadConfig() {
    try { if (fs.existsSync(configPath)) return JSON.parse(fs.readFileSync(configPath, 'utf8')) } catch {}
    return {}
  }
  function saveConfig(c) {
    const dir = path.dirname(configPath)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(configPath, JSON.stringify(c, null, 2))
  }

  // Blocked state tracking
  let isBlocked = false
  let blockReason = ''

  // License check endpoint (used by blocked.html retry button)
  // Checks CLOUD first (real-time), falls back to local DB if offline.
  app.get('/license-check', async (req, res) => {
    try {
      const cfg = loadConfig()
      if (!cfg.restaurantId) return res.json({ blocked: false })

      let row = null

      // Try cloud first for real-time block/license status
      if (cfg.supabaseUrl && cfg.supabaseKey) {
        try {
          const cloudRes = await fetch(
            `${cfg.supabaseUrl}/rest/v1/restaurants?id=eq.${cfg.restaurantId}&select=is_blocked,block_reason,license_expires_at`,
            {
              headers: { apikey: cfg.supabaseKey, Authorization: `Bearer ${cfg.supabaseKey}` },
              signal: AbortSignal.timeout(5000),
            }
          )
          if (cloudRes.ok) {
            const rows = await cloudRes.json()
            if (Array.isArray(rows) && rows.length > 0) row = rows[0]
          }
        } catch {} // Offline — fall through to local
      }

      // Fallback to local DB
      if (!row) {
        const db = getDB()
        const result = await db.query(
          'SELECT is_blocked, block_reason, license_expires_at FROM restaurants WHERE id = $1',
          [cfg.restaurantId]
        )
        row = result.rows[0]
      }

      if (!row) return res.json({ blocked: false })

      // Check explicit block
      const explicitlyBlocked = row.is_blocked === true || row.is_blocked === 'true'

      // Check license expiry
      const licenseExpired = row.license_expires_at && new Date(row.license_expires_at) < new Date()

      const blocked = explicitlyBlocked || licenseExpired
      const reason = licenseExpired
        ? `Лицензия истекла ${new Date(row.license_expires_at).toLocaleDateString('ru')}. Обратитесь к администратору.`
        : (row.block_reason || 'Заблокировано администратором')

      if (blocked) {
        isBlocked = true
        blockReason = reason
      } else {
        isBlocked = false
        blockReason = ''
      }

      res.json({ blocked, reason: blocked ? reason : '' })
    } catch (err) {
      res.json({ blocked: false })
    }
  })

  // Print endpoints (built-in print server for Electron)
  const net = require('net')
  app.post('/print', (req, res) => {
    const { printerIP, data } = req.body
    if (!printerIP || !data) return res.status(400).json({ error: 'printerIP and data required' })
    const port = 9100
    const client = new net.Socket()
    client.setTimeout(5000)
    client.connect(port, printerIP, () => {
      client.write(Buffer.from(data, 'hex'), () => {
        client.destroy()
        res.json({ success: true })
      })
    })
    client.on('error', (err) => {
      client.destroy()
      res.status(500).json({ error: `Printer connection failed: ${err.message}` })
    })
    client.on('timeout', () => {
      client.destroy()
      res.status(500).json({ error: 'Printer connection timeout' })
    })
  })

  app.get('/print/status', (req, res) => {
    res.json({ status: 'ok' })
  })

  // Activate
  app.post('/activate', async (req, res) => {
    const { licenseKey } = req.body
    if (!licenseKey) return res.status(400).json({ error: 'Key required' })
    try {
      const URL = 'https://xmittbfenlknwtxeohbz.supabase.co'
      const KEY = 'sb_publishable_siDu3MFzNOOYvMAcjrSLnQ_xR2gtrf5'
      const r = await fetch(`${URL}/rest/v1/restaurants?license_key=eq.${encodeURIComponent(licenseKey)}&limit=1`,
        { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } })
      const data = await r.json()
      if (!Array.isArray(data) || !data.length) return res.status(404).json({ error: 'Invalid key' })
      // Clear all existing data before activating new restaurant
      const db = getDB()
      for (const t of TABLES) {
        try { await db.query(`DELETE FROM "${t}"`) } catch {}
      }
      console.log('[activate] Cleared all tables for fresh activation')
      saveConfig({ supabaseUrl: URL, supabaseKey: KEY, restaurantId: data[0].id, restaurantName: data[0].name, licenseKey })
      const { SyncEngine } = require('./sync')
      const sync = new SyncEngine(URL, KEY, data[0].id, {
        onBlocked: (reason) => { isBlocked = true; blockReason = reason; onBlockedCallback?.(reason) },
        onUnblocked: () => { isBlocked = false; blockReason = ''; onUnblockedCallback?.() },
      })
      activeSyncEngine = sync
      await sync.pullFromCloud(true) // initial pull — all tables including operational
      sync.start()
      res.json({ success: true, restaurantName: data[0].name })
    } catch (err) { res.status(500).json({ error: err.message }) }
  })

  // ─── Desktop control endpoints ─────────────────────────────────────────────
  // Only allow from localhost
  function isLocalhost(req) {
    const host = req.headers.host || ''
    return host.startsWith('localhost') || host.startsWith('127.0.0.1')
  }

  app.get('/desktop/update-status', (req, res) => {
    res.json(updateState)
  })

  app.post('/desktop/check-update', async (req, res) => {
    if (!isLocalhost(req)) return res.status(403).json({ error: 'forbidden' })
    if (!desktopHandlers.checkUpdate) return res.status(503).json({ error: 'unavailable' })
    try {
      updateState = { status: 'checking', version: null, percent: 0, error: null }
      const result = await desktopHandlers.checkUpdate()
      res.json({ ok: true, result })
    } catch (e) {
      updateState = { ...updateState, status: 'error', error: e.message }
      res.status(500).json({ error: e.message })
    }
  })

  app.post('/desktop/install-update', (req, res) => {
    if (!isLocalhost(req)) return res.status(403).json({ error: 'forbidden' })
    if (!desktopHandlers.installUpdate) return res.status(503).json({ error: 'unavailable' })
    try {
      desktopHandlers.installUpdate()
      res.json({ ok: true })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  app.post('/desktop/open-connect', (req, res) => {
    if (!isLocalhost(req)) return res.status(403).json({ error: 'forbidden' })
    if (!desktopHandlers.openConnect) return res.status(503).json({ error: 'unavailable' })
    try {
      desktopHandlers.openConnect()
      res.json({ ok: true })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  // Activation & blocked pages
  const activatePage = path.join(__dirname, 'activate.html')
  const blockedPage = path.join(__dirname, 'blocked.html')

  // Inject restosDesktop config into index.html (preload.js doesn't work with loadURL)
  const pkgVersion = require('./package.json').version
  function serveIndexWithConfig(req, res) {
    const indexPath = path.join(frontendDir, 'index.html')
    if (!fs.existsSync(indexPath)) return res.status(500).send('Frontend not found')
    let html = fs.readFileSync(indexPath, 'utf8')

    const requestHost = req.headers.host || `localhost:${port}`
    const apiUrl = `http://${requestHost}`
    const ip = getLocalIP()

    // Detect if request comes from Electron (localhost) or phone (external IP)
    const isFromElectron = requestHost.startsWith('localhost') || requestHost.startsWith('127.0.0.1')

    let script
    if (isFromElectron) {
      // Full desktop config with connect button
      script = `<script>window.restosDesktop={isDesktop:true,apiUrl:"${apiUrl}",printServerUrl:"${apiUrl}",waiterUrl:"http://${ip}:${port}",connectUrl:"${apiUrl}/connect",version:"${pkgVersion}"};</script>`
    } else {
      // Waiter/phone — only apiUrl for data access, no desktop features
      script = `<script>window.restosDesktop={isDesktop:false,isLocal:true,apiUrl:"${apiUrl}",printServerUrl:"${apiUrl}",version:"${pkgVersion}"};</script>`
    }

    html = html.replace('<head>', '<head>' + script)
    // Remove external Google Fonts (blocks page load offline)
    html = html.replace(/<link[^>]*fonts\.googleapis\.com[^>]*>/g, '')
    html = html.replace(/<link[^>]*fonts\.gstatic\.com[^>]*>/g, '')
    res.type('html').send(html)
  }

  // SPA fallback — serve index.html for all non-API routes
  app.get('*', (req, res) => {
    if (req.path.startsWith('/rest/') || req.path.startsWith('/auth/') || req.path === '/status') return res.status(404).end()
    // If not activated, show activation page
    const cfg = loadConfig()
    if (!cfg.restaurantId) {
      return res.sendFile(activatePage)
    }
    // If blocked, show blocked page
    if (isBlocked) {
      return res.sendFile(blockedPage)
    }
    serveIndexWithConfig(req, res)
  })

  // Callbacks for main process (set externally)
  let onBlockedCallback = null
  let onUnblockedCallback = null

  // Start sync if configured
  const cfg = loadConfig()
  if (cfg.supabaseUrl && cfg.restaurantId) {
    const { SyncEngine } = require('./sync')
    const sync = new SyncEngine(cfg.supabaseUrl, cfg.supabaseKey, cfg.restaurantId, {
      onBlocked: (reason) => { isBlocked = true; blockReason = reason; onBlockedCallback?.(reason) },
      onUnblocked: () => { isBlocked = false; blockReason = ''; onUnblockedCallback?.() },
    })
    activeSyncEngine = sync
    sync.start(60000)
  }

  // Kill any zombie process holding the port (previous RestOS that didn't exit cleanly)
  async function killPortHolder(p) {
    try {
      const { execSync } = require('child_process')
      if (process.platform === 'win32') {
        // Windows: find PID on port and kill it
        const out = execSync(`netstat -ano | findstr :${p} | findstr LISTENING`, { encoding: 'utf8', timeout: 3000 }).trim()
        const lines = out.split('\n').filter(Boolean)
        const pids = new Set(lines.map(l => l.trim().split(/\s+/).pop()).filter(Boolean))
        for (const pid of pids) {
          if (pid !== String(process.pid)) {
            try { execSync(`taskkill /F /PID ${pid}`, { timeout: 3000 }) } catch {}
            console.log(`[API] Killed zombie process PID ${pid} on port ${p}`)
          }
        }
      } else {
        // macOS / Linux: lsof + kill
        const out = execSync(`lsof -ti :${p}`, { encoding: 'utf8', timeout: 3000 }).trim()
        const pids = out.split('\n').filter(Boolean)
        for (const pid of pids) {
          if (pid !== String(process.pid)) {
            try { process.kill(Number(pid), 'SIGKILL') } catch {}
            console.log(`[API] Killed zombie process PID ${pid} on port ${p}`)
          }
        }
      }
      // Brief pause so the OS releases the port
      await new Promise(r => setTimeout(r, 500))
    } catch {
      // No process on port — good
    }
  }

  // Listen — with auto-retry after killing zombie process
  return new Promise((resolve, reject) => {
    const ips = getLocalIPs()
    const ip = ips[0] || '127.0.0.1'
    const server = app.listen(port, '0.0.0.0', () => {
      console.log(`[API] http://localhost:${port}`)
      console.log(`[API] http://${ip}:${port}`)
      console.log(`[API] Waiters connect: http://${ip}:${port} (open /connect on this machine for the QR)`)
      resolve({
        port, ip, ips, server,
        onBlocked: (cb) => { onBlockedCallback = cb },
        onUnblocked: (cb) => { onUnblockedCallback = cb },
      })
    })
    server.on('error', async (err) => {
      if (err.code === 'EADDRINUSE') {
        console.log(`[API] Port ${port} in use — killing zombie process...`)
        await killPortHolder(port)
        // Retry once
        const retry = app.listen(port, '0.0.0.0', () => {
          console.log(`[API] http://localhost:${port} (after port recovery)`)
          resolve({
            port, ip, server: retry,
            onBlocked: (cb) => { onBlockedCallback = cb },
            onUnblocked: (cb) => { onUnblockedCallback = cb },
          })
        })
        retry.on('error', (e) => {
          console.error(`[API] Port ${port} still in use after kill:`, e.message)
          const { dialog } = require('electron')
          dialog.showErrorBox('RestOS', `Порт ${port} занят другим приложением.\nЗакройте его и перезапустите RestOS.`)
          reject(e)
        })
      } else {
        reject(err)
      }
    })
  })
}

// Interface name patterns to skip (case-insensitive substring match).
// Targets virtual / VPN / tunnel adapters that phones on the same Wi-Fi can't reach.
const SKIP_IFACE_PATTERNS = [
  'vethernet', 'wsl', 'virtualbox', 'vmware', 'vmnet', 'hyper-v',
  'loopback', 'bluetooth', 'tailscale', 'tunnel', 'tap-', 'tap windows',
  'pangp', 'cisco', 'zerotier', 'npcap', 'openvpn', 'wireguard',
  'utun', 'awdl', 'llw', 'bridge', 'vboxnet', 'docker', 'ppp',
]

function isSkippedIface(name) {
  if (!name) return false
  const n = name.toLowerCase()
  return SKIP_IFACE_PATTERNS.some(p => n.includes(p))
}

function ipPriority(ip) {
  // Lower is better
  if (ip.startsWith('192.168.')) return 0
  if (ip.startsWith('10.')) return 1
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2
  return 9
}

function isExcludedSubnet(ip, name) {
  // VirtualBox host-only default
  if (ip.startsWith('192.168.56.')) return true
  // Tailscale CGNAT (100.64.0.0/10)
  const m = ip.match(/^100\.(\d+)\./)
  if (m) {
    const second = parseInt(m[1], 10)
    if (second >= 64 && second <= 127) return true
  }
  // Link-local
  if (ip.startsWith('169.254.')) return true
  // 172.16/12 carved out by WSL/Hyper-V
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) {
    const n = (name || '').toLowerCase()
    if (n.includes('vethernet') || n.includes('wsl') || n.includes('hyper-v')) return true
  }
  return false
}

// Returns prioritized list of LAN IPv4 candidates suitable for phone connections.
// Logs skipped interfaces for diagnostics.
function getLocalIPs() {
  const ifaces = os.networkInterfaces()
  const candidates = []
  const skipped = []
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const c of addrs || []) {
      if (c.family !== 'IPv4' || c.internal) continue
      if (isSkippedIface(name) || isExcludedSubnet(c.address, name)) {
        skipped.push(`${name}=${c.address}`)
        continue
      }
      candidates.push({ name, ip: c.address, prio: ipPriority(c.address) })
    }
  }
  candidates.sort((a, b) => a.prio - b.prio)
  if (candidates.length === 0 && skipped.length > 0) {
    // Fallback: берём только адреса, которые могут быть достижимы из LAN.
    // 169.254.x.x (APIPA) — Windows self-assign когда роутер не выдал DHCP,
    // телефон до такого адреса не достучится физически.
    // 192.168.56.x — VirtualBox host-only, тоже изолированный.
    for (const [name, addrs] of Object.entries(ifaces)) {
      for (const c of addrs || []) {
        if (c.family !== 'IPv4' || c.internal) continue
        if (c.address.startsWith('169.254.')) continue
        if (c.address.startsWith('192.168.56.')) continue
        if (isSkippedIface(name)) continue
        candidates.push({ name, ip: c.address, prio: 9 })
      }
    }
  }
  if (skipped.length) console.log(`[net] skipped interfaces: ${skipped.join(', ')}`)
  if (candidates.length) console.log(`[net] LAN candidates: ${candidates.map(c => `${c.ip} (${c.name})`).join(', ')}`)
  else console.log('[net] no usable LAN candidate — desktop probably not connected to Wi-Fi/Ethernet, or router did not assign DHCP (APIPA)')
  return candidates.map(c => c.ip)
}

function getLocalIP() {
  return getLocalIPs()[0] || '127.0.0.1'
}

function setDesktopHandlers(handlers) {
  desktopHandlers = { ...desktopHandlers, ...handlers }
}

function setUpdateState(state) {
  updateState = { ...updateState, ...state }
}

module.exports = { startAPIServer, setDesktopHandlers, setUpdateState }
