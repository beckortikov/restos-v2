-- +goose Up
-- +goose StatementBegin
--
-- Н13 (ретро, вариант «кнопка в UI»): маркер разовой коррекции балансов счетов
-- под фикс «расход кассы смены списывает счёт» (v3.16.94+). Пока NULL — коррекция
-- не выполнялась; после применения хранит момент — повторный запуск отбивается,
-- чтобы не списать историю дважды.
ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS shift_balance_corrected_at TIMESTAMPTZ;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE restaurants DROP COLUMN IF EXISTS shift_balance_corrected_at;
-- +goose StatementEnd
