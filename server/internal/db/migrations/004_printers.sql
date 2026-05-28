-- +goose Up
-- +goose StatementBegin
--
-- printers — настройка физических принтеров ресторана.
--
-- Manager-UI (Phase 4.5+) ведёт CRUD по этой таблице. Worker (queue.go)
-- резолвит правильный принтер для каждого print_job:
--   - job.printer_id есть → строго этот.
--   - иначе и job.type='receipt' → fallback на kind='receipt' (default=true).
--   - иначе и job.type='runner' → station-printer соответствующего menu_item.station.
--
-- driver — какой Go-driver использовать. target — connection string per-driver:
--   tcp     → "192.168.1.50:9100"
--   virtual → "/path/to/dir" (для тестов/staging)
--   usb     → "vid:pid" (например "04b8:0202") — за build tag.
--   mock    → "" (только тесты).
CREATE TABLE IF NOT EXISTS printers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id TEXT NOT NULL,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('receipt','station')),
  station       TEXT,                          -- nullable, обязателен для kind='station'
  driver        TEXT NOT NULL CHECK (driver IN ('tcp','usb','virtual','mock')),
  target        TEXT NOT NULL DEFAULT '',
  cols          INTEGER NOT NULL DEFAULT 48,   -- 48 для 80mm, 32 для 58mm
  is_default    BOOLEAN NOT NULL DEFAULT false,
  enabled       BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_printers_restaurant ON printers (restaurant_id);
-- Уникальность «один default receipt-принтер на ресторан».
CREATE UNIQUE INDEX IF NOT EXISTS idx_printers_default_receipt
  ON printers (restaurant_id) WHERE is_default = true AND kind = 'receipt';
-- Уникальность станций (один принтер на cтанцию ресторана).
CREATE UNIQUE INDEX IF NOT EXISTS idx_printers_station
  ON printers (restaurant_id, station) WHERE kind = 'station';
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS printers;
-- +goose StatementEnd
