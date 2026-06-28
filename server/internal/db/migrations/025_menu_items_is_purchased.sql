-- +goose Up
-- +goose StatementBegin
--
-- 025_menu_items_is_purchased — явный флаг «покупной товар».
--
-- Раньше «покупной» определялся на фронте эвристикой (station='showcase' +
-- 1:1 техкарта qty=1) и поэтому не сохранялся надёжно. Теперь это настоящее
-- поле: бэк хранит его и сам создаёт складской ингредиент (0 остаток) + 1:1
-- техкарту при создании/редактировании покупного товара.
--
-- NOT NULL DEFAULT false → все существующие блюда — обычные.
ALTER TABLE menu_items
  ADD COLUMN IF NOT EXISTS is_purchased BOOLEAN NOT NULL DEFAULT false;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE menu_items
  DROP COLUMN IF EXISTS is_purchased;
-- +goose StatementEnd
