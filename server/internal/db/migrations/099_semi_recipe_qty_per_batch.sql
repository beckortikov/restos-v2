-- +goose Up
-- +goose StatementBegin
--
-- 099_semi_recipe_qty_per_batch — владелец (2026-08-30) указал на дрейф
-- точности в форме техкарты п/ф: 098 делила введённое «на партию» количество
-- на batch_qty ДО записи в БД (qty_per_unit — NUMERIC(14,4)), и для батчей,
-- не делящихся нацело (напр. 5.8), обратное умножение при повторном открытии
-- показывало испорченное число (800 г → 799.9998). Его вопрос «зачем вообще
-- что-то делить при сохранении» — верный: recipe_lines.qty_per_unit
-- переименовывается в qty_per_batch и хранит РОВНО то, что ввёл человек, «на
-- весь объём партии» — без деления. Пропорцию «на 1 единицу» теперь считают
-- сами потребители (Prepare/cascadeSemiDeduct/buildSemiSpec), в момент
-- реального использования, а не заранее.
--
-- Бэкфилл трогает только строки типов с batch_qty<>1 (только то, что успело
-- завестись через 098) — обратной операцией (qty_per_unit × batch_qty),
-- переводя их в новую, батч-относительную семантику. Для batch_qty=1
-- (подавляющее большинство, включая все данные до 098) WHERE-условие не
-- срабатывает — значения остаются побайтово теми же, что и были.
--
ALTER TABLE semi_recipe_lines RENAME COLUMN qty_per_unit TO qty_per_batch;
UPDATE semi_recipe_lines l
  SET qty_per_batch = l.qty_per_batch * t.batch_qty
  FROM semi_finished_types t
  WHERE l.semi_type_id = t.id AND t.batch_qty <> 1;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
UPDATE semi_recipe_lines l
  SET qty_per_batch = l.qty_per_batch / t.batch_qty
  FROM semi_finished_types t
  WHERE l.semi_type_id = t.id AND t.batch_qty <> 1;
ALTER TABLE semi_recipe_lines RENAME COLUMN qty_per_batch TO qty_per_unit;
-- +goose StatementEnd
