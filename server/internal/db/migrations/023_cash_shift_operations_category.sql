-- +goose Up
-- +goose StatementBegin
--
-- 023_cash_shift_operations_category — структурная категория для расходов.
--
-- Расход из смены и изъятие наличных раньше были неразличимы (оба type=cash_out),
-- а категория расхода вшивалась в description как "Категория: текст". Это ломало
-- свод/экспорт/X-Z (категорию нельзя агрегировать, расход не отделить от изъятия).
--
-- Теперь:
--   • cash_out + category IS NOT NULL  → расход (по категории)
--   • cash_out + category IS NULL      → изъятие (инкассация)
--   • cash_in                          → внесение
--
-- Колонка nullable; старые строки остаются с NULL (показываются как изъятия) —
-- автобэкфилл из префикса description НЕ делаем (description изъятий тоже может
-- содержать ":", риск ложного срабатывания).
ALTER TABLE cash_shift_operations
  ADD COLUMN IF NOT EXISTS category TEXT NULL;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE cash_shift_operations
  DROP COLUMN IF EXISTS category;
-- +goose StatementEnd
