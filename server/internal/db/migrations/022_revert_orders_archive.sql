-- +goose Up
-- +goose StatementBegin
--
-- 022_revert_orders_archive — откат migration 021 (orders_archive).
--
-- Решение v3.6.2: партиционирование / архивация для ресторанной кассы
-- не оправданы. Partial indexes (migration 019) + BRIN indexes
-- (migration 020) дают 95% эффекта без усложнения схемы:
--   - active queries бьют по partial index (десятки строк)
--   - historical queries (analytics, reports) идут по BRIN на created_at
--   - Postgres 16 спокойно держит 10M+ строк в orders с правильными индексами
--
-- Архив усложнял: VIEW orders_all для исторической аналитики, потеря
-- FK для архивных order_items, fire-and-forget hook в close shift —
-- всё ради эфемерной выгоды. Возвращаемся к простой схеме.

DROP VIEW IF EXISTS orders_all;
DROP TABLE IF EXISTS orders_archive;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
-- Восстановление: см. 021_orders_archive.sql.
CREATE TABLE IF NOT EXISTS orders_archive (LIKE orders INCLUDING DEFAULTS INCLUDING CONSTRAINTS);
CREATE INDEX IF NOT EXISTS idx_orders_archive_closed_at_brin
  ON orders_archive USING BRIN (closed_at)
  WITH (pages_per_range = 128);
CREATE INDEX IF NOT EXISTS idx_orders_archive_restaurant
  ON orders_archive (restaurant_id, closed_at DESC);
CREATE OR REPLACE VIEW orders_all AS
  SELECT * FROM orders
  UNION ALL
  SELECT * FROM orders_archive;
-- +goose StatementEnd
