-- +goose Up
-- +goose StatementBegin
--
-- 093_orders_closed_at_index — central копит ВСЮ историю заказов сети без
-- архивации (022_revert_orders_archive.sql). Сетевая аналитика (~15 точек в
-- network_analytics.go: лидерборд официантов, ABC, отчёты по категориям и
-- т.д.) фильтрует orders по restaurant_id + диапазон closed_at — индекса под
-- этот паттерн не было, каждый такой запрос — полный skan по всей сетевой
-- истории заказов. idx_orders_restaurant_status (001_init) на central
-- бесполезен: central получает по синку только терминальные заказы
-- (sync_orders.go), status почти всегда 'closed' — не сужает выборку.
-- Партиционные индексы 019 — WHERE closed_at IS NULL, на central это
-- множество пустое (там как раз наоборот, каждый заказ уже закрыт).
--
-- Найдено вживую: лидерборд официантов на central заметно медленнее
-- Z-отчёта смены (тот идёт по индексированному shift_id).
--
CREATE INDEX IF NOT EXISTS idx_orders_restaurant_closed_at
  ON orders (restaurant_id, closed_at)
  WHERE closed_at IS NOT NULL;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP INDEX IF EXISTS idx_orders_restaurant_closed_at;
-- +goose StatementEnd
