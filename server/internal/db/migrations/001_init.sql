-- +goose Up
-- +goose StatementBegin
--
-- Initial schema for RestOS v4.
--
-- Перенос 1:1 из archive/legacy-node-backend/db.js, нормализованный под PG16:
--   • Все ALTER ... ADD COLUMN IF NOT EXISTS из миграций v1 свёрнуты в CREATE TABLE.
--   • Опущены sync_log / sync_deletions / sync_meta / триггеры enqueue_sync_log —
--     облачная синхронизация в v4 отсутствует (см. CLAUDE.md + docs/prd/07-FUTURE-CLOUD.md).
--   • Денежные колонки приведены к NUMERIC(14,4) — см. ADR-002 и CLAUDE.md.
--   • UUID PK через gen_random_uuid() — pgcrypto/pg16 имеют функцию из коробки.
--   • Индексы из «волны 1 оптимизаций POS» сохранены.
--
-- Внимание: в v4 это первая (и пока единственная) миграция. Дальнейшие изменения
-- схемы — новыми файлами 002_*.sql и т.д. ALTER задним числом не правим.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ─── core tenant ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS restaurants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT,
  logo_url TEXT,
  address TEXT,
  phone TEXT,
  currency TEXT DEFAULT 'TJS',
  service_percent NUMERIC(14,4) DEFAULT 10,
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
  supply_allow_negative BOOLEAN NOT NULL DEFAULT true,
  pin_lock_enabled BOOLEAN DEFAULT false,
  pin_lock_timeout_min INTEGER DEFAULT 5,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_id UUID,
  username TEXT,
  password TEXT DEFAULT '1234',
  pin TEXT,
  name TEXT,
  role TEXT DEFAULT 'waiter',
  restaurant_id TEXT,
  phone TEXT,
  email TEXT,
  position TEXT,
  birth_date TEXT,
  station TEXT,
  shift_number INTEGER,
  salary NUMERIC(14,4) DEFAULT 0,
  hourly_rate NUMERIC(14,4) DEFAULT 0,
  advance NUMERIC(14,4) DEFAULT 0,
  deductions NUMERIC(14,4) DEFAULT 0,
  permissions JSONB,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ─── floor plan ─────────────────────────────────────────────────────────────

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

-- ─── menu ────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS menu_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,
  restaurant_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS menu_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT,
  category TEXT,
  price NUMERIC(14,4) DEFAULT 0,
  emoji TEXT DEFAULT '',
  image_url TEXT,
  is_available BOOLEAN DEFAULT true,
  stop_list_override BOOLEAN DEFAULT false,
  cogs NUMERIC(14,4) DEFAULT 0,
  cook_time_min INTEGER,
  station TEXT DEFAULT 'hot_kitchen',
  is_batch_cooking BOOLEAN DEFAULT false,
  prepared_qty INTEGER DEFAULT 0,
  unit TEXT DEFAULT 'piece',
  unit_size NUMERIC(14,4) DEFAULT 1,
  sale_step NUMERIC(14,4) DEFAULT 0,
  is_deleted BOOLEAN NOT NULL DEFAULT false,
  low_stock_threshold INTEGER NOT NULL DEFAULT 5,
  restaurant_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
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
  price NUMERIC(14,4) DEFAULT 0,
  is_default BOOLEAN DEFAULT false,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tech_card_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  menu_item_id UUID,
  ingredient_id UUID,
  semi_type_id UUID,
  name TEXT,
  qty NUMERIC(14,4) DEFAULT 0,
  unit TEXT,
  restaurant_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ─── stock ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ingredients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT,
  category TEXT,
  qty NUMERIC(14,4) DEFAULT 0,
  min_qty NUMERIC(14,4) DEFAULT 0,
  unit TEXT,
  price_per_unit NUMERIC(14,4) DEFAULT 0,
  waste_percent NUMERIC(14,4) DEFAULT 0,
  is_food BOOLEAN DEFAULT true,
  restaurant_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stock_movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT,
  ingredient_id TEXT,
  ingredient_name TEXT,
  description TEXT,
  qty NUMERIC(14,4) DEFAULT 0,
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
  credit_limit NUMERIC(14,4) DEFAULT 0,
  current_debt NUMERIC(14,4) DEFAULT 0,
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
  total_amount NUMERIC(14,4) DEFAULT 0,
  payment_type TEXT DEFAULT 'paid',
  paid_amount NUMERIC(14,4) DEFAULT 0,
  debt_amount NUMERIC(14,4) DEFAULT 0,
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
  qty NUMERIC(14,4) DEFAULT 0,
  unit TEXT,
  price_per_unit NUMERIC(14,4) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stock_writeoffs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reason TEXT,
  description TEXT,
  total_cost NUMERIC(14,4) DEFAULT 0,
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
  qty NUMERIC(14,4) DEFAULT 0,
  unit TEXT,
  cost NUMERIC(14,4) DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS semi_finished_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT,
  output_unit TEXT DEFAULT 'кг',
  yield_percent NUMERIC(14,4) DEFAULT 100,
  restaurant_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS semi_recipe_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  semi_type_id UUID,
  ingredient_id UUID,
  name TEXT,
  qty_per_unit NUMERIC(14,4) DEFAULT 0,
  unit TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS semi_finished_stock (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  semi_type_id UUID,
  name TEXT,
  qty NUMERIC(14,4) DEFAULT 0,
  unit TEXT,
  price_per_unit NUMERIC(14,4) DEFAULT 0,
  last_produced_at TIMESTAMPTZ,
  restaurant_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS batch_cooking_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  menu_item_id UUID,
  menu_item_name TEXT,
  qty INTEGER DEFAULT 0,
  produced_by TEXT,
  produced_by_id UUID,
  cost_total NUMERIC(14,4) DEFAULT 0,
  reason TEXT,
  restaurant_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS supply_expenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ingredient_id UUID,
  ingredient_name TEXT,
  qty NUMERIC(14,4) DEFAULT 0,
  unit TEXT,
  reason TEXT,
  issued_to TEXT,
  note TEXT,
  created_by TEXT,
  restaurant_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
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
  created_at TIMESTAMPTZ DEFAULT now(),
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

-- ─── orders ──────────────────────────────────────────────────────────────────

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
  total NUMERIC(14,4) DEFAULT 0,
  service_percent NUMERIC(14,4) DEFAULT 0,
  service_amount NUMERIC(14,4) DEFAULT 0,
  total_with_service NUMERIC(14,4) DEFAULT 0,
  guests_count INTEGER DEFAULT 1,
  tip_amount NUMERIC(14,4) DEFAULT 0,
  payments JSONB DEFAULT '[]',
  discount_type TEXT,
  discount_value NUMERIC(14,4) DEFAULT 0,
  discount_amount NUMERIC(14,4) DEFAULT 0,
  discount_reason TEXT,
  discount_approved_by TEXT,
  is_split BOOLEAN DEFAULT false,
  split_count INTEGER DEFAULT 0,
  shift_id TEXT,
  restaurant_id TEXT,
  ready_at TIMESTAMPTZ,
  expected_ready_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  cancelled_by TEXT,
  cancel_reason TEXT,
  cancelled_total NUMERIC(14,4),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID,
  menu_item_id UUID,
  name TEXT,
  qty NUMERIC(14,4) DEFAULT 1,
  price NUMERIC(14,4) DEFAULT 0,
  cogs NUMERIC(14,4) DEFAULT 0,
  unit TEXT DEFAULT 'piece',
  unit_size NUMERIC(14,4) DEFAULT 1,
  cancelled_at TIMESTAMPTZ,
  cancelled_by TEXT,
  cancel_reason TEXT,
  printed_at TIMESTAMPTZ,
  cancel_printed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS order_item_modifiers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_item_id UUID,
  modifier_id UUID,
  name TEXT,
  price NUMERIC(14,4) DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS order_voids (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID,
  item_name TEXT,
  item_qty INTEGER DEFAULT 1,
  item_price NUMERIC(14,4) DEFAULT 0,
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
  subtotal NUMERIC(14,4) DEFAULT 0,
  service_percent NUMERIC(14,4) DEFAULT 0,
  service_amount NUMERIC(14,4) DEFAULT 0,
  total NUMERIC(14,4) DEFAULT 0,
  status TEXT DEFAULT 'pending',
  payment_method TEXT,
  account_id TEXT,
  account_name TEXT,
  paid_at TIMESTAMPTZ,
  paid_by TEXT,
  restaurant_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ─── finance ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS financial_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT,
  type TEXT DEFAULT 'cash',
  balance NUMERIC(14,4) DEFAULT 0,
  restaurant_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS financial_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT,
  amount NUMERIC(14,4) DEFAULT 0,
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

CREATE TABLE IF NOT EXISTS cash_shifts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  opened_by TEXT,
  closed_by TEXT,
  opening_balance NUMERIC(14,4) DEFAULT 0,
  closing_balance NUMERIC(14,4) DEFAULT 0,
  expected_cash NUMERIC(14,4),
  cash_revenue NUMERIC(14,4) DEFAULT 0,
  card_revenue NUMERIC(14,4) DEFAULT 0,
  orders_count INTEGER DEFAULT 0,
  avg_check NUMERIC(14,4) DEFAULT 0,
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
  amount NUMERIC(14,4) DEFAULT 0,
  description TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT,
  category TEXT,
  amount NUMERIC(14,4) DEFAULT 0,
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
  total_amount NUMERIC(14,4) DEFAULT 0,
  paid_amount NUMERIC(14,4) DEFAULT 0,
  remaining_amount NUMERIC(14,4) DEFAULT 0,
  creditor TEXT,
  due_date TEXT,
  monthly_payment NUMERIC(14,4) DEFAULT 0,
  interest_rate NUMERIC(14,4),
  note TEXT,
  restaurant_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS equity_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT,
  category TEXT,
  amount NUMERIC(14,4) DEFAULT 0,
  note TEXT,
  restaurant_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS budget_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category TEXT,
  type TEXT,
  plan_amount NUMERIC(14,4) DEFAULT 0,
  fact_amount NUMERIC(14,4) DEFAULT 0,
  period TEXT,
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

-- ─── misc ───────────────────────────────────────────────────────────────────

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
  total_spent NUMERIC(14,4) DEFAULT 0,
  avg_check NUMERIC(14,4) DEFAULT 0,
  last_visit_at TIMESTAMPTZ,
  restaurant_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS time_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID,
  clock_in TIMESTAMPTZ,
  clock_out TIMESTAMPTZ,
  break_minutes INTEGER DEFAULT 0,
  total_hours NUMERIC(14,4) DEFAULT 0,
  status TEXT DEFAULT 'active',
  note TEXT,
  restaurant_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
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

-- ─── idempotency (v4-specific, не было в v1) ────────────────────────────────
--
-- Все write-эндпоинты принимают Idempotency-Key (UUID). Middleware кэширует
-- ответ на 24 часа. Очистка — job в internal/jobs/.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key UUID PRIMARY KEY,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_status INTEGER NOT NULL,
  response_body JSONB,
  restaurant_id TEXT,
  user_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '24 hours')
);
CREATE INDEX IF NOT EXISTS idx_idempotency_expires ON idempotency_keys (expires_at);

-- ─── print queue (v4-specific) ──────────────────────────────────────────────
--
-- close_order ставит сюда job, async worker отправляет на физический принтер.
-- См. CLAUDE.md: print is fire-and-forget внутри транзакции close_order.
CREATE TABLE IF NOT EXISTS print_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL,
  printer_id TEXT,
  payload BYTEA NOT NULL,
  order_id UUID,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  restaurant_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  printed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_print_jobs_pending ON print_jobs (status, created_at) WHERE status = 'pending';

-- ─── performance indexes ────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_orders_restaurant_created ON orders (restaurant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_restaurant_status  ON orders (restaurant_id, status);
CREATE INDEX IF NOT EXISTS idx_orders_shift              ON orders (shift_id) WHERE shift_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_order_items_order_id      ON order_items (order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_printed_at_null
  ON order_items (order_id) WHERE printed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_order_items_cancel_printed_at_null
  ON order_items (order_id) WHERE cancelled_at IS NOT NULL AND cancel_printed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_tech_card_lines_menu_item ON tech_card_lines (menu_item_id);
CREATE INDEX IF NOT EXISTS idx_ingredients_restaurant    ON ingredients (restaurant_id);
CREATE INDEX IF NOT EXISTS idx_tables_restaurant         ON tables (restaurant_id);
CREATE INDEX IF NOT EXISTS idx_tables_zone               ON tables (restaurant_id, zone_id);
CREATE INDEX IF NOT EXISTS idx_finops_shift              ON financial_operations (shift_id) WHERE shift_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_finops_account_date       ON financial_operations (account_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_order_voids_order         ON order_voids (order_id);

-- GIN-индексы на ILIKE-поиск (см. CLAUDE.md):
CREATE INDEX IF NOT EXISTS idx_menu_items_name_trgm  ON menu_items USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_ingredients_name_trgm ON ingredients USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_customers_name_trgm   ON customers   USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_customers_phone_trgm  ON customers   USING gin (phone gin_trgm_ops);

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS
  audit_log, idempotency_keys, print_jobs,
  inventory_check_lines, inventory_checks,
  supply_expenses, batch_cooking_logs,
  semi_finished_stock, semi_recipe_lines, semi_finished_types,
  stock_writeoff_lines, stock_writeoffs,
  stock_receipt_lines, stock_receipts,
  suppliers, stock_movements, ingredients,
  tech_card_lines, modifiers, modifier_groups,
  menu_items, menu_categories,
  order_item_modifiers, order_items, order_voids, order_splits, orders,
  cash_shift_operations, cash_shifts,
  financial_operations, financial_accounts,
  budget_lines, equity_entries, liabilities, assets,
  custom_categories, customers, reservations, time_entries,
  tables, zones, users, restaurants
CASCADE;
-- +goose StatementEnd
