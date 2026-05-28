# 06 — Business Logic (портирование TS → Go)

Все мутации/расчёты, влияющие на финансы и склад, переезжают с фронта на Go. Это главное архитектурное изменение v4: фронт перестаёт быть source-of-truth для бизнес-правил.

## Сервисный слой

Структура `server/internal/service/`:

```
service/
├── order_service.go       — заказы (create, addItem, void, close, split, transfer)
├── stock_service.go       — деduct, batch, inventory, semi-finished
├── shift_service.go       — open, close, encashment
├── finance_service.go     — revenue, expenses, transfers
├── print_service.go       — build receipt/runner, enqueue
├── menu_service.go        — CRUD + stoplist computation
├── auth_service.go        — PIN-login, session
├── import_service.go      — XLSX импорт
├── export_service.go      — XLSX экспорт
├── license_service.go     — 7+7+lock логика
└── interfaces.go          — порты для тестов
```

## 1. OrderService — заказы

Источник в TS: `lib/supabase-queries.ts` (5702 строки), функции типа `createOrder`, `closeOrder`, `splitOrder`, `voidOrderItem`.

### `CreateOrder`

```go
func (s *OrderService) Create(ctx context.Context, input CreateOrderInput) (*models.Order, error) {
    return s.db.Transaction(func(tx *gorm.DB) error {
        order := &models.Order{
            ID:           uuid.NewString(),
            RestaurantID: tenant.From(ctx),
            TableID:      input.TableID,
            WaiterID:     auth.UserFrom(ctx).ID,
            ShiftID:      input.ShiftID,
            Status:       "open",
            // ...
        }
        if err := tx.Create(order).Error; err != nil { return err }

        for _, item := range input.Items {
            // расчёт line_total, копии modifiers, snapshot цены меню
            ...
        }

        s.audit.Log(ctx, "order.create", order.ID, ...)
        s.sse.After(ctx, "order.created", order)
        return nil
    })
}
```

### `CloseOrder` (критичная операция)

Из `lib/supabase-queries.ts:closeOrder` сейчас:
1. Меняет статус → `closed`.
2. Создаёт `FinancialOperation` тип `in/op` (revenue).
3. Списывает ингредиенты (если не было `deduct_stock_for_order` ранее).
4. Привязывает к `cash_shift`.
5. Печатает чек (если не печатался).
6. Эмитит realtime.

На Go это **строго одна транзакция**:

```go
func (s *OrderService) Close(ctx context.Context, orderID string) error {
    return s.db.Transaction(func(tx *gorm.DB) error {
        order, err := s.repo.Orders.GetByIDForUpdate(tx, ctx, orderID)
        if err != nil { return err }
        if order.Status == "closed" {
            return errs.New("ORDER_ALREADY_CLOSED")
        }

        order.Status = "closed"
        order.ClosedAt = ptr(time.Now())
        if err := tx.Save(order).Error; err != nil { return err }

        if err := s.finance.CreateRevenueEntry(tx, ctx, order); err != nil { return err }
        if err := s.stock.DeductForOrder(tx, ctx, order); err != nil { return err }
        if err := s.shift.AttachOrder(tx, ctx, order); err != nil { return err }
        // печать — fire-and-forget job вне транзакции
        s.afterCommit(func() { s.print.EnqueueReceipt(order) })

        return nil
    })
}
```

**Ключевое:** печать НЕ внутри транзакции. SSE-broadcast и job-enqueue — после commit.

### `SplitOrder`

Из `lib/supabase-queries.ts:splitOrder`. Два режима:
- `equal` — поделить total на N равных частей, создать N orders.
- `by_items` — переместить выбранные items в отдельный order.

На Go: `service.OrderService.Split(ctx, orderID, mode, params)`. Одна транзакция, создаёт `order_splits` запись для аудита.

### `VoidOrderItem`

Списание из открытого заказа (до закрытия). Если позиция уже была отдана на кухню — создаётся `cancel_runner` job для печати на станции (повар видит «отменить»).

## 2. StockService — склад

Источник: `lib/supabase-queries.ts:deductStockForOrder`, `produceSemiFab`, `applyInventoryDiff`.

### `DeductForOrder`

Триггер: переход заказа `cooking → ready` ИЛИ `close_order` (если кухня выключена).

```go
func (s *StockService) DeductForOrder(tx *gorm.DB, ctx context.Context, order *models.Order) error {
    // Идемпотентность: если для этого order уже есть movements — выход
    var existing int64
    tx.Model(&models.StockMovement{}).
        Where("order_id = ?", order.ID).
        Where("idempotency_key = ?", "deduct:" + order.ID).
        Count(&existing)
    if existing > 0 { return nil }

    for _, item := range order.Items {
        techCard, err := s.repo.Menu.GetTechCard(tx, ctx, item.MenuItemID)
        if err != nil { return err }
        for _, line := range techCard {
            // line.IngredientID OR line.SemiTypeID
            qty := line.Qty.Mul(item.Qty)
            movement := &models.StockMovement{
                IngredientID: line.IngredientID,
                Type:         "out",
                Qty:          qty.Neg(),
                OrderID:      &order.ID,
                IdempotencyKey: "deduct:" + order.ID,
            }
            if err := tx.Create(movement).Error; err != nil { return err }
        }
    }
    return nil
}
```

### Append-only event stream

В `desktop/db.js`:
> `ingredients.qty` — **только через event-stream stock_movements**, не прямой UPDATE.

Текущий остаток = `SUM(stock_movements.qty)` по ingredient_id. Денормализованное поле `ingredients.qty` обновляется через GORM-hook на `AfterCreate StockMovement`:

```go
func (m *StockMovement) AfterCreate(tx *gorm.DB) error {
    var sum decimal.Decimal
    tx.Model(&StockMovement{}).
        Where("ingredient_id = ?", m.IngredientID).
        Select("COALESCE(SUM(qty), 0)").
        Scan(&sum)
    return tx.Model(&Ingredient{}).
        Where("id = ?", m.IngredientID).
        Update("qty", sum).Error
}
```

### Inventory check

Инвентаризация → `inventory_checks` + `inventory_check_lines`. На finalize создаёт `stock_movements` типа `adj` (корректировка).

### Semi-finished

`semi_finished_stock` — отдельный stream. `BatchCooking` производит партию: списывает ингредиенты, прибавляет полуфабрикат.

## 3. ShiftService — кассовые смены

### `OpenShift`

```go
func (s *ShiftService) Open(ctx context.Context, openingBalance decimal.Decimal, accountID string) (*models.CashShift, error) {
    // Проверка: нет уже открытой смены этим кассиром
    var existing models.CashShift
    if err := s.db.Where("opened_by = ? AND closed_at IS NULL", auth.UserFrom(ctx).ID).
        First(&existing).Error; err == nil {
        return nil, errs.New("SHIFT_ALREADY_OPEN")
    }
    // ...
}
```

### `CloseShift`

1. Считает expected_balance = opening + cash_revenue + cash_in - cash_out.
2. Принимает actual_balance от кассира.
3. diff = actual - expected.
4. Закрывает.

### Encashment

Инкассация — `cash_shift_operations` тип `cash_in/cash_out`, +/- к expected.

## 4. FinanceService

### `CreateRevenueEntry` (обязательная функция)

Из v3 ROADMAP:
> **Авто-доход при close_order** — обязательный сервис `create_revenue_entry()` в `close_order`. В текущем коде это пропущено.

В v4 этот пропуск **исправлен**:

```go
func (s *FinanceService) CreateRevenueEntry(tx *gorm.DB, ctx context.Context, order *models.Order) error {
    op := &models.FinancialOperation{
        ID:           uuid.NewString(),
        RestaurantID: tenant.From(ctx),
        AccountID:    paymentAccountID(order),  // cash or bank
        Type:         "in",
        Activity:     "op",
        Amount:       order.Total,
        OrderID:      &order.ID,
        ShiftID:      order.ShiftID,
        IdempotencyKey: "revenue:" + order.ID,
        CreatedAt:    time.Now(),
    }
    return tx.Create(op).Error
}
```

### Иммутабельность операций

`financial_operations` нельзя `UPDATE`/`DELETE`. Корректировка через **сторно**: `is_reversal=true` + `reverses_id` FK на оригинал.

### Бюджет

GORM-hook `AfterCreate FinancialOperation` обновляет `budget_lines.fact_amount` для текущего периода.

## 5. PrintService — ESC/POS

Источник: `lib/print-service.ts` (1063 строки). Содержит:
- CP866 mapping (cyrillic → бинарные коды для термопринтера)
- ESC/POS команды (init, cut, bold, align, qrcode)
- Layout-функции (заголовок, items, totals, QR)
- Snapshot-кейсы (тесты с эталонным hex)

Структура Go:

```
escpos/
├── cp866.go               — мапа cyrillic → CP866 bytes
├── commands.go            — esc/pos command constants
├── builder.go             — fluent API: b.Init().Bold().Text("...").Cut()
├── receipt.go             — БизнесLayout: чек по Order
├── runner.go              — runner на кухню
├── cancel_runner.go       — отмена позиции
├── snapshot_test.go       — golden tests (эталоны из Node-версии)
└── testdata/
    └── golden/
        ├── receipt_simple.hex
        ├── receipt_with_modifiers.hex
        ├── runner_kitchen.hex
        └── ...
```

### Golden tests (критично)

Для каждого типа чека — эталонный hex из текущей Node-версии. Тест:

```go
func TestReceipt_Simple(t *testing.T) {
    order := loadFixture("receipt_simple.json")
    got := receipt.Build(order, restaurantCfg)
    want := loadGolden("receipt_simple.hex")
    require.Equal(t, want, got)
}
```

Если меняем layout — golden обновляется явно командой `make update-golden`. Это защищает от случайных изменений ширины колонок и т.п.

### Печать на принтер

Драйверы в `server/internal/printer/`:
- `tcp.go` — `net.Dial("tcp", "192.168.1.50:9100")` + write
- `usb.go` — через `gousb` (нужен libusb) или системный lpr
- `mock.go` — для dev
- `virtual.go` — пишет hex в файл вместо принтера

### Очередь

`printer/queue.go` — port `lib/print-queue.ts`. Хранит jobs в SQLite (`print_jobs` таблица — новая, не было в v1).

```sql
CREATE TABLE print_jobs (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL,
  printer_id TEXT NOT NULL,
  job_type TEXT NOT NULL CHECK (job_type IN ('receipt','runner','cancel_runner','test')),
  hex BLOB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  order_id TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT
);
```

Worker `printer.Worker` крутится в фоне, тащит pending jobs, шлёт на принтер, retries 3 раза с exp backoff.

## 6. ImportService / ExportService — XLSX

Go библиотека: `github.com/xuri/excelize/v2`.

Порт `lib/import-excel.ts`:
- импорт меню (категории, items, цены)
- импорт техкарт
- импорт ингредиентов
- импорт зон/столов

Порт `lib/export-excel.ts`:
- экспорт смены, заказов, остатков

## 7. AuthService — PIN-логин

Сейчас в `lib/auth-store.tsx` — фронт хранит users и проверяет PIN локально. В v4 это уязвимо (PIN утекает через DevTools).

В v4:
- `POST /api/v1/auth/pin {pin, restaurant_id}` → бэк проверяет, выдаёт `session_token` (JWT короткий + опц. refresh).
- Token хранится в Electron via `electron-store` или OS keychain.
- Middleware проверяет токен, кладёт user в ctx.

## 8. LicenseService — 7+7+lock

Логика (из CLAUDE.md):
> лицензия 7+7+lock

Подробности нужно вытащить из `desktop/api-server.js:/license-check` и `/activate`. PRD будет дополнен после исследования v1-кода в Phase 1.

## 9. Audit logging

GORM-хуки централизованно пишут в `audit_log`:

```go
// server/internal/audit/hooks.go
func RegisterHooks(db *gorm.DB) {
    db.Callback().Create().After("gorm:create").Register("audit:create", func(tx *gorm.DB) {
        if tx.Statement.Schema.Name == "AuditLog" { return }  // не рекурсивно
        writeAudit(tx, "create")
    })
    // ... update, delete
}
```

## 10. Background jobs

`server/internal/jobs/`:

| Job | Cron | Что |
|---|---|---|
| `sync.Push` | `* * * * *` | Раз в минуту пушит `sync_log` в Supabase |
| `print.Retry` | `*/30 * * * * *` | Каждые 30 сек ретраит failed jobs |
| `backup.Daily` | `0 3 * * *` | В 3:00 копирует `restos.db` |
| `audit.Vacuum` | `0 4 1 * *` | 1-го числа в 4:00 чистит audit_log старше 6 мес |
| `license.Check` | `0 6 * * *` | Проверяет лицензию (offline grace) |

Планировщик: `github.com/robfig/cron/v3`.
