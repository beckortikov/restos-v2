-- +goose Up
-- +goose StatementBegin
--
-- 096_orders_reopened_at — явный признак «этот закрытый заказ сейчас
-- переоткрыт для правки» (владелец 2026-08-29: «дать доступ редактирование
-- закрытых заказов, если один товар захотят заменить по просьбе клиента»).
--
-- NULL — обычный заказ (никогда не переоткрывался, либо переоткрытие уже
-- завершилось повторным закрытием — Close() сбрасывает поле). Непустое —
-- заказ сейчас в состоянии "открыт после close", used двумя местами:
--   1. returnStockForVoidedItem (orders_close.go) — возврат склада при
--      void/cancel позиции включается ТОЛЬКО когда заказ был переоткрыт,
--      обычная живая отмена (до первой оплаты) стока не трогает;
--   2. UI payment-панели — баннер «ранее оплачено X, доплата/возврат Y»
--      вместо полной новой суммы к оплате.
--
ALTER TABLE orders ADD COLUMN IF NOT EXISTS reopened_at TIMESTAMPTZ NULL;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE orders DROP COLUMN IF EXISTS reopened_at;
-- +goose StatementEnd
