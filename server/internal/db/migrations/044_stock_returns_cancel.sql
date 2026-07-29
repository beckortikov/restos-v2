-- +goose Up
-- +goose StatementBegin
--
-- 044_stock_returns_cancel — сторно возврата поставщику.
--
-- Зачем: возврат двигает склад И деньги/долг, а отменить его было нечем —
-- ошибся кладовщик в количестве или причине, и правится только руками в базе.
--
-- Не удаляем строку: документы append-only, удаление сломало бы аудит и
-- «уже возвращено». Вместо этого помечаем отменённым, а компенсирующие
-- движения склада и деньги проводим отдельными записями — история видна целиком.
--
-- Отменённый возврат перестаёт считаться в guard'е «нельзя вернуть больше, чем
-- пришло»: количество вернулось на склад, значит его снова можно возвращать.
--
ALTER TABLE stock_returns ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE stock_returns ADD COLUMN IF NOT EXISTS cancelled_by TEXT;

-- Горячий путь: и guard, и списки фильтруют «не отменённые».
CREATE INDEX IF NOT EXISTS idx_stock_returns_active
  ON stock_returns (restaurant_id, cancelled_at);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP INDEX IF EXISTS idx_stock_returns_active;
ALTER TABLE stock_returns DROP COLUMN IF EXISTS cancelled_by;
ALTER TABLE stock_returns DROP COLUMN IF EXISTS cancelled_at;
-- +goose StatementEnd
