-- +goose Up
-- +goose StatementBegin
--
-- Тумблер «Сортировать меню по продаваемости» (POS + pos2).
--
-- По умолчанию false — меню сортируется по алфавиту (как раньше). Когда true,
-- внутри каждой категории хиты продаж встают вверх (окно 30 дней), алфавит —
-- тайбрейк и для позиций без продаж.
ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS menu_sort_by_sales BOOLEAN NOT NULL DEFAULT false;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE restaurants DROP COLUMN IF EXISTS menu_sort_by_sales;
-- +goose StatementEnd
