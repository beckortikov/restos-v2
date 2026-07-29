-- +goose Up
-- +goose StatementBegin
--
-- 042_stock_returns — возврат товара поставщику (порча/бой/просрочка).
--
-- Почему отдельный документ, а не списание: списание (stock_writeoffs) — наш
-- убыток, оно отдельной строкой бьёт по прибыли в ОПиУ (finance.go, out.Writeoffs).
-- Возврат — сторно закупки: товар уехал назад, деньги/долг вернулись, прибыль
-- не трогаем. Оформлять возврат списанием = фейковый убыток + деньги из ниоткуда.
--
-- Возврат всегда привязан к конкретной СТРОКЕ накладной (receipt_line_id):
--   * цена берётся из строки накладной, а не из средневзвешенной себестоимости
--     склада — поставщик отдаёт ровно то, что взял;
--   * одна и та же номенклатура может быть в накладной дважды по разным ценам —
--     привязка к строке снимает неоднозначность;
--   * даёт guard «нельзя вернуть больше, чем пришло» (Σ qty по строке);
--   * накладная знает поставщика и состояние оплаты → куда возвращать деньги.
-- Партионного учёта (FIFO) нет: товар на складе обезличен, накладную для
-- возврата выбирает кладовщик — он физически звонит этому поставщику.
--
-- refund_type — выбирается не на глаз, а по остатку долга поставщику:
--   debt  — долг есть: уменьшаем stock_receipts.debt_amount И
--           suppliers.current_debt. Обязательно обе: RecomputeDebts (admin.go)
--           пересчитывает current_debt как Σ receipts.debt_amount − Σ оплат,
--           тронешь только поставщика — первый же пересчёт воскресит долг.
--   money — долга нет: financial_accounts.balance += total и
--           financial_operation type=in, category=stock_purchase.
--           Категория именно stock_purchase, чтобы возврат схлопнулся с закупкой:
--           ОПиУ берёт выручку из orders, а opex фильтрует type='out' → ни
--           фейкового дохода, ни отрицательного расхода. ДДС покажет реальный приток.
-- Ветки взаимоисключающие по debtRoom = min(receipt.debt_amount,
-- supplier.current_debt): иначе money выдавал деньги за неоплаченный товар,
-- оставляя долг висеть. Идемпотентность — на Idempotency-Key middleware
-- (uq_finops_tenant_receipt_source_ref частичный, только для 'receipt:%').
--
-- Склад уменьшается ТОЛЬКО через stock_movements (type='return_supplier',
-- qty < 0) — колонка type это голый TEXT без CHECK, новый тип не требует правок.
--
CREATE TABLE IF NOT EXISTS stock_returns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id UUID NOT NULL,
  supplier_id TEXT,
  supplier_name TEXT,
  date TEXT,
  reason TEXT NOT NULL DEFAULT 'spoilage',
  note TEXT,
  total_amount NUMERIC(14,4) NOT NULL DEFAULT 0,
  refund_type TEXT NOT NULL DEFAULT 'debt',
  account_id TEXT,
  created_by TEXT,
  restaurant_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT stock_returns_reason_chk
    CHECK (reason IN ('spoilage', 'breakage', 'expired', 'other')),
  CONSTRAINT stock_returns_refund_type_chk
    CHECK (refund_type IN ('debt', 'money'))
);

CREATE TABLE IF NOT EXISTS stock_return_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id UUID NOT NULL,
  receipt_line_id UUID NOT NULL,
  ingredient_id TEXT,
  name TEXT,
  qty NUMERIC(14,4) NOT NULL DEFAULT 0,
  unit TEXT,
  price_per_unit NUMERIC(14,4) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Листинг возвратов (keyset-курсор по created_at, id — как у stock_receipts).
CREATE INDEX IF NOT EXISTS idx_stock_returns_restaurant
  ON stock_returns (restaurant_id, created_at DESC, id DESC);
-- «Что уже вернули по этой накладной» — для UI и для guard'а.
CREATE INDEX IF NOT EXISTS idx_stock_returns_receipt ON stock_returns (receipt_id);
CREATE INDEX IF NOT EXISTS idx_stock_returns_supplier ON stock_returns (supplier_id);
CREATE INDEX IF NOT EXISTS idx_stock_return_lines_return ON stock_return_lines (return_id);
-- Горячий путь guard'а Σ(qty) ≤ receipt_line.qty на каждой строке возврата.
CREATE INDEX IF NOT EXISTS idx_stock_return_lines_receipt_line
  ON stock_return_lines (receipt_line_id);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS stock_return_lines;
DROP TABLE IF EXISTS stock_returns;
-- +goose StatementEnd
