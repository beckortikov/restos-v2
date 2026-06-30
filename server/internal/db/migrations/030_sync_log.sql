-- +goose Up
-- +goose StatementBegin
--
-- 030_sync_log — журнал дельт для синхронизации филиал → центральный узел
-- (Фаза 2 multi-branch, ADR-003).
--
-- Каждая мутация tracked-таблицы (заказы, движения склада, перемещения, …)
-- порождает строку sync_log с полным снимком (payload), чтобы пушер мог
-- отправить дельты на центральный узел, а тот — выполнить upsert без обращения
-- к источнику. synced_at NULL → ещё не отправлено (пушер сканирует такие).
--
-- Конфликтов почти нет: филиал — единственный писатель своих строк
-- (партиционирование по restaurant_id). Поэтому sync почти односторонний.
--
-- Append-only журнал (как audit_log/stock_movements). BRIN-индекс по created_at
-- (см. 020) при необходимости добавим позже.
CREATE TABLE IF NOT EXISTS sync_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  op TEXT NOT NULL CHECK (op IN ('insert', 'update', 'delete')),
  restaurant_id UUID,
  account_id UUID,
  payload JSONB,
  created_at TIMESTAMPTZ DEFAULT now(),
  synced_at TIMESTAMPTZ
);
-- Пушер сканирует неотправленные — partial index держит его дешёвым.
CREATE INDEX IF NOT EXISTS idx_sync_log_unsynced
  ON sync_log(created_at) WHERE synced_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_sync_log_account ON sync_log(account_id);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS sync_log;
-- +goose StatementEnd
