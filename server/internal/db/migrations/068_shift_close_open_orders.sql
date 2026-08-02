-- +goose Up
-- +goose StatementBegin
--
-- 068_shift_close_open_orders — закрытие смены при незакрытых столах.
--
-- Раньше Close() блокировал закрытие НАГЛУХО, пока в ресторане есть хоть один
-- незакрытый заказ (не только этой смены — вообще). При двух сменах в один
-- день (066) это делает пересменку с открытыми столами невозможной: новый
-- кассир не может открыть смену, пока старая не закрыта, а старую нельзя
-- закрыть, пока висит хоть один стол. На практике смена просто не
-- закрывалась в момент пересменки — что не блокирует данные (order.shift_id
-- проставляется при оплате, а не при открытии заказа), но не даёт вести
-- раздельную кассовую отчётность по кассиру-смене.
--
-- closed_open_orders_count — сколько заказов были ещё открыты в момент
-- закрытия ЭТОЙ смены. 0 — обычное закрытие (как раньше). >0 — закрыли
-- осознанно (право shifts.close_with_open_orders + явное подтверждение с
-- фронта), для видимости в истории смен.
ALTER TABLE cash_shifts
  ADD COLUMN IF NOT EXISTS closed_open_orders_count INTEGER NOT NULL DEFAULT 0;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE cash_shifts DROP COLUMN IF EXISTS closed_open_orders_count;
-- +goose StatementEnd
