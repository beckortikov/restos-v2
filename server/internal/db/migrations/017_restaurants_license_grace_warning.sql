-- +goose Up
-- +goose StatementBegin
--
-- 017_restaurants_license_grace_warning — per-key grace/warning periods (v2.1.3).
--
-- До v2.1.3 grace=7 и warning=7 были константами в коде. Теперь админ при
-- выписке токена сам выбирает (важному клиенту 7+7, новому 0+0 hard lock,
-- VIP 14+14). Значения копятся из payload в restaurants на activate'е.
--
-- Backward compatibility:
--   • DEFAULT = 7 для legacy-ресторанов, чтобы существующие клиенты с уже
--     активированными токенами (без grace_days в payload) НЕ ушли в hard
--     lock — сохраняют прежнее поведение 7+7.
--   • НОВЫЕ токены из CLI license-gen имеют default 0+0 (hard lock) — это
--     задаётся на стороне инструмента, не БД. Безопасный forward.
--   • При activate'е значения из payload перетирают колонки явно (включая 0).

ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS license_grace_days   INT NOT NULL DEFAULT 7,
  ADD COLUMN IF NOT EXISTS license_warning_days INT NOT NULL DEFAULT 7;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE restaurants
  DROP COLUMN IF EXISTS license_grace_days,
  DROP COLUMN IF EXISTS license_warning_days;
-- +goose StatementEnd
