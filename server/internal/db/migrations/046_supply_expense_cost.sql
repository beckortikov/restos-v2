-- +goose Up
-- +goose StatementBegin
--
-- Н8 — snapshot стоимости хозрасхода (расход не-food со склада).
--
-- Раньше ОПиУ считал supply-расход как SUM(se.qty * i.price_per_unit) через
-- LEFT JOIN на ingredients. Два дефекта:
--   1) подорожал ингредиент → вся история хозрасхода дорожает задним числом;
--   2) удалили ингредиент → JOIN даёт NULL → расход исчезает из ОПиУ.
-- Фиксируем стоимость в момент выдачи в колонке cost. ОПиУ читает её напрямую.
ALTER TABLE supply_expenses
  ADD COLUMN IF NOT EXISTS cost NUMERIC(14,4) NOT NULL DEFAULT 0;

-- Бэкфилл существующих строк по ТЕКУЩЕЙ цене ингредиента — ровно та же формула,
-- что использовал ОПиУ до фикса, поэтому переключение отчёта на колонку не даёт
-- скачка. Дальше история заморожена и меняться не будет.
UPDATE supply_expenses se
   SET cost = se.qty * i.price_per_unit
  FROM ingredients i
 WHERE i.id::text = se.ingredient_id::text
   AND se.cost = 0;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE supply_expenses DROP COLUMN IF EXISTS cost;
-- +goose StatementEnd
