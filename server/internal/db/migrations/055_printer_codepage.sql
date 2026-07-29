-- +goose Up
-- +goose StatementBegin
--
-- 055_printer_codepage — номер таблицы символов (ESC t n) на принтер.
--
-- Единой нумерации кодовых страниц в ESC/POS НЕТ. У Epson PC866 (кириллица)
-- сидит на 17, и мы слали 17 захардкоженно. Часть принтеров держит кириллицу
-- на другом индексе, а незнакомый номер молча игнорирует и остаётся на своей
-- дефолтной таблице.
--
-- Симптом ровно такой: латиница, цифры и разделители печатаются верно, а
-- вместо кириллицы лезут греческие буквы и символы (β, γ, μ, ¥, ¬) — это
-- CP437. То есть поток корректный, принтер просто читает его не той таблицей.
-- Встречено на встроенном принтере моноблока Caysn TC3680B-UP, у которого в
-- самотесте Default Codepage = GBK(255).
--
-- 17 остаётся дефолтом: на уже работающих принтерах ничего не меняется.
--
ALTER TABLE printers ADD COLUMN IF NOT EXISTS codepage SMALLINT NOT NULL DEFAULT 17;

-- ESC t n — один байт.
ALTER TABLE printers DROP CONSTRAINT IF EXISTS printers_codepage_check;
ALTER TABLE printers ADD CONSTRAINT printers_codepage_check
  CHECK (codepage BETWEEN 0 AND 255);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE printers DROP CONSTRAINT IF EXISTS printers_codepage_check;
ALTER TABLE printers DROP COLUMN IF EXISTS codepage;
-- +goose StatementEnd
