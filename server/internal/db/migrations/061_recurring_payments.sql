-- +goose Up
-- +goose StatementBegin
--
-- 061_recurring_payments — регулярные (повторяющиеся) платежи.
--
-- Модуль «Платежи»: шаблоны обязательств, которые повторяются каждый месяц —
-- аренда, коммуналка, интернет, оклады. Раньше их не было в модели: каждый
-- месяц кассир вручную заводил операцию в ДДС. Теперь задаётся один раз с днём
-- оплаты, а система напоминает («к оплате») и проводит платёж одной кнопкой.
--
-- Это НЕ авто-списание: шаблон лишь напоминает и подставляет сумму/счёт. Деньги
-- уходят только когда человек нажал «Оплатить» (аренда могла быть ещё не
-- заплачена, коммуналка меняется от месяца к месяцу — сумма правится при оплате).
--
-- next_due — следующая дата платежа (денормализована для дешёвого списка «к
-- оплате» и виджета дашборда). Двигается вперёд на месяц при каждой оплате.
CREATE TABLE IF NOT EXISTS recurring_payments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL,
  name          text NOT NULL,
  category      text,
  amount        numeric(14,4) NOT NULL DEFAULT 0,
  account_id    uuid,
  activity      text NOT NULL DEFAULT 'operational',
  counterparty  text,
  day_of_month  int NOT NULL DEFAULT 1 CHECK (day_of_month BETWEEN 1 AND 31),
  -- next_due — text «YYYY-MM-DD», как financial_operations.date (не postgres
  -- date: тот round-trip'ится через GORM в timestamp-строку и ломает парсинг).
  next_due      text,
  last_paid_at  timestamptz,
  active        boolean NOT NULL DEFAULT true,
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_recurring_payments_tenant ON recurring_payments(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_recurring_payments_due ON recurring_payments(restaurant_id, active, next_due);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS recurring_payments;
-- +goose StatementEnd
