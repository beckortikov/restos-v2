// Sync engine — PGlite is the source of truth.
//
// All writes happen against the local PGlite. A trigger on every tracked table
// appends to sync_log. This engine reads sync_log and replays unpushed entries
// to Supabase Cloud as a one-way replica. Cloud is read-only (web dashboards
// view but cannot edit — see lib/runtime-mode.ts).
//
// The only time we pull from cloud is **once** during /activate, to seed a
// fresh PGlite install with the restaurant's existing data. After that, the
// desktop is autonomous.

const { getDB } = require('./db')
const os = require('os')

// One-time seed list when activating a fresh desktop install.
const INITIAL_SEED_TABLES = [
  // Reference / config
  'restaurants', 'users', 'zones',
  'menu_items', 'tech_card_lines',
  'ingredients', 'financial_accounts',
  'custom_categories', 'menu_categories',
  'modifier_groups', 'modifiers',
  'semi_finished_types', 'semi_recipe_lines', 'semi_finished_stock',
  'suppliers', 'customers',
  'assets', 'liabilities', 'equity_entries', 'budget_lines',
  // Operational (might exist if cloud already has data from a previous install)
  'tables', 'orders', 'order_items', 'order_item_modifiers',
  'cash_shifts', 'cash_shift_operations', 'reservations',
  'financial_operations', 'stock_movements',
  'order_voids', 'order_splits',
  'stock_writeoffs', 'stock_writeoff_lines',
  'stock_receipts', 'stock_receipt_lines',
  'batch_cooking_logs', 'supply_expenses', 'time_entries',
  'audit_log',
]

// Schema parity with cloud is now enforced by docs/migrations/wave6_align_with_pglite.sql:
//   - generated/missing columns are now regular columns in cloud
//   - UNIQUE constraints that PGlite didn't have are dropped from cloud
// So no per-table strip / on-conflict hacks are needed anymore.

// Child → parent FK map for push self-healing. When cloud rejects a child
// insert with FK violation 23503, we look up the parent locally and push it
// first (or drop the orphan child if the parent doesn't exist locally either).
const CHILD_PARENT_MAP = {
  order_items:           { parent: 'orders',              fk: 'order_id' },
  order_item_modifiers:  { parent: 'order_items',         fk: 'order_item_id' },
  order_voids:           { parent: 'orders',              fk: 'order_id' },
  order_splits:          { parent: 'orders',              fk: 'order_id' },
  stock_receipt_lines:   { parent: 'stock_receipts',      fk: 'receipt_id' },
  stock_writeoff_lines:  { parent: 'stock_writeoffs',     fk: 'writeoff_id' },
  modifiers:             { parent: 'modifier_groups',     fk: 'group_id' },
  cash_shift_operations: { parent: 'cash_shifts',         fk: 'shift_id' },
  semi_recipe_lines:     { parent: 'semi_finished_types', fk: 'semi_type_id' },
}

// Parse Postgres FK violation detail: `Key (col)=(val) is not present in table "parent".`
// Supabase returns this inside a JSON body's `details` field, so try JSON first
// and fall back to a raw match for safety.
function parseFkViolation(errorText) {
  if (!errorText || !errorText.includes('23503')) return null
  let detail = ''
  try {
    const parsed = JSON.parse(errorText)
    if (parsed && typeof parsed.details === 'string') detail = parsed.details
  } catch { /* not JSON, fall through */ }
  const haystack = detail || errorText
  const m = haystack.match(/Key \(([^)]+)\)=\(([^)]+)\) is not present in table "([^"]+)"/)
  if (!m) return null
  return { col: m[1], val: m[2], parent: m[3] }
}

// Tables we periodically reconcile cloud against PGlite. Operational state
// only — reference data (menu_items, ingredients, users, ...) is excluded so
// a desktop wipe can't nuke the cloud copy.
//
// Child tables (order_item_modifiers, cash_shift_operations) are intentionally
// omitted: they don't carry restaurant_id in cloud (scoped through parent FK)
// and a `?restaurant_id=eq.X` filter on them returns 42703 errors. Their
// lifecycle is already covered by ON DELETE CASCADE on parent + the sync_log
// FK self-heal in pushSyncLog.
const RECONCILE_TABLES = [
  'orders', 'order_items',
  'order_voids', 'order_splits',
  'tables',
  'cash_shifts',
  'reservations',
]

function getLocalIP() {
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const c of iface || []) { if (c.family === 'IPv4' && !c.internal) return c.address }
  }
  return '127.0.0.1'
}

class SyncEngine {
  constructor(supabaseUrl, supabaseKey, restaurantId, options = {}) {
    this.supabaseUrl = supabaseUrl
    this.supabaseKey = supabaseKey
    this.restaurantId = restaurantId
    this.onBlocked = options.onBlocked || null
    this.onUnblocked = options.onUnblocked || null
    this.wasBlocked = false
    this._pushing = false
    this._seeding = false
  }

  // ─── Heartbeat / license check (cloud → desktop, read-only) ────────────────

  async sendHeartbeat() {
    try {
      const version = require('./package.json').version
      const ip = getLocalIP()
      await fetch(
        `${this.supabaseUrl}/rest/v1/restaurants?id=eq.${this.restaurantId}`,
        {
          method: 'PATCH',
          headers: {
            apikey: this.supabaseKey,
            Authorization: `Bearer ${this.supabaseKey}`,
            'Content-Type': 'application/json',
            Prefer: 'return=minimal',
          },
          body: JSON.stringify({
            last_seen_at: new Date().toISOString(),
            app_version: version,
            local_server_ip: ip,
          }),
        }
      )
    } catch (err) {
      console.log('[heartbeat] Failed:', err.message)
    }
  }

  async checkBlocked() {
    let row = null
    try {
      const res = await fetch(
        `${this.supabaseUrl}/rest/v1/restaurants?id=eq.${this.restaurantId}&select=is_blocked,block_reason,license_expires_at`,
        {
          headers: { apikey: this.supabaseKey, Authorization: `Bearer ${this.supabaseKey}` },
          signal: AbortSignal.timeout(5000),
        }
      )
      if (res.ok) {
        const rows = await res.json()
        if (Array.isArray(rows) && rows.length > 0) row = rows[0]
      }
    } catch {} // Offline — fall through to local

    if (!row) {
      try {
        const db = getDB()
        const result = await db.query(
          'SELECT is_blocked, block_reason, license_expires_at FROM restaurants WHERE id = $1',
          [this.restaurantId]
        )
        row = result.rows[0]
      } catch {}
    }
    if (!row) return

    const isBlocked = row.is_blocked === true || row.is_blocked === 'true'
    const isExpired = row.license_expires_at && new Date(row.license_expires_at) < new Date()
    if (isBlocked || isExpired) {
      const reason = isExpired
        ? `Лицензия истекла ${new Date(row.license_expires_at).toLocaleDateString('ru')}. Обратитесь к администратору для продления.`
        : (row.block_reason || 'Заблокировано администратором')
      if (!this.wasBlocked) {
        this.wasBlocked = true
        console.log('[sync] License BLOCKED:', reason)
        if (this.onBlocked) this.onBlocked(reason)
      }
    } else if (this.wasBlocked) {
      this.wasBlocked = false
      console.log('[sync] License UNBLOCKED')
      if (this.onUnblocked) this.onUnblocked()
    }
  }

  // ─── Initial seed (cloud → PGlite, runs ONCE on /activate) ────────────────

  async seedFromCloud() {
    if (this._seeding) return
    this._seeding = true
    console.log('[seed] Pulling initial data from cloud...')
    const db = getDB()

    // Suppress sync_log triggers so the seed rows aren't echoed back to cloud.
    try { await db.query(`SELECT set_config('restos.sync_disabled', 'on', false)`) } catch {}

    try {
      for (const table of INITIAL_SEED_TABLES) {
        try {
          const filterCol = table === 'restaurants' ? 'id' : 'restaurant_id'
          const childWithRestId = new Set(['tech_card_lines'])
          const childParentMap = {
            order_items:           { parent: 'orders',         fk: 'order_id' },
            order_item_modifiers:  { parent: 'order_items',    fk: 'order_item_id' },
            semi_recipe_lines:     { parent: 'semi_finished_types', fk: 'semi_type_id' },
            stock_receipt_lines:   { parent: 'stock_receipts', fk: 'receipt_id' },
            stock_writeoff_lines:  { parent: 'stock_writeoffs', fk: 'writeoff_id' },
            modifiers:             { parent: 'modifier_groups', fk: 'group_id' },
            cash_shift_operations: { parent: 'cash_shifts',    fk: 'shift_id' },
          }
          let url
          if (childWithRestId.has(table)) {
            url = `${this.supabaseUrl}/rest/v1/${table}?restaurant_id=eq.${this.restaurantId}&limit=10000`
          } else if (childParentMap[table]) {
            const { parent } = childParentMap[table]
            url = `${this.supabaseUrl}/rest/v1/${table}?select=*,${parent}!inner(restaurant_id)&${parent}.restaurant_id=eq.${this.restaurantId}&limit=10000`
          } else {
            url = `${this.supabaseUrl}/rest/v1/${table}?${filterCol}=eq.${this.restaurantId}&limit=10000`
          }

          const res = await fetch(url, {
            headers: { apikey: this.supabaseKey, Authorization: `Bearer ${this.supabaseKey}` },
          })
          if (!res.ok) continue
          const rows = await res.json()
          if (!Array.isArray(rows) || rows.length === 0) continue

          if (childParentMap[table]) {
            const parent = childParentMap[table].parent
            for (const row of rows) delete row[parent]
          }

          // Auto-add missing columns so the upsert can't fail on schema drift.
          const columns = Object.keys(rows[0])
          for (const col of columns) {
            try { await db.query(`SELECT "${col}" FROM "${table}" LIMIT 0`) }
            catch {
              try { await db.query(`ALTER TABLE "${table}" ADD COLUMN "${col}" TEXT`) } catch {}
            }
          }

          for (const row of rows) {
            const cols = Object.keys(row)
            const placeholders = cols.map((_, i) => `$${i + 1}`).join(',')
            const updates = cols.map(c => `"${c}" = EXCLUDED."${c}"`).join(',')
            try {
              await db.query(
                `INSERT INTO "${table}" (${cols.map(c => `"${c}"`).join(',')})
                 VALUES (${placeholders})
                 ON CONFLICT (id) DO UPDATE SET ${updates}`,
                cols.map(c => row[c])
              )
            } catch (e) {
              console.warn(`[seed] ${table} row insert failed:`, e.message)
            }
          }
          console.log(`[seed] ${table}: ${rows.length} rows`)
        } catch (e) {
          console.warn(`[seed] ${table} skipped:`, e.message)
        }
      }
    } finally {
      try { await db.query(`SELECT set_config('restos.sync_disabled', 'off', false)`) } catch {}
      this._seeding = false
    }
    console.log('[seed] Done')
  }

  // Backwards-compat shim — /activate calls pullFromCloud(true) on first run.
  async pullFromCloud(initial = false) {
    if (initial) return this.seedFromCloud()
    // Periodic pulls are gone — desktop is master, nothing to pull.
  }

  // ─── PUSH: PGlite → Cloud via sync_log (the only outbound channel) ────────

  // Send one row payload to cloud as an upsert. Returns { ok, status, text }.
  async _cloudUpsert(table, payload) {
    const resp = await fetch(
      `${this.supabaseUrl}/rest/v1/${table}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: this.supabaseKey,
          Authorization: `Bearer ${this.supabaseKey}`,
          Prefer: 'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000),
      }
    )
    const text = resp.ok ? '' : await resp.text().catch(() => '')
    return { ok: resp.ok, status: resp.status, text }
  }

  // FK self-heal: when child insert is rejected because parent is missing in
  // cloud, try to push the parent from PGlite. If parent is also missing
  // locally, returns { orphan: true } so the caller can drop the dead child.
  async _selfHealParent(childTable, errorText, payload) {
    const fk = parseFkViolation(errorText)
    const map = CHILD_PARENT_MAP[childTable]

    // Resolve parent table + FK value, preferring full parser output.
    // Supabase sometimes elides `Key (col)=(val)` from `details`, leaving only
    // `Key is not present in table "X"`. In that case fall back to the static
    // map + the row's own payload to find the parent id.
    let parent, fkCol, fkVal
    if (fk) {
      parent = fk.parent
      fkCol = fk.col
      fkVal = fk.val
      if (map && map.parent !== parent) return { healed: false }
    } else if (map && payload && payload[map.fk]) {
      parent = map.parent
      fkCol = map.fk
      fkVal = String(payload[map.fk])
    } else {
      return { healed: false }
    }

    const db = getDB()
    let parentRow = null
    try {
      const r = await db.query(
        `SELECT row_to_json(t)::jsonb AS j FROM "${parent}" t WHERE id::text = $1`,
        [fkVal]
      )
      parentRow = r.rows?.[0]?.j || null
    } catch (e) {
      console.warn(`[sync] self-heal lookup ${parent}/${fkVal} failed:`, e.message)
      return { healed: false }
    }

    if (!parentRow) {
      console.log(`[sync] orphan ${childTable} — parent ${parent}/${fkVal} missing locally`)
      return { orphan: true, parent, val: fkVal }
    }

    const up = await this._cloudUpsert(parent, parentRow)
    if (!up.ok) {
      console.warn(`[sync] self-heal push ${parent}/${fkVal} failed: HTTP ${up.status} ${up.text.slice(0, 120)}`)
      return { healed: false }
    }
    console.log(`[sync] self-healed parent ${parent}/${fkVal}`)
    return { healed: true }
  }

  async pushSyncLog() {
    if (this._pushing) return
    this._pushing = true
    const db = getDB()
    try {
      let rows = []
      try {
        const r = await db.query(`
          SELECT id, table_name, row_id, operation, payload
            FROM sync_log
           WHERE pushed_at IS NULL AND push_attempts < 10
           ORDER BY id ASC
           LIMIT 200`)
        rows = r.rows || []
      } catch (e) {
        console.warn('[sync-log] read failed:', e.message)
        return
      }
      if (rows.length === 0) return

      for (const entry of rows) {
        try {
          let ok, status, text
          if (entry.operation === 'delete') {
            const resp = await fetch(
              `${this.supabaseUrl}/rest/v1/${entry.table_name}?id=eq.${entry.row_id}`,
              {
                method: 'DELETE',
                headers: { apikey: this.supabaseKey, Authorization: `Bearer ${this.supabaseKey}` },
                signal: AbortSignal.timeout(10000),
              }
            )
            // 404 is "row already gone" — fine for DELETE.
            ok = resp.ok || resp.status === 404
            status = resp.status
            text = ok ? '' : await resp.text().catch(() => '')
          } else {
            ;({ ok, status, text } = await this._cloudUpsert(entry.table_name, entry.payload))

            // FK violation? Try to push the parent first, then retry once.
            if (!ok && status === 409 && text.includes('23503')) {
              const heal = await this._selfHealParent(entry.table_name, text, entry.payload)
              if (heal.orphan) {
                // Parent doesn't exist locally either — drop the dead child
                // (mirrors cloud's ON DELETE CASCADE) and resolve the log entry.
                try {
                  await db.query(
                    `DELETE FROM "${entry.table_name}" WHERE id::text = $1`,
                    [entry.row_id]
                  )
                } catch (e) {
                  console.warn(`[sync] orphan delete ${entry.table_name}/${entry.row_id} failed:`, e.message)
                }
                await db.query(
                  `UPDATE sync_log SET pushed_at = now(), last_error = $2 WHERE id = $1`,
                  [entry.id, `orphan: parent ${heal.parent}/${heal.val} missing`]
                )
                console.log(`[sync] orphan: dropped ${entry.table_name}/${entry.row_id}`)
                continue
              }
              if (heal.healed) {
                ;({ ok, status, text } = await this._cloudUpsert(entry.table_name, entry.payload))
              }
            }

            // UNIQUE violation? Cloud already has an equivalent row by some
            // unique business key (e.g. menu_categories(restaurant_id, name)).
            // For our sync-as-read-replica purpose that means "already in
            // cloud" — don't keep retrying until push_attempts hits 10.
            // Mark resolved and move on. If wave6 migration removed the
            // UNIQUE index, this path is never hit.
            if (!ok && status === 409 && text.includes('23505')) {
              await db.query(
                `UPDATE sync_log SET pushed_at = now(), last_error = $2 WHERE id = $1`,
                [entry.id, 'duplicate: equivalent row already in cloud']
              )
              console.log(`[sync] duplicate-resolved ${entry.table_name}/${entry.row_id}`)
              continue
            }
          }

          if (!ok) {
            throw new Error(`HTTP ${status}: ${text.slice(0, 200)}`)
          }
          await db.query(
            `UPDATE sync_log SET pushed_at = now(), last_error = NULL WHERE id = $1`,
            [entry.id]
          )
        } catch (e) {
          const msg = String(e && e.message || e).slice(0, 500)
          await db.query(
            `UPDATE sync_log SET push_attempts = push_attempts + 1, last_error = $2 WHERE id = $1`,
            [entry.id, msg]
          )
        }
      }
    } finally {
      this._pushing = false
    }
  }

  // ─── RECONCILE: enforce cloud == PGlite for tracked operational tables ───
  //
  // The push loop only fires on rows that pass through PGlite. Anything that
  // landed on cloud some other way (older web that could write, Supabase
  // Studio, a previous desktop install on the same license key) becomes an
  // orphan: web dashboards see it as live state, desktop has no record.
  //
  // This pass is one-way — PGlite wins. Cloud rows whose id isn't in PGlite
  // get DELETEd. PGlite rows whose id isn't on cloud get re-enqueued into
  // sync_log so the push loop replays them.
  async reconcileCloud() {
    if (this._reconciling) return { skipped: true }
    this._reconciling = true
    const summary = { tables: {}, deletedTotal: 0, requeuedTotal: 0 }
    const db = getDB()
    try {
      for (const table of RECONCILE_TABLES) {
        const tableSummary = { deleted: 0, requeued: 0, error: null }
        try {
          // 1. Cloud ids
          const r = await fetch(
            `${this.supabaseUrl}/rest/v1/${table}?restaurant_id=eq.${this.restaurantId}&select=id`,
            {
              headers: {
                apikey: this.supabaseKey,
                Authorization: `Bearer ${this.supabaseKey}`,
              },
              signal: AbortSignal.timeout(15000),
            }
          )
          if (!r.ok) throw new Error(`cloud GET ${r.status}`)
          const cloudRows = await r.json()
          const cloudIds = new Set(
            (Array.isArray(cloudRows) ? cloudRows : []).map(x => String(x.id))
          )

          // 2. Local ids
          let localIds = new Set()
          try {
            const local = await db.query(
              `SELECT id::text AS id FROM "${table}" WHERE restaurant_id::text = $1`,
              [this.restaurantId]
            )
            localIds = new Set((local.rows || []).map(x => x.id))
          } catch (e) {
            // Table might not exist locally yet — treat as empty
            console.warn(`[reconcile] ${table} local read failed:`, e.message)
          }

          // 3. Cloud orphans → DELETE on cloud
          for (const id of cloudIds) {
            if (!localIds.has(id)) {
              try {
                const dr = await fetch(
                  `${this.supabaseUrl}/rest/v1/${table}?id=eq.${id}`,
                  {
                    method: 'DELETE',
                    headers: {
                      apikey: this.supabaseKey,
                      Authorization: `Bearer ${this.supabaseKey}`,
                    },
                    signal: AbortSignal.timeout(10000),
                  }
                )
                // 404 here is fine — already gone.
                if (dr.ok || dr.status === 404) {
                  tableSummary.deleted++
                }
              } catch (e) {
                console.warn(`[reconcile] ${table} DELETE ${id} failed:`, e.message)
              }
            }
          }

          // 4. Missed pushes (PGlite has, cloud doesn't) → requeue
          for (const id of localIds) {
            if (!cloudIds.has(id)) {
              try {
                const row = await db.query(
                  `SELECT row_to_json(t)::jsonb AS j FROM "${table}" t WHERE id::text = $1`,
                  [id]
                )
                const payload = row.rows?.[0]?.j
                if (payload) {
                  await db.query(
                    `INSERT INTO sync_log (table_name, row_id, operation, payload, restaurant_id)
                     VALUES ($1, $2, 'insert', $3, $4)`,
                    [table, id, payload, this.restaurantId]
                  )
                  tableSummary.requeued++
                }
              } catch (e) {
                console.warn(`[reconcile] ${table} requeue ${id} failed:`, e.message)
              }
            }
          }
        } catch (e) {
          tableSummary.error = String(e && e.message || e).slice(0, 200)
          console.warn(`[reconcile] ${table} failed:`, tableSummary.error)
        }
        summary.tables[table] = tableSummary
        summary.deletedTotal += tableSummary.deleted
        summary.requeuedTotal += tableSummary.requeued
      }

      // After requeueing missed pushes, kick the push loop so the user sees
      // the diff close immediately instead of waiting for the next 1.5 s tick.
      if (summary.requeuedTotal > 0) {
        this.pushSyncLog().catch(() => {})
      }
    } finally {
      this._reconciling = false
    }
    console.log(
      `[reconcile] done — deleted ${summary.deletedTotal} cloud orphans, ` +
      `requeued ${summary.requeuedTotal} missed pushes`
    )
    return summary
  }

  // Drop entries older than 30 days that have already been pushed.
  async cleanupSyncLog() {
    const db = getDB()
    try {
      await db.query(
        `DELETE FROM sync_log WHERE pushed_at IS NOT NULL AND pushed_at < now() - INTERVAL '30 days'`
      )
    } catch {}
  }

  // Periodic + on-startup: entries that hit push_attempts >= 10 because of a
  // Postgres constraint violation (23502 NOT NULL, 23503 FK, 23505 UNIQUE,
  // 23514 CHECK) or a PostgREST schema-cache miss (PGRST204 — column not yet
  // in the API schema cache after a cloud migration) get a fresh chance under
  // the current code. The wave6 cloud migration removed most causes; even so,
  // transient violations during schema migrations leave entries frozen —
  // periodic resurrect (every 30 min) pulls them back into rotation without
  // requiring a desktop restart.
  async resurrectFailedPushes() {
    const db = getDB()
    try {
      const r = await db.query(
        `UPDATE sync_log
            SET push_attempts = 0
          WHERE pushed_at IS NULL
            AND push_attempts >= 10
            AND (last_error LIKE '%2350%' OR last_error LIKE '%PGRST%')`
      )
      const n = r.rowCount || 0
      if (n > 0) console.log(`[sync] resurrected ${n} failed-push entries for retry`)
    } catch (e) {
      console.warn('[sync] resurrectFailedPushes failed:', e.message)
    }
  }

  // ─── Loop ────────────────────────────────────────────────────────────────

  start() {
    // Give constraint-blocked entries one more chance under the self-heal
    // / on-conflict logic.
    this.resurrectFailedPushes().catch(() => {})

    // Repeat every 30 min so transient cloud-side issues don't permanently
    // freeze a sync_log row until the user restarts the desktop.
    setInterval(() => { this.resurrectFailedPushes().catch(() => {}) }, 30 * 60 * 1000)

    // Push outstanding sync_log entries every 1.5 sec when online.
    setInterval(async () => {
      try {
        const res = await fetch(`${this.supabaseUrl}/rest/v1/restaurants?limit=1`, {
          headers: { apikey: this.supabaseKey, Authorization: `Bearer ${this.supabaseKey}` },
          signal: AbortSignal.timeout(5000),
        })
        if (res.ok) {
          await this.pushSyncLog()
        }
      } catch {}
    }, 1500)

    // License + heartbeat every 30 sec.
    setInterval(async () => {
      try {
        await this.checkBlocked()
        await this.sendHeartbeat()
      } catch {}
    }, 30000)

    // Cleanup once a day.
    setInterval(() => { this.cleanupSyncLog().catch(() => {}) }, 24 * 60 * 60 * 1000)

    // Reconcile cloud == PGlite. First pass 30 s after start (let the push
    // loop drain the easy stuff first), then once an hour.
    setTimeout(() => { this.reconcileCloud().catch(() => {}) }, 30 * 1000)
    setInterval(() => { this.reconcileCloud().catch(() => {}) }, 60 * 60 * 1000)

    console.log('[sync] Started — push-only via sync_log (1.5s), license/heartbeat (30s), reconcile (1h)')
  }
}

module.exports = { SyncEngine }
