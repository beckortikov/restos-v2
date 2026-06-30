# 05 — Приложение официанта (Android / Kotlin)

Нативный апп официанта в `android-kotlin/` (не Capacitor!). LAN-only планшетный UI, плотно
завязанный на Go-бэк по `http://<ip-кассы>:3002`. Стек: Kotlin 2.1 + Jetpack Compose, Hilt (DI),
Retrofit/OkHttp (+ okhttp-sse), kotlinx.serialization, CameraX + ML Kit (QR), DataStore.

---

## 1. Сборка и зависимости

**`android-kotlin/app/build.gradle.kts`:**

| Параметр | Значение |
|---|---|
| `applicationId` / `namespace` | `com.restos.waiter` |
| `minSdk` / `targetSdk` / `compileSdk` | 26 / 35 / 35 |
| `versionCode` / `versionName` | 14 / `0.2.12` (на момент написания) |
| `jvmTarget` | 17 |
| **release-подпись** | **debug-ключом** (`signingConfig = signingConfigs.getByName("debug")`) — LAN-сайдлоад без Play Store; иначе `assembleRelease` даёт неподписанный APK, который Android не ставит (см. [06](06-build-run-dev.md)) |
| release | `isMinifyEnabled=true` + `isShrinkResources=true` (ProGuard) |

`buildConfigField("String","API_BASE_URL","\"http://10.0.2.2:3001/\"")` — **только плейсхолдер** для
инициализации Retrofit. ⚠️ Порт `3001` тут **устаревший**: реальный хост приходит из онбординга
(QR/ручной ввод), где касса отдаёт `http://<lan-ip>:3002`, и подменяется `HostRedirectInterceptor`.
Стоит вычистить плейсхолдер до `:3002`, чтобы не путать.

Версии библиотек — `android-kotlin/gradle/libs.versions.toml`: Compose BOM, Navigation Compose,
Hilt (+KSP), Retrofit 2.11, OkHttp 4.12 (+ logging, sse), kotlinx-serialization, DataStore, CameraX,
ML Kit Barcode, Accompanist Permissions, Coil.

---

## 2. Структура (пакет `com.restos.waiter`)

```
app/src/main/java/com/restos/waiter/
├── MainActivity.kt            @AndroidEntryPoint
├── WaiterApp.kt               @HiltAndroidApp
├── ui/                        — Compose-экраны + ViewModels
│   ├── WaiterNavGraph.kt      — навигация
│   ├── auth/AuthGateViewModel.kt
│   ├── login/   {PinLoginScreen, PinLoginViewModel}
│   ├── onboarding/ {OnboardingScreen, OnboardingViewModel, QrScanner}
│   ├── shell/   {WaiterShell, WaiterShellViewModel}
│   ├── tables/  {TablesScreen, SelectTableForNewOrderScreen}
│   ├── composer/{NewOrderScreen, NewOrderViewModel, GuestsDialog, WeightDialog}
│   ├── order/   {OrderDetailScreen, OrderDetailViewModel}
│   ├── orders/  {ActiveOrdersScreen, KitchenScreen}
│   ├── lan/LanGuard.kt
│   └── theme/Theme.kt
└── data/                      — данные
    ├── net/   {NetworkModule, HostRedirectInterceptor, AuthInterceptor,
    │           IdempotencyInterceptor, NetworkProbe, ApiEnvelope}
    ├── auth/  {AuthApi, AuthRepository, TokenStore}
    ├── config/ServerConfigStore.kt
    ├── orders/{OrdersApi, CreateOrderApi, OrderDetailRepository, DTOs}
    ├── tables/{TablesApi, TablesRepository, DTOs}
    ├── menu/  {MenuApi, DTOs}
    ├── users/ {UsersApi}
    ├── kitchen/{KitchenApi}
    ├── onboarding/{LicenseApi}
    ├── events/{EventStreamClient, EventBus}
    ├── cache/AppCache.kt
    ├── preferences/WaiterPrefsStore.kt
    └── drafts/{WaiterDraft, WaiterDraftStore}
```

Архитектура — **MVVM**: Compose-экран ↔ `@HiltViewModel` (StateFlow) ↔ Repository ↔ Api/DataStore.

---

## 3. DI (Hilt)

**`data/net/NetworkModule.kt`** (`@InstallIn(SingletonComponent)`) предоставляет синглтоны:
`Json` (ignoreUnknownKeys, coerceInputValues), `NetworkConfig`, `OkHttpClient` (цепочка
интерсепторов), `Retrofit`, и все Api (`AuthApi`, `TablesApi`, `OrdersApi`, `UsersApi`, `MenuApi`,
`CreateOrderApi`, `KitchenApi`, `LicenseApi`).

Через конструкторный `@Inject` — синглтоны `TokenStore`, `ServerConfigStore`, `EventBus`,
`AppCache`, `WaiterPrefsStore` (все, кроме EventBus/AppCache, держат `@ApplicationContext` для
DataStore). ViewModels — `@HiltViewModel` + `hiltViewModel()` в Compose.

---

## 4. Сеть

### Retrofit Api

`suspend`-методы, напр. `AuthApi`:
```kotlin
@POST("api/v1/auth/login")
suspend fun loginWithPin(@Body body: PinLoginRequest,
    @Header(AuthInterceptor.SKIP_AUTH_HEADER) skipAuth: String = "1"): PinLoginResponse
```
Эндпоинты: orders (`GET/POST /orders`, `/items`, `/items/{id}/void`), tables (`/zones`, `/tables`,
`/tables/{id}/assign-waiter`), menu (`/menu/items`, `/categories`), users, kitchen
(`/items/{id}/served`), license (`GET /api/v1/public/machine-info` — публичный).

### Цепочка интерсепторов (`NetworkModule`)

1. **HostRedirectInterceptor** — подменяет scheme/host/port на реальный из `ServerConfigStore`
   (`runBlocking { configStore.current() }`). Retrofit видит плейсхолдер, OkHttp бьёт по настоящему URL.
2. **AuthInterceptor** — добавляет `Authorization: Bearer <token>` (кроме запросов с `SKIP_AUTH_HEADER`,
   напр. логин). На **401** при наличии токена — `tokenStore.clear()` (рефреша нет → UI ведёт на PIN).
3. **IdempotencyInterceptor** — `Idempotency-Key: <uuid>` на write.
4. **HttpLoggingInterceptor** — BODY в debug, NONE в release.

### SSE — `data/events/EventStreamClient.kt` + `EventBus.kt`

`GET /api/v1/events` через okhttp-sse, авто-реконнект с экспоненциальным backoff (1→2→4→…→30 с),
readTimeout 0. События маппятся в `ServerEvent` (`order.created/updated`, `table.updated`,
`resync/ping → Resync`, прочее → `Other`) и эмитятся в `EventBus` (`MutableSharedFlow`,
буфер 64). ViewModels подписываются: `eventBus.events.collect { … }` и перезагружают данные.

---

## 5. Онбординг и хост

**`data/config/ServerConfigStore.kt`** (DataStore): `base_url`, `restaurant_id`, `restaurant_name`
(+ flow-обзёрверы). Поток:
1. Пользователь сканирует **QR** (`ui/onboarding/QrScanner.kt` — CameraX + ML Kit, формат QR) или
   вводит URL вручную.
2. `OnboardingViewModel.probe(baseUrl)` дёргает `GET <baseUrl>api/v1/public/machine-info` → бэк
   возвращает `{machine_id, restaurant_id, restaurant_name}`.
3. `configStore.save(url, restaurantId, restaurantName)` — нормализует URL (`http://` + слэш), пишет в DataStore.
4. Навигация на логин.

`usesCleartextTraffic="true"` в манифесте — разрешает `http://` (только LAN). Permission `CAMERA`
(через Accompanist), `INTERNET`, `ACCESS_NETWORK_STATE`.

---

## 6. Навигация и экраны

**`ui/WaiterNavGraph.kt`** — маршруты: `ONBOARDING`, `LOGIN`, `APP` (shell с табами Tables/Orders),
`SELECT_TABLE`, `ORDER_NEW` (`order/new?tableId=…&orderId=…`), `ORDER_DETAIL` (`order/{orderId}`).
Стартовый экран выбирает **`AuthGateViewModel`** (`ui/auth/AuthGateViewModel.kt`):
```kotlin
combine(authRepo.isLoggedIn, serverConfig.baseUrlFlow) { loggedIn, baseUrl ->
  when { baseUrl.isNullOrBlank() -> NeedsOnboarding; loggedIn -> LoggedIn; else -> LoggedOut }
}
```

Экраны:
- **PIN-логин** (`ui/login/*`): ввод PIN → `AuthRepository.loginWithPin` → сохранить токен.
- **Онбординг** (`ui/onboarding/*`): QR/URL → probe → `ServerConfigStore`.
- **Shell** (`ui/shell/*`): табы Tables/Orders; статистика дня считается **на клиенте** из закрытых
  заказов (в v4 нет `/orders/me/stats/today`); слушает EventBus (на `OrderCreated/Updated/Resync` —
  пересчёт); logout; UI-префы (`WaiterPrefsStore`).
- **Tables** (`ui/tables/*`): сетка/список столов, тап → детали/новый заказ/резюме черновика.
- **Композер** (`ui/composer/*`): меню из кэша, добавление позиций, диалоги гостей и **веса**
  (`WeightDialog` для весовых) → `POST /orders`.
- **Order Detail** (`ui/order/*`): заказ + позиции/voids, группы (несколько заказов на столе),
  действия (добавить, отменить позицию, served/unserved, сменить официанта/стол, отменить заказ);
  слушает EventBus.
- **LanGuard** (`ui/lan/LanGuard.kt`): оверлей при потере связи с бэком (`NetworkProbe`), кнопка Retry.

### Auth (`data/auth/`)

- `AuthRepository.loginWithPin(pin)`: `restaurant_id` из `ServerConfigStore` → `POST /auth/login` →
  сохранить токен+user+restaurant в `TokenStore`. `me()` — из кэша `TokenStore.meFlow` (нет
  `/auth/me`). `logout()` — best-effort `POST /auth/logout` + очистка.
- `TokenStore` (DataStore): `TOKEN`, `USER_JSON`, `RESTAURANT_JSON`; `tokenFlow`, `meFlow`.
- **Рефреша токена нет** — один токен, на 401 чистим и ведём на логин.

---

## 7. Хранилища и кэш

| Стор | Файл | Что |
|---|---|---|
| TokenStore | `data/auth/TokenStore.kt` | токен, user, restaurant |
| ServerConfigStore | `data/config/ServerConfigStore.kt` | base_url, restaurant_id, name |
| WaiterPrefsStore | `data/preferences/WaiterPrefsStore.kt` | viewMode, homeScreen, tablesTab |
| WaiterDraftStore | `data/drafts/WaiterDraftStore.kt` | черновики неотправленных заказов |
| AppCache | `data/cache/AppCache.kt` | in-memory снапшоты (меню, столы, заказы, юзеры) для мгновенных экранов |

---

## 8. Сборка APK

```bash
pnpm waiter:apk          # release → android-kotlin/app/build/outputs/apk/release/app-release.apk
pnpm waiter:apk-debug    # debug   → .../apk/debug/app-debug.apk
# или из android-kotlin/: ./gradlew assembleRelease | assembleDebug | :app:installDebug
```
`JAVA_HOME` по умолчанию — JBR из Android Studio (см. скрипты в корневом `package.json`). Установка:
`adb install -r <apk>` или копирование на планшет. Подробнее и про подпись — [06](06-build-run-dev.md).

---

## 9. Известные ограничения v4-порта (из README/комментариев)

- нет `/auth/me` (профиль кэшируется на логине — устаревает при смене прав);
- нет `/orders/me/stats/today` (статистика считается на клиенте);
- пре-чек/`print_pre_bill` — частично заглушки;
- заметка к позиции (`note`) не персистится;
- модификаторы пока не маппятся в UI заказа;
- `qty: Int` обрезает дробные — весовым нужен String-qty (рефактор UI);
- переназначение официанта — через `POST /tables/{id}/assign-waiter`.
