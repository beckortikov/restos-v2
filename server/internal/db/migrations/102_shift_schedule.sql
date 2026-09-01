-- +goose Up
-- +goose StatementBegin
--
-- 102_shift_schedule — плановый график смен.
--
-- До этого система знала только ФАКТ (time_entries: кто пришёл) и не знала
-- ПЛАНА (кто должен был прийти). Из-за этого «кто не пришёл» не вычислялось
-- в принципе: отсутствие отметки неотличимо от выходного, а опоздание — от
-- нормального прихода к своей смене. Табель показывал приходы, но не
-- дисциплину.
--
-- Две таблицы, а не одна, по тому же принципу, что salary_worked_days (059) и
-- salary_day_multipliers (066): «строка существует, только когда отличается от
-- дефолта».
--
--   shift_schedule_templates — обычная неделя сотрудника («пн-пт с 09:00»).
--     Одна строка на день недели; нет строки — в этот день не работает.
--     Именно это заполняется один раз при найме и почти не меняется.
--
--   shift_schedule_days — переопределение на КОНКРЕТНУЮ дату: подмена, отгул,
--     разовая вечерняя смена. Перебивает шаблон. kind='off' — выходной вопреки
--     шаблону (не «нет строки», а явное «сегодня не работает»), иначе отгул
--     нельзя отличить от незаполненного графика.
--
-- План на дату = переопределение, если есть; иначе шаблон по дню недели.
--
-- Время смены — TEXT 'HH:MM' в ЛОКАЛЬНОМ времени ресторана, не TIME и не
-- timestamptz. График составляется в человеческих часах («с девяти»), он не
-- привязан к дате и не должен ездить при пересчёте зон; сравнение с фактом
-- (clock_in, UTC) делается явным переводом в restaurants.timezone. Ровно тот
-- же приём, что work_date DATE в 059 — хранить то, что человек написал.
--
CREATE TABLE IF NOT EXISTS shift_schedule_templates (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id TEXT NOT NULL,
  user_id       UUID NOT NULL,
  -- ISO-нумерация: 1=понедельник … 7=воскресенье. Не 0-based: в SQL день
  -- недели считается через EXTRACT(ISODOW), и совпадение нумераций избавляет
  -- от сдвига на единицу в каждом запросе.
  weekday       SMALLINT NOT NULL,
  starts_at     TEXT NOT NULL,
  ends_at       TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, user_id, weekday)
);

ALTER TABLE shift_schedule_templates DROP CONSTRAINT IF EXISTS shift_schedule_templates_weekday_check;
ALTER TABLE shift_schedule_templates ADD CONSTRAINT shift_schedule_templates_weekday_check
  CHECK (weekday BETWEEN 1 AND 7);

CREATE INDEX IF NOT EXISTS idx_shift_schedule_templates_user
  ON shift_schedule_templates (restaurant_id, user_id);

CREATE TABLE IF NOT EXISTS shift_schedule_days (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id TEXT NOT NULL,
  user_id       UUID NOT NULL,
  work_date     DATE NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'work',
  -- NULL при kind='off': у выходного нет времени начала.
  starts_at     TEXT,
  ends_at       TEXT,
  note          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, user_id, work_date)
);

ALTER TABLE shift_schedule_days DROP CONSTRAINT IF EXISTS shift_schedule_days_kind_check;
ALTER TABLE shift_schedule_days ADD CONSTRAINT shift_schedule_days_kind_check
  CHECK (kind IN ('work','off'));

CREATE INDEX IF NOT EXISTS idx_shift_schedule_days_lookup
  ON shift_schedule_days (restaurant_id, work_date);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS shift_schedule_days;
DROP TABLE IF EXISTS shift_schedule_templates;
-- +goose StatementEnd
