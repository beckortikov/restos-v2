-- +goose Up
-- +goose StatementBegin
--
-- 013_finops_source_ref_unique — обеспечивает идемпотентность
-- авто-создаваемых финансовых операций по «привязке» к домен-сущности
-- (например приёмка склада, закрытие заказа).
--
-- Семантика source_ref:
--   "receipt:<uuid>"  — авто-расход на оплату приёмки.
--   "order:<uuid>"    — авто-приход на закрытие заказа (split-payment
--                      может породить несколько строк → не уникальны).
--   "refund:<uuid>"   — возврат денег.
--
-- Уникальность ограничена префиксом "receipt:" — это поток, который
-- мы делаем идемпотентным в v2.0.87 (атомарная приёмка). Для других
-- префиксов идемпотентность держится на Idempotency-Key middleware.

CREATE UNIQUE INDEX IF NOT EXISTS uq_finops_tenant_receipt_source_ref
  ON financial_operations (restaurant_id, source_ref)
  WHERE source_ref LIKE 'receipt:%';
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP INDEX IF EXISTS uq_finops_tenant_receipt_source_ref;
-- +goose StatementEnd
