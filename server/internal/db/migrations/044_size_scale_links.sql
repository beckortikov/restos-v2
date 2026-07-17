-- +goose Up
-- +goose StatementBegin
--
-- 044_size_scale_links — привязка атрибутов продукта и типов полуфабрикатов
-- к общей шкале размеров (043_size_scales.sql).
--
-- menu_attributes.size_scale_id: если задан — значения атрибута берутся не
-- из ручного ввода, а зеркалятся из значений шкалы (см. syncAttributeDefs в
-- menu_variants.go). menu_attribute_values.size_scale_value_id — какое именно
-- значение шкалы зеркалит эта строка (NULL — обычный свободный лейбл).
--
-- semi_finished_types.size_scale_value_id: тег «это заготовка вот этого
-- размера» (например «Тесто-30» → значение «30»). Помогает UI подсказать
-- нужную заготовку при сборке техкарты варианта того же размера — критично
-- по ТЗ: техкарта «Пепперони 30» обязана списывать «Тесто 30», а не «Тесто 25».
-- Это не FK-принуждение уровня БД (сопоставление мягкое, на уровне UI) —
-- SET NULL, а не RESTRICT/CASCADE, чтобы удаление шкалы не рушило продукты
-- и заготовки, а просто откатывало их к несвязанному состоянию.
--
ALTER TABLE menu_attributes
  ADD COLUMN IF NOT EXISTS size_scale_id UUID REFERENCES size_scales(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_menu_attributes_size_scale
  ON menu_attributes (size_scale_id) WHERE size_scale_id IS NOT NULL;

ALTER TABLE menu_attribute_values
  ADD COLUMN IF NOT EXISTS size_scale_value_id UUID REFERENCES size_scale_values(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_menu_attribute_values_size_scale_value
  ON menu_attribute_values (size_scale_value_id) WHERE size_scale_value_id IS NOT NULL;

ALTER TABLE semi_finished_types
  ADD COLUMN IF NOT EXISTS size_scale_value_id UUID REFERENCES size_scale_values(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_semi_finished_types_size_scale_value
  ON semi_finished_types (size_scale_value_id) WHERE size_scale_value_id IS NOT NULL;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE semi_finished_types DROP COLUMN IF EXISTS size_scale_value_id;
ALTER TABLE menu_attribute_values DROP COLUMN IF EXISTS size_scale_value_id;
ALTER TABLE menu_attributes DROP COLUMN IF EXISTS size_scale_id;
-- +goose StatementEnd
