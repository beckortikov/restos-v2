-- +goose Up
-- +goose StatementBegin
--
-- 037 — закупочная цена значения атрибута (для покупных товаров).
--
-- Бутылка 1 л и 1.5 л — разные SKU с разной закупкой. Закупка варианта =
-- Σ purchase_price выбранных значений (первый атрибут несёт цену,
-- последующие — доплату) и пишется в price_per_unit его складского
-- ингредиента + в cogs варианта. Для обычных блюд поле игнорируется.
ALTER TABLE menu_attribute_values
  ADD COLUMN IF NOT EXISTS purchase_price NUMERIC(14,4) NOT NULL DEFAULT 0;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE menu_attribute_values DROP COLUMN IF EXISTS purchase_price;
-- +goose StatementEnd
