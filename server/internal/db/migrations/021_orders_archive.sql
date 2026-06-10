-- +goose Up
-- +goose StatementBegin
--
-- 021_orders_archive — таблица архива закрытых заказов.
--
-- Зачем: через 2-3 года активного ресторана `orders` разрастается до
-- сотен тысяч строк. UI-запросы (history, search, KDS, POS) почти всегда
-- работают только с активными или недавно закрытыми. Старые закрытые
-- сидят там «мёртвым грузом» и удлиняют:
--   - GIN/B-tree поиск на orders
--   - pg_dump (бэкап растёт)
--   - VACUUM (анализ всей таблицы)
--
-- Решение: каждую ночь cron перемещает orders где closed_at < NOW() - 365 days
-- в orders_archive. История доступна через VIEW orders_all (union).
--
-- Это «партиционирование без партиционирования»:
--   ✓ Никаких FK-каскадных изменений
--   ✓ Никакого downtime — миграция batch'ами по 1000 ночью
--   ✓ pg_dump активной БД маленький, архива — отдельно
--   ✓ Откат тривиален (INSERT обратно)
--
-- Схема orders_archive идентична orders. Constraints упрощённые —
-- архивные данные неизменяемы. FK на child-таблицы НЕ переносим
-- (order_items, voids и т.п. остаются в основных таблицах с
-- разорванной ссылкой на archive — это допустимо).

-- Полная копия структуры orders без FK-каскадов (архив самостоятелен).
CREATE TABLE IF NOT EXISTS orders_archive (LIKE orders INCLUDING DEFAULTS INCLUDING CONSTRAINTS);

-- BRIN на closed_at — поиск по диапазону «закрытые в Q2 2023» быстрый.
CREATE INDEX IF NOT EXISTS idx_orders_archive_closed_at_brin
  ON orders_archive USING BRIN (closed_at)
  WITH (pages_per_range = 128);

-- Поиск по restaurant_id для multi-tenant отчётов.
CREATE INDEX IF NOT EXISTS idx_orders_archive_restaurant
  ON orders_archive (restaurant_id, closed_at DESC);

-- VIEW для аналитики которая хочет ВСЁ (live + архив).
-- Использовать с from/to фильтром — иначе сканирует обе таблицы.
CREATE OR REPLACE VIEW orders_all AS
  SELECT * FROM orders
  UNION ALL
  SELECT * FROM orders_archive;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP VIEW IF EXISTS orders_all;
DROP TABLE IF EXISTS orders_archive;
-- +goose StatementEnd
