-- +goose Up
-- +goose StatementBegin
--
-- 057_shift_op_account — счёт кассовой операции смены.
--
-- Расход из смены раньше всегда списывался со счёта смены (наличный ящик).
-- Теперь расход может быть безналичным — с банк-счёта: он дебетует свой счёт,
-- но наличный ящик (expected_cash) не трогает, ровно как безнал-выручка идёт
-- на банк-счёт, а не в кассу.
--
-- NULL = счёт смены (наличный ящик) — так все существующие операции остаются
-- наличными без backfill.
ALTER TABLE cash_shift_operations ADD COLUMN IF NOT EXISTS account_id uuid;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE cash_shift_operations DROP COLUMN IF EXISTS account_id;
-- +goose StatementEnd
