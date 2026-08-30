-- +goose Up
-- +goose StatementBegin
--
-- 097_employee_relay_actions — центральное управление персоналом сети
-- (владелец 2026-08-30: «с центрального нужно дать возможность создать
-- сотрудников филиалам тоже, а также полное управление сотрудниками с
-- центра»). Учётка сотрудника обязана физически существовать в БД ЕГО
-- филиала (иначе он не сможет залогиниться по PIN на своей кассе) — central
-- не может писать в чужой Postgres напрямую. Узкая очередь-транспорт по
-- образцу delivery_relay_orders (091): central кладёт pending-запись, филиал
-- забирает своим пулером и вызывает СВОИ, настоящие UsersService.Create/
-- Patch/SalaryService.SetWorkedDays/ToggleDayMultiplier под синтетическим
-- актором — т.е. реально создаёт/правит сотрудника у себя, как будто это
-- сделал местный владелец.
--
-- kind — 5 вариантов, а не 4: WorkedDaysDialog на фронте дёргает ДВА разных
-- бэкенд-метода (SetWorkedDays — массовая отметка доп.смен, ToggleDayMultiplier
-- — точечный ×2 на один день), это разные операции, не общий payload с
-- разными полями.
--
-- Одна таблица на все kind'ы (не пять) — тот же приём, что уже даёт
-- delivery_relay_orders для create/amend: одинаковый жизненный цикл
-- (pending→delivered/failed), одинаковая адресация (target_restaurant_id),
-- одинаковая идемпотентность (employee_relay_received).
--
-- target_user_id: users.id СОВПАДАЕТ на central и филиале (в отличие от
-- menu_item_id у delivery-relay — там central/филиал генерируют свои id
-- независимо) — central уже видит его в СВОЕЙ реплике users (up-sync),
-- поэтому трансляция id (как master_id у delivery-relay) не нужна.
--
CREATE TABLE IF NOT EXISTS employee_relay_actions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id           UUID NOT NULL,
  restaurant_id        UUID NOT NULL,        -- central (кто поставил в очередь)
  target_restaurant_id UUID NOT NULL,        -- филиал-цель
  target_user_id       UUID,                 -- NULL только для kind=create
  kind                 TEXT NOT NULL,
  payload              JSONB NOT NULL,
  status               TEXT NOT NULL DEFAULT 'pending',
  local_user_id        UUID,                 -- филиал проставляет по ack
  error                TEXT,
  created_by_user_id   UUID,
  created_by_name      TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at         TIMESTAMPTZ,
  CONSTRAINT employee_relay_actions_kind_check CHECK (kind IN
    ('create', 'update_identity', 'update_pay', 'set_worked_days', 'toggle_day_multiplier')),
  CONSTRAINT employee_relay_actions_status_check CHECK (status IN ('pending', 'delivered', 'failed')),
  CONSTRAINT employee_relay_actions_target_user_required CHECK (kind = 'create' OR target_user_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_employee_relay_actions_target_status
  ON employee_relay_actions (target_restaurant_id, status);
CREATE INDEX IF NOT EXISTS idx_employee_relay_actions_account
  ON employee_relay_actions (account_id);

-- Идемпотентность НА ФИЛИАЛЕ — какие relay-действия уже применены, чтобы
-- обрыв сети между обработкой и ack не продублировал мутацию на
-- следующем тике пулера (та же роль, что delivery_relay_received у 091).
CREATE TABLE IF NOT EXISTS employee_relay_received (
  relay_action_id UUID PRIMARY KEY,
  local_user_id   UUID NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS employee_relay_received;
DROP TABLE IF EXISTS employee_relay_actions;
-- +goose StatementEnd
