-- +goose Up
-- +goose StatementBegin
--
-- 038 — цены на комбинациях, а не на значениях атрибутов.
--
-- «Надбавка/доплата» убрана из модели: значение атрибута — чистый лейбл,
-- цена и закупка задаются per-комбинация и живут на строке варианта
-- (menu_items.price / cogs + price_per_unit его ингредиента). PUT
-- /menu/items/{id}/attributes принимает combos[{labels, price,
-- purchase_price}].
ALTER TABLE menu_attribute_values DROP COLUMN IF EXISTS price;
ALTER TABLE menu_attribute_values DROP COLUMN IF EXISTS purchase_price;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE menu_attribute_values ADD COLUMN IF NOT EXISTS price NUMERIC(14,4) NOT NULL DEFAULT 0;
ALTER TABLE menu_attribute_values ADD COLUMN IF NOT EXISTS purchase_price NUMERIC(14,4) NOT NULL DEFAULT 0;
-- +goose StatementEnd
