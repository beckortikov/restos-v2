-- +goose Up
-- +goose StatementBegin
--
-- 090_recurring_payment_history_backfill — историю платежей (владелец:
-- «если нажать на платёж — должен показывать историю, сколько оплатил»)
-- строим по financial_operations.source_ref = "recurring_payment:"+id
-- (Pay теперь всегда его проставляет). Но платежи, сделанные ДО этого
-- изменения, никакого source_ref не имеют — без бэкфилла история для
-- давно существующих шаблонов была бы пустой, хотя платежи по ним были.
--
-- Матчим тем же приёмом, что и 082 (salary_period): по тегу в description
-- ("Платёж: <имя шаблона>" [+ " (частично)"], который Pay пишет с самого
-- начала) + restaurant_id + is_auto + пока ещё пустой source_ref. Разные
-- шаблоны с одинаковым именем в одном ресторане — редкий край, останется
-- недосвязанным (безопасно: просто не попадёт в историю, не привяжется по
-- ошибке к чужому шаблону, т.к. amount/date всё равно из description не
-- извлекаем — только сам факт совпадения имени).
-- restaurant_id: financial_operations.restaurant_id — text (001_init), но
-- recurring_payments.restaurant_id — uuid (061, откололось от общей
-- конвенции) — без явного каста "operator does not exist: text = uuid".
UPDATE financial_operations fo
SET source_ref = 'recurring_payment:' || rp.id
FROM recurring_payments rp
WHERE fo.restaurant_id = rp.restaurant_id::text
  AND fo.source_ref IS NULL
  AND fo.is_auto = true
  AND (
    fo.description = 'Платёж: ' || rp.name
    OR fo.description = 'Платёж: ' || rp.name || ' (частично)'
  );

-- last_paid_amount раньше не существовал — у шаблонов, которые уже платили
-- ДО этой миграции, last_paid_at есть, а суммы нет (список показывал бы
-- обманчивое «Последний платёж: 0,00 с.»). Берём сумму САМОЙ СВЕЖЕЙ из
-- только что связанных проводок — тот же платёж, что last_paid_at и
-- next_due уже отражают.
UPDATE recurring_payments rp
SET last_paid_amount = latest.amount
FROM (
  SELECT DISTINCT ON (fo.source_ref) fo.source_ref, fo.amount
  FROM financial_operations fo
  WHERE fo.source_ref LIKE 'recurring_payment:%'
  ORDER BY fo.source_ref, fo.date DESC, fo.created_at DESC
) latest
WHERE latest.source_ref = 'recurring_payment:' || rp.id
  AND rp.last_paid_amount IS NULL
  AND rp.last_paid_at IS NOT NULL;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
-- Бэкфилл необратим: разорвать связь можно, но незачем — пустое поле не
-- безопаснее заполненного, а различить «бэкфилленное» от «проставленного
-- Pay после апдейта» нечем. Down — no-op.
SELECT 1;
-- +goose StatementEnd
