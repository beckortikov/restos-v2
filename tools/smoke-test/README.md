# RestOS smoke test

Read-only проверка работающей кассы RestOS. Бьёт по всем основным endpoint'ам
(catalog, orders, shifts, analytics, finance, license, SSE), проверяет shape
ответов и латентность. Пишет всё в `smoke-test.log`.

## Что нужно

- Python 3.10+
- RestOS касса запущена (Electron окно открыто, server слушает на порту 3001)
- PIN менеджера или owner'а

## Шаг 1 — установка

```cmd
pip install -r requirements.txt
```

## Шаг 2 — узнать restaurant_id

Открой http://127.0.0.1:3001/api/v1/restaurants в браузере (нужен Bearer токен)
или просто в кассе зайди в Настройки → Ресторан — там UUID. Можно также
посмотреть в `%APPDATA%\RestOS v2\config.json` если он есть, или через
postgres напрямую.

Самый простой способ:
1. В кассе залогинься (по PIN).
2. Открой DevTools (Ctrl+Shift+I) → Network → найди любой запрос к /api/v1/
3. В Headers скопируй `Authorization: Bearer <token>` и в любом запросе
   `restaurant_id` параметр или из самого URL вытащи UUID.

## Шаг 3 — задать env-vars

```cmd
set RESTOS_BASE_URL=http://127.0.0.1:3001
set RESTOS_RESTAURANT_ID=<сюда uuid ресторана>
set RESTOS_PIN=<сюда PIN>
```

## Шаг 4 — запустить

```cmd
pytest smoke_test.py -v -s
```

После запуска появится файл `smoke-test.log` — пришли его обратно
для анализа.

## Опциональный режим: write cycle

Если хочешь чтобы скрипт реально **создал тестовый заказ** на свободном столе
и сразу его отменил (проверка write-флоу):

```cmd
pytest smoke_test.py -v -s --write
```

⚠ Делай только на тестовой машине — на боевой кассе это создаст реальный
заказ (хоть и сразу отменённый, он останется в audit_log).

---

# Нагрузочное тестирование (`load_test.py`)

Отдельный скрипт — определяет сколько официантов может работать одновременно
без лагов.

## Как работает

1. Логинится по PIN.
2. Берёт свободные столы + меню.
3. Запускает раунды с растущим числом конкурентных официантов: **1 → 2 → 5
   → 10 → 20 → 50**.
4. В каждом раунде каждый «официант» (отдельный поток) последовательно
   делает **10 циклов: create_order → cancel_order**. Cancel — чтобы не
   засорять реальную выручку (БД останется почти чистой, только audit_log
   и order_voids подрастут).
5. Меряет p50/p95/p99 латентности для create + cancel, throughput,
   процент ошибок.
6. Находит **breaking point** — первый раунд где p99 > 500ms или ошибки
   > 1%. Выдаёт вердикт: «безопасный максимум — N официантов».

## Запуск (винда)

```cmd
set RESTOS_BASE_URL=http://127.0.0.1:3001
set RESTOS_RESTAURANT_ID=<uuid>
set RESTOS_PIN=<пин>
python load_test.py
```

Опции:
- `--max-waiters 50` — потолок (default 50)
- `--orders-per 10` — заказов на «официанта» в раунде (default 10)
- `--p99-threshold 500` — граница «лага» в мс (default 500)

⚠ **Нужны свободные столы** на момент запуска. Если столов мало, скрипт
переиспользует их по кругу — это нормально для load-теста.

## Пример вывода

```
== SUMMARY ==
waiters orders  time   tps   create_p99 cancel_p99  errors
       1     10   1.2s   8.3        45ms      55ms        0
       2     20   1.4s  14.2        65ms      70ms        0
       5     50   2.8s  17.8       125ms     150ms        0
      10    100   5.5s  18.2       280ms     310ms        0
      20    200  12.1s  16.5       620ms     750ms        2  ← lag
      50    500  31.0s  16.1      1450ms    1800ms       15  ← lag

== VERDICT ==
⚠ Лаги начинаются с 20 официантов.
   Безопасный максимум: 10 официантов (p99 create = 280ms, throughput = 18.2/сек).
```

Лог: `load-test.log` — пришли его обратно для анализа.

---

## Что проверяется (smoke)

| # | Группа | Что |
|---|---|---|
| 0 | environment | env-vars заданы |
| 1 | server.alive | бэк отвечает |
| 2 | auth.login | POST /auth/login → token |
| 3 | license.status | лицензия не залочена |
| 4 | catalog reads | menu/tables/zones/users/ingredients/suppliers/printers |
| 5 | orders.list+items | `?include=items` возвращает items inline (N+1 фикс v3.1.0) |
| 6 | shifts.list | список смен |
| 7 | analytics × 9 | abc-menu, peak-hours, waiters, tables, food-cost (+monthly), ingredient-stock, forecast, abc-inventory |
| 8 | finance reports × 4 | pnl / cashflow / balance / monthly-revenue |
| 9 | finance extras | accounts, operations, custom-categories, assets, liabilities, equity, budget |
| 10 | stock | movements, supply-expenses, stop-list |
| 11 | reservations | список броней |
| 12 | sse.handshake | /api/v1/events открывается, идёт heartbeat |
| 99 | write cycle (--write) | create-order → cancel |

## Формат лога

```
[15:30:01.123] GET /api/v1/menu/items
[15:30:01.234]   → PASS (111ms) http 200, count=42

...

SUMMARY
======================================================================
Tests: 23  Passed: 22  Failed: 1

name                             ms      status  detail
-------------------------------------------------------------
auth.login                       45      ✓       user=Менеджер role=manager
analytics.abc_menu              123      ✓       shape ok | A=5 B=8 C=12
analytics.forecast                5      ✗       BODY PARSE ERROR: KeyError
...
```
