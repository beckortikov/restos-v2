-- +goose Up
-- +goose StatementBegin
--
-- 053_printer_stations — принтер обслуживает НЕСКОЛЬКО цехов.
--
-- До этого station-принтер был жёстко привязан к одному цеху
-- (printers.station), а бегунок печатался по одному на цех. Теперь принтер
-- объявляет список цехов (эта таблица), и всё, что попало в заказ по этим
-- цехам, печатается ОДНИМ бегунком плоским списком (см. enqueueRunners).
-- Станции блюд (menu_items.station) не меняются — статистика и KDS живут
-- на них, объединение существует только в маршрутизации печати.
--
-- Цех, не привязанный ни к одному принтеру, при наличии у ресторана
-- станционных принтеров — «бесбумажный»: бегунок не печатается вовсе
-- (позиции видны на KDS и в чеке гостя). Ресторан вовсе без станционных
-- принтеров работает по-старому (job без printer_id → первый станционный).
--
-- printers.station остаётся заполненным (первая станция списка) для
-- обратной совместимости читателей, но маршрутизация её больше не читает.
CREATE TABLE IF NOT EXISTS printer_stations (
  printer_id    UUID NOT NULL REFERENCES printers(id) ON DELETE CASCADE,
  station       TEXT NOT NULL,
  restaurant_id TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (printer_id, station)
);

-- Один цех — максимум один принтер (включая отключённые: владелец видит
-- привязку явно, «два принтера спорят за цех» невозможно по построению).
CREATE UNIQUE INDEX IF NOT EXISTS uq_printer_stations_restaurant_station
  ON printer_stations (restaurant_id, station);
CREATE INDEX IF NOT EXISTS idx_printer_stations_printer
  ON printer_stations (printer_id);

-- Backfill 1: каждому существующему station-принтеру — его текущая станция.
INSERT INTO printer_stations (printer_id, station, restaurant_id)
SELECT id, station, restaurant_id
  FROM printers
 WHERE kind = 'station' AND station IS NOT NULL AND station <> ''
ON CONFLICT DO NOTHING;

-- Backfill 2: цехи БЕЗ своего принтера до сих пор печатались fallback'ом на
-- первый ВКЛЮЧЁННЫЙ станционный принтер ресторана (db_router.go). Привязываем
-- их к нему явно, чтобы после обновления ни одна печать не пропала (бегунки
-- цехов одного принтера при этом сольются в один чек — это и есть фича).
-- Набор цехов: пять известных UI + всё, что реально встречается в меню
-- ресторана (импорт позволяет произвольные строки станций).
WITH first_printer AS (
  SELECT DISTINCT ON (restaurant_id) restaurant_id, id
    FROM printers
   WHERE kind = 'station' AND enabled = true
   ORDER BY restaurant_id, created_at ASC
), wanted AS (
  SELECT fp.restaurant_id, s.station, fp.id AS printer_id
    FROM first_printer fp
   CROSS JOIN (VALUES ('hot_kitchen'), ('cold_kitchen'), ('grill'),
                      ('bar'), ('showcase'), ('dessert')) AS s(station)
  UNION
  SELECT fp.restaurant_id,
         COALESCE(NULLIF(mi.station, ''), 'hot_kitchen') AS station,
         fp.id
    FROM first_printer fp
    JOIN menu_items mi ON mi.restaurant_id = fp.restaurant_id
   WHERE mi.is_deleted = false
)
INSERT INTO printer_stations (printer_id, station, restaurant_id)
SELECT DISTINCT printer_id, station, restaurant_id FROM wanted
ON CONFLICT DO NOTHING;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS printer_stations;
-- +goose StatementEnd
