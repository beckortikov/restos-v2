-- +goose Up
-- +goose StatementBegin
--
-- 089_money_transfer_requested_status — новый статус 'requested' (Ф-Ц,
-- 2026-08-25): центр запрашивает списание со счёта филиала без участия
-- человека там («у филиала может не быть своего управляющего»). Документ
-- заводится центром в этом статусе БЕЗ движения по счетам — реальное
-- списание происходит само на филиале при получении (applyRequestedTransfer
-- в sync_ingest.go), после чего статус меняется на sent как у обычного
-- перевода.
ALTER TABLE money_transfers DROP CONSTRAINT IF EXISTS money_transfers_status_check;
ALTER TABLE money_transfers ADD CONSTRAINT money_transfers_status_check
  CHECK (status IN ('requested', 'sent', 'received', 'cancelled'));
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE money_transfers DROP CONSTRAINT IF EXISTS money_transfers_status_check;
ALTER TABLE money_transfers ADD CONSTRAINT money_transfers_status_check
  CHECK (status IN ('sent', 'received', 'cancelled'));
-- +goose StatementEnd
