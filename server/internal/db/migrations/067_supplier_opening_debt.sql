-- +goose Up
-- +goose StatementBegin
--
-- 067_supplier_opening_debt — ручной долг поставщику без накладной.
--
-- Клиент мог задолжать поставщику ДО перехода на нашу систему — реального
-- прихода товара под накладной в этой базе нет, вносить его как фиктивную
-- приёмку (с придуманной строкой/ингредиентом) значит портить остатки склада.
--
-- suppliers.current_debt денормализован и «самолечится» кнопкой «Пересчитать
-- долги» (RecomputeDebts) СТРОГО из SUM(stock_receipts.debt_amount) — долг,
-- вписанный напрямую в колонку, эта кнопка молча стёрла бы. Поэтому долг без
-- накладной — тоже строка stock_receipts (без строк товара, allocateDebtPayment
-- и RecomputeDebts трогать не нужно, они уже работают по debt_amount), только
-- помечена is_opening_debt — чтобы отличить от настоящей накладной в UI.
ALTER TABLE stock_receipts
  ADD COLUMN IF NOT EXISTS is_opening_debt BOOLEAN NOT NULL DEFAULT false;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE stock_receipts DROP COLUMN IF EXISTS is_opening_debt;
-- +goose StatementEnd
