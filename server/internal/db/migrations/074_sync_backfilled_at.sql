-- +goose Up
-- +goose StatementBegin
--
-- 074_sync_backfilled_at — маркер «история этого филиала уже отправлена
-- на central» (ADR-003 «Central видит всё», Ф6).
-- (Перенумерована 066→072 при первом мерже main, затем 072→074 при втором —
-- main оба раза независимо занимал те же номера своими миграциями.)
--
-- sync_settings.enabled — persisted-флаг, остаётся true при КАЖДОМ рестарте
-- процесса после первого включения; по нему одному нельзя отличить «sync
-- только что включили впервые» от «sync давно работает, это обычный
-- рестарт». Без отдельного маркера автозапуск бэкфилла на старте либо
-- сработал бы на каждом рестарте (дублирующие sync_log-записи на каждый
-- рестарт кассы), либо не сработал бы вовсе.
--
-- NULL — бэкфилл ещё не выполнялся (в т.ч. все существующие кассы на
-- момент этой миграции — намеренно, чтобы автозапуск отработал один раз
-- после апдейта у тех, кто уже включил sync раньше Ф6).
ALTER TABLE sync_settings
  ADD COLUMN IF NOT EXISTS backfilled_at TIMESTAMPTZ;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE sync_settings DROP COLUMN IF EXISTS backfilled_at;
-- +goose StatementEnd
