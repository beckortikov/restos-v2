-- +goose Up
-- +goose StatementBegin
--
-- 032_network_menu — сетевое меню: общая база + переопределения (ADR-004).
--
-- network_menu_items — мастер-меню на уровне сети (account_id): что за блюдо,
-- категория, базовая цена, станция. Филиалы наследуют это; локальные поля
-- (price/is_available/оформление) остаются у филиала (см. ADR-004).
--
-- menu_items.master_id — связь блюда филиала с мастером. NULL → локальное блюдо
-- филиала (местный специалитет), в мастере его нет.
CREATE TABLE IF NOT EXISTS network_menu_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID,
  name TEXT NOT NULL,
  category TEXT,
  base_price NUMERIC(14,4) DEFAULT 0,
  station TEXT DEFAULT 'hot_kitchen',
  unit TEXT DEFAULT 'piece',
  emoji TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_network_menu_items_account ON network_menu_items(account_id);

ALTER TABLE menu_items
  ADD COLUMN IF NOT EXISTS master_id UUID;
CREATE INDEX IF NOT EXISTS idx_menu_items_master
  ON menu_items(master_id) WHERE master_id IS NOT NULL;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP INDEX IF EXISTS idx_menu_items_master;
ALTER TABLE menu_items DROP COLUMN IF EXISTS master_id;
DROP INDEX IF EXISTS idx_network_menu_items_account;
DROP TABLE IF EXISTS network_menu_items;
-- +goose StatementEnd
