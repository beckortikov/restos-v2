-- +goose Up
-- +goose StatementBegin
--
-- Н1 — инвентаризация полуфабрикатов и заготовок.
--
-- Раньше inventory_check_lines несла только ингредиенты — усадка п/ф
-- (semi_finished_stock) и готовых заготовок (menu_items.prepared_qty) не
-- измерялась вообще. Добавляем kind; ingredient_id переиспользуется как id
-- сущности (для kind='semi' — id п/ф, для 'batch' — id блюда-заготовки).
ALTER TABLE inventory_check_lines
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'ingredient';

ALTER TABLE inventory_check_lines
  DROP CONSTRAINT IF EXISTS inventory_check_lines_kind_check;
ALTER TABLE inventory_check_lines
  ADD CONSTRAINT inventory_check_lines_kind_check
  CHECK (kind IN ('ingredient', 'semi', 'batch'));
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE inventory_check_lines DROP CONSTRAINT IF EXISTS inventory_check_lines_kind_check;
ALTER TABLE inventory_check_lines DROP COLUMN IF EXISTS kind;
-- +goose StatementEnd
