-- +goose Up
-- +goose StatementBegin
--
-- 072_restaurant_board_settings — настройки ТВ-табло выдачи (/board).
--
-- Табло — отдельное устройство (телевизор в браузере), поэтому его настройки
-- должны жить на сервере (в отличие от кухонного планшета, который хранит выбор
-- станций локально). Владелец настраивает всё в разделе «Табло выдачи»:
--   board_stations      — CSV станций, которые показывать (как на кухонном
--                         планшете); пусто/NULL = все станции. Без этого фильтра
--                         табло показывало заказы всех станций, включая те, что
--                         планшет не ведёт → «призрачные» заказы висели до 90 мин.
--   board_logo_opacity  — яркость логотипа-фона за колонкой «Готово», в процентах
--                         (0–100); NULL = дефолт 13%.
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS board_stations     TEXT;
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS board_logo_opacity INTEGER;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE restaurants DROP COLUMN IF EXISTS board_stations;
ALTER TABLE restaurants DROP COLUMN IF EXISTS board_logo_opacity;
-- +goose StatementEnd
