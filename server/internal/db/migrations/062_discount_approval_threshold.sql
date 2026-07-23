-- +goose Up
-- +goose StatementBegin
--
-- 062_discount_approval_threshold — настраиваемый порог одобрения скидки.
--
-- Раньше порог был захардкожен в orders_close.go (скидка > 10% требует
-- approved_by менеджера/владельца). Теперь владелец задаёт его в настройках
-- ресторана. DEFAULT 10 — сохраняем прежнее поведение для всех существующих
-- касс без backfill.
ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS discount_approval_threshold numeric(14,4) NOT NULL DEFAULT 10;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE restaurants DROP COLUMN IF EXISTS discount_approval_threshold;
-- +goose StatementEnd
