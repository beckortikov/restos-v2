-- +goose Up
-- +goose StatementBegin
--
-- 006_orders_extras — поля для Phase 9 (orders cutover):
--   • order_items.served_at — момент, когда позиция отдана клиенту;
--   • order_items.print_claimed_at / print_claimed_by — атомарный claim
--     задания на станционную печать (KDS worker);
--   • order_items.cancel_print_claimed_at / cancel_print_claimed_by — то же
--     для cancel-runner'а.
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS served_at TIMESTAMPTZ;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS print_claimed_at TIMESTAMPTZ;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS print_claimed_by TEXT;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS cancel_print_claimed_at TIMESTAMPTZ;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS cancel_print_claimed_by TEXT;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE order_items DROP COLUMN IF EXISTS cancel_print_claimed_by;
ALTER TABLE order_items DROP COLUMN IF EXISTS cancel_print_claimed_at;
ALTER TABLE order_items DROP COLUMN IF EXISTS print_claimed_by;
ALTER TABLE order_items DROP COLUMN IF EXISTS print_claimed_at;
ALTER TABLE order_items DROP COLUMN IF EXISTS served_at;
-- +goose StatementEnd
