-- +goose Up
-- +goose StatementBegin
--
-- 019_orders_partial_indexes — partial indexes для «горячих» orders.
--
-- Зачем: на больших ресторанах (>100k закрытых заказов) запросы вида
--   SELECT * FROM orders WHERE restaurant_id=? AND status='new'
-- сканируют все строки в общем индексе. Большая часть из них —
-- закрытые/отменённые, которые никому не нужны в горячих UI-запросах.
--
-- Partial index содержит ТОЛЬКО активные заказы (десятки строк), запросы
-- по нему летят за <1ms независимо от размера таблицы.
--
-- На пустой БД эффект незаметен. На БД с 500k+ заказов — ускорение
-- в 5-50 раз для KDS / POS / waiter UI.
--
-- Если в будущем добавим столбцы — пересоздать индекс (Postgres не
-- умеет ALTER PARTIAL INDEX). Делать через CONCURRENTLY на проде
-- чтобы не блокировать кассу.

-- Активные orders для KDS / POS / waiter views.
-- created_at нужен для сортировки по времени поступления + cursor pagination.
CREATE INDEX IF NOT EXISTS idx_orders_active
  ON orders (restaurant_id, created_at DESC)
  WHERE status IN ('new','open','cooking','ready','served','bill_requested')
    AND closed_at IS NULL;

-- Активные orders по столу — для «какой заказ на столе X».
-- Используется в TableDetailSheet, POS картинке зала.
CREATE INDEX IF NOT EXISTS idx_orders_active_by_table
  ON orders (restaurant_id, table_id)
  WHERE status IN ('new','open','cooking','ready','served','bill_requested')
    AND closed_at IS NULL
    AND table_id IS NOT NULL;

-- Активные orders по официанту — для «Мои заказы» (waiter PWA).
CREATE INDEX IF NOT EXISTS idx_orders_active_by_waiter
  ON orders (restaurant_id, waiter_id)
  WHERE status IN ('new','open','cooking','ready','served','bill_requested')
    AND closed_at IS NULL
    AND waiter_id IS NOT NULL;

-- Незаплачено-готовые позиции для KDS-runner'а.
CREATE INDEX IF NOT EXISTS idx_order_items_pending_print
  ON order_items (order_id)
  WHERE printed_at IS NULL
    AND cancelled_at IS NULL;

-- Незакрытые position для kitchen ready-flow.
CREATE INDEX IF NOT EXISTS idx_order_items_pending_serve
  ON order_items (order_id, created_at)
  WHERE served_at IS NULL
    AND cancelled_at IS NULL;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP INDEX IF EXISTS idx_orders_active;
DROP INDEX IF EXISTS idx_orders_active_by_table;
DROP INDEX IF EXISTS idx_orders_active_by_waiter;
DROP INDEX IF EXISTS idx_order_items_pending_print;
DROP INDEX IF EXISTS idx_order_items_pending_serve;
-- +goose StatementEnd
