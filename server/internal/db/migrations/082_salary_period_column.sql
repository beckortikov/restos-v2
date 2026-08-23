-- +goose Up
-- +goose StatementBegin
--
-- 082_salary_period_column — период начисления (YYYY-MM) СТРУКТУРНЫМ полем на
-- зарплатных проводках, вместо тега в description ("Зарплата:2026-07").
--
-- Баг владельца: список сотрудников/Ведомость считали «выплачено за месяц»
-- ПО ДАТЕ ПРОВОДКИ в окне месяца (loadSalaryPaid, payroll/page.tsx), а сервер
-- (кап на выплату, salaryCapForPeriod) — по тегу периода в description через
-- LIKE. Выплата «за июль», проведённая в августе (обычное дело — зарплату
-- часто платят в начале следующего месяца), у сервера корректно ложилась в
-- июль, а у клиента — в август: «Выплачено» там задваивалось на сумму чужого
-- месяца, «К выплате» уходило в минус. Фикс — один источник истины: колонка,
-- а не два разных способа его извлечь из текста.
ALTER TABLE financial_operations ADD COLUMN IF NOT EXISTS salary_period TEXT;

-- Бэкфилл существующих зарплатных/авансовых проводок.
-- Шаг 1: период есть в теге description ("Зарплата:2026-07" / "Аванс:2026-07",
-- возможно с префиксом другого текста) — извлекаем регуляркой.
UPDATE financial_operations
SET salary_period = substring(description FROM '(?:Зарплата|Аванс):(\d{4}-\d{2})')
WHERE category IN ('Зарплата', 'Аванс')
  AND salary_period IS NULL
  AND description ~ '(?:Зарплата|Аванс):\d{4}-\d{2}';

-- Шаг 2: тега нет (легаси-выплата до введения тега, либо свободный текст без
-- периода) — период = месяц деловой даты (foBizDay: date, а если пусто —
-- created_at), тем же способом, что и весь остальной ОПиУ/ДДС в проекте.
UPDATE financial_operations
SET salary_period = left(COALESCE(NULLIF(date, ''), to_char(created_at, 'YYYY-MM-DD')), 7)
WHERE category IN ('Зарплата', 'Аванс')
  AND salary_period IS NULL;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE financial_operations DROP COLUMN IF EXISTS salary_period;
-- +goose StatementEnd
