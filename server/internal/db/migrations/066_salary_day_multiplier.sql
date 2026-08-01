-- +goose Up
-- +goose StatementBegin
--
-- 066_salary_day_multiplier — «две смены в один день» для дневной оплаты (054).
--
-- Текущий расчёт (054/059): дневная ставка × число РАЗНЫХ отработанных дней,
-- где день считается по дате прихода (table `time_entries` ∪ ручные отметки
-- `salary_worked_days`). Две отметки в один день намеренно схлопываются в
-- один рабочий день (см. комментарий в daysWorked) — иначе перерыв на обеде
-- (пришёл-ушёл-пришёл) удваивал бы оплату.
--
-- Но бывает реальный случай: сотрудник в один календарный день отработал ДВЕ
-- полные смены (напр. подменил коллегу вечером). Это не перерыв, а
-- сознательное решение менеджера доплатить за день вдвое. Не пытаемся
-- отличить «перерыв» от «вторая смена» автоматически по интервалу между
-- отметками (ненадёжная эвристика) — вместо этого явный ручной множитель на
-- конкретный день, который менеджер проставляет через календарь.
--
-- Строка существует только когда множитель != 1 (по умолчанию день = ×1,
-- строки в таблице нет — как и salary_worked_days, это чистый override).
CREATE TABLE IF NOT EXISTS salary_day_multipliers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id TEXT NOT NULL,
  user_id       UUID NOT NULL,
  work_date     DATE NOT NULL,
  multiplier    INTEGER NOT NULL DEFAULT 2,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, user_id, work_date)
);

ALTER TABLE salary_day_multipliers
  ADD CONSTRAINT salary_day_multipliers_multiplier_chk
  CHECK (multiplier >= 2 AND multiplier <= 3);

CREATE INDEX IF NOT EXISTS idx_salary_day_multipliers_lookup
  ON salary_day_multipliers (restaurant_id, user_id, work_date);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS salary_day_multipliers;
-- +goose StatementEnd
