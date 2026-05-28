-- +goose Up
-- +goose StatementBegin
--
-- 007_orders_kitchen_started — Phase 18 F19:
--   • orders.kitchen_started_at — момент, когда заказ переведён в 'cooking'
--     через POST /orders/{id}/start-cooking. Используется для подсчёта
--     времени готовки и аналитики.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS kitchen_started_at TIMESTAMPTZ;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE orders DROP COLUMN IF EXISTS kitchen_started_at;
-- +goose StatementEnd
