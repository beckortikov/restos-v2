# 03 — Бэкенд: доменная логика

Бизнес-правила в `server/internal/service/`. Базовые конвенции (tenant, транзакции, идемпотентность,
audit, decimal) — в [02-backend-architecture.md](02-backend-architecture.md). Термины — в [07-glossary.md](07-glossary.md).

Все операции ниже выполняются в **одной GORM-транзакции** и публикуют доменные события **после
commit** (см. EventBuffer в [02 §3](02-backend-architecture.md)).

---

## 1. Жизненный цикл заказа

Состояния: `open → cooking → ready → served → bill_requested → closed | cancelled`.
Статус — строка в БД (без enum-констрейнта), валидируется в сервисном слое.

### 1.1 Создание — `OrdersService.Create` (`orders_write.go`)

1. **Pre-merge** входящих позиций (iiko-стиль): одинаковые `menu_item_id` + модификаторы
   сливаются (qty суммируется) **до** INSERT — чтобы не плодить строки.
2. **Снапшот цен меню** — один батч-SELECT по `menu_items`; цены замораживаются на момент создания.
3. **Stop-list** — `validateStopListForItems`: ручной (`menu_items.stop_list_override`) и авто
   (низкий остаток ингредиента, только в strict-режиме). Блок → `409 ITEM_STOPPED`, кроме
   `override_stop_list=true` от manager/owner.
4. **Проверка склада по тех-картам** — `validateStockForItems` → `stockcheck.ComputeShortages`
   (режимы `ModeTechCardOnly` без энфорса / `ModeStrict`). Нет тех-карты → `400 VALIDATION`,
   нехватка → `409 INSUFFICIENT_STOCK`.
5. **Снапшот модификаторов** (имя/цена).
6. **Создание `Order`**: `order_number` — атомарный счётчик на ресторан-в-день через UPSERT
   `order_counters` (по таймзоне ресторана, дефолт `Asia/Dushanbe`); статус `open`;
   `service_percent` копируется из ресторана (только для `hall`; takeaway/delivery = 0);
   `waiter_id` из актора.
7. **Создание `OrderItem` + модификаторы**, накопление `line_total` → `order.total`.
8. **Runner-печать** — `enqueueRunners` ставит `print_jobs` на кухонные станции.
9. **Синк стола** — стол `occupied`, `current_order_id`, `opened_at` (идемпотентно: если уже занят,
   только bump `updated_at` — поддержка нескольких заказов на столе).
10. Событие `order.created`.

Инварианты: одна транзакция на всё; `service_percent` заморожен (пересчитается при закрытии);
`total_with_service` пока = `total`.

### 1.2 Дозаказ — `OrdersService.AddItems` (`orders_write.go`)

- Lock заказа `FOR UPDATE`; `closed` → отказ; `cancelled` → реактивация в `open`.
- Сливается **только с непечатанными** строками (`printed_at IS NULL AND served_at IS NULL AND
  cancelled_at IS NULL`) — иначе кухня не увидит дозаказ (увидела бы только дельту).
- Слияние увеличивает qty существующей строки; для runner считается **дельта** (печатается только
  неприготовленная часть; `qty_printed` уже стоит).
- `order.total += extra` (инкрементально, не пересчётом всех строк).
- Если заказ был `ready/served` — откатывается в `cooking` (новым позициям нужна готовка).
- События `order.item.added`, `order.updated`.

### 1.3 Закрытие/оплата — `OrdersService.Close` (`orders_close.go`)

1. **Валидация входа**: обязателен `shift_id`; `payment_method+account_id` (одиночная оплата) или
   `payments[]` (смешанная, сумма с допуском ±0.01); discount-тип/значение enum-чек.
2. **Lock заказа**, отказ если уже закрыт. **Валидация смены** (`status=open`, тот же ресторан).
3. **Скидка**: percent/fixed, кап по `order.total`. **Гейт одобрения**: скидка ≥10% требует
   `approved_by` (manager/owner), иначе `DISCOUNT_REQUIRES_APPROVAL`; одобрение сохраняется.
4. **Сервис**: только для `hall`; `service_amount = (total − discount) × service_percent / 100`
   (**после** скидки). `total_with_service = (total − discount) + service + tip`.
5. **Снапшот оплаты**: одиночная или `split` (массив `payments` JSONB + `is_split`/`split_count`).
6. **Выручка** — на каждую часть оплаты `financial_operation` `type=in`, `category=revenue`,
   `source_ref="order:<id>"` (идемпотентность); инкремент `financial_account.balance`.
7. **Списание склада** — `deductStockForOrder` (см. §3), идемпотентно по `source_ref`.
8. **Смена** — инкремент `cash_revenue`/`card_revenue`, `orders_count`, пересчёт `avg_check`.
9. **Чек** — `enqueueReceipt` ставит `print_jobs` (если не `skip_receipt`); fire-and-forget —
   падение печати **не** откатывает закрытие.
10. **Стол** — нет других активных заказов → освободить; иначе переключить на старейший активный.
11. Событие `order.closed`.

Инварианты: идемпотентность по `source_ref` (выручка/склад — раз на заказ); повторный close → 409
(не 200); сервис считается **после** скидки и только для зала.

### 1.4 Отмена заказа — `OrdersService.Cancel` (`orders_void.go`)

- Lock; `closed`/`cancelled` → отказ. Ставит `status=cancelled`, снапшот `cancelled_total`.
- Отменяет ещё **не напечатанные** runner-задачи (`printed_at IS NULL`); для уже напечатанных —
  ставит **cancel-runner** (кухня видит «ОТМЕНА»).
- Освобождает/переключает стол. Событие `order.cancelled`.
- **Склад не возвращается** (на момент отмены он ещё не списан — списание только при close).

### 1.5 Void позиции / частичная отмена — `VoidItem` (`orders_void.go`) и `CancelItem` (`orders_extras.go`)

- Lock; позиция уже `cancelled_at` → отказ.
- **Частичный void**: если `qty < item.Qty` — создаётся отдельная `cancelled`-строка на нужное
  кол-во, исходная уменьшается (split row). Иначе — полный void.
- Запись в `order_voids` (аудит для менеджера: имя/qty/цена + approved_by/created_by).
- Пересчёт `order.total` (минус line_total отменённого, с учётом весовых — см. §2).
- Cancel-runner на кухню. Если живых позиций не осталось → **авто-отмена** всего заказа + освобождение стола.

### 1.6 Разделение счёта — `Split` (`orders_split.go`) + `PaySplit` (`orders_extras.go`)

- Режимы: **equal** (на N равных, остаток в последнюю часть) и **by_items** (позиции/qty по частям,
  фронт следит, чтобы сумма ≤ item.qty).
- `order_split` записи `status=pending`, snapshot `items` (JSONB), `order.is_split=true`.
- `PaySplit`: lock сплита → `paid` → `financial_operation` (выручка) + inc баланса + апдейт смены.
  Когда **все** сплиты оплачены → авто-закрытие родительского заказа (race-safe через lock).
- Сплиты иммутабельны; пересоздание — через `clearUnpaidSplits` (если ни один не `paid`).

### 1.7 Перенос — `Transfer` (`orders_split.go`)

- Lock; смена `table_id`/`waiter_id` с проверкой принадлежности ресторану; SSE `table.updated`
  для старого и нового стола.

### 1.8 Возврат — `orders_refund.go`

- Закрытый заказ → возврат: запись и перепечать чека (`LineTotal` считается с учётом весовых, см. §2).

---

## 2. Деньги (модель)

### Хранение в `Order`

`total` (Σ line_total), `service_percent`, `service_amount`, `total_with_service`,
`discount_type/value/amount`, `tip_amount`, `payments` (JSONB), `is_split`/`split_count`.
`line_total` у `OrderItem` **не хранится в БД** — считается на чтение.

### Формула суммы — весовые позиции ⚠️

Ключевой инвариант: весовые блюда (`unit ∈ {g, kg}`) хранят `price`/`cogs` **за `unitSize`**
(напр. 40 c за 100 г), а `qty` — в граммах. Поэтому число «порций» = `qty / unitSize`.

`effectivePortions(unit, qty, unitSize)` (`orders.go`, зеркало `lib/helpers.ts calcLineTotal` на фронте):
```go
// g/kg → qty/unitSize ; piece/nil → qty ; гард unitSize=0 → qty
func effectivePortions(unit *string, qty, unitSize decimal.Decimal) decimal.Decimal
```
`computeSubtotal` и `buildOrderItem` считают `line_total = price × effectivePortions(...)`
(модификаторы — на те же порции). Штучные позиции (`unitSize=1`) не затронуты.

> Историческая заметка: до фикса бэк считал `price*qty` без деления — «100 г» при 40 c/100 г давало
> 4000 c вместо 40. Исправлено единым хелпером во всех денежных точках (line-total, void, split,
> refund, печать) **и** в SQL-отчётах (выручка/COGS/обслуживание — `CASE WHEN unit IN ('g','kg')`)
> **и** в списании склада. Тест: `internal/service/orders_weight_pricing_test.go`.

### Состав итога (при закрытии)

```
discountedTotal  = total − discount_amount
serviceAmount    = discountedTotal × service_percent / 100      (только hall)
totalWithService = discountedTotal + serviceAmount + tipAmount
```
Сервис — **после** скидки. Все промежуточные значения `Normalize`-ятся.

---

## 3. Склад (event-stream + тех-карты)

### `stock_movements` — append-only

`ingredients.qty` — **read-only**. Любое изменение — только добавлением `stock_movement`
(`type ∈ {receipt, out, writeoff, inventory_correction, …}`, `qty<0` для списания,
`description="order:<id>"` для идемпотентности). Денормализованный `ingredients.qty` обновляется
отдельным процессом/хуком (`audit.RegisterStockDenorm`).

### Списание при закрытии — `deductStockForOrder` (`orders_close.go`)

Для каждой неотменённой позиции:
- **batch-cooking блюдо** (`menu_items.is_batch_cooking`) → декремент `prepared_qty` (с
  `GREATEST(...,0)`), сырьё **не списывается** (оно списано на этапе производства заготовки).
- иначе — по строкам тех-карты:
  - **ингредиент** → `writeIngredientDeduct` создаёт `stock_movement type=out`;
  - **полуфабрикат** → `cascadeSemiDeduct` рекурсивно разворачивает `semi_recipe_lines` до базовых
    ингредиентов с учётом `yield_percent` (макс. глубина 5).

Кол-во списания нормализуется на порции: `line.Qty × effectivePortions(unit, item.qty, unitSize)`
(весовые не переспискивают в ×unitSize — см. §2).

### Проверка наличия / stop-list — `validateStockForItems`, `stockcheck`

- Срабатывает при **создании и дозаказе** (не при закрытии).
- `restaurants.tech_cards_enabled` (дефолт true) включает проверку; `enforce_stock_check`
  переключает `ModeTechCardOnly` (только предупреждения) ↔ `ModeStrict` (резервы + остатки).
- В strict считаются **резервы** активных заказов (`computeReservations`) с конвертацией единиц и
  waste-процентом, затем `stockcheck.ComputeShortages`.

---

## 4. Финансы и смены

### Счета и операции

- `FinancialAccount{ name, type (cash|bank|…), balance }` — баланс единственный источник правды,
  операции — иммутабельный лог.
- `FinancialOperation{ type (in|out), amount, category, account_id, activity, date (YYYY-MM-DD),
  source_ref, shift_id }`. Выручка заказа → `type=in, category=revenue, source_ref="order:<id>"`
  + inc `account.balance`. Идемпотентность по `source_ref`.

### Кассовая смена `CashShift`

- `opening_balance/closing_balance`, агрегаты `cash_revenue/card_revenue`, `orders_count`, `avg_check`,
  `status (open|closed)`.
- Закрытие заказа требует **открытую** смену и инкрементит её агрегаты (денормализация для дашборда).

### Отчёты/аналитика

`analytics.go`, `analytics_extras.go`, `finance.go`, `reports_pl.go` — агрегируют из `order_items`
и `financial_operations` (выручка/COGS/обслуживание считаются с учётом весовых через `CASE`, см. §2).
Принцип: операции append-only — источник правды, отчёты считаются запросами.

---

## 5. Печать

### Очередь `print_jobs`

`PrintJob{ type (receipt|runner|cancel_runner), printer_id, payload (ESC/POS байты), order_id,
status (pending|running|done|failed|dismissed), attempts, last_error, printed_at }`.

Жизненный цикл: `pending` → worker берёт → `done` или `failed` (ретраи с backoff). Кассир может
`Retry()` (failed/done → pending) и `Dismiss()` (failed → dismissed). `print_jobs` **не**
аудируется (`SkipHooks=true`). Драйверы принтеров — `internal/printer/` (tcp, usb, mock, virtual).

### Runner (на кухню) — `enqueueRunners` (`orders_runner.go`)

- Группирует позиции по станции (`menu_items.station`, дефолт `hot_kitchen`), грузит мету заказа
  (стол/зона/официант/гости), вызывает `escpos.RunnerLayout`, ставит `print_jobs type=runner`,
  помечает позиции `qty_printed=qty`, `printed_at=now` (идемпотентно через COALESCE).
- `groupPrintItems` (`orders_print_group.go`) сливает одинаковые весовые порции (`g/kg`) в одну
  строку с `Count>1` (штучные — 1:1), не меняя итог.

### Чек и пре-чек

- **Чек** — `enqueueReceipt` (`orders_close.go`): мета + позиции + флаги принтера (логотип, скидка,
  сервис, чаевые, QR-фидбек) → `escpos.ReceiptLayout` → `print_jobs type=receipt`.
- **Пре-чек** — превью перед закрытием (без `print_job` на чек закрытия). На фронте это лист с тем
  же чек-компонентом; см. [04](04-frontend.md).
- **ESC/POS** — `internal/escpos/` (CP866), на каждый тип чека — **golden-тесты** (байт-в-байт),
  обновляются явно через `make update-golden`.

---

## 6. Частые «грабли» (design notes)

1. `line_total` нет в БД — считается на чтение; клиент должен брать сумму из API, не пересчитывать.
2. Сервис — **после** скидки и только для `hall` (takeaway/delivery = 0).
3. Дозаказ **не сливается** с уже напечатанными строками (гигиена кухни).
4. batch-cooking декрементит `prepared_qty`, сырьё списывается при производстве заготовки, не при продаже.
5. Полуфабрикаты разворачиваются рекурсивно с `yield_percent`.
6. Void последней живой позиции → авто-отмена заказа + освобождение стола.
7. Сплит-заказ закрывается, только когда **все** части оплачены (в той же транзакции последней оплаты).
8. Повторный close → 409 «already closed», никогда 200.
9. Весовые: `effectivePortions` (`qty/unitSize`) — во **всех** денежных и складских расчётах.
10. Скидка ≥10% требует одобрения manager/owner (хранится для аудита).

## Индекс функций

| Домен | Файл | Ключевые функции |
|---|---|---|
| Создание/дозаказ | `orders_write.go` | `Create`, `AddItems`, `buildOrderItem`, `preMergeInputs`, `validateStockForItems`, `validateStopListForItems`, `effectivePortions` |
| Закрытие/склад | `orders_close.go` | `Close`, `deductStockForOrder`, `cascadeSemiDeduct`, `enqueueReceipt` |
| Отмена/void | `orders_void.go` | `Cancel`, `VoidItem`, `enqueueCancelRunners` |
| Частичная отмена | `orders_extras.go` | `CancelItem`, `PaySplit`, `clearUnpaidSplits` |
| Сплит/перенос | `orders_split.go` | `Split`, `Transfer` |
| Возврат | `orders_refund.go` | refund-флоу |
| Печать на кухню | `orders_runner.go`, `orders_print_group.go` | `enqueueRunners`, `groupPrintItems` |
| Подытог/деньги | `orders.go` | `computeSubtotal`, `effectivePortions`, `List`, `Get` |
| Финансы | `finance.go` | счета, операции, переводы |
| ESC/POS | `internal/escpos/` | `ReceiptLayout`, `RunnerLayout` + golden |
