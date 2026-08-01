-- +goose Up
-- +goose StatementBegin
--
-- 065_order_item_stage_events — история переходов station_status по позиции
-- заказа, для отчёта владельца «время блюда по станциям» (аналитика).
--
-- order_items.station_status_at (миграция 033) хранит только ПОСЛЕДНИЙ переход —
-- на "ready" мы теряем, когда началась готовка, а на "served" теряем, когда
-- блюдо стало готовым. Посчитать длительность каждой стадии (очередь →
-- готовка → ожидание выдачи) после первого перехода уже нельзя.
--
-- Эта таблица — append-only лог: строка на КАЖДЫЙ переход station_status
-- (pending→cooking→ready→served, включая повторные заходы, если блюдо вернули
-- на станцию). Пишется явной вставкой в той же транзакции, что и сам переход
-- (KDSService.SetItemStatus, buildOrderItem — начальное событие "→pending"),
-- аналогично stock_movements/financial_operations — не через блэнкет audit-хук,
-- т.к. это новая доменная сущность со своей формой, а не сырой diff колонок.
--
-- station и dish_name — СНЭПШОТ на момент события (а не join на menu_items),
-- чтобы правки меню (переименование блюда, смена станции) не переписывали
-- историю задним числом.
CREATE TABLE IF NOT EXISTS order_item_stage_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_item_id UUID NOT NULL,
  restaurant_id TEXT NOT NULL,
  menu_item_id  UUID,
  dish_name     TEXT,
  station       TEXT NOT NULL DEFAULT 'hot_kitchen',
  from_status   TEXT,
  to_status     TEXT NOT NULL,
  changed_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE order_item_stage_events
  ADD CONSTRAINT order_item_stage_events_to_status_chk
  CHECK (to_status IN ('pending', 'cooking', 'ready', 'served'));

-- Отчёт всегда сканирует «мой ресторан + диапазон дат» — основной запрос.
CREATE INDEX IF NOT EXISTS idx_order_item_stage_events_tenant_range
  ON order_item_stage_events (restaurant_id, created_at);

-- Восстановление полной цепочки событий одной позиции (для drill-down).
CREATE INDEX IF NOT EXISTS idx_order_item_stage_events_order_item
  ON order_item_stage_events (order_item_id, created_at);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS order_item_stage_events;
-- +goose StatementEnd
