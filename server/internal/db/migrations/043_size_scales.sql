-- +goose Up
-- +goose StatementBegin
--
-- 043_size_scales — переиспользуемые шкалы размеров («25/30/35»).
--
-- Отдельно от menu_attributes: значения атрибута сегодня заводятся с нуля
-- на каждом продукте (свободный текст), поэтому ничего не гарантирует, что
-- «30» у одной пиццы и «30» у другой (и у заготовки «Тесто») — один и тот
-- же размер. Шкала — общий справочник значений, на который продукт (через
-- menu_attributes.size_scale_id) и полуфабрикат (semi_finished_types.
-- size_scale_value_id) ссылаются, вместо того чтобы каждый раз перепечатывать
-- одинаковые лейблы. См. 044_size_scale_links.sql для самих связей.
--
CREATE TABLE IF NOT EXISTS size_scales (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  restaurant_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_size_scales_restaurant
  ON size_scales (restaurant_id);

CREATE TABLE IF NOT EXISTS size_scale_values (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  size_scale_id UUID NOT NULL REFERENCES size_scales(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  title TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_default BOOLEAN NOT NULL DEFAULT false,
  restaurant_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_size_scale_values_scale
  ON size_scale_values (size_scale_id);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS size_scale_values;
DROP TABLE IF EXISTS size_scales;
-- +goose StatementEnd
