# lib/api — клиент v4 (Go-бэк) + shadow-mode

Этот пакет добавляется в Phase 8 [docs/prd/08-MIGRATION-PLAN.md](../../docs/prd/08-MIGRATION-PLAN.md) — параллельный прогон старого Node/Supabase-стека (v1) и нового Go-бэка (v4) на одном и том же UI.

## Файлы

- **`generated.ts`** — ✨ **авто-сгенерированный** OpenAPI → TypeScript. 3254 строки типов на все 67 endpoints (body / response / params / enums). **Не править вручную.** Обновление: `cd server && make ts-client`.

- **`v4-typed.ts`** — типизированный клиент поверх `generated.ts` через `openapi-fetch`. **Рекомендуемый способ** в новом коде:

  ```ts
  import { v4 } from '@/lib/api/v4-typed'

  const { data, error } = await v4.GET('/api/v1/orders', {
    params: { query: { limit: 50, status: 'closed' } },  // ← type-checked
  })
  // data: components['schemas']['OrdersSlimList'] | undefined
  // error: ErrorEnvelope | undefined
  ```

  Опечатки в URL, отсутствие обязательных полей, неверные enum-значения — ловятся компилятором (`tsc --noEmit`).

- **`v4-client.ts`** — `V4Client`: ручная fetch-обёртка с удобными методами (`v4.listOrders()`, `v4.login()`, ...). Управляет token-storage в localStorage, автоматически генерирует `Idempotency-Key` для write-запросов, оборачивает ошибки в `V4Error{status, bodyText, envelope()}`. Используй когда нужна простота без openapi-fetch overhead.

- **`shadow.ts`** — `shadowCall(key, v1Fn, v4Fn)` для параллельного прогона v1↔v4 (Phase 8). Запускает обе функции параллельно, отдаёт результат primary, сравнивает payload'ы канонически (sorted keys), пушит `ShadowReportItem` в `ShadowReporter`. Reporter батчит и шлёт раз в 10 секунд на `POST /api/v1/admin/shadow/reports`.

## Включение в проде

```ts
// bootstrap (например в src/main.tsx):
import { createV4Client } from '@/lib/api/v4-client'
import { initShadowReporter, enableShadow } from '@/lib/api/shadow'

const v4 = createV4Client({ appVersion: APP_VERSION })
await v4.login(restaurantId, pin)
initShadowReporter(v4)
// Включить shadow — кассир/менеджер в Settings нажимает кнопку.
enableShadow('v1') // primary = v1, v4 идёт в shadow
```

В компонентах:

```ts
// Было:
const orders = await fetchOrdersV1(filter)

// Стало:
const orders = await shadowCall(
  'orders.list',
  () => fetchOrdersV1(filter),
  () => v4.listOrders(filter),
)
```

## Метрики

Owner Dashboard читает агрегаты:

```
GET /api/v1/admin/shadow/stats?from=...&to=...
→ {
  total: 14823,
  matched: 14770,
  match_rate: 0.9964,
  by_operation: [
    { operation: "menu.items.list", total: 5400, matched: 5400, match_rate: 1.0 },
    { operation: "orders.list",     total: 1200, matched: 1147, match_rate: 0.9558, avg_v1_latency_ms: 87, avg_v4_latency_ms: 4 }
  ]
}

GET /api/v1/admin/shadow/drifts?limit=50
→ последние 50 расхождений с sample (для debug)
```

Когда `match_rate > 0.99` для всех operations стабильно ≥24 часа на нескольких кассах — можно переключать `enableShadow('v4')` и готовить cutover (Phase 9).

## Что НЕ делает

- Не оборачивает write-операции. В shadow-mode мы только читаем из обеих систем, чтобы убедиться что v4 даёт те же данные. Write остаётся в v1 до Phase 9.
- Не пишет в БД сам. Все данные через `V4Client.reportShadowBatch` уходят в табличку `shadow_drifts` на v4 backend.
