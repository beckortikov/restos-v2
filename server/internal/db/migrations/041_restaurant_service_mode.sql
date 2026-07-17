-- +goose Up
-- +goose StatementBegin
--
-- 041_restaurant_service_mode — режим обслуживания ресторана + дефолт нового POS.
--
-- tables_enabled  — есть ли столы в зале. false → фастфуд «в зал по номеру»:
--                   заказ hall создаётся без table_id (table_id уже nullable),
--                   идентификация по order_number. default true = как сейчас.
-- kitchen_on_pay  — фастфуд-флоу: кухонный бегунок (runner) печатается на ОПЛАТЕ,
--                   а не на «Отправить». default false = текущее поведение
--                   (table-service: кухня на создании, оплата потом).
-- pos_v2_default  — новый POS (pos2) по умолчанию на кассах ресторана. Устройство
--                   может переопределить локально (localStorage pos_ui_v2).
--                   default false = классический POS по умолчанию.
--
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS tables_enabled BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS kitchen_on_pay BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS pos_v2_default BOOLEAN NOT NULL DEFAULT false;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE restaurants DROP COLUMN IF EXISTS pos_v2_default;
ALTER TABLE restaurants DROP COLUMN IF EXISTS kitchen_on_pay;
ALTER TABLE restaurants DROP COLUMN IF EXISTS tables_enabled;
-- +goose StatementEnd
