-- +goose Up
-- +goose StatementBegin
--
-- 071_financial_operation_cancellable — выплату зарплаты можно отменить.
--
-- Раньше отменялись только авансы (salary_advances) и удержания
-- (salary_deductions) — у них своя строка с id и cancelled_at. Сама ВЫПЛАТА
-- зарплаты — это только financial_operations-проводка, отменить/вернуть деньги
-- было нечем (DeleteOperation работает с кассовыми операциями смены, не с
-- финоперациями). Владелец: любую выплату надо уметь отменить с возвратом на
-- счёт.
--
-- cancelled_at/cancelled_by — та же модель, что у аванса: проводка не
-- удаляется (история не переписывается), а помечается отменённой; деньги
-- возвращаются компенсирующей проводкой type='in' + прямым возвратом на счёт.
ALTER TABLE financial_operations ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE financial_operations ADD COLUMN IF NOT EXISTS cancelled_by TEXT;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE financial_operations DROP COLUMN IF EXISTS cancelled_at;
ALTER TABLE financial_operations DROP COLUMN IF EXISTS cancelled_by;
-- +goose StatementEnd
