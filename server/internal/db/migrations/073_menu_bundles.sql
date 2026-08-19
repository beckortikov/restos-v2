-- +goose Up
-- +goose StatementBegin
--
-- 073_menu_bundles — фастфуд-сеты («Комбо №1» = Бургер + Картошка + Напиток).
--
-- Названо "bundle", не "combo" — слово "комбо" уже занято декартовым
-- произведением атрибутов (Размер×Вкус, см. menu_variants.go/ComboPricesEditor).
--
-- menu_items.is_bundle — помечает пункт меню как сет (взаимоисключающе с
-- is_purchased/is_batch_cooking на уровне UI, как и они между собой).
--
-- bundle_slots — слот сета («Бургер»/«Гарнир»/«Напиток»), min/max_select —
-- сколько опций слота выбирается (обычно 1..1, но допускает "выбери 2 из 3").
--
-- bundle_slot_options — вариант внутри слота. option_menu_item_id ссылается на
-- НАСТОЯЩИЙ пункт меню (не текстовое имя, как у Modifier) — у выбора есть своя
-- техкарта/станция/сток автоматически, без специальной обработки нигде в
-- системе (кухня/КДС/списание работают per-item, как обычно).
--
-- price — цена ЭТОГО варианта ВНУТРИ сета (не скидка на весь заказ). Компонент
-- сета создаётся как order_item с этой ценой через уже существующий
-- CreateOrderItem.Price override (используется сегодня для comp/custom price).
-- Сумма цен выбранных опций по слотам = цена сета — отдельного поля "цена
-- сета" нет: оно того не стоит, цена и так следует из компонентов.
--
-- order_items.bundle_group_id — общий ключ у всех order_items одного добавления
-- сета в заказ (для группировки в корзине/чеке и каскадной отмены/возврата).
-- bundle_slot_label — денормализация подписи слота ("Бургер") для печати чека
-- без JOIN на bundle_slots (которых к моменту заказа может уже не быть, если
-- сет отредактировали/удалили после продажи — история заказа не должна ломаться).
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS is_bundle BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS bundle_slots (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id       TEXT,
  bundle_menu_item_id UUID NOT NULL,
  label               TEXT NOT NULL,
  is_required         BOOLEAN NOT NULL DEFAULT true,
  min_select          INT NOT NULL DEFAULT 1,
  max_select          INT NOT NULL DEFAULT 1,
  sort_order          INT NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bundle_slots_restaurant ON bundle_slots (restaurant_id);
CREATE INDEX IF NOT EXISTS idx_bundle_slots_bundle_item ON bundle_slots (bundle_menu_item_id);

CREATE TABLE IF NOT EXISTS bundle_slot_options (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slot_id             UUID NOT NULL,
  option_menu_item_id UUID NOT NULL,
  price               NUMERIC(14,4) NOT NULL DEFAULT 0,
  is_default          BOOLEAN NOT NULL DEFAULT false,
  sort_order          INT NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bundle_slot_options_slot ON bundle_slot_options (slot_id);
CREATE INDEX IF NOT EXISTS idx_bundle_slot_options_item ON bundle_slot_options (option_menu_item_id);

ALTER TABLE order_items ADD COLUMN IF NOT EXISTS bundle_group_id UUID;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS bundle_slot_label TEXT;
CREATE INDEX IF NOT EXISTS idx_order_items_bundle_group ON order_items (bundle_group_id);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE order_items DROP COLUMN IF EXISTS bundle_group_id;
ALTER TABLE order_items DROP COLUMN IF EXISTS bundle_slot_label;
DROP TABLE IF EXISTS bundle_slot_options;
DROP TABLE IF EXISTS bundle_slots;
ALTER TABLE menu_items DROP COLUMN IF EXISTS is_bundle;
-- +goose StatementEnd
