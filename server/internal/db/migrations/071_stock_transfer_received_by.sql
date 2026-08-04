-- +goose Up
-- +goose StatementBegin
--
-- 071_stock_transfer_received_by — кто принял перемещение (ADR-003).
-- (Перенумерована с 065 при мерже main → feat/multi-branch-network: main
-- независимо занял 065-070 своими миграциями после расхождения веток.)
--
-- Receive() раньше обновлял только status/received_at — узнать, кто именно
-- принял перемещение на филиале, было негде (ни в БД, ни в audit_log с
-- entity_id: апдейт через map[string]any не даёт хуку прочитать id).
ALTER TABLE stock_transfers ADD COLUMN IF NOT EXISTS received_by TEXT;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE stock_transfers DROP COLUMN IF EXISTS received_by;
-- +goose StatementEnd
