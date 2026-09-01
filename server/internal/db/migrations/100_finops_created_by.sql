-- +goose Up
-- +goose StatementBegin
--
-- 100_finops_created_by — авторство финансовой операции (владелец 2026-08-31:
-- «раздел расходы по статьям надо улучшить, чтобы рассмотреть каждый расход
-- когда сделан КЕМ и какие дни»). До этой миграции «кто провёл расход» в
-- financial_operations не хранилось вообще: единственным «кто» был
-- cancelled_by (071) — то есть кто ОТМЕНИЛ, но не кто создал.
--
-- TEXT (не uuid) — как у cash_shift_operations.created_by и
-- money_transfers.created_by: единый стиль уже существующих колонок авторства.
--
ALTER TABLE financial_operations ADD COLUMN IF NOT EXISTS created_by TEXT;

-- Бэкфилл истории из audit_log: GORM-хук (internal/audit/hooks.go) и так
-- пишет create-запись с user_id на каждый INSERT этой таблицы
-- (financial_operations нет в skipTables), поэтому автор большинства уже
-- проведённых операций восстановим без потерь.
--
-- Best-effort: у строк, приехавших репликацией с филиала (SkipHooks — аудит
-- пропускается) и у совсем старых, записанных до появления хука, автор
-- останется NULL — UI покажет «—». Это честнее, чем угадывать.
UPDATE financial_operations fo
   SET created_by = al.user_id
  FROM audit_log al
 WHERE al.entity_type = 'financial_operation'
   AND al.action = 'create'
   -- ::text обязателен: financial_operations.id — uuid, audit_log.entity_id —
   -- text (хук пишет его рефлексией как строку). Без каста Postgres валит
   -- миграцию «operator does not exist: text = uuid».
   AND al.entity_id = fo.id::text
   AND fo.created_by IS NULL
   AND al.user_id IS NOT NULL
   AND al.user_id <> '';
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE financial_operations DROP COLUMN IF EXISTS created_by;
-- +goose StatementEnd
