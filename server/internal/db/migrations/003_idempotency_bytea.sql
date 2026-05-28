-- +goose Up
-- +goose StatementBegin
--
-- idempotency_keys.response_body: jsonb → bytea.
--
-- Причина: jsonb пересортирует ключи и добавляет пробелы при roundtrip,
-- из-за чего кэшированный ответ становится байт-в-байт НЕ равен оригиналу.
-- На read это безопасно семантически, но идемпотентный replay должен
-- возвращать ТОЧНО те же байты — иначе клиенты с гэшированием/сигнатурами
-- ловят расхождения.
--
-- В Phase 2 эта таблица была пустой (idempotency middleware появился
-- в Phase 3), так что DROP/ADD безопасен.

ALTER TABLE idempotency_keys DROP COLUMN IF EXISTS response_body;
ALTER TABLE idempotency_keys ADD COLUMN response_body BYTEA;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE idempotency_keys DROP COLUMN IF EXISTS response_body;
ALTER TABLE idempotency_keys ADD COLUMN response_body JSONB;
-- +goose StatementEnd
