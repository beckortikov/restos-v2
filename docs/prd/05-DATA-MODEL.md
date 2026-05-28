# 05 — Data Model

Источник схемы — `archive/legacy-node-backend/db.js` (40+ таблиц). В v4 портируем 1:1 на PostgreSQL 16. Поскольку оригинал был PGlite (тот же Postgres под капотом), миграция почти буквальная — без диалект-адаптаций.

## Что НЕ требует адаптации

В отличие от SQLite-плана, на настоящем Postgres сохраняем как есть:

- `UUID PRIMARY KEY DEFAULT gen_random_uuid()` — поддерживается (extension `pgcrypto`).
- `NUMERIC(p,s)` — нативный точный десятичный тип, идеально для денег.
- `TIMESTAMPTZ` — нативно.
- `JSONB` — нативно, с GIN-индексами.
- `BOOLEAN` — нативно.
- `CHECK`-constraints — нативно.
- Generated columns — нативно.
- Триггеры — нативно (хотя в v4 переходим на GORM-хуки, см. ниже).
- Partial indexes (`WHERE ...`) — нативно.

## Postgres extensions (включаем при init DB)

```sql
CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "citext";      -- case-insensitive text (например, email)
CREATE EXTENSION IF NOT EXISTS "pg_trgm";     -- триграммы для ILIKE-поиска по меню
```

`embedded-postgres` поставляется с этими extensions из коробки.

## Деньги

`NUMERIC(14, 4)` в БД + `decimal.Decimal` (`github.com/shopspring/decimal`) в Go. Никакого float. GORM-маппинг:

```go
type Order struct {
    Total decimal.Decimal `gorm:"type:numeric(14,4);not null;default:0" json:"total"`
}
```

## Список таблиц (40)

Из `archive/legacy-node-backend/db.js`:

### Core / tenant
- `restaurants` — тенанты
- `users` — кассиры/повара/официанты/менеджеры/owner
- `audit_log` — все мутации

### Layout
- `zones`
- `tables`
- `reservations`
- `customers`

### Menu
- `menu_categories` (системные)
- `custom_categories` (пользовательские)
- `menu_items`
- `tech_card_lines`
- `modifier_groups`
- `modifiers`

### Orders
- `orders`
- `order_items`
- `order_item_modifiers`
- `order_voids`
- `order_splits`

### Stock
- `ingredients`
- `stock_movements` — event stream (append-only)
- `suppliers`
- `stock_receipts`
- `stock_receipt_lines`
- `stock_writeoffs`
- `stock_writeoff_lines`
- `inventory_checks`
- `inventory_check_lines`
- `supply_expenses`
- `semi_finished_types`
- `semi_recipe_lines`
- `semi_finished_stock`
- `batch_cooking_logs`

### Shifts & finance
- `cash_shifts`
- `cash_shift_operations`
- `financial_accounts`
- `financial_operations`
- `assets`
- `liabilities`
- `equity_entries`
- `budget_lines`

### Payroll
- `time_entries`

### v4 новые/служебные
- `idempotency_keys` — для Idempotency-Key middleware
- `print_jobs` — очередь печати
- `sessions` — PIN-сессии (если решим хранить server-side)

**Удалены** относительно v1 (Supabase sync убран):
- ~~`sync_log`~~
- ~~`sync_deletions`~~
- ~~`sync_meta`~~

## GORM-модели — структура

Каждая модель в `server/internal/db/models/`. Пример заказа:

```go
// server/internal/db/models/order.go
package models

import (
    "time"
    "github.com/shopspring/decimal"
)

type Order struct {
    ID            string          `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
    RestaurantID  string          `gorm:"type:uuid;not null;index" json:"restaurant_id"`
    TableID       *string         `gorm:"type:uuid;index" json:"table_id,omitempty"`
    WaiterID      *string         `gorm:"type:uuid;index" json:"waiter_id,omitempty"`
    ShiftID       *string         `gorm:"type:uuid;index" json:"shift_id,omitempty"`

    Status        string          `gorm:"type:text;not null;check:status IN ('draft','open','bill_requested','closed','cancelled');index" json:"status"`
    KitchenStatus string          `gorm:"type:text;not null;default:'new'" json:"kitchen_status"`
    OrderType     string          `gorm:"type:text;not null;default:'dine_in';check:order_type IN ('dine_in','takeaway','delivery')" json:"order_type"`

    Subtotal       decimal.Decimal `gorm:"type:numeric(14,4);not null;default:0" json:"subtotal"`
    DiscountAmount decimal.Decimal `gorm:"type:numeric(14,4);not null;default:0" json:"discount_amount"`
    ServiceAmount  decimal.Decimal `gorm:"type:numeric(14,4);not null;default:0" json:"service_amount"`
    TipAmount      decimal.Decimal `gorm:"type:numeric(14,4);not null;default:0" json:"tip_amount"`
    Total          decimal.Decimal `gorm:"type:numeric(14,4);not null;default:0" json:"total"`

    Meta          datatypes.JSON  `gorm:"type:jsonb" json:"meta,omitempty"`

    CreatedAt     time.Time       `gorm:"not null;index" json:"created_at"`
    UpdatedAt     time.Time       `gorm:"not null;index" json:"updated_at"`
    ClosedAt      *time.Time      `json:"closed_at,omitempty"`

    // associations
    Items         []OrderItem     `gorm:"foreignKey:OrderID" json:"items,omitempty"`
    Table         *Table          `gorm:"foreignKey:TableID" json:"table,omitempty"`
    Waiter        *User           `gorm:"foreignKey:WaiterID" json:"waiter,omitempty"`
}

func (Order) TableName() string { return "orders" }
```

## Индексы (критичные)

```sql
-- orders: hot path queries
CREATE INDEX idx_orders_restaurant_status_created
  ON orders(restaurant_id, status, created_at DESC);

CREATE INDEX idx_orders_restaurant_table_open
  ON orders(restaurant_id, table_id)
  WHERE status IN ('open', 'bill_requested');

CREATE INDEX idx_orders_shift ON orders(shift_id) WHERE shift_id IS NOT NULL;

-- order_items
CREATE INDEX idx_order_items_order ON order_items(order_id);
CREATE INDEX idx_order_items_menu_item ON order_items(menu_item_id);

-- menu search (ILIKE)
CREATE INDEX idx_menu_items_name_trgm ON menu_items USING GIN (name gin_trgm_ops);

-- stock_movements: event stream
CREATE INDEX idx_stock_movements_ingredient_ts
  ON stock_movements(ingredient_id, created_at);
CREATE INDEX idx_stock_movements_order
  ON stock_movements(order_id) WHERE order_id IS NOT NULL;

-- financial_operations: reports
CREATE INDEX idx_finops_restaurant_created
  ON financial_operations(restaurant_id, created_at DESC);
CREATE INDEX idx_finops_account ON financial_operations(account_id);
CREATE INDEX idx_finops_order ON financial_operations(order_id) WHERE order_id IS NOT NULL;

-- audit_log
CREATE INDEX idx_audit_restaurant_created
  ON audit_log(restaurant_id, created_at DESC);

-- idempotency
CREATE INDEX idx_idem_expires ON idempotency_keys(expires_at);

-- print_jobs queue
CREATE INDEX idx_print_jobs_pending
  ON print_jobs(created_at) WHERE status = 'pending';
```

## Миграции

- `server/internal/db/migrations/*.sql` — embedded через `embed.FS`.
- Инструмент: **goose**.
- Naming: `001_init.up.sql`, `001_init.down.sql`, `002_add_kitchen_status.up.sql`, ...
- Все миграции forward-compatible (нет `DROP COLUMN` без deprecation period).

### Что в `001_init.sql`

Берётся `desktop/db.js` целиком (CREATE TABLE × 40+), копируется почти 1:1, плюс убираются `sync_log/sync_deletions/sync_meta` и связанные триггеры, плюс добавляются `idempotency_keys` и `print_jobs`. Это разовая ручная работа на 1 день.

### Без БД-триггеров

В v1 были триггеры на каждую таблицу, которые писали в `sync_log` (для Supabase replication). В v4 этого больше нет. Если понадобятся cross-cutting эффекты (audit, events) — пишем через GORM-хуки в Go:

```go
// server/internal/audit/hooks.go
func RegisterHooks(db *gorm.DB) {
    db.Callback().Create().After("gorm:create").Register("audit:create", auditAfterCreate)
    db.Callback().Update().After("gorm:update").Register("audit:update", auditAfterUpdate)
    db.Callback().Delete().After("gorm:delete").Register("audit:delete", auditAfterDelete)
}
```

Преимущество: легко тестировать, легко выключать в тестах, нет SQL-специфики.

## tenant_id — обязательность

Каждая операционная таблица содержит `restaurant_id UUID NOT NULL`. На уровне Go:

```go
// server/internal/repo/base.go
func (r *OrdersRepo) ForTenant(ctx context.Context) *gorm.DB {
    tid := tenant.From(ctx)
    if tid == "" {
        panic("missing tenant_id in context")  // явная защита от утечки
    }
    return r.db.WithContext(ctx).Where("restaurant_id = ?", tid)
}

func (r *OrdersRepo) List(ctx context.Context, filter OrderFilter) ([]models.Order, error) {
    q := r.ForTenant(ctx).Model(&models.Order{})
    // ...применяем фильтры...
    var out []models.Order
    return out, q.Find(&out).Error
}
```

CI-линтер запрещает прямой `r.db.Find(...)` в `repo/*.go` (вне `ForTenant`-хелперов).

## Constraints (CHECK)

Все enum-поля защищены `CHECK`-ами (дублируется валидация в Go через `go-playground/validator`):

```sql
CREATE TABLE orders (
  ...
  status TEXT NOT NULL CHECK (status IN ('draft', 'open', 'bill_requested', 'closed', 'cancelled')),
  order_type TEXT NOT NULL DEFAULT 'dine_in'
    CHECK (order_type IN ('dine_in', 'takeaway', 'delivery')),
  ...
);
```

## Connection pool

```go
sqlDB, _ := db.DB()
sqlDB.SetMaxIdleConns(5)
sqlDB.SetMaxOpenConns(25)        // 20 официантов + кассиры + KDS — 25 хватит с запасом
sqlDB.SetConnMaxLifetime(time.Hour)
sqlDB.SetConnMaxIdleTime(10 * time.Minute)
```

## Postgres tuning (для embedded)

Конфиг `postgresql.conf` подкручивается через `embedded-postgres` `StartParameters` или через `ALTER SYSTEM`:

```
shared_buffers = 128MB           # 25% RAM мини-ПК (если 1 ГБ свободно)
work_mem = 4MB
effective_cache_size = 512MB
maintenance_work_mem = 64MB
wal_buffers = 8MB
checkpoint_completion_target = 0.9
random_page_cost = 1.1           # SSD
synchronous_commit = on          # данные кассы — не теряем
fsync = on
max_connections = 50
```

Эти параметры мини-ПК спокойно тянет, и Postgres не упрётся в default 128 connections.

## Бэкап

- Background job (`jobs/backup.go`) делает `pg_dump --format=custom > backups/restos-YYYY-MM-DD.dump` ежедневно в 3:00.
- Ротация: 7 daily + 4 weekly + 12 monthly.
- Команда `POST /admin/backup` — для саппорта вручную.
- Команда `restos-server restore --from=file.dump` — CLI восстановление.

## Размеры (оценка)

Для среднего ресторана 6 мес:
- 60 заказов/день × 180 дней = 10800 заказов × 5 items = 54000 order_items
- 54000 stock_movements
- ~100000 audit_log
- ~500 МБ итого вместе с индексами. На SSD не критично.

После 2 лет — ~2 ГБ. Тоже норм. Архивация старых заказов (move to `orders_archive`) — отдельный job, не в MVP.
