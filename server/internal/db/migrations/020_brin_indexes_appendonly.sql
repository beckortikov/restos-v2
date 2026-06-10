-- +goose Up
-- +goose StatementBegin
--
-- 020_brin_indexes_appendonly — BRIN-индексы на append-only таблицы.
--
-- Зачем: audit_log, stock_movements, financial_operations растут быстрее всего
-- (десятки записей на каждый close_order). К году работы у активного ресторана
-- audit_log ~3-5 миллионов строк, stock_movements ~500k.
--
-- B-tree индекс на created_at для такой таблицы:
--   - занимает 50-100 МБ
--   - замедляет INSERT (каждый ~10% time penalty)
--   - GIST scan для диапазонных запросов нормальный, но fanout растёт
--
-- BRIN (Block Range INdex) для append-only данных по времени идеален:
--   - 100× меньше места (~500 КБ вместо 50 МБ)
--   - INSERT почти бесплатный
--   - SELECT WHERE created_at BETWEEN ... AND ... — за O(N/page_count)
--
-- Когда созданная BRIN-таблица переписана (TRUNCATE+INSERT), индекс надо
-- VACUUM — но в нашем случае такого не бывает (append-only). Если бы было —
-- REINDEX INDEX <name>.
--
-- Pages_per_range=128 (default) — оптимально для созданных-по-времени
-- таблиц. При нагрузке ресторана это ~16 минут «окно» данных на range.

-- audit_log: запросы вида «что менялось за день» / «логи смены».
CREATE INDEX IF NOT EXISTS idx_audit_log_created_brin
  ON audit_log USING BRIN (created_at)
  WITH (pages_per_range = 128);

-- stock_movements: запросы «движения за период» (ABC inventory, reports).
CREATE INDEX IF NOT EXISTS idx_stock_movements_created_brin
  ON stock_movements USING BRIN (created_at)
  WITH (pages_per_range = 128);

-- financial_operations: cashflow / pnl / by_day агрегаты.
CREATE INDEX IF NOT EXISTS idx_financial_operations_created_brin
  ON financial_operations USING BRIN (created_at)
  WITH (pages_per_range = 128);

-- print_jobs: «история печати за смену».
CREATE INDEX IF NOT EXISTS idx_print_jobs_created_brin
  ON print_jobs USING BRIN (created_at)
  WITH (pages_per_range = 128);

-- Sessions / idempotency_keys: используется при logout/cleanup.
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_created_brin
  ON idempotency_keys USING BRIN (created_at)
  WITH (pages_per_range = 128);

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP INDEX IF EXISTS idx_audit_log_created_brin;
DROP INDEX IF EXISTS idx_stock_movements_created_brin;
DROP INDEX IF EXISTS idx_financial_operations_created_brin;
DROP INDEX IF EXISTS idx_print_jobs_created_brin;
DROP INDEX IF EXISTS idx_idempotency_keys_created_brin;
-- +goose StatementEnd
