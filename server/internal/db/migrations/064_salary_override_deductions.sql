-- +goose Up
-- +goose StatementBegin
--
-- 064_salary_override_deductions — честный выбор режима выплаты (ЗП-4).
--
-- Раньше сервер жёстко блокировал зарплату/аванс/обслуживание выше расчётного
-- остатка без единой возможности переопределить — единственный способ
-- заплатить свободно был случайным (аванс не капался вовсе, т.к. фронт не
-- передавал period; обслуживание с этой же страницы не капалось, т.к. фронт
-- не передавал shift_id). is_override различает такую осознанную "свободную"
-- выплату от обычной "по начислению" — без него отчёт не может показать,
-- что сумма превысила формулу намеренно, а не по ошибке.
ALTER TABLE financial_operations
  ADD COLUMN IF NOT EXISTS is_override BOOLEAN NOT NULL DEFAULT false;

-- Удержание раньше было чистым счётчиком на users.deductions — ни одной
-- проводки, причина терялась в тосте сразу после ввода. salary_deductions —
-- НЕ financial_operations: удержание не двигает баланс счёта (деньги не
-- выданы — им неоткуда "выходить"), это только уменьшение будущей выплаты.
-- Отдельная таблица хранит саму причину как факт, а не текст-однодневку.
CREATE TABLE IF NOT EXISTS salary_deductions (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    restaurant_id TEXT,
    user_id       UUID NOT NULL,
    amount        NUMERIC(14,4) NOT NULL CHECK (amount > 0),
    reason        TEXT NOT NULL,
    created_by    TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_salary_deductions_user ON salary_deductions (user_id, created_at DESC);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS salary_deductions;
ALTER TABLE financial_operations DROP COLUMN IF EXISTS is_override;
-- +goose StatementEnd
