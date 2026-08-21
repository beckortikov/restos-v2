-- +goose Up
-- +goose StatementBegin
--
-- 078_sync_log_quarantine — карантин «ядовитых» строк очереди синка + ротация
-- (ADR-003, Фаза О «оффлайн-устойчивость»).
--
-- Проблема (найдена разбором кода, до инцидента): ingest на central применяет
-- батч ПОСЛЕДОВАТЕЛЬНО и на первой же ошибке возвращает 500 на весь батч.
-- Пушер филиала при ошибке не двигается дальше — на следующем тике собирает
-- ТОТ ЖЕ батч (те же 200 старейших неотправленных строк) и падает снова.
-- Одна битая строка (payload от новой версии, которую старый central не умеет
-- разобрать; повреждённый JSON; баг в apply) останавливает синхронизацию
-- филиала НАВСЕГДА и молча — никакого счётчика, порога или сигнала не было.
--
-- attempts   — сколько раз строка уезжала в неудачном батче;
-- failed_at  — карантин: строка исключена из выборки пушера, очередь идёт
--              дальше без неё (данные не теряются — строка остаётся в журнале
--              с last_error, её видно и можно разобрать/переотправить руками);
-- last_error — текст ответа central, чтобы причина не терялась.
--
-- Ротация: журнал append-only и НИКОГДА не чистился (ни одного DELETE в коде)
-- — на кассе с многолетней историей он растёт бесконечно. Индекс ниже
-- покрывает обе новые выборки: «что отправлять» и «что чистить».
ALTER TABLE sync_log
  ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS failed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_error TEXT;

-- Выборка пушера теперь исключает и отправленные, и карантинные. Старый
-- частичный индекс (WHERE synced_at IS NULL) этому условию уже не
-- соответствует — заводим точный и убираем прежний.
CREATE INDEX IF NOT EXISTS idx_sync_log_pending
  ON sync_log(created_at) WHERE synced_at IS NULL AND failed_at IS NULL;
DROP INDEX IF EXISTS idx_sync_log_unsynced;

-- Ротация чистит отправленное по дате — отдельный индекс не нужен: DELETE
-- по synced_at < X идёт раз в сутки и переживёт seq scan, а лишний индекс
-- удорожал бы каждую вставку в горячий журнал.
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
CREATE INDEX IF NOT EXISTS idx_sync_log_unsynced
  ON sync_log(created_at) WHERE synced_at IS NULL;
DROP INDEX IF EXISTS idx_sync_log_pending;
ALTER TABLE sync_log
  DROP COLUMN IF EXISTS last_error,
  DROP COLUMN IF EXISTS failed_at,
  DROP COLUMN IF EXISTS attempts;
-- +goose StatementEnd
