-- +goose Up
-- +goose StatementBegin
--
-- 043_allocate_supplier_payments — раскладывает УЖЕ СДЕЛАННЫЕ оплаты долга по
-- накладным, чтобы stock_receipts.debt_amount означал ОСТАТОК долга, а не
-- начисленный когда-то.
--
-- Что было сломано: PayDebt уменьшал только suppliers.current_debt, а
-- debt_amount накладной оставался прежним навсегда. Единственными писателями
-- debt_amount были создание накладной и ConfirmReceipt. Из-за этого:
--   * экран «Накладные» завышал «Задолженность» (Σ debt_amount) на всю сумму
--     когда-либо сделанных оплат;
--   * карточка поставщика показывала рядом два разных долга: «Наш долг»
--     (current_debt, верный) и «Долг» по истории закупок (Σ debt_amount);
--   * погашенная кредитная накладная вечно висела должником;
--   * RecomputeDebts сверял оплаты по counterparty = ИМЕНИ поставщика —
--     переименование поставщика воскрешало весь его долг.
--
-- Раскладка FIFO: оплаты гасят накладные от старых к новым. Сумма долга
-- ПОСТАВЩИКА при этом не меняется — меняется только её распределение по
-- накладным. Проверка: старая формула Σ(debt) − Σ(оплат) и новая Σ(debt после
-- раскладки) дают одно и то же число. Поэтому ни одна цифра, которую видел
-- владелец на уровне поставщика, не съедет; починятся только те экраны, что
-- читали debt_amount как остаток.
--
-- applied для накладной = clamp(total_paid − долг_всех_предыдущих, 0, debt_amount).
-- Накладные без supplier_id не трогаем: их долг никому не начислен (CreateReceipt
-- начисляет current_debt только при известном поставщике).
--
-- Не идемпотентно (повторный прогон списал бы оплаты второй раз) — рассчитано
-- на однократный запуск goose. По той же причине НЕ добавляется в selfheal.
--
WITH paid AS (
  SELECT s.id AS supplier_id,
         COALESCE((SELECT SUM(fo.amount) FROM financial_operations fo
                   WHERE fo.category = 'supplier_payment'
                     AND fo.counterparty = s.name
                     AND fo.restaurant_id::text = s.restaurant_id::text), 0) AS total_paid
  FROM suppliers s
),
ranked AS (
  SELECT sr.id, sr.supplier_id, sr.debt_amount,
         COALESCE(SUM(sr.debt_amount) OVER (
           PARTITION BY sr.supplier_id
           ORDER BY sr.created_at, sr.id
           ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS prior_debt
  FROM stock_receipts sr
  WHERE sr.supplier_id IS NOT NULL AND sr.debt_amount > 0
)
UPDATE stock_receipts sr
SET debt_amount = r.debt_amount - LEAST(r.debt_amount, GREATEST(0, p.total_paid - r.prior_debt)),
    updated_at = now()
FROM ranked r
JOIN paid p ON p.supplier_id::text = r.supplier_id::text
WHERE sr.id = r.id
  AND LEAST(r.debt_amount, GREATEST(0, p.total_paid - r.prior_debt)) > 0;

-- Приводим денормализованный current_debt к новому первоисточнику. Значение не
-- меняется (см. выше), но состояние становится согласованным явно.
UPDATE suppliers s SET
  current_debt = GREATEST(0, COALESCE((
    SELECT SUM(sr.debt_amount) FROM stock_receipts sr
    WHERE sr.supplier_id::text = s.id::text), 0)),
  updated_at = now();
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
-- Откатить раскладку нельзя: исходные debt_amount не сохранялись, а восстановить
-- их из оплат нельзя — оплаты не привязаны к накладным (в этом и была проблема).
-- Down пустой намеренно: схема не менялась, только данные, и они согласованы.
SELECT 1;
-- +goose StatementEnd
