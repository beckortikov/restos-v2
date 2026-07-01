-- +goose Up
-- +goose StatementBegin
--
-- 031_sync_settings — конфиг multi-branch sync, редактируемый из UI (ADR-003/004).
--
-- Раньше sync настраивался только через env/флаги (RESTOS_SYNC_*), что неудобно
-- на кассе внутри Electron. Теперь — singleton-строка в БД: сервер читает её при
-- старте (перекрывает env), UI её редактирует. Применяется после перезапуска.
--
-- Singleton: одна строка (id=1) на машину/БД. Это конфиг узла, не tenant-данные.
CREATE TABLE IF NOT EXISTS sync_settings (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled BOOLEAN NOT NULL DEFAULT false,
  central_url TEXT,
  token TEXT,
  restaurant_id UUID,
  interval_sec INTEGER NOT NULL DEFAULT 30,
  updated_at TIMESTAMPTZ DEFAULT now()
);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS sync_settings;
-- +goose StatementEnd
