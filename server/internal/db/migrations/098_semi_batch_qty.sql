-- +goose Up
-- +goose StatementBegin
--
-- 098_semi_batch_qty — объём партии в техкарте полуфабриката (владелец
-- 2026-08-30): «сейчас делается на один килограм, а клиент может на выход
-- 10кг сделать тех карту или 20 шт». Prepare (semi_ops.go) уже умеет
-- производить любое количество — recipe_lines.qty_per_unit всегда «на 1
-- единицу выхода», и это НЕ меняется этой миграцией. batch_qty — чисто
-- авторская подсказка для формы (сколько сырья повар вводит «на партию»,
-- фронт сам делит на batch_qty перед сохранением) — Prepare/Consume/COGS/
-- cascadeSemiDeduct её не видят и не используют.
--
ALTER TABLE semi_finished_types
  ADD COLUMN IF NOT EXISTS batch_qty NUMERIC(14,4) NOT NULL DEFAULT 1;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE semi_finished_types DROP COLUMN IF EXISTS batch_qty;
-- +goose StatementEnd
