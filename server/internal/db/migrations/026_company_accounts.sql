-- +goose Up
-- +goose StatementBegin
--
-- 026_company_accounts — сеть филиалов (Фаза 1 multi-branch, ADR-003).
--
-- Группирует N ресторанов одного владельца под общим account_id. Колонка
-- restaurants.account_id уже есть с миграции 009 (заполняется из license-
-- токена payload.aid). Эта таблица материализует саму «сеть».
--
-- Хард-FK не ставим: в проекте таблицы связаны на уровне приложения (ср.
-- stock_receipt_lines без REFERENCES), целостность tenant обеспечивает код
-- (ForTenant/ForAccount). account_id=NULL у ресторана = одиночная точка.
CREATE TABLE IF NOT EXISTS company_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  owner_name TEXT,
  phone TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS company_accounts;
-- +goose StatementEnd
