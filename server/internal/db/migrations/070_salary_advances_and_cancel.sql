-- +goose Up
-- +goose StatementBegin
--
-- 070_salary_advances_and_cancel — аванс становится записью, а не сырым
-- счётчиком; удержание и аванс можно отменить.
--
-- Раньше «выдать аванс» — это ДВА независимых запроса подряд: PaySalary
-- (создаёт проводку, реально списывает деньги) и следом отдельный
-- PATCH /users/{id} с новым значением users.advance. Если второй запрос не
-- прошёл (сеть/валидация) — деньги ушли, счётчик остался старым, и поправить
-- было нечем: у "аванса" нет id, это просто число на карточке. Ту же причину
-- называл и запрет редактировать/отменять — нечего редактировать, есть только
-- сумма.
--
-- salary_advances — тот же принцип, что и salary_deductions (064): каждая
-- выдача — отдельная строка с id, period и причиной, а не число. account_id и
-- source_op_id хранят, с какого счёта и какой проводкой выдано — чтобы отмена
-- (CancelAdvance) знала, куда вернуть деньги и на какую проводку сослаться.
CREATE TABLE IF NOT EXISTS salary_advances (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    restaurant_id TEXT,
    user_id       UUID NOT NULL,
    amount        NUMERIC(14,4) NOT NULL CHECK (amount > 0),
    period        TEXT NOT NULL,
    account_id    UUID NOT NULL,
    note          TEXT,
    source_op_id  UUID,
    created_by    TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    cancelled_at  TIMESTAMPTZ,
    cancelled_by  TEXT
);
CREATE INDEX IF NOT EXISTS idx_salary_advances_user ON salary_advances (user_id, created_at DESC);

-- salary_deductions (064) не несла period (нельзя было привязать удержание к
-- месяцу) и не отменялась — DELETE/PUT для неё не существовало вовсе.
ALTER TABLE salary_deductions
  ADD COLUMN IF NOT EXISTS period       TEXT,
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled_by TEXT;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE salary_deductions
  DROP COLUMN IF EXISTS cancelled_by,
  DROP COLUMN IF EXISTS cancelled_at,
  DROP COLUMN IF EXISTS period;
DROP TABLE IF EXISTS salary_advances;
-- +goose StatementEnd
