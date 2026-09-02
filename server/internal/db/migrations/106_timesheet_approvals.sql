-- +goose Up
-- +goose StatementBegin
--
-- 106_timesheet_approvals — утверждение табеля за период.
--
-- До этого «утверждённой суммы» в системе не существовало: начисление
-- считалось на лету из отметок, и правка задним числом молча меняла уже
-- показанную цифру. Пока период не выплачен, это удобно. После выплаты —
-- источник спора: в ведомости одна сумма, на экране другая, и объяснить
-- разницу нечем.
--
-- Утверждение фиксирует итог по каждому сотруднику на момент нажатия: дни,
-- часы и начисление. Дальше отчёты и ведомость показывают ЗАФИКСИРОВАННОЕ, а
-- если отметки правят после утверждения — видно расхождение («утверждено
-- 41,5 ч, сейчас 43,0 ч»), и человек решает: пересогласовать или оставить.
--
-- Строка на КАЖДОГО сотрудника, а не одна на период: расхождение нужно видеть
-- поимённо, иначе непонятно, чей день поправили.
--
-- accrued хранится снимком, хотя его можно пересчитать: правило начисления со
-- временем меняется (ставку подняли, тип оплаты сменили), и пересчёт старого
-- периода по новым правилам дал бы сумму, которой никогда не выплачивали.
--
CREATE TABLE IF NOT EXISTS timesheet_approvals (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id    TEXT NOT NULL,
  period_from      DATE NOT NULL,
  period_to        DATE NOT NULL,
  user_id          UUID NOT NULL,
  days             INTEGER NOT NULL DEFAULT 0,
  hours            NUMERIC(14,4) NOT NULL DEFAULT 0,
  accrued          NUMERIC(14,4) NOT NULL DEFAULT 0,
  approved_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_by      UUID,
  approved_by_name TEXT,
  -- Переоткрытие периода — не удаление строки: кто и когда снял утверждение,
  -- в споре важнее самого факта снятия.
  cancelled_at     TIMESTAMPTZ,
  cancelled_by     UUID,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Один действующий снимок на (период, сотрудник). Частичный индекс: снятое
-- утверждение освобождает ключ, и период можно утвердить заново.
CREATE UNIQUE INDEX IF NOT EXISTS uq_timesheet_approvals_active
  ON timesheet_approvals (restaurant_id, period_from, period_to, user_id)
  WHERE cancelled_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_timesheet_approvals_period
  ON timesheet_approvals (restaurant_id, period_from, period_to);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS timesheet_approvals;
-- +goose StatementEnd
