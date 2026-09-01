-- +goose Up
-- +goose StatementBegin
--
-- 105_late_fine_policy — штрафы за опоздания.
--
-- Перекличка (102) уже показывает, кто опоздал и на сколько, но на деньги это
-- никак не влияло: владелец видел «опоздал на 32 минуты» и дальше считал
-- удержание в уме, а потом руками заводил его в ЗП. Здесь система считает
-- сумму по заданному правилу.
--
-- Штраф НЕ списывается автоматически. Система предлагает — человек
-- подтверждает. Это деньги сотрудника, а данные, на которых строится расчёт,
-- бывают неточными: сбитое время планшета, забытый вчера уход, подмена без
-- записи в графике. Молча удержанная сумма превращается в спор задним числом,
-- который нечем закрыть.
--
--   late_grace_minutes   — сколько минут опоздания не считаются опозданием.
--                          Ноль был бы бессмысленно строгим: приход в 09:00:40
--                          при плане 09:00 опозданием не является. 5 минут —
--                          прежняя константа из кода, теперь настройка.
--   late_fine_fixed      — фиксированная часть штрафа (за сам факт).
--   late_fine_per_minute — за каждую минуту сверх грейса.
--   late_fine_max        — потолок; 0 = без потолка. Нужен именно потому, что
--                          поминутная часть на «опоздал на 4 часа» иначе
--                          съедает дневной заработок целиком.
--
-- Обе части, а не одна: где-то принято «100 сомони за опоздание», где-то
-- «по 2 за минуту», и навязывать одну модель значило бы заставить половину
-- клиентов считать вручную.
--
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS late_grace_minutes   INTEGER       NOT NULL DEFAULT 5;
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS late_fine_fixed      NUMERIC(14,4) NOT NULL DEFAULT 0;
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS late_fine_per_minute NUMERIC(14,4) NOT NULL DEFAULT 0;
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS late_fine_max        NUMERIC(14,4) NOT NULL DEFAULT 0;

-- source_ref у удержания — маркер «откуда оно взялось», как у
-- financial_operations (013). Для штрафа это 'late:<user_id>:<дата>', и
-- уникальный индекс делает повторный штраф за тот же день невозможным на
-- уровне БД: два менеджера, открывшие перекличку одновременно, иначе
-- удержали бы дважды.
--
-- Индекс частичный: отменённое удержание (cancelled_at) освобождает ключ —
-- ошибочно снятый штраф должно быть можно выставить заново.
ALTER TABLE salary_deductions ADD COLUMN IF NOT EXISTS source_ref TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_salary_deductions_source_ref
  ON salary_deductions (restaurant_id, source_ref)
  WHERE source_ref IS NOT NULL AND cancelled_at IS NULL;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP INDEX IF EXISTS uq_salary_deductions_source_ref;
ALTER TABLE salary_deductions DROP COLUMN IF EXISTS source_ref;
ALTER TABLE restaurants DROP COLUMN IF EXISTS late_fine_max;
ALTER TABLE restaurants DROP COLUMN IF EXISTS late_fine_per_minute;
ALTER TABLE restaurants DROP COLUMN IF EXISTS late_fine_fixed;
ALTER TABLE restaurants DROP COLUMN IF EXISTS late_grace_minutes;
-- +goose StatementEnd
