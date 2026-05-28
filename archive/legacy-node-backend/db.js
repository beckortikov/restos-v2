const { PGlite } = require('@electric-sql/pglite')
const path = require('path')
const fs = require('fs')

// Store DB in user data folder
function getDataDir() {
  try { const { app } = require('electron'); return path.join(app.getPath('userData'), 'pgdata') }
  catch { return path.join(__dirname, 'data', 'pgdata') }
}
const DB_DIR = getDataDir()
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true })

let db = null

async function initDB() {
  db = new PGlite(DB_DIR)

  // Create all tables — identical to Supabase schema
  await db.exec(`
    CREATE TABLE IF NOT EXISTS restaurants (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      slug TEXT,
      logo_url TEXT,
      address TEXT,
      phone TEXT,
      currency TEXT DEFAULT 'TJS',
      service_percent NUMERIC DEFAULT 10,
      timezone TEXT DEFAULT 'Asia/Dushanbe',
      enforce_stock_check BOOLEAN DEFAULT false,
      tech_cards_enabled BOOLEAN DEFAULT true,
      auto_ready_mode BOOLEAN DEFAULT false,
      auto_ready_buffer_min INTEGER DEFAULT 5,
      local_server_ip TEXT,
      license_key TEXT,
      license_expires_at TIMESTAMPTZ,
      is_blocked BOOLEAN DEFAULT false,
      block_reason TEXT,
      last_seen_at TIMESTAMPTZ,
      app_version TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      auth_id UUID,
      username TEXT,
      password TEXT DEFAULT '1234',
      name TEXT,
      role TEXT DEFAULT 'waiter',
      restaurant_id TEXT,
      phone TEXT,
      email TEXT,
      position TEXT,
      birth_date TEXT,
      station TEXT,
      shift_number INTEGER,
      salary NUMERIC DEFAULT 0,
      hourly_rate NUMERIC DEFAULT 0,
      advance NUMERIC DEFAULT 0,
      deductions NUMERIC DEFAULT 0,
      permissions JSONB,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS zones (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      description TEXT,
      sort_order INTEGER DEFAULT 0,
      restaurant_id TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS tables (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      number INTEGER,
      name TEXT,
      capacity INTEGER DEFAULT 4,
      zone_id TEXT,
      status TEXT DEFAULT 'free',
      current_order_id TEXT,
      waiter_id TEXT,
      opened_at TIMESTAMPTZ,
      merged_with TEXT,
      original_capacity INTEGER,
      restaurant_id TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS menu_items (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT,
      category TEXT,
      price NUMERIC DEFAULT 0,
      emoji TEXT DEFAULT '',
      image_url TEXT,
      is_available BOOLEAN DEFAULT true,
      stop_list_override BOOLEAN DEFAULT false,
      cogs NUMERIC DEFAULT 0,
      cook_time_min INTEGER,
      station TEXT DEFAULT 'hot_kitchen',
      is_batch_cooking BOOLEAN DEFAULT false,
      prepared_qty INTEGER DEFAULT 0,
      unit TEXT DEFAULT 'piece',
      unit_size NUMERIC DEFAULT 1,
      sale_step NUMERIC DEFAULT 0,
      restaurant_id TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS tech_card_lines (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      menu_item_id UUID,
      ingredient_id UUID,
      semi_type_id UUID,
      name TEXT,
      qty NUMERIC DEFAULT 0,
      unit TEXT,
      restaurant_id TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS ingredients (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT,
      category TEXT,
      qty NUMERIC DEFAULT 0,
      min_qty NUMERIC DEFAULT 0,
      unit TEXT,
      price_per_unit NUMERIC DEFAULT 0,
      waste_percent NUMERIC DEFAULT 0,
      is_food BOOLEAN DEFAULT true,
      restaurant_id TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS orders (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      order_number SERIAL,
      status TEXT DEFAULT 'new',
      type TEXT DEFAULT 'hall',
      table_id TEXT,
      waiter_id TEXT,
      cashier_id TEXT,
      customer_id TEXT,
      payment_method TEXT,
      comment TEXT,
      total NUMERIC DEFAULT 0,
      service_percent NUMERIC DEFAULT 0,
      service_amount NUMERIC DEFAULT 0,
      total_with_service NUMERIC DEFAULT 0,
      guests_count INTEGER DEFAULT 1,
      tip_amount NUMERIC DEFAULT 0,
      payments JSONB DEFAULT '[]',
      discount_type TEXT,
      discount_value NUMERIC DEFAULT 0,
      discount_amount NUMERIC DEFAULT 0,
      discount_reason TEXT,
      discount_approved_by TEXT,
      is_split BOOLEAN DEFAULT false,
      split_count INTEGER DEFAULT 0,
      shift_id TEXT,
      restaurant_id TEXT,
      ready_at TIMESTAMPTZ,
      expected_ready_at TIMESTAMPTZ,
      closed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id UUID,
      menu_item_id UUID,
      name TEXT,
      qty NUMERIC DEFAULT 1,
      price NUMERIC DEFAULT 0,
      cogs NUMERIC DEFAULT 0,
      unit TEXT DEFAULT 'piece',
      unit_size NUMERIC DEFAULT 1,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS order_item_modifiers (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      order_item_id UUID,
      modifier_id UUID,
      name TEXT,
      price NUMERIC DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS financial_accounts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT,
      type TEXT DEFAULT 'cash',
      balance NUMERIC DEFAULT 0,
      restaurant_id TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS financial_operations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      type TEXT,
      amount NUMERIC DEFAULT 0,
      category TEXT,
      account_id TEXT,
      account_name TEXT,
      activity TEXT DEFAULT 'operational',
      date TEXT,
      description TEXT,
      counterparty TEXT,
      is_auto BOOLEAN DEFAULT false,
      source_ref TEXT,
      restaurant_id TEXT,
      shift_id TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS stock_movements (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      type TEXT,
      ingredient_id TEXT,
      ingredient_name TEXT,
      description TEXT,
      qty NUMERIC DEFAULT 0,
      unit TEXT,
      below_zero BOOLEAN DEFAULT false,
      restaurant_id TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      "timestamp" TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS suppliers (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT,
      contact_person TEXT,
      phone TEXT,
      categories JSONB,
      payment_terms_days INTEGER DEFAULT 0,
      credit_limit NUMERIC DEFAULT 0,
      current_debt NUMERIC DEFAULT 0,
      restaurant_id TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS stock_receipts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      supplier_id TEXT,
      supplier_name TEXT,
      date TEXT,
      note TEXT,
      total_amount NUMERIC DEFAULT 0,
      payment_type TEXT DEFAULT 'paid',
      paid_amount NUMERIC DEFAULT 0,
      debt_amount NUMERIC DEFAULT 0,
      due_date TEXT,
      confirmed_at TIMESTAMPTZ,
      confirmed_by TEXT,
      restaurant_id TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS stock_receipt_lines (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      receipt_id UUID,
      ingredient_id TEXT,
      name TEXT,
      qty NUMERIC DEFAULT 0,
      unit TEXT,
      price_per_unit NUMERIC DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS cash_shifts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      opened_by TEXT,
      closed_by TEXT,
      opening_balance NUMERIC DEFAULT 0,
      closing_balance NUMERIC DEFAULT 0,
      expected_cash NUMERIC,
      cash_revenue NUMERIC DEFAULT 0,
      card_revenue NUMERIC DEFAULT 0,
      orders_count INTEGER DEFAULT 0,
      avg_check NUMERIC DEFAULT 0,
      status TEXT DEFAULT 'open',
      opened_at TIMESTAMPTZ DEFAULT now(),
      closed_at TIMESTAMPTZ,
      restaurant_id TEXT,
      account_id TEXT,
      updated_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS cash_shift_operations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      shift_id UUID,
      type TEXT,
      amount NUMERIC DEFAULT 0,
      description TEXT,
      created_by TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS reservations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      table_id TEXT,
      guest_name TEXT,
      guest_phone TEXT,
      guests_count INTEGER DEFAULT 2,
      reserved_at TIMESTAMPTZ,
      duration_min INTEGER DEFAULT 120,
      status TEXT DEFAULT 'pending',
      note TEXT,
      created_by TEXT,
      restaurant_id TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS customers (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT,
      phone TEXT,
      email TEXT,
      birth_date TEXT,
      notes TEXT,
      visits_count INTEGER DEFAULT 0,
      total_spent NUMERIC DEFAULT 0,
      avg_check NUMERIC DEFAULT 0,
      last_visit_at TIMESTAMPTZ,
      restaurant_id TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS order_voids (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id UUID,
      item_name TEXT,
      item_qty INTEGER DEFAULT 1,
      item_price NUMERIC DEFAULT 0,
      reason TEXT,
      approved_by TEXT,
      approved_by_name TEXT,
      created_by TEXT,
      created_by_name TEXT,
      restaurant_id TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS order_splits (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id UUID,
      split_number INTEGER,
      split_type TEXT DEFAULT 'equal',
      items JSONB,
      subtotal NUMERIC DEFAULT 0,
      service_percent NUMERIC DEFAULT 0,
      service_amount NUMERIC DEFAULT 0,
      total NUMERIC DEFAULT 0,
      status TEXT DEFAULT 'pending',
      payment_method TEXT,
      account_id TEXT,
      account_name TEXT,
      paid_at TIMESTAMPTZ,
      paid_by TEXT,
      restaurant_id TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS modifier_groups (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT,
      menu_item_id UUID,
      is_required BOOLEAN DEFAULT false,
      max_select INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0,
      restaurant_id TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS modifiers (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      group_id UUID,
      name TEXT,
      price NUMERIC DEFAULT 0,
      is_default BOOLEAN DEFAULT false,
      sort_order INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS semi_finished_types (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT,
      output_unit TEXT DEFAULT 'кг',
      yield_percent NUMERIC DEFAULT 100,
      restaurant_id TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS semi_recipe_lines (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      semi_type_id UUID,
      ingredient_id UUID,
      name TEXT,
      qty_per_unit NUMERIC DEFAULT 0,
      unit TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS semi_finished_stock (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      semi_type_id UUID,
      name TEXT,
      qty NUMERIC DEFAULT 0,
      unit TEXT,
      price_per_unit NUMERIC DEFAULT 0,
      last_produced_at TIMESTAMPTZ,
      restaurant_id TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS stock_writeoffs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      reason TEXT,
      description TEXT,
      total_cost NUMERIC DEFAULT 0,
      created_by TEXT,
      restaurant_id TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS stock_writeoff_lines (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      writeoff_id UUID,
      ingredient_id TEXT,
      name TEXT,
      qty NUMERIC DEFAULT 0,
      unit TEXT,
      cost NUMERIC DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS batch_cooking_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      menu_item_id UUID,
      menu_item_name TEXT,
      qty INTEGER DEFAULT 0,
      produced_by TEXT,
      produced_by_id UUID,
      cost_total NUMERIC DEFAULT 0,
      reason TEXT,
      restaurant_id TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS supply_expenses (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      ingredient_id UUID,
      ingredient_name TEXT,
      qty NUMERIC DEFAULT 0,
      unit TEXT,
      reason TEXT,
      issued_to TEXT,
      note TEXT,
      created_by TEXT,
      restaurant_id TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS time_entries (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID,
      clock_in TIMESTAMPTZ,
      clock_out TIMESTAMPTZ,
      break_minutes INTEGER DEFAULT 0,
      total_hours NUMERIC DEFAULT 0,
      status TEXT DEFAULT 'active',
      note TEXT,
      restaurant_id TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS assets (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT,
      category TEXT,
      amount NUMERIC DEFAULT 0,
      purchase_date TEXT,
      useful_life_months INTEGER,
      note TEXT,
      restaurant_id TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS liabilities (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT,
      category TEXT,
      total_amount NUMERIC DEFAULT 0,
      paid_amount NUMERIC DEFAULT 0,
      remaining_amount NUMERIC DEFAULT 0,
      creditor TEXT,
      due_date TEXT,
      monthly_payment NUMERIC DEFAULT 0,
      interest_rate NUMERIC,
      note TEXT,
      restaurant_id TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS equity_entries (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT,
      category TEXT,
      amount NUMERIC DEFAULT 0,
      note TEXT,
      restaurant_id TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS budget_lines (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      category TEXT,
      type TEXT,
      plan_amount NUMERIC DEFAULT 0,
      fact_amount NUMERIC DEFAULT 0,
      period TEXT,
      restaurant_id TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      action TEXT,
      entity_type TEXT,
      entity_id TEXT,
      entity_name TEXT,
      details JSONB,
      user_id TEXT,
      user_name TEXT,
      restaurant_id TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS menu_categories (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0,
      restaurant_id TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS custom_categories (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'out',
      restaurant_id TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS sync_deletions (
      id SERIAL PRIMARY KEY,
      table_name TEXT NOT NULL,
      row_id TEXT NOT NULL,
      deleted_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS sync_meta (
      table_name TEXT PRIMARY KEY,
      last_synced_at TIMESTAMPTZ,
      last_pulled_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS inventory_checks (
      id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
      restaurant_id UUID NOT NULL,
      conducted_by TEXT NOT NULL,
      conducted_by_id UUID,
      status TEXT NOT NULL DEFAULT 'draft',
      total_items INTEGER DEFAULT 0,
      items_with_diff INTEGER DEFAULT 0,
      note TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      applied_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS inventory_check_lines (
      id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
      check_id UUID NOT NULL,
      ingredient_id UUID NOT NULL,
      ingredient_name TEXT NOT NULL,
      unit TEXT NOT NULL,
      system_qty NUMERIC(14,4) NOT NULL DEFAULT 0,
      actual_qty NUMERIC(14,4) NOT NULL DEFAULT 0,
      diff NUMERIC(14,4) NOT NULL DEFAULT 0,
      restaurant_id UUID NOT NULL
    );
  `)

  // ─── Idempotent migrations for existing installs ──────────────────────────
  // These ALTER statements upgrade pre-existing databases that were created
  // with older schemas. All wrapped in try/catch since IF NOT EXISTS works in PG 9.6+.
  const migrations = [
    // users: payroll fields + cloud parity
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS advance NUMERIC DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS deductions NUMERIC DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_id UUID`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS hourly_rate NUMERIC DEFAULT 0`,

    // zones: cloud parity
    `ALTER TABLE zones ADD COLUMN IF NOT EXISTS description TEXT`,
    `ALTER TABLE zones ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 0`,

    // orders: cloud parity
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_id TEXT`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_approved_by TEXT`,
    // orders: soft-cancellation columns (cloud has them via wave5)
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancelled_by TEXT`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancel_reason TEXT`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancelled_total NUMERIC`,
    // order_items: soft-cancellation columns
    `ALTER TABLE order_items ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ`,
    `ALTER TABLE order_items ADD COLUMN IF NOT EXISTS cancelled_by TEXT`,
    `ALTER TABLE order_items ADD COLUMN IF NOT EXISTS cancel_reason TEXT`,
    // order_items: print-dedup flags (atomic claim across devices)
    `ALTER TABLE order_items ADD COLUMN IF NOT EXISTS printed_at TIMESTAMPTZ`,
    `ALTER TABLE order_items ADD COLUMN IF NOT EXISTS cancel_printed_at TIMESTAMPTZ`,
    // One-shot: pre-existing items shouldn't reprint after deploy of dedup flow
    `UPDATE order_items SET printed_at = now() WHERE printed_at IS NULL`,
    `UPDATE order_items SET cancel_printed_at = now() WHERE cancelled_at IS NOT NULL AND cancel_printed_at IS NULL`,
    // Partial indexes for «not yet printed» lookups
    `CREATE INDEX IF NOT EXISTS idx_order_items_printed_at_null ON order_items (order_id) WHERE printed_at IS NULL`,
    `CREATE INDEX IF NOT EXISTS idx_order_items_cancel_printed_at_null ON order_items (order_id) WHERE cancelled_at IS NOT NULL AND cancel_printed_at IS NULL`,

    // ─── perf indexes (волна 1 оптимизаций POS) ──────────────────────────
    // Доказано в tests/perf/payload-fetchOrders.spec.ts: на 200 заказов
    // fetchOrders делает full table scan. С этими индексами list-запросы
    // переходят на index-only / index range scan.
    `CREATE INDEX IF NOT EXISTS idx_orders_restaurant_created ON orders (restaurant_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_orders_restaurant_status ON orders (restaurant_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_orders_shift ON orders (shift_id) WHERE shift_id IS NOT NULL`,
    // FK-lookup для order_items при JOIN-выборках (slim fetchOrders, диалоги).
    `CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items (order_id)`,
    // validateStockForItems batched использует .in(menu_item_id) на tech_card_lines.
    `CREATE INDEX IF NOT EXISTS idx_tech_card_lines_menu_item ON tech_card_lines (menu_item_id)`,
    // ingredients lookup при stock-deduct и пересчёте COGS.
    `CREATE INDEX IF NOT EXISTS idx_ingredients_restaurant ON ingredients (restaurant_id)`,
    // Tables list для table-map.
    `CREATE INDEX IF NOT EXISTS idx_tables_restaurant ON tables (restaurant_id)`,
    `CREATE INDEX IF NOT EXISTS idx_tables_zone ON tables (restaurant_id, zone_id)`,
    // Финансовые операции: фильтрация по shift_id и account_id+date.
    `CREATE INDEX IF NOT EXISTS idx_finops_shift ON financial_operations (shift_id) WHERE shift_id IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_finops_account_date ON financial_operations (account_id, date DESC)`,
    // Voids на заказ — для visibleReceiptItems и recompute.
    `CREATE INDEX IF NOT EXISTS idx_order_voids_order ON order_voids (order_id)`,
    // assets: cloud has updated_at
    `ALTER TABLE assets ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now()`,

    // tech_card_lines: align with cloud (semi_type_id, restaurant_id, created_at)
    `ALTER TABLE tech_card_lines ADD COLUMN IF NOT EXISTS semi_type_id UUID`,
    `ALTER TABLE tech_card_lines ADD COLUMN IF NOT EXISTS restaurant_id TEXT`,
    `ALTER TABLE tech_card_lines ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now()`,
    // copy old semi_fab_type_id to new semi_type_id
    `UPDATE tech_card_lines SET semi_type_id = semi_fab_type_id WHERE semi_type_id IS NULL AND semi_fab_type_id IS NOT NULL`,

    // financial_operations: cloud has updated_at
    `ALTER TABLE financial_operations ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now()`,

    // suppliers: cloud has updated_at
    `ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now()`,

    // stock_receipts: cloud has updated_at
    `ALTER TABLE stock_receipts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now()`,
    // stock_receipt_lines: cloud has created_at
    `ALTER TABLE stock_receipt_lines ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now()`,

    // cash_shifts: cloud aggregate columns
    `ALTER TABLE cash_shifts ADD COLUMN IF NOT EXISTS expected_cash NUMERIC`,
    `ALTER TABLE cash_shifts ADD COLUMN IF NOT EXISTS cash_revenue NUMERIC DEFAULT 0`,
    `ALTER TABLE cash_shifts ADD COLUMN IF NOT EXISTS card_revenue NUMERIC DEFAULT 0`,
    `ALTER TABLE cash_shifts ADD COLUMN IF NOT EXISTS orders_count INTEGER DEFAULT 0`,
    `ALTER TABLE cash_shifts ADD COLUMN IF NOT EXISTS avg_check NUMERIC DEFAULT 0`,
    `ALTER TABLE cash_shifts ADD COLUMN IF NOT EXISTS account_id TEXT`,
    `ALTER TABLE financial_operations ADD COLUMN IF NOT EXISTS shift_id TEXT`,

    // order_voids: cloud has approved_by + created_by (UUIDs alongside the *_name fields)
    `ALTER TABLE order_voids ADD COLUMN IF NOT EXISTS approved_by TEXT`,
    `ALTER TABLE order_voids ADD COLUMN IF NOT EXISTS created_by TEXT`,

    // order_splits: full cloud schema
    `ALTER TABLE order_splits ADD COLUMN IF NOT EXISTS split_type TEXT DEFAULT 'equal'`,
    `ALTER TABLE order_splits ADD COLUMN IF NOT EXISTS subtotal NUMERIC DEFAULT 0`,
    `ALTER TABLE order_splits ADD COLUMN IF NOT EXISTS service_percent NUMERIC DEFAULT 0`,
    `ALTER TABLE order_splits ADD COLUMN IF NOT EXISTS service_amount NUMERIC DEFAULT 0`,
    `ALTER TABLE order_splits ADD COLUMN IF NOT EXISTS account_id TEXT`,
    `ALTER TABLE order_splits ADD COLUMN IF NOT EXISTS account_name TEXT`,
    `ALTER TABLE order_splits ADD COLUMN IF NOT EXISTS paid_by TEXT`,

    // modifier_groups + modifiers: cloud has sort_order + created_at
    `ALTER TABLE modifier_groups ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 0`,
    `ALTER TABLE modifier_groups ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now()`,
    `ALTER TABLE modifiers ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 0`,
    `ALTER TABLE modifiers ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now()`,

    // semi_finished_*: cloud has created_at + updated_at
    `ALTER TABLE semi_finished_types ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now()`,
    `ALTER TABLE semi_recipe_lines  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now()`,
    `ALTER TABLE semi_finished_stock ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now()`,
    `ALTER TABLE semi_finished_stock ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now()`,

    // budget_lines: cloud has updated_at
    `ALTER TABLE budget_lines ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now()`,

    // batch_cooking_logs: reason for writeoffs
    `ALTER TABLE batch_cooking_logs ADD COLUMN IF NOT EXISTS reason TEXT`,

    // Menu archive (soft-delete for dishes with order history).
    // order_items.menu_item_id has ON DELETE RESTRICT, so hard DELETE fails
    // if any order references the dish. is_deleted=true hides the item in UI.
    `ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT false`,

    // Per-dish low-stock threshold for batch-cooking view (default 5 portions).
    `ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS low_stock_threshold INTEGER NOT NULL DEFAULT 5`,

    // Supplies: allow ingredient.qty to go negative when issuing non-food items
    // (outstanding debt is cleared by the next receipt). Default true.
    `ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS supply_allow_negative BOOLEAN NOT NULL DEFAULT true`,

    // PIN lock for POS
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS pin TEXT`,
    `ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS pin_lock_enabled BOOLEAN DEFAULT false`,
    `ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS pin_lock_timeout_min INTEGER DEFAULT 5`,

    // Fix columns that may have been auto-created as TEXT by ensureColumns on older builds.
    // Older api-server.js defaulted to TEXT for any missing column, so booleans/ints sent
    // from the UI hit a TEXT column and PGlite errored with "Invalid input for string type".
    `ALTER TABLE restaurants ALTER COLUMN pin_lock_enabled TYPE BOOLEAN USING (CASE WHEN pin_lock_enabled::text IN ('true','t','1') THEN true WHEN pin_lock_enabled IS NULL THEN false ELSE false END)`,
    `ALTER TABLE restaurants ALTER COLUMN pin_lock_enabled SET DEFAULT false`,
    `ALTER TABLE restaurants ALTER COLUMN pin_lock_timeout_min TYPE INTEGER USING (COALESCE(NULLIF(pin_lock_timeout_min::text,'')::INTEGER, 5))`,
    `ALTER TABLE restaurants ALTER COLUMN pin_lock_timeout_min SET DEFAULT 5`,
    `ALTER TABLE restaurants ALTER COLUMN tech_cards_enabled TYPE BOOLEAN USING (CASE WHEN tech_cards_enabled::text IN ('false','f','0') THEN false WHEN tech_cards_enabled IS NULL THEN true ELSE true END)`,
    `ALTER TABLE restaurants ALTER COLUMN tech_cards_enabled SET DEFAULT true`,
    `ALTER TABLE restaurants ALTER COLUMN auto_ready_mode TYPE BOOLEAN USING (CASE WHEN auto_ready_mode::text IN ('true','t','1') THEN true WHEN auto_ready_mode IS NULL THEN false ELSE false END)`,
    `ALTER TABLE restaurants ALTER COLUMN auto_ready_mode SET DEFAULT false`,
    `ALTER TABLE restaurants ALTER COLUMN auto_ready_buffer_min TYPE INTEGER USING (COALESCE(NULLIF(auto_ready_buffer_min::text,'')::INTEGER, 5))`,
    `ALTER TABLE restaurants ALTER COLUMN auto_ready_buffer_min SET DEFAULT 5`,
    `ALTER TABLE restaurants ALTER COLUMN enforce_stock_check TYPE BOOLEAN USING (CASE WHEN enforce_stock_check::text IN ('true','t','1') THEN true WHEN enforce_stock_check IS NULL THEN false ELSE false END)`,
    `ALTER TABLE restaurants ALTER COLUMN enforce_stock_check SET DEFAULT false`,

    // assets: align with cloud schema
    `ALTER TABLE assets ADD COLUMN IF NOT EXISTS amount NUMERIC DEFAULT 0`,
    `ALTER TABLE assets ADD COLUMN IF NOT EXISTS useful_life_months INTEGER`,
    `ALTER TABLE assets ADD COLUMN IF NOT EXISTS note TEXT`,
    `ALTER TABLE assets ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now()`,
    // backfill amount from old "value" column if it exists
    `UPDATE assets SET amount = value WHERE amount IS NULL AND value IS NOT NULL`,

    // liabilities: align with cloud schema
    `ALTER TABLE liabilities ADD COLUMN IF NOT EXISTS category TEXT`,
    `ALTER TABLE liabilities ADD COLUMN IF NOT EXISTS paid_amount NUMERIC DEFAULT 0`,
    `ALTER TABLE liabilities ADD COLUMN IF NOT EXISTS creditor TEXT`,
    `ALTER TABLE liabilities ADD COLUMN IF NOT EXISTS interest_rate NUMERIC`,
    `ALTER TABLE liabilities ADD COLUMN IF NOT EXISTS note TEXT`,
    `ALTER TABLE liabilities ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now()`,

    // stock_writeoffs: align with cloud (description column, updated_at)
    `ALTER TABLE stock_writeoffs ADD COLUMN IF NOT EXISTS description TEXT`,
    `ALTER TABLE stock_writeoffs ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now()`,
    // backfill description from old "note" column if it exists
    `UPDATE stock_writeoffs SET description = note WHERE description IS NULL AND note IS NOT NULL`,

    // stock_writeoff_lines: rename from old writeoff_lines (cloud uses stock_writeoff_lines)
    `CREATE TABLE IF NOT EXISTS stock_writeoff_lines (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      writeoff_id UUID,
      ingredient_id TEXT,
      name TEXT,
      qty NUMERIC DEFAULT 0,
      unit TEXT,
      cost NUMERIC DEFAULT 0
    )`,
    // copy any data from the old writeoff_lines table if it exists
    `INSERT INTO stock_writeoff_lines (id, writeoff_id, ingredient_id, name, qty, unit, cost)
       SELECT id, writeoff_id, ingredient_id, name, qty, unit, cost FROM writeoff_lines
       WHERE NOT EXISTS (SELECT 1 FROM stock_writeoff_lines WHERE stock_writeoff_lines.id = writeoff_lines.id)`,

    // equity_entries: create if old "equity" table existed
    `CREATE TABLE IF NOT EXISTS equity_entries (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT,
      category TEXT,
      amount NUMERIC DEFAULT 0,
      note TEXT,
      restaurant_id TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    )`,
    // copy data from old "equity" table if it exists and has rows
    `INSERT INTO equity_entries (id, name, amount, restaurant_id, created_at)
       SELECT id, name, amount, restaurant_id, created_at FROM equity
       WHERE NOT EXISTS (SELECT 1 FROM equity_entries WHERE equity_entries.id = equity.id)`,

    // menu_categories table (for existing installs that don't have it yet)
    `CREATE TABLE IF NOT EXISTS menu_categories (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0,
      restaurant_id TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    )`,

    // Add updated_at to child tables for conflict detection
    `ALTER TABLE order_items ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now()`,
    `ALTER TABLE order_item_modifiers ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now()`,
    `ALTER TABLE stock_receipt_lines ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now()`,
    `ALTER TABLE stock_writeoff_lines ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now()`,
    `ALTER TABLE cash_shift_operations ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now()`,

    // sync_deletions table for tracking deletes
    `CREATE TABLE IF NOT EXISTS sync_deletions (
      id SERIAL PRIMARY KEY,
      table_name TEXT NOT NULL,
      row_id TEXT NOT NULL,
      deleted_at TIMESTAMPTZ DEFAULT now()
    )`,

    // Inventory checks (v1.5.10+)
    `CREATE TABLE IF NOT EXISTS inventory_checks (
      id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
      restaurant_id UUID NOT NULL,
      conducted_by TEXT NOT NULL,
      conducted_by_id UUID,
      status TEXT NOT NULL DEFAULT 'draft',
      total_items INTEGER DEFAULT 0,
      items_with_diff INTEGER DEFAULT 0,
      note TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      applied_at TIMESTAMPTZ
    )`,
    `CREATE TABLE IF NOT EXISTS inventory_check_lines (
      id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
      check_id UUID NOT NULL,
      ingredient_id UUID NOT NULL,
      ingredient_name TEXT NOT NULL,
      unit TEXT NOT NULL,
      system_qty NUMERIC(14,4) NOT NULL DEFAULT 0,
      actual_qty NUMERIC(14,4) NOT NULL DEFAULT 0,
      diff NUMERIC(14,4) NOT NULL DEFAULT 0,
      restaurant_id UUID NOT NULL
    )`,

    // ─── Change-log for cloud push (Этап 2 of sync rewrite) ─────────────────
    // Every INSERT/UPDATE/DELETE on a tracked table appends one row here via
    // trigger. The push loop in sync.js pulls unpushed entries and replays
    // them to Supabase. Replaces the brittle full-table pull/diff approach.
    `CREATE TABLE IF NOT EXISTS sync_log (
      id BIGSERIAL PRIMARY KEY,
      table_name TEXT NOT NULL,
      row_id TEXT NOT NULL,
      operation TEXT NOT NULL CHECK (operation IN ('insert','update','delete')),
      payload JSONB,
      restaurant_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      pushed_at TIMESTAMPTZ,
      push_attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_sync_log_unpushed ON sync_log (id) WHERE pushed_at IS NULL`,
    `CREATE INDEX IF NOT EXISTS idx_sync_log_table_row ON sync_log (table_name, row_id, id DESC)`,

    // Generic enqueue function — captures full row as JSON.
    // Skips logging when current_setting('restos.sync_disabled') = 'on' so the
    // pull loop can write rows without echoing them back to cloud.
    // Also fires pg_notify('restos_change', ...) so api-server can broadcast
    // SSE events to all connected LAN clients in real time (Этап 5).
    `CREATE OR REPLACE FUNCTION enqueue_sync_log() RETURNS TRIGGER AS $$
     DECLARE
       _rid TEXT;
       _row_id TEXT;
       _op TEXT;
     BEGIN
       IF current_setting('restos.sync_disabled', true) = 'on' THEN
         RETURN COALESCE(NEW, OLD);
       END IF;
       IF TG_OP = 'DELETE' THEN
         _op := 'delete';
         _row_id := OLD.id::text;
         BEGIN _rid := OLD.restaurant_id::text; EXCEPTION WHEN undefined_column THEN _rid := NULL; END;
         INSERT INTO sync_log (table_name, row_id, operation, payload, restaurant_id)
           VALUES (TG_TABLE_NAME, _row_id, _op, NULL, _rid);
       ELSE
         _op := lower(TG_OP);
         _row_id := NEW.id::text;
         BEGIN _rid := NEW.restaurant_id::text; EXCEPTION WHEN undefined_column THEN _rid := NULL; END;
         INSERT INTO sync_log (table_name, row_id, operation, payload, restaurant_id)
           VALUES (TG_TABLE_NAME, _row_id, _op, row_to_json(NEW)::jsonb, _rid);
       END IF;
       PERFORM pg_notify('restos_change', json_build_object(
         'table', TG_TABLE_NAME,
         'op',    _op,
         'id',    _row_id
       )::text);
       RETURN COALESCE(NEW, OLD);
     END;
     $$ LANGUAGE plpgsql`,
  ]

  // Attach the enqueue trigger to every push-tracked table. We DROP first so
  // re-running migrations (after function changes) updates the binding.
  const SYNCED_TABLES = [
    'users', 'zones', 'customers', 'suppliers', 'ingredients',
    'financial_accounts', 'custom_categories', 'menu_categories',
    'modifier_groups', 'modifiers',
    'semi_finished_types', 'semi_recipe_lines', 'semi_finished_stock',
    'assets', 'liabilities', 'equity_entries', 'budget_lines',
    'menu_items', 'tech_card_lines',
    'tables',
    'cash_shifts', 'cash_shift_operations',
    'orders', 'order_items', 'order_item_modifiers',
    'order_voids', 'order_splits',
    'reservations',
    'stock_receipts', 'stock_receipt_lines',
    'stock_writeoffs', 'stock_writeoff_lines',
    'stock_movements',
    'financial_operations',
    'batch_cooking_logs', 'supply_expenses',
    'time_entries',
  ]
  for (const t of SYNCED_TABLES) {
    migrations.push(`DROP TRIGGER IF EXISTS trg_sync_log_${t} ON ${t}`)
    migrations.push(`CREATE TRIGGER trg_sync_log_${t}
                       AFTER INSERT OR UPDATE OR DELETE ON ${t}
                       FOR EACH ROW EXECUTE FUNCTION enqueue_sync_log()`)
  }

  for (const sql of migrations) {
    try {
      await db.exec(sql)
    } catch (e) {
      // Ignore "table doesn't exist" errors for the equity backfill
      if (!/relation .* does not exist|column .* does not exist/i.test(e.message)) {
        console.warn('[DB] migration warn:', e.message)
      }
    }
  }

  console.log('  [DB] PostgreSQL (PGlite) initialized')
  return db
}

function getDB() {
  return db
}

const DB_PATH = DB_DIR

module.exports = { initDB, getDB, DB_PATH }
