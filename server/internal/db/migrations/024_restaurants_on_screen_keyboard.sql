-- +goose Up
-- +goose StatementBegin
--
-- 024_restaurants_on_screen_keyboard — флаг экранной клавиатуры (iiko-style).
--
-- Экранная клавиатура (POS / смена / карта зала) теперь управляется из настроек
-- ресторана и по умолчанию ВЫКЛЮЧЕНА. Нужна только на тач-терминалах без
-- физической клавиатуры — кто хочет, включает в настройках владельца.
--
-- NOT NULL DEFAULT false → все существующие рестораны получают false (выкл).
ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS on_screen_keyboard_enabled BOOLEAN NOT NULL DEFAULT false;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE restaurants
  DROP COLUMN IF EXISTS on_screen_keyboard_enabled;
-- +goose StatementEnd
