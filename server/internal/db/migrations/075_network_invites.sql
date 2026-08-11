-- +goose Up
-- +goose StatementBegin
--
-- 075_network_invites — код приглашения для подключения филиала к сети
-- (ADR-003, продолжение). Перенумерована 073→075 при мерже main (коллизия
-- с main-миграциями 073-074). Central генерирует одноразовый короткий код
-- (не сам секрет sync) — филиал обменивает его на настоящий sync_settings
-- token + account_id через POST /api/v1/sync/pair. used_at гарантирует
-- одноразовость, expires_at — TTL 7 дней. Без hard FK — конвенция проекта
-- (см. 026_company_accounts.sql), целостность на уровне приложения.
CREATE TABLE IF NOT EXISTS network_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL,
  code TEXT NOT NULL,
  label TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  used_by_restaurant_id UUID,
  used_by_restaurant_name TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_network_invites_code ON network_invites(code);
CREATE INDEX IF NOT EXISTS idx_network_invites_account ON network_invites(account_id);

-- Публичный адрес central-узла — вводится один раз при генерации первого
-- кода, переиспользуется для следующих (не перевводить каждый раз).
ALTER TABLE company_accounts ADD COLUMN IF NOT EXISTS public_url TEXT;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS network_invites;
ALTER TABLE company_accounts DROP COLUMN IF EXISTS public_url;
-- +goose StatementEnd
