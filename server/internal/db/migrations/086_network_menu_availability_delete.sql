-- +goose Up
-- +goose StatementBegin
--
-- 086_network_menu_availability_delete — два прицельных фикса Фазы М/ADR-004,
-- найденных владельцем сразу после первого боевого импорта меню сети:
--
-- 1. available — стартовая доступность мастера. Раньше applyNetworkMenu на
--    филиале ХАРДКОДИЛ available=true для КАЖДОГО впервые материализуемого
--    блюда, игнорируя стоп-статус центра. Итог живьём: 36 легаси/нулевых
--    позиций Макбургера были выключены на центре, но материализовались на
--    филиале включёнными и продавабельными. Значение отдаётся ОДИН РАЗ, при
--    первом создании локальной копии на филиале — дальше доступность,
--    как цена и emoji, целиком локальная, каждый филиал переключает сам.
--
-- 2. deleted_at — tombstone мастера (тот же приём, что nomenclature,
--    миграция 081). Владелец удалил блюдо сети с центра — блюдо осталось
--    жить на филиалах, потому что путь удаления мастера на приём не был
--    заведён вовсе (SoftDeleteItem трогал только локальную копию центра).
--    PullFor уже отдаёт ВСЕ строки account'а без фильтра — новую колонку
--    подхватит без единой правки запроса, как и было с номенклатурой.
--
ALTER TABLE network_menu_items
  ADD COLUMN IF NOT EXISTS available BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE network_menu_items
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_network_menu_items_live
  ON network_menu_items (account_id) WHERE deleted_at IS NULL;

-- Бэкфилл available из ФАКТИЧЕСКОГО состояния локальной копии центра —
-- иначе уже заведённые мастера (весь McBurger-импорт) остались бы со
-- значением по умолчанию true, и следующая доставка на филиал не исправила
-- бы уже неверно материализованные блюда сама: applyNetworkMenu трогает
-- available ТОЛЬКО при первом создании, повторный pull его не перезаписывает
-- (см. головной коммент выше и в sync_ingest.go).
UPDATE network_menu_items nmi
SET available = mi.is_available
FROM menu_items mi
JOIN restaurants r ON r.id::text = mi.restaurant_id
WHERE mi.master_id = nmi.id
  AND r.account_id = nmi.account_id
  AND r.kind = 'central_warehouse'
  AND mi.is_available IS NOT NULL;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP INDEX IF EXISTS idx_network_menu_items_live;
ALTER TABLE network_menu_items DROP COLUMN IF EXISTS deleted_at;
ALTER TABLE network_menu_items DROP COLUMN IF EXISTS available;
-- +goose StatementEnd
