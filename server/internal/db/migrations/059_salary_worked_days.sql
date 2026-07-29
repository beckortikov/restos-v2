-- +goose Up
-- +goose StatementBegin
--
-- Ручная отметка отработанных дней для дневной оплаты труда.
--
-- Дневная ЗП (054) считала дни ТОЛЬКО из табеля (time_entries по clock_in).
-- В фастфуде/малых точках приход-уход не отмечают — владелец хочет просто
-- проставить руками, сколько дней отработал сотрудник. Эти отметки живут
-- отдельно от табеля, чтобы не засорять «кто на смене»: начисление дневника =
-- уникальные дни (табель ∪ ручные отметки).
CREATE TABLE IF NOT EXISTS salary_worked_days (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL,
  user_id       UUID NOT NULL,
  work_date     DATE NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- один день на сотрудника не задваивается (повторная отметка идемпотентна).
  UNIQUE (restaurant_id, user_id, work_date)
);

CREATE INDEX IF NOT EXISTS idx_salary_worked_days_user
  ON salary_worked_days (restaurant_id, user_id, work_date);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS salary_worked_days;
-- +goose StatementEnd
