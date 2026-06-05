-- +goose Up
-- +goose StatementBegin
--
-- 018_restaurants_license_issued_at — добавляем license_issued_at для
-- защиты от backdating системного времени (clock skew check, v2.6.0).
--
-- Если now() < license_issued_at → backend трактует это как tampered clock
-- и блокирует ресторан (audit + lock).
--
-- Для legacy-ресторанов (активированных до v2.6.0) issued_at пуст →
-- check пропускается (backward compat). Они получат issued_at при
-- следующей re-activation.
--
-- Колонка license_key уже существует с 001_init.sql и хранит весь
-- подписанный Ed25519 token (см. service.Activate). На каждом запросе
-- backend re-verify signature → защита от прямого UPDATE в psql.

ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS license_issued_at TIMESTAMPTZ NULL;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE restaurants
  DROP COLUMN IF EXISTS license_issued_at;
-- +goose StatementEnd
