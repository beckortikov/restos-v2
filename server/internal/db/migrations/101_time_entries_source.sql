-- +goose Up
-- +goose StatementBegin
--
-- 101_time_entries_source — откуда взялась отметка табеля.
--
-- До этого time_entries знал только «строка есть» и не различал, кто её
-- создал: менеджер руками в веб-табеле или сам сотрудник на терминале у
-- служебного входа. Различать нужно с самого начала, по двум причинам.
--
-- Во-первых, доверие к отметке разное: проставленный задним числом день —
-- это решение менеджера, а не факт прихода, и в спорах их надо отличать.
--
-- Во-вторых, на этом же поле держится будущий коннектор СКУД: терминал
-- Hikvision станет ЕЩЁ ОДНИМ источником отметок, а не параллельной таблицей
-- со своим табелем. В сети из нескольких филиалов это позволяет одним точкам
-- стоять на планшете, другим — на турникете, а центру видеть единый табель.
--
--   manual    — заведено человеком в веб-табеле (текущее поведение; дефолт
--               для всех уже существующих строк);
--   app       — сотрудник отметился сам на терминале :checkin по PIN;
--   hikvision — событие из СКУД-терминала (коннектор пока не написан).
--
ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual';

-- CHECK отдельным шагом с DROP IF EXISTS — идемпотентно и переживает кассы,
-- ушедшие в рассинхрон goose.
ALTER TABLE time_entries DROP CONSTRAINT IF EXISTS time_entries_source_check;
ALTER TABLE time_entries ADD CONSTRAINT time_entries_source_check
  CHECK (source IN ('manual','app','hikvision'));
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE time_entries DROP CONSTRAINT IF EXISTS time_entries_source_check;
ALTER TABLE time_entries DROP COLUMN IF EXISTS source;
-- +goose StatementEnd
