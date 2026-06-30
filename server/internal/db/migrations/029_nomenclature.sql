-- +goose Up
-- +goose StatementBegin
--
-- 029_nomenclature — общий справочник номенклатуры сети (вариант 3B, ADR-003).
--
-- Проблема: ingredients привязаны к ресторану, поэтому один и тот же продукт
-- в разных филиалах — разные строки. Перемещению нужно сопоставить ингредиент
-- источника и получателя.
--
-- Решение 3B (без раскола остатка): остаток qty НЕ трогаем, ingredients
-- остаются пер-ресторанными. Добавляем account-level справочник nomenclature
-- и ссылку ingredients.nomenclature_id. Перемещение находит ингредиент
-- получателя по (to_restaurant_id, nomenclature_id).
--
-- Обратная совместимость: nomenclature_id = NULL → одиночный ресторан, всё
-- работает как прежде. Ни один из существующих read-site остатка не трогается.

CREATE TABLE IF NOT EXISTS nomenclature (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID,
  name TEXT NOT NULL,
  unit TEXT,
  category TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_nomenclature_account ON nomenclature(account_id);

ALTER TABLE ingredients
  ADD COLUMN IF NOT EXISTS nomenclature_id UUID;
CREATE INDEX IF NOT EXISTS idx_ingredients_nomenclature
  ON ingredients(nomenclature_id) WHERE nomenclature_id IS NOT NULL;

ALTER TABLE stock_transfer_lines
  ADD COLUMN IF NOT EXISTS nomenclature_id UUID;
CREATE INDEX IF NOT EXISTS idx_stock_transfer_lines_nomenclature
  ON stock_transfer_lines(nomenclature_id) WHERE nomenclature_id IS NOT NULL;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP INDEX IF EXISTS idx_stock_transfer_lines_nomenclature;
ALTER TABLE stock_transfer_lines DROP COLUMN IF EXISTS nomenclature_id;
DROP INDEX IF EXISTS idx_ingredients_nomenclature;
ALTER TABLE ingredients DROP COLUMN IF EXISTS nomenclature_id;
DROP TABLE IF EXISTS nomenclature;
-- +goose StatementEnd
