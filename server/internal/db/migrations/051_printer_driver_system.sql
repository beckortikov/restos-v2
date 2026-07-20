-- +goose Up
-- +goose StatementBegin
--
-- 051_printer_driver_system — расширяет список допустимых driver в printers
-- значением 'system' (печать через системную очередь ОС).
--
-- Зачем: на кассовых моноблоках принтер встроен в корпус и висит на внутреннем
-- USB (например Caysn TC3680B-UP, VID:0x4B43/PID:0x3830) — сети у него нет,
-- и наш tcp-драйвер до него не достаёт. Прямой USB через libusb/gousb требует
-- cgo (у нас весь пайплайн CGO_ENABLED=0) и подмены вендорного драйвера на
-- WinUSB через Zadig, что ломает печать для любого другого софта на той же
-- машине. Вместо этого пишем сырой ESC/POS в спулер ОС:
--   Windows — winspool RAW (StartDocPrinter с datatype="RAW");
--   macOS/Linux — CUPS (`lp -d <очередь> -o raw`).
-- Спулер отдаёт байты в USB-порт как есть, не рендеря их — принтеру всё равно,
-- пришли они по TCP или через очередь.
--
-- target для driver='system' — имя системной очереди печати («POS-80 Printer»),
-- а не vid:pid. Список очередей отдаёт GET /api/v1/printers/system-queues.
--
-- Старый driver='usb' (vid:pid, за build tag) остаётся в списке как есть —
-- миграция только расширяет множество, существующие строки под новый CHECK
-- подходят все, данные не переписываются.
--
-- DROP ... IF EXISTS + ADD делает миграцию идемпотентной и переживает кассы,
-- ушедшие в рассинхрон goose (версия применена, а constraint'а нет).
-- Имя printers_driver_check — автоген Postgres для инлайнового CHECK в 004.
--
ALTER TABLE printers DROP CONSTRAINT IF EXISTS printers_driver_check;
ALTER TABLE printers ADD CONSTRAINT printers_driver_check
  CHECK (driver IN ('tcp','usb','system','virtual','mock'));
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
-- Откат сузит множество — строки с driver='system' сначала переводим на 'tcp',
-- иначе ADD CONSTRAINT упадёт на валидации существующих данных.
UPDATE printers SET driver = 'tcp' WHERE driver = 'system';
ALTER TABLE printers DROP CONSTRAINT IF EXISTS printers_driver_check;
ALTER TABLE printers ADD CONSTRAINT printers_driver_check
  CHECK (driver IN ('tcp','usb','virtual','mock'));
-- +goose StatementEnd
