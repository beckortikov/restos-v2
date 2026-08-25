-- +goose Up
-- +goose StatementBegin
--
-- 087_money_transfer_suggested_account — Ф-С2: центр видит кассы филиалов
-- (реплики Ф5) и делает перевод «на конкретный счёт филиала» из единого
-- диалога в Финансы → Деньги.
--
-- suggested_to_account_id — счёт-НАЗНАЧЕНИЕ, предложенный ОТПРАВИТЕЛЕМ.
-- Двухфазность приёма сохраняется намеренно (между двумя независимыми БД
-- она защищает от гонок и потери денег): филиал при приёме видит этот счёт
-- предвыбранным, но волен выбрать другой — его касса, его решение. Поле
-- отличается от to_account_id (фактического счёта зачисления, который
-- заполняет ПОЛУЧАТЕЛЬ в Receive) — сливать их нельзя: иначе не отличить
-- «предложено» от «зачислено».
ALTER TABLE money_transfers
  ADD COLUMN IF NOT EXISTS suggested_to_account_id UUID;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE money_transfers DROP COLUMN IF EXISTS suggested_to_account_id;
-- +goose StatementEnd
