-- +goose Up
-- +goose StatementBegin
--
-- 063_account_enabled — отключение счёта вместо удаления.
--
-- Удалить счёт нельзя: на financial_accounts.id ссылаются cash_shifts,
-- cash_shift_operations, recurring_payments, stock_returns, order_splits —
-- и ни одного FK в схеме нет, только текстовые колонки. Снос строки оставил
-- бы эти ссылки в никуда (регулярный платёж стал бы списывать с
-- несуществующего счёта).
--
-- Поэтому счёт «отключается»: строка на месте, все ссылки резолвятся,
-- история цела, остаток продолжает учитываться в Балансе — счёт лишь
-- перестаёт предлагаться при оплате и в операциях.
--
-- DEFAULT true — все существующие счета на кассах остаются включёнными
-- без backfill.
ALTER TABLE financial_accounts
  ADD COLUMN IF NOT EXISTS is_enabled  BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE financial_accounts
  ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE financial_accounts DROP COLUMN IF EXISTS disabled_at;
ALTER TABLE financial_accounts DROP COLUMN IF EXISTS is_enabled;
-- +goose StatementEnd
