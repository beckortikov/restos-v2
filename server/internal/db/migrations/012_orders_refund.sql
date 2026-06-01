-- +goose Up
-- +goose StatementBegin
--
-- 012_orders_refund — поля для функции «Возврат» из истории заказов.
--
-- Семантика:
--   refunded_total = 0          → возвратов не было;
--   0 < refunded_total < total_with_service → частичный возврат;
--   refunded_total >= total_with_service    → полный возврат, status = 'refunded'.
--
-- Финансовая операция (type='out', activity='operational') создаётся в момент
-- возврата на ту же сумму. Сами order_items НЕ восстанавливаются — это
-- денежная компенсация, а не отмена заказа.

ALTER TABLE orders ADD COLUMN IF NOT EXISTS refunded_total NUMERIC(14,4) NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS refund_reason TEXT;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE orders DROP COLUMN IF EXISTS refund_reason;
ALTER TABLE orders DROP COLUMN IF EXISTS refunded_at;
ALTER TABLE orders DROP COLUMN IF EXISTS refunded_total;
-- +goose StatementEnd
