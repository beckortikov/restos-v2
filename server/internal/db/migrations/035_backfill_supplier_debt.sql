-- +goose Up
-- +goose StatementBegin
--
-- 035_backfill_supplier_debt — разовый пересчёт suppliers.current_debt из
-- исторических накладных.
--
-- Учёт долга поставщикам (stock_write.go: кредитная/частичная приёмка →
-- suppliers.current_debt += debt_amount) добавлен в v3.16.42. Накладные,
-- проведённые ДО этого коммита, долг не начисляли: suppliers.current_debt
-- остался 0, хотя stock_receipts.debt_amount > 0 (в UI «Поставщики» показывало
-- «Всё оплачено», расходясь с «Накладными»).
--
-- Здесь один раз выставляем current_debt = Σ debt_amount по всем накладным
-- поставщика (в разрезе ресторана). Дальше поле поддерживается инкрементально:
-- приёмка (+debt_amount) и pay-debt (-pay). Значение авторитетно на момент
-- миграции: перезапись (=), а не инкремент, поэтому уже начисленный после фикса
-- долг не задваивается.
-- Типы id/ссылок в разных инсталляциях «поплыли» (uuid vs text — GORM
-- auto-migrate + ручные правки за много версий). Без каста Postgres падает
-- «operator does not exist: text = uuid», миграция не применяется, и (до фикса
-- wipe-fallback в main.go) это приводило к УНИЧТОЖЕНИЮ базы. Поэтому кастуем
-- ОБЕ стороны каждого сравнения к text — сравнение text=text работает при любой
-- комбинации исходных типов.
UPDATE suppliers s SET
  current_debt = COALESCE((
    SELECT SUM(sr.debt_amount)
    FROM stock_receipts sr
    WHERE sr.supplier_id::text = s.id::text
      AND sr.restaurant_id::text = s.restaurant_id::text
  ), 0),
  updated_at = now();
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
-- Бэкфилл необратим: после него исторический долг неотличим от начисленного
-- инкрементально, поэтому Down — no-op (обнулять current_debt небезопасно —
-- затрёт актуальные долги). Для повторного пересчёта применить Up заново.
SELECT 1;
-- +goose StatementEnd
