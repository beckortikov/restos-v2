-- +goose Up
-- +goose StatementBegin
--
-- 084_network_menu_attributes — вариации у мастер-блюда сети (ADR-004,
-- продолжение). До этого мастер нёс только плоские поля (name/category/
-- station/base_price), и продукт с вариациями (пицца с размерами) в сеть
-- попасть не мог вовсе: тумблер «Блюдо сети» в карточке был заблокирован
-- для продуктов с атрибутами, а материализация на филиале создала бы
-- плоское блюдо без размеров.
--
-- attributes — JSON-снапшот атрибутов мастера, форма повторяет
-- SyncAttributesInput (см. menu_variants.go), но без каких-либо id —
-- id атрибутов/значений/шкал локальны для каждого узла:
--
--   {"attributes":[{"name":"Размер","scale":true,"values":["Мини","M","L"]}],
--    "combos":[{"labels":["Мини"],"price":"25"}, ...]}
--
-- scale:true — применяющая сторона find-or-create'ит СВОЮ шкалу размеров
-- с именем атрибута и связывает (size_scale_id); так техкарты вариантов
-- на каждом узле могут цеплять заготовки нужного размера («Тесто-30»).
--
-- NULL = обычное блюдо без вариаций.
ALTER TABLE network_menu_items
  ADD COLUMN IF NOT EXISTS attributes JSONB;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE network_menu_items DROP COLUMN IF EXISTS attributes;
-- +goose StatementEnd
