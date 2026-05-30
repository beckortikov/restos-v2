-- +goose Up
-- +goose StatementBegin
--
-- 009_restaurants_account_id — Phase 1 multi-branch grouping.
--
-- account_id (Owner ID) — позволяет в будущем группировать N ресторанов
-- одного владельца под общий Dashboard. Сейчас колонка только хранит
-- значение из license-токена (payload.aid). Никакой логики пока нет —
-- готовим почву чтобы потом не делать миграцию данных.
--
-- Существующие рестораны (одиночные) останутся с NULL — это валидное
-- состояние «не в сети».

ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS account_id UUID;
CREATE INDEX IF NOT EXISTS idx_restaurants_account_id ON restaurants(account_id) WHERE account_id IS NOT NULL;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP INDEX IF EXISTS idx_restaurants_account_id;
ALTER TABLE restaurants DROP COLUMN IF EXISTS account_id;
-- +goose StatementEnd
