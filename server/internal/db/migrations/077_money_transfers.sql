-- +goose Up
-- +goose StatementBegin
--
-- 077_money_transfers — переводы ДЕНЕГ между узлами сети (ADR-003, Фаза Д).
--
-- Зачем: инкассация филиал→central и переброска денег между филиалами. До сих
-- пор FinancialAccountsService.Transfer умел двигать деньги только между
-- счетами ОДНОГО ресторана (жёсткий WHERE restaurant_id = ?) — межузловой
-- операции не существовало вовсе.
--
-- Модель — зеркало stock_transfers (та же двухфазность, тот же жизненный цикл):
--   отправитель: баланс своего счёта −amount + финопа out, status=sent
--   получатель:  выбирает СВОЙ счёт, баланс +amount + финопа in, status=received
--
-- Деньги «в пути» (sent, ещё не принято) не лежат ни на одном счёте — ровно
-- как товар в пути у stock_transfers. Это осознанно: документ виден в списке
-- обеих сторон со статусом «отправлено», расхождение самоочевидно.
--
-- Обе финопы получают activity='financial' — та же зарезервированная
-- активность, что у внутренних переводов между счетами (см. applyOpexFilter):
-- перевод НЕ расход и НЕ доход, в ОПиУ он не попадает ни на одной стороне.
-- В ДДС попадает (деньги реально ушли/пришли), в сетевом ДДС суммарно даёт
-- ноль — деньги остались внутри сети.
--
-- from_account_name — ДЕНОРМАЛИЗАЦИЯ, обязательная: у получателя своя БД со
-- своими UUID, счетов отправителя он не знает в принципе (та же причина, по
-- которой в stock_transfer_lines лежит ingredient_name).
--
-- 'cancelled' в CHECK заложен на будущее, но отмена НЕ реализована осознанно:
-- отправитель и получатель — РАЗНЫЕ БД, и «отмена» на одной стороне гонится с
-- «приёмом» на другой (деньги возникли бы из воздуха). Отмена межузлового
-- перевода потребует арбитража на central — отдельная задача, не эта.
--
-- Хард-FK не ставим (стиль проекта).
CREATE TABLE IF NOT EXISTS money_transfers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID,
  from_restaurant_id UUID,
  to_restaurant_id UUID,
  transfer_number INTEGER,
  amount NUMERIC(14,4) NOT NULL CHECK (amount > 0),
  status TEXT NOT NULL DEFAULT 'sent'
    CHECK (status IN ('sent', 'received', 'cancelled')),
  note TEXT,
  from_account_id UUID,
  from_account_name TEXT,
  to_account_id UUID,
  sent_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ,
  created_by TEXT,
  received_by TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_money_transfers_account ON money_transfers(account_id);
CREATE INDEX IF NOT EXISTS idx_money_transfers_from ON money_transfers(from_restaurant_id);
CREATE INDEX IF NOT EXISTS idx_money_transfers_to ON money_transfers(to_restaurant_id);
-- Частичный индекс под самый горячий запрос down-sync: PullFor на КАЖДОМ тике
-- (раз в 20-30с с каждого филиала) ищет входящие в статусе sent.
CREATE INDEX IF NOT EXISTS idx_money_transfers_to_pending
  ON money_transfers(to_restaurant_id) WHERE status = 'sent';
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP INDEX IF EXISTS idx_money_transfers_to_pending;
DROP INDEX IF EXISTS idx_money_transfers_to;
DROP INDEX IF EXISTS idx_money_transfers_from;
DROP INDEX IF EXISTS idx_money_transfers_account;
DROP TABLE IF EXISTS money_transfers;
-- +goose StatementEnd
