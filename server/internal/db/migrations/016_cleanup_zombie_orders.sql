-- +goose Up
-- +goose StatementBegin
--
-- 016_cleanup_zombie_orders — одноразовая чистка zombie-заказов.
--
-- Контекст (v2.1.2): до v2.1.1 при void последней позиции заказ оставался
-- в статусе new/open/cooking/... с пустыми items. Waiter PWA «Мои заказы»
-- показывал такие заказы как «0 позиций», стол висел «Занят».
--
-- v2.1.1 добавил invariant в VoidItem/CancelItem (см. orders_void.go:239
-- и orders_extras.go) — последний void авто-cancel'ит order и освобождает
-- table. Но старые zombies в БД остались. Эта миграция чистит их:
--
--   1. orders, у которых status ∈ {new,open,cooking,ready,served,
--      bill_requested} и НЕТ ни одной живой позиции — переводим в
--      status='cancelled' с reason='Legacy cleanup (все позиции отменены)'.
--   2. tables, к которым были привязаны эти zombies и где не осталось
--      других активных заказов — освобождаем (status='free', current_order_id=NULL,
--      opened_at=NULL).
--
-- Идемпотентность: повторный прогон ничего не находит (условие NOT EXISTS
-- + статус ∈ active отсеют уже cancelled-ные).
--

WITH zombies AS (
  SELECT o.id AS order_id, o.table_id, o.restaurant_id
  FROM orders o
  WHERE o.status IN ('new','open','cooking','ready','served','bill_requested')
    AND NOT EXISTS (
      SELECT 1 FROM order_items oi
      WHERE oi.order_id = o.id AND oi.cancelled_at IS NULL
    )
)
UPDATE orders o
SET status           = 'cancelled',
    cancelled_at     = NOW(),
    cancel_reason    = 'Legacy cleanup (все позиции отменены)',
    cancelled_total  = 0,
    updated_at       = NOW()
FROM zombies z
WHERE o.id = z.order_id;

-- Освобождаем столы, на которых не осталось других активных заказов.
-- Берём table_id из только что cancelled-ных «по legacy-reason» orders
-- за последнюю минуту (то есть наших).
WITH freed_tables AS (
  SELECT DISTINCT z.table_id, z.restaurant_id
  FROM (
    SELECT o.table_id, o.restaurant_id
    FROM orders o
    WHERE o.status = 'cancelled'
      AND o.cancel_reason = 'Legacy cleanup (все позиции отменены)'
      AND o.cancelled_at >= NOW() - INTERVAL '1 minute'
      AND o.table_id IS NOT NULL
  ) z
  WHERE NOT EXISTS (
    SELECT 1 FROM orders o2
    WHERE o2.table_id = z.table_id
      AND o2.restaurant_id IS NOT DISTINCT FROM z.restaurant_id
      AND o2.status IN ('new','open','cooking','ready','served','bill_requested')
  )
)
UPDATE tables t
SET status            = 'free',
    current_order_id  = NULL,
    opened_at         = NULL,
    updated_at        = NOW()
FROM freed_tables f
WHERE t.id::text = f.table_id
  AND t.restaurant_id IS NOT DISTINCT FROM f.restaurant_id;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin

-- Down не имеет смысла: мы не можем восстановить прежний статус
-- (он был logically incorrect). No-op.
SELECT 1;

-- +goose StatementEnd
