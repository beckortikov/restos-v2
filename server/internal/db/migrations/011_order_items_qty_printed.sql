-- +goose Up
-- +goose StatementBegin
--
-- 011_order_items_qty_printed — денормализованное tracking-поле
-- «сколько единиц уже улетело на принтер runner'а».
--
-- Нужно для iiko-style merge: при добавлении позиции с тем же ключом мержим
-- в существующую row (даже если повар её уже видел), а runner-эмиттер печатает
-- только delta = qty - qty_printed.
--
-- Семантика:
--   qty_printed = 0   → строка ни разу не была отправлена на станцию (delta = qty).
--   qty_printed = N   → повар уже видит N единиц; на следующем enqueue печатается
--                       только (qty - N) и затем qty_printed := qty.
--
-- Бэкфилл: для строк, где printed_at IS NOT NULL (то есть исторически уже считалось
-- «напечатано целиком»), выставляем qty_printed = qty.

ALTER TABLE order_items ADD COLUMN IF NOT EXISTS qty_printed NUMERIC(14,4) NOT NULL DEFAULT 0;

UPDATE order_items
   SET qty_printed = qty
 WHERE printed_at IS NOT NULL
   AND qty_printed = 0;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE order_items DROP COLUMN IF EXISTS qty_printed;
-- +goose StatementEnd
