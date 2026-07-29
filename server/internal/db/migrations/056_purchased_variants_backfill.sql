-- +goose Up
-- +goose StatementBegin
--
-- 056_purchased_variants_backfill — чинит складской учёт УЖЕ созданных покупных
-- товаров с вариациями («напитки по объёмам»).
--
-- Что было сломано: при конвертации блюда-с-вариациями в «Покупной»
-- (patchPurchased) складской ингредиент получал только РОДИТЕЛЬ (группа), а
-- вариации оставались is_purchased=false без ингредиента и без остатка. Продаётся
-- же вариант — значит у каждого должен быть свой SKU и свой остаток. Плюс у
-- родителя-контейнера болтался фантом-ингредиент (он напрямую не продаётся).
--
-- Код (ensureVariantsPurchasedBacking) чинит это для НОВЫХ конвертаций; здесь —
-- разовый бэкофилл существующих. Идемпотентно: шаги пропускают уже корректные
-- строки (NOT EXISTS / условие пустого фантома).

-- Шаг 1. Вариации покупных продуктов — тоже покупные.
UPDATE menu_items v
SET is_purchased = true, updated_at = now()
FROM menu_items p
WHERE v.parent_id = p.id
  AND v.is_deleted = false
  AND p.is_purchased = true
  AND v.is_purchased = false;

-- Шаг 2. У вариаций без покупных техкарт удаляем «пустые» строки техкарты
-- (обычно их нет; но если вариация до конвертации ссылалась на полуфабрикат/
-- ингредиент рецепта — заменяем на 1:1 покупной ниже, не плодя вторую строку).
DELETE FROM tech_card_lines tl
USING menu_items v, menu_items p
WHERE tl.menu_item_id = v.id
  AND v.parent_id = p.id
  AND v.is_deleted = false
  AND p.is_purchased = true
  AND NOT EXISTS (
    SELECT 1 FROM tech_card_lines t2
    WHERE t2.menu_item_id = v.id AND t2.ingredient_id IS NOT NULL
  );

-- Шаг 3. Каждой вариации без 1:1 покупного ингредиента — свой ингредиент на
-- складе «Покупные» (0 остаток) + 1:1 техкарта. gen_random_uuid() считается ОДИН
-- раз в materialized-CTE, поэтому ингредиент и его техкарта ссылаются на один id.
WITH to_create AS MATERIALIZED (
  SELECT
    v.id                                         AS variant_id,
    v.name                                       AS name,
    v.category                                   AS category,
    v.restaurant_id                              AS restaurant_id,
    COALESCE(pu.unit, 'шт')                      AS unit,
    CASE WHEN v.cogs > 0 THEN v.cogs
         ELSE COALESCE(p.cogs, 0) END            AS price,
    w.id                                         AS warehouse_id,
    gen_random_uuid()                            AS new_ing_id
  FROM menu_items v
  JOIN menu_items p ON p.id = v.parent_id
  LEFT JOIN warehouses w
    ON w.restaurant_id = v.restaurant_id AND w.kind = 'purchased'
  LEFT JOIN LATERAL (
    SELECT i2.unit
    FROM tech_card_lines t2
    JOIN ingredients i2 ON i2.id = t2.ingredient_id
    WHERE t2.menu_item_id = p.id
    LIMIT 1
  ) pu ON true
  WHERE v.is_deleted = false
    AND p.is_purchased = true
    AND NOT EXISTS (
      SELECT 1 FROM tech_card_lines tl
      WHERE tl.menu_item_id = v.id AND tl.ingredient_id IS NOT NULL
    )
),
ins_ing AS (
  INSERT INTO ingredients
    (id, name, category, qty, min_qty, unit, price_per_unit, warehouse_id, restaurant_id, created_at, updated_at)
  SELECT new_ing_id, name, category, 0, 0, unit, price, warehouse_id, restaurant_id, now(), now()
  FROM to_create
  RETURNING id
)
INSERT INTO tech_card_lines
  (id, menu_item_id, ingredient_id, name, qty, unit, restaurant_id, created_at)
SELECT gen_random_uuid(), variant_id, new_ing_id, name, 1, unit, restaurant_id, now()
FROM to_create;

-- Шаг 4. Снять фантом-ингредиент родителя-контейнера: у продукта с вариациями
-- backing-ингредиент не нужен. Удаляем ТОЛЬКО безопасный фантом — пустой (qty 0)
-- и без единого движения (иначе там была приёмка/начальный остаток — оставляем).
WITH phantom AS (
  SELECT tl.id AS line_id, i.id AS ing_id
  FROM menu_items p
  JOIN tech_card_lines tl ON tl.menu_item_id = p.id AND tl.ingredient_id IS NOT NULL
  JOIN ingredients i ON i.id = tl.ingredient_id
  WHERE p.is_purchased = true
    AND EXISTS (
      SELECT 1 FROM menu_items v WHERE v.parent_id = p.id AND v.is_deleted = false
    )
    AND i.qty = 0
    -- stock_movements.ingredient_id — text, ingredients.id — uuid: явный каст.
    AND NOT EXISTS (SELECT 1 FROM stock_movements sm WHERE sm.ingredient_id = i.id::text)
),
del_lines AS (
  DELETE FROM tech_card_lines WHERE id IN (SELECT line_id FROM phantom)
)
DELETE FROM ingredients WHERE id IN (SELECT ing_id FROM phantom);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
-- Разовый бэкофилл данных — откат не восстанавливает удалённые фантом-ингредиенты
-- и не удаляет заведённые складские SKU вариаций (это уже рабочие остатки).
-- No-op: данные назад не отменяем.
SELECT 1;
-- +goose StatementEnd
