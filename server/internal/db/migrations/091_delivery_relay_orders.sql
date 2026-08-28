-- +goose Up
-- +goose StatementBegin
--
-- 091_delivery_relay_orders — central пробивает заказ доставки ЗА филиал, с
-- печатью на кассе филиала (владелец, 2026-08-27). Это НЕ через общий
-- sync_log/sync_queue (ADR-003) — тот синкает только ВВЕРХ и только
-- терминальные (уже закрытые/отменённые) заказы, раз в interval_sec
-- (по умолчанию 30с), и намеренно не видит "живых" заказов вообще
-- (branch_override.go: "нетерминальные... на central физически не существуют").
-- Доставке нужен обратный и быстрый путь: central → филиал, ДО создания.
--
-- delivery_relay_orders — очередь на central. items — JSONB-массив
-- {network_menu_item_id, qty, note}: id из network_menu_items (мастер-меню
-- сети, ADR-004), НЕ локальный menu_items.id — у central и филиала разные
-- локальные id одного и того же блюда. Филиал забирает pending-строки
-- быстрым poll'ом (DeliveryPuller, интервал в разы короче общего синка) и
-- материализует НАСТОЯЩИЙ Order через обычный orders.Service.Create —
-- деньги/сток/смена считаются филиалу как за любой другой заказ, только
-- состав приехал по сети. Если товар не резолвится в menu_items.master_id
-- на филиале — вся строка падает в status=failed целиком, не частично.
--
-- delivery_relay_received — идемпотентность на СТОРОНЕ ФИЛИАЛА: без неё
-- обрыв сети между локальным Create() и ack на central привёл бы к тому,
-- что на следующем тике та же pending-строка (central её ack не получил)
-- материализовалась бы ВТОРОЙ раз — реальный дубль продажи. Ключ —
-- relay_order_id, filled ДО ack, проверяется ДО создания заказа.
--
CREATE TABLE IF NOT EXISTS delivery_relay_orders (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id           UUID NOT NULL,
  restaurant_id        UUID NOT NULL,
  target_restaurant_id UUID NOT NULL,
  items                JSONB NOT NULL,
  delivery_phone       TEXT,
  delivery_address     TEXT,
  comment              TEXT,
  status               TEXT NOT NULL DEFAULT 'pending',
  local_order_id       UUID,
  error                TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at         TIMESTAMPTZ,
  CONSTRAINT delivery_relay_orders_status_check CHECK (status IN ('pending', 'delivered', 'failed'))
);
CREATE INDEX IF NOT EXISTS idx_delivery_relay_orders_target_status ON delivery_relay_orders (target_restaurant_id, status);
CREATE INDEX IF NOT EXISTS idx_delivery_relay_orders_account ON delivery_relay_orders (account_id);

CREATE TABLE IF NOT EXISTS delivery_relay_received (
  relay_order_id UUID PRIMARY KEY,
  local_order_id UUID NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS delivery_relay_received;
DROP TABLE IF EXISTS delivery_relay_orders;
-- +goose StatementEnd
