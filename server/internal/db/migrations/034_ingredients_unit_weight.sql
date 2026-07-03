-- +goose Up
-- +goose StatementBegin
--
-- 026_ingredients_unit_weight — фактор пересчёта штучной единицы в вес/объём.
--
-- Некоторые ингредиенты закупаются и считаются штучно (шт — банка, бутылка,
-- пачка), а тех-карта расходует их по весу/объёму (10 г кукурузы). Нет
-- универсального метрического коэффициента: нетто банки — свойство конкретного
-- товара (1 банка = 340 г). unit_weight хранит вес/объём ОДНОЙ складской единицы,
-- unit_weight_unit — единицу, в которой он задан (г/мл). Конвертация применяется
-- только в точке расхода (резерв, COGS, списание при закрытии, produce). См.
-- units.ConvertToStock. 0/NULL = фактор не задан → поведение как раньше.
ALTER TABLE ingredients
  ADD COLUMN IF NOT EXISTS unit_weight NUMERIC(14,4) NOT NULL DEFAULT 0;
ALTER TABLE ingredients
  ADD COLUMN IF NOT EXISTS unit_weight_unit TEXT;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE ingredients
  DROP COLUMN IF EXISTS unit_weight_unit;
ALTER TABLE ingredients
  DROP COLUMN IF EXISTS unit_weight;
-- +goose StatementEnd
