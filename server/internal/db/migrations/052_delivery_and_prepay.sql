-- +goose Up
-- +goose StatementBegin
--
-- 052_delivery_and_prepay — доставка как третий тип заказа + слияние фастфуда
-- в один режим.
--
-- ── Доставка ──────────────────────────────────────────────────────────────
-- orders.type уже принимает 'delivery' (001_init: type TEXT DEFAULT 'hall', без
-- CHECK), и бэк её знает: orderTypeLabel → «Доставка», процент обслуживания не
-- начисляется наравне с takeaway, Z-отчёт даёт разрез по типам. Не хватало
-- только двух вещей — переключателя видимости и контактов курьеру.
--
-- delivery_enabled            — показывать ли «Доставка» третьей кнопкой рядом
--                               с «Зал»/«С собой». false → остаются две, как
--                               было. Заказы, уже созданные с type='delivery',
--                               при выключении никуда не деваются: флаг влияет
--                               только на выбор нового типа.
-- delivery_contacts_required  — спрашивать ли телефон и адрес перед оплатой
--                               заказа-доставки. Спрашиваем именно на оплате,
--                               а не при создании: кассир сначала набирает
--                               корзину, контакты — последний шаг перед чеком.
--
-- orders.delivery_phone / delivery_address — контакты конкретного заказа.
-- Отдельно от customers.phone: доставка часто разовая, заводить карточку
-- клиента ради одного адреса незачем. NULL — контакты не спрашивали
-- (delivery_contacts_required=false) или тип заказа не доставка.
--
-- ── Фастфуд одним режимом ────────────────────────────────────────────────
-- kitchen_on_pay НЕ удаляем: колонка остаётся, чтобы существующие конфиги и
-- откат не ломались. Но с этой версии поведение «бегунок на оплате» включается
-- ещё и от tables_enabled=false — см. prepayMode() в orders_runner.go. То есть
-- фастфуд теперь самодостаточен: нет столов → нельзя создать заказ без оплаты,
-- чек и бегунок печатаются только по оплате. Отдельный тумблер в настройках
-- убран, чтобы нельзя было выставить противоречивую комбинацию.
--
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS delivery_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS delivery_contacts_required BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_phone TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_address TEXT;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE orders DROP COLUMN IF EXISTS delivery_address;
ALTER TABLE orders DROP COLUMN IF EXISTS delivery_phone;
ALTER TABLE restaurants DROP COLUMN IF EXISTS delivery_contacts_required;
ALTER TABLE restaurants DROP COLUMN IF EXISTS delivery_enabled;
-- +goose StatementEnd
