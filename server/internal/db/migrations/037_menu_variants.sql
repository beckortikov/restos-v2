-- +goose Up
-- +goose StatementBegin
--
-- 035_menu_variants — товары с атрибутами (Размер, Вкус, ...).
--
-- Модель: продукт (menu_items, parent_id IS NULL) описывает атрибуты
-- (menu_attributes) и их значения (menu_attribute_values, каждое с дельтой
-- к базовой цене). Продаваемые комбинации — обычные строки menu_items с
-- parent_id = продукт: у каждой свой price/техкарта/складской SKU, поэтому
-- списание, COGS, возвраты, отчёты и чеки работают без изменений.
-- Связка «вариант ↔ выбранные значения» — menu_item_variant_values.
-- Варианты скрываются из всех списков UI (фильтр parent_id IS NULL);
-- генерирует/архивирует их сервис при PUT /menu/items/{id}/attributes.

-- NO ACTION (не RESTRICT): проверка в конце statement'а — bulk DELETE
-- родителей вместе с вариантами (wipe ресторана, тесты) не падает.
ALTER TABLE menu_items
  ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES menu_items(id);

CREATE INDEX IF NOT EXISTS idx_menu_items_parent
  ON menu_items (restaurant_id, parent_id) WHERE parent_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS menu_attributes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  menu_item_id UUID NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  restaurant_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_menu_attributes_item
  ON menu_attributes (restaurant_id, menu_item_id);

CREATE TABLE IF NOT EXISTS menu_attribute_values (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attribute_id UUID NOT NULL REFERENCES menu_attributes(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  price_delta NUMERIC(14,4) NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  restaurant_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_menu_attribute_values_attr
  ON menu_attribute_values (attribute_id);

-- Связка вариант ↔ значения атрибутов. Значение может быть удалено
-- (CASCADE): сам вариант при этом soft-delete'ится сервисом, а связка
-- по оставшимся значениям сохраняется для резуррекции по имени.
CREATE TABLE IF NOT EXISTS menu_item_variant_values (
  menu_item_id UUID NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  value_id UUID NOT NULL REFERENCES menu_attribute_values(id) ON DELETE CASCADE,
  restaurant_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (menu_item_id, value_id)
);

CREATE INDEX IF NOT EXISTS idx_menu_item_variant_values_value
  ON menu_item_variant_values (value_id);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS menu_item_variant_values;
DROP TABLE IF EXISTS menu_attribute_values;
DROP TABLE IF EXISTS menu_attributes;
DROP INDEX IF EXISTS idx_menu_items_parent;
ALTER TABLE menu_items DROP COLUMN IF EXISTS parent_id;
-- +goose StatementEnd
