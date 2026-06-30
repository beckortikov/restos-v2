-- +goose Up
-- +goose StatementBegin
--
-- 028_stock_transfers — перемещения товара между филиалами сети
-- (Фаза 1 multi-branch, ADR-003).
--
-- Документ перемещения: расход на складе-источнике (transfer_out) ↔ приход
-- на филиале-получателе (transfer_in). Сами движения остатка идут через
-- event-stream stock_movements (правило проекта), здесь — «шапка» документа.
--
-- Жизненный цикл status: draft → sent (списано с источника) → received
-- (зачислено получателю); cancelled — отменён до отправки.
--
-- Хард-FK не ставим (стиль проекта). restaurant/account id — UUID (как
-- restaurants.id), ingredient_id — TEXT (как в stock_movements/receipt_lines).
CREATE TABLE IF NOT EXISTS stock_transfers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID,
  from_restaurant_id UUID,
  to_restaurant_id UUID,
  transfer_number INTEGER,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'sent', 'received', 'cancelled')),
  note TEXT,
  sent_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ,
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_stock_transfers_account ON stock_transfers(account_id);
CREATE INDEX IF NOT EXISTS idx_stock_transfers_from ON stock_transfers(from_restaurant_id);
CREATE INDEX IF NOT EXISTS idx_stock_transfers_to ON stock_transfers(to_restaurant_id);

CREATE TABLE IF NOT EXISTS stock_transfer_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_id UUID,
  ingredient_id TEXT,
  ingredient_name TEXT,
  qty NUMERIC(14,4) DEFAULT 0,
  unit TEXT,
  cost_per_unit NUMERIC(14,4) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_stock_transfer_lines_transfer ON stock_transfer_lines(transfer_id);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS stock_transfer_lines;
DROP TABLE IF EXISTS stock_transfers;
-- +goose StatementEnd
