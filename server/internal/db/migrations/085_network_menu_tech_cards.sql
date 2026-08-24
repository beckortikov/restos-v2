-- +goose Up
-- +goose StatementBegin
--
-- 085_network_menu_tech_cards — техкарты мастер-блюда сети (продолжение 084).
--
-- Модель клиента: бухгалтер/технолог сидит в центре, техкарты заводятся там
-- и должны приезжать в филиалы — иначе на точках не работает ни списание
-- склада при продаже, ни фудкост.
--
-- tech_cards — JSON-снапшот техкарт продукта и его вариантов:
--
--   {"cards":{
--      "":     [ {"nom":"<nomenclature_id>","name":"Сыр","unit":"кг",
--                 "qty":"0.05","price":"120"},
--                {"semi":{"name":"Тесто","size":"30","output_unit":"кг",
--                         "yield":"100","recipe":[...]},"qty":"1","unit":"кг"} ],
--      "Мини": [ ... ]      -- ключ = comboLabelKey лейблов варианта
--   }}
--
-- Идентичность ингредиентов между узлами — ТОЛЬКО через nomenclature_id
-- (локальные id через сеть не ездят); филиал разрешает их тем же
-- ensureNomenclatureIngredient, что и приём перемещения. Полуфабрикаты
-- сопоставляются по (имя, размер); отсутствующие создаются вместе с рецептом.
--
-- NULL = «мастер техкартами не управляет» (у всех старых мастеров так) —
-- филиал свои техкарты ведёт сам, ничего не затирается.
ALTER TABLE network_menu_items
  ADD COLUMN IF NOT EXISTS tech_cards JSONB;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE network_menu_items DROP COLUMN IF EXISTS tech_cards;
-- +goose StatementEnd
