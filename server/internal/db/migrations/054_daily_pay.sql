-- +goose Up
-- +goose StatementBegin
--
-- 054_daily_pay — дневная оплата труда.
--
-- До этого система знала только месячный оклад (users.salary). Повара,
-- посудомойщики и подсобные работники часто работают «за смену»: ставка × число
-- отработанных дней. Такому сотруднику приходилось каждый месяц руками
-- пересчитывать оклад, и в системе не оставалось следа, за сколько именно дней
-- заплатили.
--
-- pay_type   — 'monthly' (оклад, дефолт = текущее поведение) | 'daily' (ставка
--              за день). Начисление за период считается по-разному:
--                monthly → salary;
--                daily   → daily_rate × число дней с отметкой в табеле.
-- daily_rate — ставка за один отработанный день. Для monthly игнорируется.
--
-- Число отработанных дней НЕ хранится отдельной колонкой: источник правды —
-- table time_entries (табель). День считается отработанным, если в нём есть
-- хотя бы одна отметка прихода. Так число дней всегда сходится с тем, что
-- видно в табеле, и не разъезжается при правке отметок задним числом.
--
-- users.hourly_rate НЕ трогаем: колонка существует с 001_init, но мертва —
-- ни один расчёт её не читает. Удалять её здесь значило бы смешать две
-- несвязанные правки; на поведение она не влияет.
--
ALTER TABLE users ADD COLUMN IF NOT EXISTS pay_type TEXT NOT NULL DEFAULT 'monthly';
ALTER TABLE users ADD COLUMN IF NOT EXISTS daily_rate NUMERIC(14,4) NOT NULL DEFAULT 0;

-- CHECK отдельным шагом с DROP IF EXISTS — идемпотентно и переживает кассы,
-- ушедшие в рассинхрон goose.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_pay_type_check;
ALTER TABLE users ADD CONSTRAINT users_pay_type_check
  CHECK (pay_type IN ('monthly','daily'));

-- Табель читается по (user_id, дата прихода) — индекс под подсчёт дней.
CREATE INDEX IF NOT EXISTS idx_time_entries_user_clockin
  ON time_entries (user_id, clock_in);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP INDEX IF EXISTS idx_time_entries_user_clockin;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_pay_type_check;
ALTER TABLE users DROP COLUMN IF EXISTS daily_rate;
ALTER TABLE users DROP COLUMN IF EXISTS pay_type;
-- +goose StatementEnd
