-- +goose Up
-- +goose StatementBegin
--
-- 008_daily_order_number — per-restaurant per-day order numbering.
--
-- Раньше orders.order_number был глобальным SERIAL и кроме того никогда не
-- проставлялся в коде (Go-модель имела `int` без указателя — zero-value 0 шёл
-- в INSERT, перекрывая sequence default). У всех заказов оказался номер 0,
-- UI показывал хэш UUID как fallback.
--
-- order_counters (restaurant_id, date) -> last_number. Сервис при создании
-- заказа делает атомарный UPSERT и берёт next-номер. Дата считается в
-- timezone ресторана (см. restaurants.timezone).

CREATE TABLE IF NOT EXISTS order_counters (
  restaurant_id UUID NOT NULL,
  date          DATE NOT NULL,
  last_number   INT  NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (restaurant_id, date)
);

ALTER TABLE orders ALTER COLUMN order_number DROP DEFAULT;
ALTER TABLE orders ALTER COLUMN order_number DROP NOT NULL;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS order_counters;
-- +goose StatementEnd
