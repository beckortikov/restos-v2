# 07 — Доменный глоссарий

Сквозные термины предметной области. Где термин подробно разобран — ссылка на [03](03-backend-domain.md)
(бэк) / [04](04-frontend.md) (фронт). Схема таблиц целиком — `docs/prd/05-DATA-MODEL.md`.

## Заказ (Order)

- **Заказ** — `orders`. Статусы: `open → cooking → ready → served → bill_requested → closed |
  cancelled`. Тип `hall | takeaway | delivery`. На фронте статус `closed` называется `done`
  (`lib/types.ts`).
- **Позиция** — `order_items`. Поля: `qty`, `price`, `cogs`, `unit` (`piece|g|kg`), `unitSize`,
  `printed_at`, `served_at`, `cancelled_at`. `line_total` **не хранится** — считается на чтение.
- **Модификатор** — `order_item_modifiers` (снапшот имени/цены модификатора на момент заказа).
- **`order_number`** — человекочитаемый номер, **на ресторан в день** (счётчик `order_counters`,
  по таймзоне ресторана).
- **Дозаказ** — добавление позиций в открытый заказ (`AddItems`). Сливается только с **непечатанными**
  строками; на кухню печатается дельта.
- **iiko-merge** — слияние одинаковых позиций (`menu_item_id` + модификаторы) в одну строку с
  суммированием `qty`, чтобы не плодить строки.
- **Группа / мульти-таб** — несколько одновременных заказов на одном столе (напр. «Гость 1/2»);
  стол хранит `current_order_ids`.

## Деньги

- **Подытог (subtotal)** — Σ `line_total` неотменённых позиций (`computeSubtotal` на бэке /
  `calcLineTotal` на фронте).
- **Обслуживание (service)** — `service_amount = (subtotal − discount) × service_percent / 100`,
  **после** скидки и только для `hall`.
- **`total` / `total_with_service`** — сумма позиций / финальная сумма к оплате
  (`(total − discount) + service + tip`).
- **Скидка** — `discount_type` (`percent|fixed`), кап по `total`; ≥10% требует одобрения manager/owner.
- **Весовая позиция** — `unit ∈ {g, kg}`: `price`/`cogs` заданы **за `unitSize`** (напр. 40 c/100 г),
  а `qty` — в граммах. «Порций» = `qty / unitSize`. Все денежные/складские расчёты используют
  `effectivePortions` (бэк) / `calcLineTotal` (фронт). См. [03 §2](03-backend-domain.md).
- **decimal** — деньги только `decimal` (NUMERIC(14,4)), никакого float; клиент шлёт строками.

## Оплата и смена

- **financial_operations** — иммутабельный лог денежных операций (`type in|out`, `category`,
  `account_id`, `source_ref`). Выручка заказа → `type=in, category=revenue, source_ref="order:<id>"`.
- **financial_accounts** — счета (`cash|bank|…`), `balance` — единственный источник правды; операции — лог.
- **Кассовая смена (cash_shift)** — `opening/closing_balance`, агрегаты `cash_revenue/card_revenue`,
  `orders_count`, `avg_check`, `status open|closed`. Закрытие заказа **требует открытую смену**.
- **Смешанная оплата** — массив `payments` (JSONB) на заказе; `is_split=false`, но несколько способов.

## Отмена / возврат / разделение

- **Отмена заказа (cancel)** — заказ целиком → `cancelled` (склад не возвращается, т.к. ещё не списан).
- **Void позиции** — отмена одной позиции; запись в `order_voids` (аудит). **Частичный void** —
  split-строка на часть `qty`, исходная уменьшается. Void последней живой позиции → авто-отмена заказа.
- **`order_voids`** — аудит-таблица отменённых позиций (видна менеджеру); чек строит видимые позиции
  через `visibleReceiptItems` (исключает отменённые).
- **Разделение счёта (split)** — `order_splits` (`equal` поровну / `by_items` по позициям),
  `status pending|paid`. Заказ закрывается, когда **все** части оплачены.
- **Возврат (refund)** — по закрытому заказу, с перепечатью чека.

## Склад

- **stock_movements** — append-only event-stream: любое изменение остатка ингредиента — только
  добавлением движения. **`ingredients.qty` — read-only**, обновляется денормализующим процессом.
- **Тех-карта (tech card / tech_card_lines)** — рецепт блюда: ингредиенты/полуфабрикаты на **одну
  порцию**. Списание при закрытии: `line.qty × effectivePortions(...)`.
- **Полуфабрикат (semi-finished)** — `semi_finished_type` + `semi_recipe_lines`; при списании
  рекурсивно разворачивается до базовых ингредиентов с `yield_percent`.
- **Batch-cooking** — блюдо готовится партиями: при производстве списывается сырьё и растёт
  `prepared_qty`; при продаже декрементится `prepared_qty` (сырьё **не** списывается повторно).
- **Стоп-лист (stop-list)** — блюдо недоступно: **ручной** (`menu_items.stop_list_override`) или
  **авто** (низкий остаток ингредиента, только в strict-режиме). Обход — `override_stop_list` от manager/owner.
- **Режимы проверки** — `tech_cards_enabled` (вкл/выкл), `enforce_stock_check`:
  `ModeTechCardOnly` (только предупреждения) ↔ `ModeStrict` (резервы + остатки).
- **Резервы** — ожидаемый расход ингредиентов под активные заказы (`computeReservations`, эфемерно).

## Печать

- **print_jobs** — очередь печати (`receipt|runner|cancel_runner`), статусы
  `pending → running → done|failed|dismissed`, ESC/POS-`payload`, ретраи с backoff. Fire-and-forget.
- **Runner** — кухонная печать: позиции по станциям (`menu_items.station`), помечает `printed_at`/`qty_printed`.
- **Cancel-runner** — печать «ОТМЕНА» для уже виденных кухней позиций.
- **Чек / пре-чек** — гостевой счёт при закрытии / предварительный счёт перед оплатой; единый
  билдер `lib/receipt-data.ts` + рендер `print-receipt.tsx`. ESC/POS — `internal/escpos/` + golden-тесты.
- **groupPrintItems** — слияние одинаковых весовых порций («100 г × 3») в одну строку чека.

## Платформа / инфраструктура

- **Sidecar** — Go-бинарь (`restos-server`), который спавнит Electron; он же спавнит Postgres.
- **Tenant / `restaurant_id`** — арендатор; фильтр обязателен в каждом запросе (`repo.ForTenant`).
- **Idempotency-Key** — UUID в заголовке write-запроса; повтор → кэшированный ответ (24 ч). Плюс
  доменная идемпотентность по `source_ref`.
- **SSE** — `GET /api/v1/events`, in-memory hub, события фильтруются по `restaurant_id`; фронт по ним
  точечно инвалидирует кэш.
- **Audit-log** — `audit_log`, заполняется централизованным GORM-хуком (async worker); ручных вставок нет.
- **Лицензия** — `active / grace / locked`; в locked write-операции → 403 `LICENSE_LOCKED`.
- **Роли** — owner, manager, cashier, waiter, cook, storekeeper, accountant; права — дефолты роли или
  кастом `users.permissions_json` (см. [02 §10](02-backend-architecture.md)).
- **ErrorEnvelope** — формат ошибки `{code, message, details}`; коды маппятся на HTTP-статусы.
