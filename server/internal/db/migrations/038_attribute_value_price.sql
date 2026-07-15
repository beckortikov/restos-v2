-- +goose Up
-- +goose StatementBegin
--
-- 036 — цена значения атрибута вместо «надбавки к базовой цене».
--
-- Пользовательская модель: у продукта с атрибутами НЕТ собственной цены —
-- цену задают значения атрибутов. Цена варианта = Σ price выбранных значений
-- (первый атрибут несёт цену, последующие — доплату). Базовая цена продукта
-- в расчёте больше не участвует.
ALTER TABLE menu_attribute_values RENAME COLUMN price_delta TO price;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE menu_attribute_values RENAME COLUMN price TO price_delta;
-- +goose StatementEnd
