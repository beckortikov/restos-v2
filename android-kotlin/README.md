# RestOS Waiter (Kotlin Compose — v4)

Android-планшет для официанта. **Только LAN** к локальному Go-бэку RestOS v4.

Скопировано из `restos-v3/android-kotlin/` и портировано под v4-контракт:
- Go-бэк (chi + GORM + PostgreSQL 16) на `http://<lan-ip>:3001`.
- Один токен на сессию, без refresh.
- Все ID — UUID-строки (а не Long, как в Django v3).

См. также корневой `../CLAUDE.md` для гайдлайнов проекта.

---

## Архитектура

| Слой | Что |
|---|---|
| UI | Jetpack Compose + Material3, Hilt-навигация |
| State | Hilt-ViewModels + StateFlow |
| Network | Retrofit2 + OkHttp + kotlinx.serialization |
| Persistence | DataStore (preferences) — token, drafts, prefs, server config |
| Realtime | SSE через `okhttp3.sse` (`/api/v1/events`) |
| DI | Hilt (KSP) |

---

## v3 → v4: ключевые отличия

### Auth

- **Эндпоинт:** `POST /api/v1/auth/login` принимает `{pin, restaurant_id}` (multi-tenant).
- **Ответ:** `{token, user, restaurant}` — плоский, без `{data: ...}` envelope.
- **Refresh нет.** На 401 интерцептор чистит токен; UI редиректит на PIN-экран.
- **`/auth/me` нет.** Профиль кэшируется локально в `TokenStore` из `PinLoginResponse`.
- `TokenAuthenticator` удалён.

### IDs

Все ID — `String` (UUID), а не `Long`:
- `UserDto.id`, `RestaurantDto.id`, `OrderDto.id`, `TableDto.id`, `ZoneDto.id`,
  `MenuItemDto.id`, `CategoryDto.id`, `OrderItemDto.id`, и т.д.
- Nav-аргументы `orderId` / `tableId` — `NavType.StringType`, sentinel `""=null`.
- Все ViewModels с `myUserId: Long?` → `String?`.

### Response envelopes

- **Single-resource:** плоский объект (`Order`, не `{data: Order}`).
- **List:** `{data: [...], next_cursor: ""}` — см. `ListEnvelope` / `PagedEnvelope`.
- **Error:** `{error: {code, message, detail}}` — `ApiError` (без изменений).

### Эндпоинты

| v3 Django | v4 Go |
|---|---|
| `POST /auth/waiter/pin/` | `POST /auth/login` (с `restaurant_id`) |
| `GET /auth/me/` | удалён — локальный кэш |
| `POST /auth/refresh/` | удалён |
| `POST /auth/pin/logout/` | `POST /auth/logout` |
| `GET /tables/zones/` | `GET /zones` |
| `GET /cancel_reasons/` | удалён — хардкод `CancelReasons` enum |
| `GET /orders/me/` | `GET /orders?waiter_id=<uuid>` |
| `GET /orders/me/stats/today/` | удалён — считаем на клиенте в `WaiterShellViewModel` |
| `POST /orders/{id}/cancel_item/` | `POST /orders/{id}/items/{itemId}/void` |
| `POST /orders/{id}/assign_waiter/` | `POST /tables/{tableId}/assign-waiter` |
| `POST /orders/{id}/request_bill/` | **stub no-op** (локальный статус) |
| `POST /orders/{id}/print_pre_bill/` | **stub no-op** (client-side concern) |
| `POST /orders/{id}/set_item_note/` | **stub no-op** (локальная заметка) |
| `POST /kitchen/items/{id}/mark_served/` | `POST /orders/{orderId}/items/{itemId}/served` |
| `POST /kitchen/items/{id}/unmark_served/` | `DELETE /orders/{orderId}/items/{itemId}/served` |
| `GET /events/` SSE | `GET /events` SSE — события типизованы (`order.created`, `order.updated`, `table.updated`, `resync`) |

Каждый stub помечен в коде `// TODO(v4-port): ...`.

### Onboarding

При первом запуске:
1. Сканируем QR с экрана кассы (или вводим URL вручную).
2. Дёргаем публичный `GET /api/v1/license/machine-id` (без токена) — возвращает
   `{machine_id, restaurant_id, restaurant_name}`.
3. Сохраняем `baseUrl + restaurantId + restaurantName` в `ServerConfigStore`.
4. Дальше PIN-логин уже знает, в какой ресторан стучаться.

`NetworkProbe` (LAN-guard) дёргает тот же `/license/machine-id` — публичный
эндпоинт, не требует токена.

---

## Полностью удалено (dead code из v3)

- `data/net/TokenAuthenticator.kt` — refresh-цикл, не нужен.
- `data/orders/CancelReasonsApi.kt` — нет CRUD на v4, причины хардкодим.
- Поля `access`/`refresh` в `Tokens` — теперь один `token`.
- `MeEnvelope` / `MeData` (как API-DTO) — `MeData` остаётся как локальная модель
  кэша, формируется из логина.

---

## Команды

```bash
# Сборка APK (нужен Android SDK)
./gradlew :app:assembleDebug

# Установить на устройство в одной LAN с Go-бэком
./gradlew :app:installDebug
```

API_BASE_URL в `app/build.gradle.kts` — placeholder
(`http://10.0.2.2:3001/`). Реальный host подменяется
`HostRedirectInterceptor` из `ServerConfigStore` на каждом запросе.

---

## Network discovery debug

Если приложение не находит бэк:
1. Проверьте, что Go-бэк слушает на 0.0.0.0:3001 (не на 127.0.0.1).
2. Проверьте, что планшет в той же Wi-Fi сети, что и кассирская машина.
3. `adb shell ping <ip-кассы>` должен отвечать.
4. `curl http://<ip-кассы>:3001/api/v1/license/machine-id` должен вернуть JSON.

---

## Известные ограничения v4-порта

- `print_pre_bill` / `request_bill` — заглушки. UI меняет локальный state, но
  на сервере ничего не происходит. Реализовать когда бэк добавит эндпоинты.
- `set_item_note` — заметка живёт только в текущем `OrderDetailUiState`,
  при перезагрузке экрана пропадает. Заметку при `addItems` бэк сохраняет.
- `WaiterTodayStats` собирается на клиенте через листинг заказов;
  на 1000+ заказов в день это начнёт лагать. Перенести на бэк-эндпоинт.
- Поле `OrderDto.id` в title-bar показывается как UUID-строка (длинная) —
  по-хорошему бэк должен возвращать `human_order_number`.
