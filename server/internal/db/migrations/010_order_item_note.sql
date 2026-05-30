-- +goose Up
-- +goose StatementBegin
--
-- 010_order_item_note — комментарий к позиции заказа.
--
-- Используется официантом (PATCH /orders/{id}/items/{itemId}/note) для
-- передачи кухне особых пожеланий («без лука», «прожарка medium-rare» и т.п.).
-- Печатается на runner (строкой "  ! <note>") и на пре-чеке.
--
-- NULL = нет комментария. Пустая строка после trim тоже трактуется как NULL
-- на уровне сервиса.

ALTER TABLE order_items ADD COLUMN IF NOT EXISTS note TEXT;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE order_items DROP COLUMN IF EXISTS note;
-- +goose StatementEnd
