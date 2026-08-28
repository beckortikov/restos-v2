-- +goose Up
-- +goose StatementBegin
--
-- 094_delivery_relay_amend — «дозаказ» в уже отправленный central→филиал
-- заказ (продолжение 091 базовый relay, 092 order_type). kind различает
-- обычное создание от дозаказа в уже материализованный заказ;
-- parent_relay_id указывает на исходную create-строку — по её id филиал
-- находит local_order_id через delivery_relay_received (091) и добавляет
-- позиции в уже существующий заказ, а не создаёт новый.
--
ALTER TABLE delivery_relay_orders ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'create';
ALTER TABLE delivery_relay_orders DROP CONSTRAINT IF EXISTS delivery_relay_orders_kind_check;
ALTER TABLE delivery_relay_orders ADD CONSTRAINT delivery_relay_orders_kind_check CHECK (kind IN ('create', 'amend'));
ALTER TABLE delivery_relay_orders ADD COLUMN IF NOT EXISTS parent_relay_id UUID REFERENCES delivery_relay_orders(id);
CREATE INDEX IF NOT EXISTS idx_delivery_relay_orders_parent ON delivery_relay_orders (parent_relay_id) WHERE parent_relay_id IS NOT NULL;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP INDEX IF EXISTS idx_delivery_relay_orders_parent;
ALTER TABLE delivery_relay_orders DROP COLUMN IF EXISTS parent_relay_id;
ALTER TABLE delivery_relay_orders DROP CONSTRAINT IF EXISTS delivery_relay_orders_kind_check;
ALTER TABLE delivery_relay_orders DROP COLUMN IF EXISTS kind;
-- +goose StatementEnd
