-- +goose Up
-- +goose StatementBegin
--
-- 015_printers_content_flags — настраиваемое содержимое чека на принтер.
--
-- Контекст (v2.0.93): кассир жаловался что нет настройки «что печатать» —
-- логотип, скидка, сервис, чаевые, QR-фидбэк. Сейчас layout жёстко зашит.
-- Делаем булевы флаги per-принтер. При false соответствующая строка
-- не печатается. Умолчания совпадают с прошлым поведением (полный набор).
--
-- Также: дополнительная защита от 409 на default — индекс остаётся, но
-- сервис теперь делает swap (clear other default → set new) в транзакции,
-- так что повторный default «just works».

ALTER TABLE printers
  ADD COLUMN IF NOT EXISTS print_logo        BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS print_discount    BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS print_service     BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS print_tip         BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS print_qr_feedback BOOLEAN NOT NULL DEFAULT FALSE;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin

ALTER TABLE printers
  DROP COLUMN IF EXISTS print_logo,
  DROP COLUMN IF EXISTS print_discount,
  DROP COLUMN IF EXISTS print_service,
  DROP COLUMN IF EXISTS print_tip,
  DROP COLUMN IF EXISTS print_qr_feedback;

-- +goose StatementEnd
