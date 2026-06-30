-- +goose Up
-- +goose StatementBegin
--
-- 027_restaurants_kind — тип точки в сети (Фаза 1 multi-branch, ADR-003).
--
--   outlet           — обычный филиал (зал + продажи).
--   central_warehouse — центральный склад: закуп оптом + перемещения в
--                       филиалы, может быть «без зала».
--
-- DEFAULT 'outlet' → все существующие рестораны остаются обычными точками.
ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'outlet'
  CHECK (kind IN ('outlet', 'central_warehouse'));
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE restaurants DROP COLUMN IF EXISTS kind;
-- +goose StatementEnd
