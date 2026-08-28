-- +goose Up
-- +goose StatementBegin
--
-- 095_delivery_relay_shift_creator — привязка delivery_relay_orders к смене
-- и реальному пользователю-отправителю central (продолжение 091/092/094).
--
-- shift_id — та же смена central, что открыл диспетчер (ShiftsService.Active
-- в момент Create/CreateAmend, NULL если смена не открыта — дозаказ/заказ не
-- блокируем из-за этого, просто он не попадёт ни в один Z-отчёт). Нужно,
-- чтобы «Смены сети» центрального узла показывала не нули, а реальную
-- статистику диспетчеризации (владелец, 2026-08-28: «статистка должен
-- отражаться смене центрального»).
--
-- created_by_user_id/name — реальный central-пользователь (audit.Actor из
-- middleware.Auth), НЕ строка-заглушка "Central (доставка)" (та остаётся в
-- audit_log/actor заказа НА ФИЛИАЛЕ — branch и central разные тенанты, id
-- пользователя central не существует в users филиала, поэтому туда его
-- проставить нельзя). Нужно для атрибуции выручки диспетчеру в сетевой
-- аналитике официантов (network_analytics.go WaitersNetwork).
--
ALTER TABLE delivery_relay_orders ADD COLUMN IF NOT EXISTS shift_id UUID;
ALTER TABLE delivery_relay_orders ADD COLUMN IF NOT EXISTS created_by_user_id UUID;
ALTER TABLE delivery_relay_orders ADD COLUMN IF NOT EXISTS created_by_name TEXT;
CREATE INDEX IF NOT EXISTS idx_delivery_relay_orders_shift ON delivery_relay_orders (shift_id) WHERE shift_id IS NOT NULL;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP INDEX IF EXISTS idx_delivery_relay_orders_shift;
ALTER TABLE delivery_relay_orders DROP COLUMN IF EXISTS created_by_name;
ALTER TABLE delivery_relay_orders DROP COLUMN IF EXISTS created_by_user_id;
ALTER TABLE delivery_relay_orders DROP COLUMN IF EXISTS shift_id;
-- +goose StatementEnd
