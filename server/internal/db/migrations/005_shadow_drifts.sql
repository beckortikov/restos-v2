-- +goose Up
-- +goose StatementBegin
--
-- shadow_drifts — приём drift-репортов от фронта в параллельном прогоне (Phase 8).
--
-- Каждая запись = одна shadow-операция (фронт сделал один и тот же read-запрос
-- в v1 и v4, сравнил, прислал результат). matched=true → ответы идентичны.
-- matched=false → diff_size_bytes / sample (первое расхождение в JSON-payload).
--
-- Owner Dashboard читает агрегаты:
--   SELECT operation, COUNT(*) total, SUM(CASE WHEN matched THEN 1 ELSE 0 END) ok
--   FROM shadow_drifts WHERE created_at > now() - interval '24 hours'
--   GROUP BY operation;
--
-- → видно «v4 имеет 100% match по menu/items, но 12% drift по orders» →
--   до cutover в Phase 9 нужно фиксить.
CREATE TABLE IF NOT EXISTS shadow_drifts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id   TEXT NOT NULL,
  operation       TEXT NOT NULL,                -- "menu.items.list", "orders.get/{id}", ...
  matched         BOOLEAN NOT NULL,
  v1_status       INTEGER,                       -- HTTP status кода v1 (опц.)
  v4_status       INTEGER,                       -- HTTP status кода v4
  v1_latency_ms   INTEGER,
  v4_latency_ms   INTEGER,
  diff_size_bytes INTEGER,                       -- 0 если match
  diff_sample     TEXT,                          -- первые 2KB diff'а (truncated)
  user_id         TEXT,
  app_version     TEXT,                          -- версия фронта (для debug)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shadow_restaurant_created
  ON shadow_drifts (restaurant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_shadow_operation
  ON shadow_drifts (restaurant_id, operation, matched);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS shadow_drifts;
-- +goose StatementEnd
