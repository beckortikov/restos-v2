# 04 — API Contract

**Base URL:** `http://127.0.0.1:3001/api/v1` (local sidecar) либо `http://<lan-ip>:3001/api/v1` (для официантов APK по LAN).

**Формат:** REST + JSON. Errors через `ErrorEnvelope`. Realtime через SSE на `/api/v1/events`.

**Документация:** `server/api/openapi.yaml` — источник правды. Swagger UI на `http://127.0.0.1:3001/docs`.

## Общие соглашения

### Headers

```
Authorization: Bearer <session_token>
Content-Type: application/json
Idempotency-Key: <uuid>          # обязателен на всех POST/PUT/DELETE
X-Restaurant-Id: <uuid>           # резерв; в MVP берётся из session
```

### Response shape

Success:
```json
{ "data": {...} | [...], "meta": { "total": 123, "page": 1 } }
```

Error (ErrorEnvelope):
```json
{
  "error": {
    "code": "ORDER_ALREADY_CLOSED",
    "message": "Order is already closed",
    "details": { "order_id": "..." },
    "trace_id": "req_abc123"
  }
}
```

### Pagination

`?limit=50&offset=100` — default `limit=50`, max `limit=500`.
Заголовок ответа: `X-Total-Count: 1234`.

### Sorting

`?order=created_at:desc,name:asc` — точка разделитель убрана, двоеточие явный.

### Filtering

Простые case-equality по query: `?status=open&zone_id=abc`.
Сложные операторы (range, like, in) — суффиксы:

```
?total__gte=100&total__lt=500
?name__ilike=*пицца*
?status__in=open,bill_requested
?created_at__between=2026-01-01,2026-01-31
```

Решение: операторы через `__suffix` (Django-style), читается лучше, чем PostgREST `?total=gte.100`.

## Endpoints (по доменам)

### Health & meta

| Метод | Path | Что |
|---|---|---|
| GET | `/health` | `{status: "ok", db: "ok", version: "..."}` |
| GET | `/version` | `{version, git_sha, build_time}` |
| GET | `/status` | расширенный статус (sync lag, db size, queue depth) |

### Auth (PIN-логин)

| Метод | Path | Body | Что |
|---|---|---|---|
| POST | `/auth/pin` | `{pin, restaurant_id}` | Логин по PIN → `{session_token, user}` |
| POST | `/auth/logout` | — | Завершить сессию |
| GET | `/auth/me` | — | Текущий пользователь |

### Restaurants (tenant config)

| Метод | Path | Что |
|---|---|---|
| GET | `/restaurants/current` | Конфиг текущего ресторана (валюта, service %, флаги) |
| PUT | `/restaurants/current` | Обновить (только owner/manager) |

### Users

| Метод | Path | Что |
|---|---|---|
| GET | `/users` | Список пользователей ресторана |
| POST | `/users` | Создать |
| GET | `/users/{id}` | Получить |
| PUT | `/users/{id}` | Обновить |
| DELETE | `/users/{id}` | Soft-delete |

### Tables & zones

| Метод | Path | Что |
|---|---|---|
| GET | `/zones` | Зоны зала |
| POST | `/zones` | Создать |
| GET | `/tables` | Столы (с текущим заказом) |
| POST | `/tables` | Создать |
| PUT | `/tables/{id}` | Переименовать/переместить |
| DELETE | `/tables/{id}` | Удалить |

### Menu

| Метод | Path | Что |
|---|---|---|
| GET | `/menu/categories` | Категории |
| GET | `/menu/items` | Блюда (с tech_card, modifiers) |
| GET | `/menu/items/{id}` | Одно блюдо |
| POST | `/menu/items` | Создать |
| PUT | `/menu/items/{id}` | Обновить |
| DELETE | `/menu/items/{id}` | Удалить |
| GET | `/menu/stoplist` | Стоп-лист (производный view) |
| POST | `/menu/import` | XLSX-импорт (multipart) |

### Orders (главный домен)

| Метод | Path | Что |
|---|---|---|
| GET | `/orders` | Список с фильтрами (`?status=open&table_id=...&shift_id=...`) |
| GET | `/orders/{id}` | Полный заказ с items + modifiers |
| POST | `/orders` | Создать (от официанта) |
| PUT | `/orders/{id}` | Обновить шапку (комментарий, гость) |
| DELETE | `/orders/{id}` | Soft-cancel (`status=cancelled`) |
| POST | `/orders/{id}/items` | Добавить позицию |
| PUT | `/orders/{id}/items/{itemId}` | Изменить qty/modifiers |
| DELETE | `/orders/{id}/items/{itemId}` | Void позицию |
| POST | `/orders/{id}/discount` | Применить скидку |
| POST | `/orders/{id}/request-bill` | Официант → кассир («запрос чека») |
| POST | `/orders/{id}/payment` | Принять оплату (multi-method) |
| POST | `/orders/{id}/close` | Закрыть заказ → revenue entry, deduct stock |
| POST | `/orders/{id}/split` | Разделить счёт (`{mode: equal\|by_items, ...}`) |
| POST | `/orders/{id}/transfer` | Перенести на другой стол |
| POST | `/orders/{id}/print-bill` | Печать пре-чека |
| POST | `/orders/{id}/print-receipt` | Печать фискального чека |

### Kitchen / KDS

| Метод | Path | Что |
|---|---|---|
| GET | `/kitchen/queue` | Активные заказы для KDS (`new/cooking/ready`) |
| POST | `/kitchen/orders/{id}/status` | Изменить kitchen_status |
| POST | `/kitchen/orders/{id}/items/{itemId}/status` | Изменить статус позиции |

### Shifts

| Метод | Path | Что |
|---|---|---|
| GET | `/shifts/current` | Открытая смена текущего кассира |
| POST | `/shifts/open` | `{opening_balance, account_id}` |
| POST | `/shifts/{id}/close` | `{closing_balance_actual}` → diff |
| POST | `/shifts/{id}/operations` | Инкассация (`cash_in/cash_out`) |
| GET | `/shifts/{id}/report` | Сводка |
| GET | `/shifts/{id}/report.xlsx` | Экспорт XLSX |

### Stock / Warehouse

| Метод | Path | Что |
|---|---|---|
| GET | `/stock/ingredients` | Остатки |
| GET | `/stock/movements` | Журнал движений |
| POST | `/stock/receipts` | Приход (`{supplier_id, lines, paid_amount}`) |
| GET | `/stock/receipts` | Список приходов |
| POST | `/stock/writeoffs` | Списание |
| POST | `/stock/inventory-checks` | Инвентаризация |
| PUT | `/stock/inventory-checks/{id}/finalize` | Завершить → adj movements |
| POST | `/stock/batch-cooking` | Партия полуфабриката |
| POST | `/stock/import` | XLSX-импорт |

### Suppliers

| Метод | Path | Что |
|---|---|---|
| GET | `/suppliers` | Список |
| POST | `/suppliers` | Создать |
| GET | `/suppliers/{id}/debts` | Долги (FIFO) |
| POST | `/suppliers/{id}/payments` | Погашение |

### Finance

| Метод | Path | Что |
|---|---|---|
| GET | `/finance/accounts` | Счета (cash/bank) |
| POST | `/finance/accounts` | Создать |
| GET | `/finance/operations` | Операции с фильтрами |
| POST | `/finance/operations` | Создать (вручную) |
| POST | `/finance/operations/{id}/reverse` | Сторно |
| GET | `/finance/cashflow` | ДДС |
| GET | `/finance/pnl` | ОПиУ |
| GET | `/finance/balance` | Баланс |
| GET | `/finance/budget` | Бюджет |

### Reservations & customers

| Метод | Path | Что |
|---|---|---|
| GET | `/reservations` | Список |
| POST | `/reservations` | Создать |
| GET | `/customers` | Гости |
| POST | `/customers` | Создать |

### Payroll & time tracking

| Метод | Path | Что |
|---|---|---|
| GET | `/payroll/periods` | Периоды зарплат |
| POST | `/payroll/periods/{id}/pay` | Выплатить → FinancialOperation(out) |
| POST | `/time-entries/clock-in` | Табель: приход |
| POST | `/time-entries/clock-out` | Уход |

### Printers

| Метод | Path | Что |
|---|---|---|
| GET | `/printers` | Конфиг принтеров |
| PUT | `/printers/{id}` | Обновить |
| POST | `/printers/{id}/test` | Тестовая печать |
| GET | `/printers/queue` | Очередь печати |
| POST | `/printers/queue/{jobId}/retry` | Повтор |

### Realtime

| Метод | Path | Что |
|---|---|---|
| GET | `/events?topics=orders,tables,prints,kitchen` | SSE поток |

Events format:
```
event: order.updated
data: {"id":"...","status":"closed","ts":1716480000}

event: print.failed
data: {"order_id":"...","printer":"kitchen-1","error":"..."}
```

### Admin

| Метод | Path | Что |
|---|---|---|
| POST | `/admin/clear-operations` | Очистить операции (dev) |
| POST | `/admin/clear-menu` | Очистить меню |
| POST | `/admin/cleanup-orphans` | Удалить orphan-items |
| POST | `/admin/db/vacuum` | SQLite VACUUM |

### Connect (для официантов APK)

| Метод | Path | Что |
|---|---|---|
| GET | `/connect/qr.png` | QR с URL `http://<ip>:3001` |
| GET | `/connect/diag` | Сетевая диагностика |
| GET | `/connect` | HTML-страница с инструкцией |

### License & activation

| Метод | Path | Что |
|---|---|---|
| GET | `/license/status` | Статус лицензии (7+7+lock) |
| POST | `/license/activate` | Активация по ключу |

### ~~Sync~~ — в v4 нет (см. [07-FUTURE-CLOUD.md](07-FUTURE-CLOUD.md))

## Error codes (стандартные)

| Code | HTTP | Смысл |
|---|---|---|
| `UNAUTHORIZED` | 401 | Нет/невалиден токен |
| `FORBIDDEN` | 403 | Роль не имеет права |
| `NOT_FOUND` | 404 | — |
| `VALIDATION_FAILED` | 422 | Тело не прошло валидацию (details: per-field errors) |
| `IDEMPOTENCY_CONFLICT` | 409 | Тот же Idempotency-Key с другим body |
| `ORDER_ALREADY_CLOSED` | 409 | — |
| `SHIFT_NOT_OPEN` | 409 | Действие требует открытой смены |
| `STOCK_INSUFFICIENT` | 409 | Нехватка ингредиента (если enforce_stock_check) |
| `PRINTER_UNREACHABLE` | 503 | Принтер не отвечает |
| `LICENSE_EXPIRED` | 402 | — |
| `INTERNAL` | 500 | Что-то непредвиденное |

## OpenAPI

Источник правды — `server/api/openapi.yaml`. Каждый эндпоинт описывается там одновременно с реализацией. CI прогоняет `oapi-codegen --validate`.

Фронт может авто-генерировать TS-клиент из openapi.yaml (например, `openapi-typescript`).
