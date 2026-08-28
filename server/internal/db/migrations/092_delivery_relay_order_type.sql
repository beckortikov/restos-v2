-- +goose Up
-- +goose StatementBegin
--
-- 092_delivery_relay_order_type — central не всегда диспетчерит именно
-- доставку: звонок может быть заказом на зал/самовывоз в конкретном
-- филиале (владелец, 2026-08-28: «в филиалах в нужные разделы заказы
-- падать должны» — т.е. материализованный заказ должен попасть в ТУ ЖЕ
-- секцию кассы филиала, что и обычный заказ такого типа). До этой миграции
-- DeliveryPuller жёстко создавал type='delivery' на филиале.
--
ALTER TABLE delivery_relay_orders ADD COLUMN IF NOT EXISTS order_type TEXT NOT NULL DEFAULT 'delivery';
ALTER TABLE delivery_relay_orders DROP CONSTRAINT IF EXISTS delivery_relay_orders_order_type_check;
ALTER TABLE delivery_relay_orders ADD CONSTRAINT delivery_relay_orders_order_type_check CHECK (order_type IN ('hall', 'takeaway', 'delivery'));
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE delivery_relay_orders DROP CONSTRAINT IF EXISTS delivery_relay_orders_order_type_check;
ALTER TABLE delivery_relay_orders DROP COLUMN IF EXISTS order_type;
-- +goose StatementEnd
