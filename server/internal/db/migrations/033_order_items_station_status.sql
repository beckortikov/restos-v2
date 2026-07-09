-- +goose Up
-- +goose StatementBegin
--
-- 033_order_items_station_status — per-dish статус для KDS (кухонного дисплея).
--
-- До этого статус готовки был только на уровне ЗАКАЗА (orders.status:
-- new/cooking/ready). Но каждое блюдо готовится отдельно (часто на разных
-- станциях), поэтому KDS двигает не заказ целиком, а каждую позицию.
--
-- station_status — статус позиции на кухне:
--   pending  — новое, ещё не взяли в работу
--   cooking  — готовится
--   ready    — готово к выдаче
--   served   — выдано/закрыто (уходит с доски)
-- Отмена позиции остаётся через order_items.cancelled_at (не отдельный статус).
--
-- station_status_at — когда статус последний раз менялся (для таймеров/сортировки).
--
-- NOT NULL DEFAULT 'pending' → все существующие позиции считаются новыми; на живой
-- кухне это безопасно (закрытые заказы KDS не показывает — фильтр по заказу).
ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS station_status TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS station_status_at TIMESTAMPTZ;

ALTER TABLE order_items
  ADD CONSTRAINT order_items_station_status_chk
  CHECK (station_status IN ('pending', 'cooking', 'ready', 'served'));

-- KDS фильтрует активные позиции по статусу — частичный индекс на «в работе».
CREATE INDEX IF NOT EXISTS idx_order_items_station_status
  ON order_items (station_status)
  WHERE station_status IN ('pending', 'cooking', 'ready');
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP INDEX IF EXISTS idx_order_items_station_status;
ALTER TABLE order_items DROP CONSTRAINT IF EXISTS order_items_station_status_chk;
ALTER TABLE order_items
  DROP COLUMN IF EXISTS station_status,
  DROP COLUMN IF EXISTS station_status_at;
-- +goose StatementEnd
