-- +goose Up
-- +goose StatementBegin
--
-- 036_multi_warehouse — мультисклад, Фаза 1.
--
-- Модель: товар (ingredient) целиком лежит на ОДНОМ складе (ingredients.warehouse_id).
-- Остаток не дробится по складам; перемещение = смена warehouse_id всего товара
-- + запись движения type=transfer (from/to). Списание продажи идёт со склада,
-- где лежит товар — определяется автоматически, кассир склад не выбирает.
--
-- Ровно 3 фиксированных склада на ресторан (произвольные не создаём):
--   products  «Продукты»        — всё, кроме покупных и хозтоваров
--   purchased «Покупные товары» — бар/витрина (ingredient техкарты покупного блюда)
--   supplies  «Хозтовары»       — is_food = false
--
CREATE TABLE IF NOT EXISTS warehouses (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('products','purchased','supplies')),
  restaurant_id TEXT,
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_warehouses_restaurant ON warehouses (restaurant_id);
-- Один склад каждого вида на ресторан.
CREATE UNIQUE INDEX IF NOT EXISTS uq_warehouses_rest_kind ON warehouses (restaurant_id, kind);

ALTER TABLE ingredients ADD COLUMN IF NOT EXISTS warehouse_id UUID;
CREATE INDEX IF NOT EXISTS idx_ingredients_warehouse ON ingredients (warehouse_id);

-- Движение несёт склад. Для transfer заполняются from/to; для остальных типов —
-- warehouse_id (где произошло движение).
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS warehouse_id      UUID;
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS from_warehouse_id UUID;
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS to_warehouse_id   UUID;

-- ── Backfill: 3 склада на каждый ресторан, у кого есть ингредиенты ──────────
INSERT INTO warehouses (name, kind, restaurant_id)
SELECT DISTINCT 'Продукты', 'products', restaurant_id
FROM ingredients WHERE restaurant_id IS NOT NULL
ON CONFLICT (restaurant_id, kind) DO NOTHING;

INSERT INTO warehouses (name, kind, restaurant_id)
SELECT DISTINCT 'Покупные товары', 'purchased', restaurant_id
FROM ingredients WHERE restaurant_id IS NOT NULL
ON CONFLICT (restaurant_id, kind) DO NOTHING;

INSERT INTO warehouses (name, kind, restaurant_id)
SELECT DISTINCT 'Хозтовары', 'supplies', restaurant_id
FROM ingredients WHERE restaurant_id IS NOT NULL
ON CONFLICT (restaurant_id, kind) DO NOTHING;

-- ── Раскладка товаров по складам (приоритет: покупные → хозтовары → продукты) ─
-- 1. Покупные: ingredient входит в техкарту блюда-товара (is_purchased).
UPDATE ingredients i SET warehouse_id = w.id
FROM warehouses w
WHERE w.restaurant_id = i.restaurant_id AND w.kind = 'purchased'
  AND i.id IN (
    SELECT tcl.ingredient_id FROM tech_card_lines tcl
    JOIN menu_items mi ON mi.id = tcl.menu_item_id
    WHERE mi.is_purchased = TRUE AND tcl.ingredient_id IS NOT NULL
  );

-- 2. Хозтовары: не еда (и ещё не размечены как покупные).
UPDATE ingredients i SET warehouse_id = w.id
FROM warehouses w
WHERE w.restaurant_id = i.restaurant_id AND w.kind = 'supplies'
  AND i.warehouse_id IS NULL AND i.is_food = FALSE;

-- 3. Продукты: всё остальное.
UPDATE ingredients i SET warehouse_id = w.id
FROM warehouses w
WHERE w.restaurant_id = i.restaurant_id AND w.kind = 'products'
  AND i.warehouse_id IS NULL;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE stock_movements DROP COLUMN IF EXISTS to_warehouse_id;
ALTER TABLE stock_movements DROP COLUMN IF EXISTS from_warehouse_id;
ALTER TABLE stock_movements DROP COLUMN IF EXISTS warehouse_id;
ALTER TABLE ingredients DROP COLUMN IF EXISTS warehouse_id;
DROP TABLE IF EXISTS warehouses;
-- +goose StatementEnd
