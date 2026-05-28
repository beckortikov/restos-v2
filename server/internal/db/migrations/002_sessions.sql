-- +goose Up
-- +goose StatementBegin
--
-- Sessions для PIN-login (Phase 2).
--
-- Контракт:
--   - POST /api/v1/auth/login {restaurant_id, pin} → token (opaque, 32 байта random hex).
--   - Token + user_id + restaurant_id + expires_at хранятся здесь.
--   - Middleware читает Bearer-token, валидирует, кладёт Actor/RestaurantID в context.
--   - Logout → DELETE row.
--   - TTL: 12 часов rolling; last_seen_at обновляется при каждом запросе (опционально, чтобы не делать write на каждый GET).
--
-- Сессии не привязаны к tenant в смысле RLS — но в БД они и не должны быть.
-- Они источник tenant'а: токен → restaurant_id → дальше ForTenant.
CREATE TABLE IF NOT EXISTS sessions (
  token        TEXT PRIMARY KEY,
  user_id      UUID NOT NULL,
  restaurant_id TEXT NOT NULL,
  user_name    TEXT,
  role         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sessions_expires_at  ON sessions (expires_at);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id     ON sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_restaurant  ON sessions (restaurant_id);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS sessions;
-- +goose StatementEnd
