-- +goose Up
-- +goose StatementBegin
--
-- 014_orders_discount_approval — backend-gate для скидок ≥10%.
--
-- Контекст (v2.0.90, БАГ #1): кассир мог провести произвольный размер скидки
-- через прямой API без участия менеджера. Backend теперь требует
-- approved_by (UUID менеджера/owner), либо отказывает 403
-- DISCOUNT_REQUIRES_APPROVAL.
--
-- Колонка discount_approved_by уже существует с миграции 001 (ALTER ниже —
-- идемпотентная защита, безопасно для свежих установок).
--
-- Дополнительно: индекс для аудита/отчётов «кто одобрял скидки за период».

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS discount_approved_by TEXT;

CREATE INDEX IF NOT EXISTS idx_orders_discount_approved_by
  ON orders (restaurant_id, discount_approved_by)
  WHERE discount_approved_by IS NOT NULL;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin

DROP INDEX IF EXISTS idx_orders_discount_approved_by;
-- discount_approved_by сам по себе остаётся (создан в 001).

-- +goose StatementEnd
