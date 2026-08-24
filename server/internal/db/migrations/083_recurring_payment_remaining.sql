-- +goose Up
-- +goose StatementBegin
--
-- 083_recurring_payment_remaining — частичная оплата регулярного платежа
-- (долг/рассрочка типа «Погащение поставщику») не должна молча закрывать
-- цикл на полную сумму шаблона.
--
-- Баг владельца: оплатил 6000 из 9885 по «Погащения Арванд» — Pay() всегда
-- безусловно двигал next_due на месяц вперёд и не хранил остаток текущего
-- цикла, поэтому строка тут же показывала снова полную сумму 9885 и дату
-- СЛЕДУЮЩЕГО месяца — 3885 недоплаты терялись молча, ничего не намекало,
-- что цикл не закрыт. remaining_amount — сколько осталось долить по ТЕКУЩЕМУ
-- циклу (NULL = ничего не платили, остаток = полная amount шаблона).
-- last_paid_amount — сумма последнего платежа, для строки «последний платёж»
-- в списке (last_paid_at уже был, но без суммы бесполезен как подтверждение).
ALTER TABLE recurring_payments ADD COLUMN IF NOT EXISTS remaining_amount NUMERIC(14,4);
ALTER TABLE recurring_payments ADD COLUMN IF NOT EXISTS last_paid_amount NUMERIC(14,4);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE recurring_payments DROP COLUMN IF EXISTS remaining_amount;
ALTER TABLE recurring_payments DROP COLUMN IF EXISTS last_paid_amount;
-- +goose StatementEnd
