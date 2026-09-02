-- +goose Up
-- +goose StatementBegin
--
-- 107_hourly_pay — почасовая оплата труда.
--
-- До этого система знала два уклада: оклад (054: monthly) и ставку за смену
-- (daily). Часы при этом считались и показывались, но на деньги не влияли
-- никак — из табеля в зарплату шли только ДНИ. Там, где платят «за час»
-- (подработка, неполный день, разная длительность смен), это значило ручной
-- пересчёт каждый месяц.
--
-- hourly_rate НЕ добавляем: колонка есть с 001_init, но всё это время была
-- мертва — ни один расчёт её не читал. Теперь она наконец получает смысл.
--
-- Начисление: Σ часов закрытых смен × hourly_rate. Открытые смены не в счёт —
-- у них нет ухода, и платить за незавершённое нельзя.
--
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_pay_type_check;
ALTER TABLE users ADD CONSTRAINT users_pay_type_check
  CHECK (pay_type IN ('monthly','daily','hourly'));

-- Округление смены. При дневной оплате оно бессмысленно (день есть или нет),
-- при почасовой — определяет сумму: 7 ч 58 мин это «8 часов» или «7,97»?
--
-- 0 = не округлять (текущее поведение и дефолт). Иначе — до кратного N минут,
-- в БЛИЖАЙШУЮ сторону: округление всегда вверх дарило бы работнику минуты
-- из воздуха, всегда вниз — отбирало бы заработанное.
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS shift_rounding_minutes INTEGER NOT NULL DEFAULT 0;

ALTER TABLE restaurants DROP CONSTRAINT IF EXISTS restaurants_shift_rounding_check;
ALTER TABLE restaurants ADD CONSTRAINT restaurants_shift_rounding_check
  CHECK (shift_rounding_minutes >= 0 AND shift_rounding_minutes <= 60);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE restaurants DROP CONSTRAINT IF EXISTS restaurants_shift_rounding_check;
ALTER TABLE restaurants DROP COLUMN IF EXISTS shift_rounding_minutes;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_pay_type_check;
ALTER TABLE users ADD CONSTRAINT users_pay_type_check
  CHECK (pay_type IN ('monthly','daily'));
-- +goose StatementEnd
