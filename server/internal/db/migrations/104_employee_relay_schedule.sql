-- +goose Up
-- +goose StatementBegin
--
-- 104_employee_relay_schedule — центр ставит график смен филиалам.
--
-- График (102) заводился как локальная сущность филиала, но составляет его
-- владелец сети: он же держит в голове, кто на какой точке работает, и он же
-- отвечает за то, чтобы смены закрывали всю неделю. Ходить для этого на кассу
-- каждого филиала — ровно та боль, ради которой в 097 появился relay для
-- найма и оплаты.
--
-- Расширяем ту же очередь ещё двумя kind'ами вместо новой таблицы: жизненный
-- цикл (pending→delivered/failed), адресация (target_restaurant_id) и
-- идемпотентность (employee_relay_received) у них общие.
--
--   set_schedule     — недельный шаблон целиком (PUT-семантика, как локальный
--                      SetTemplate: снятые дни исчезают);
--   set_schedule_day — правка одной даты: подмена, отгул, либо возврат к
--                      шаблону (в payload action='reset').
--
-- Два kind'а, а не один с флагом: у них разные payload'ы (набор слотов против
-- одной даты) и разные локальные методы — та же причина, по которой 097
-- развёл set_worked_days и toggle_day_multiplier.
--
ALTER TABLE employee_relay_actions DROP CONSTRAINT IF EXISTS employee_relay_actions_kind_check;
ALTER TABLE employee_relay_actions ADD CONSTRAINT employee_relay_actions_kind_check
  CHECK (kind IN (
    'create', 'update_identity', 'update_pay',
    'set_worked_days', 'toggle_day_multiplier',
    'set_schedule', 'set_schedule_day'
  ));
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE employee_relay_actions DROP CONSTRAINT IF EXISTS employee_relay_actions_kind_check;
ALTER TABLE employee_relay_actions ADD CONSTRAINT employee_relay_actions_kind_check
  CHECK (kind IN (
    'create', 'update_identity', 'update_pay',
    'set_worked_days', 'toggle_day_multiplier'
  ));
-- +goose StatementEnd
