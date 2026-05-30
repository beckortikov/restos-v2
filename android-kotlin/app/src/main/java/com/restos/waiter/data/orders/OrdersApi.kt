package com.restos.waiter.data.orders

import com.restos.waiter.data.common.PagedEnvelope
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.Header
import retrofit2.http.PATCH
import retrofit2.http.POST
import retrofit2.http.Path
import retrofit2.http.Query

/**
 * v4 Go-бэк REST contract:
 *   - все ID — UUID-строки;
 *   - list-эндпоинты возвращают `{data:[], next_cursor:""}` (PagedEnvelope);
 *   - single-эндпоинты возвращают плоский Order, без `{data: ...}` обёртки;
 *   - бэк сам берёт restaurant_id из токена.
 */
interface OrdersApi {
    /**
     * Список заказов. `created_at_from` (ISO-8601 RFC3339) фильтрует
     * по времени создания. `waiter_id` — заменяет v3 `/orders/me/`.
     */
    @GET("api/v1/orders")
    suspend fun listOrders(
        @Query("created_at_from") createdAtFrom: String? = null,
        @Query("status") status: String? = null,
        @Query("waiter_id") waiterId: String? = null,
        @Query("limit") limit: Int? = 200,
    ): PagedEnvelope<OrderDto>

    /**
     * v4 detail endpoint возвращает envelope `{order, items, voids}` (см.
     * server/internal/service/orders.go::OrderDetail). UI работает с плоским
     * OrderDto — слияние делает OrderDetailRepository.retrieveFlat().
     */
    @GET("api/v1/orders/{id}")
    suspend fun retrieve(@Path("id") id: String): OrderDetailEnvelope

    /**
     * `idemKey` — стабильный UUID; при retry должен быть тем же, иначе
     * добавление позиций задублируется.
     */
    @POST("api/v1/orders/{id}/items")
    suspend fun addItems(
        @Path("id") id: String,
        @Header("Idempotency-Key") idemKey: String,
        @Body body: AddItemsRequest,
    ): OrderDto

    /**
     * v4: `POST /orders/{id}/items/{itemId}/void` — itemId в path, в body
     * только причина.
     */
    @POST("api/v1/orders/{id}/items/{itemId}/void")
    suspend fun cancelItem(
        @Path("id") id: String,
        @Path("itemId") itemId: String,
        @Body body: CancelItemRequest,
    ): OrderDto

    @POST("api/v1/orders/{id}/cancel")
    suspend fun cancelOrder(
        @Path("id") id: String,
        @Body body: CancelOrderRequest,
    ): OrderDto

    @POST("api/v1/orders/{id}/transfer")
    suspend fun transfer(
        @Path("id") id: String,
        @Body body: TransferRequest,
    ): OrderDto

    /**
     * v4: PATCH /orders/{id}/items/{itemId}/note — комментарий к позиции.
     * `note=null` или пустая строка → очищает.
     */
    @PATCH("api/v1/orders/{orderId}/items/{itemId}/note")
    suspend fun setItemNote(
        @Path("orderId") orderId: String,
        @Path("itemId") itemId: String,
        @Body body: SetItemNoteRequest,
    ): RawOrderItem

    /**
     * v4: POST /orders/{id}/print-pre-bill — печать предварительного чека.
     * Заказ не закрывается; возвращает ссылку на PrintJob.
     */
    @POST("api/v1/orders/{orderId}/print-pre-bill")
    suspend fun printPreBill(@Path("orderId") orderId: String): PrintJobRefDto

    // -------- stubs: эндпоинтов на v4 пока нет (см. CLAUDE.md в android-kotlin/) --------

    // TODO(v4-port): /orders/{id}/request_bill не реализован — пока нет
    //   статусной PATCH-операции; UI получит no-op (просто не меняет статус
    //   на стороне сервера). Возможно вернётся как `POST /orders/{id}/status`.

    // TODO(v4-port): waiter reassignment — v4 переезжает на
    //   `POST /api/v1/tables/{tableId}/assign-waiter` (см. TablesApi).
    //   В OrderDetailRepository вызов проксируется в TablesApi.
}

@Serializable
data class SetItemNoteRequest(val note: String?)

@Serializable
data class PrintJobRefDto(
    @SerialName("job_id") val jobId: String,
    val status: String,
)

// v4 не поддерживает stats по официанту — оставлен как «нулевой» по контракту,
// чтобы UI WaiterShellViewModel компилировался. См. ShellRepository.statsToday().
@Serializable
data class WaiterTodayStats(
    @SerialName("orders_count") val ordersCount: Int = 0,
    val total: String = "0",
    @SerialName("service_charge") val serviceCharge: String = "0",
    val tip: String = "0",
)

@Serializable
data class AddItemsRequest(val items: List<NewOrderItem>)

/**
 * v4: id меню — String (UUID), qty передаём строкой decimal-safe (бэк парсит
 * через `shopspring/decimal`).
 */
@Serializable
data class NewOrderItem(
    @SerialName("menu_item_id") val menuItemId: String,
    val qty: String,
    val note: String = "",
    @SerialName("modifier_ids") val modifierIds: List<String> = emptyList(),
) {
    constructor(menuItemId: String, qty: Int, note: String = "") :
        this(menuItemId = menuItemId, qty = qty.toString(), note = note)
}

@Serializable
data class CancelItemRequest(val reason: String)

@Serializable
data class CancelOrderRequest(val reason: String)

@Serializable
data class TransferRequest(@SerialName("table_id") val tableId: String)

/**
 * Envelope для `GET /api/v1/orders/{id}` — сервер возвращает Order вместе
 * с relation'ами отдельными списками (см. server/internal/service/orders.go
 * `OrderDetail`). Мы парсим envelope как есть и потом плющим его в OrderDto
 * в OrderDetailRepository.
 *
 * Серверные OrderItem/OrderVoid имеют другие имена полей (`name`/`price`
 * вместо `name_at_order`/`price_at_order` и `qty` как decimal-string),
 * поэтому здесь объявляем "сырые" DTO и маппим в Kotlin-DTO на границе.
 */
@Serializable
data class OrderDetailEnvelope(
    val order: OrderDto,
    val items: List<RawOrderItem> = emptyList(),
    val voids: List<RawOrderVoid> = emptyList(),
)

/**
 * Сырая позиция как её отдаёт Go-бэк (`models.OrderItem`). Имена полей —
 * 1:1 с json-тегами в `server/internal/db/models/orders.go::OrderItem`.
 * `qty`/`price` — decimal-string (см. `decimal.Decimal MarshalJSON`).
 *
 * Сервер НЕ возвращает `sent_to_kitchen_at` и `kitchen_status` на уровне
 * item — есть только `served_at` и `printed_at`. Производное «состояние
 * кухни» (cooking/ready/served) UI выводит из таймстампов сам.
 */
@Serializable
data class RawOrderItem(
    val id: String,
    @SerialName("order_id") val orderId: String? = null,
    @SerialName("menu_item_id") val menuItemId: String? = null,
    val name: String? = null,
    val note: String? = null,
    val qty: String = "0",
    val price: String = "0",
    val cogs: String = "0",
    val unit: String? = null,
    @SerialName("unit_size") val unitSize: String = "1",
    @SerialName("cancelled_at") val cancelledAt: String? = null,
    @SerialName("cancel_reason") val cancelReason: String? = null,
    @SerialName("printed_at") val printedAt: String? = null,
    @SerialName("served_at") val servedAt: String? = null,
    @SerialName("created_at") val createdAt: String? = null,
)

/** Сырое void-событие как отдаёт бэк (`models.OrderVoid`). */
@Serializable
data class RawOrderVoid(
    val id: String,
    @SerialName("order_id") val orderId: String? = null,
    @SerialName("item_name") val itemName: String? = null,
    @SerialName("item_qty") val itemQty: Int? = 1,
    @SerialName("item_price") val itemPrice: String = "0",
    val reason: String? = null,
    @SerialName("approved_by_name") val approvedByName: String? = null,
    @SerialName("created_by_name") val createdByName: String? = null,
    @SerialName("created_at") val createdAt: String? = null,
)

/**
 * Маппинг сырой item -> UI-DTO. UI-имена (`nameAtOrder`/`priceAtOrder`)
 * — наследие v3; сервер v4 отдаёт `name`/`price` напрямую.
 */
internal fun RawOrderItem.toDto(): OrderItemDto = OrderItemDto(
    id = id,
    menuItem = menuItemId,
    nameAtOrder = name.orEmpty(),
    priceAtOrder = price,
    qty = qty.toIntSafe(),
    note = note.orEmpty(),
    cancelledAt = cancelledAt,
    sentToKitchenAt = printedAt, // server возвращает только printed_at; на печать = «ушло на кухню»
    servedAt = servedAt,
    kitchenStatus = null, // не приходит с сервера; UI вычисляет из servedAt/printedAt
)

internal fun RawOrderVoid.toDto(): CancelledItemDto = CancelledItemDto(
    id = id,
    menuItem = null,
    nameAtOrder = itemName.orEmpty(),
    priceAtOrder = itemPrice,
    qty = itemQty ?: 1,
    cancelReason = reason.orEmpty(),
    cancelledAt = createdAt,
    cancelledByName = createdByName,
)

private fun String.toIntSafe(): Int =
    runCatching { java.math.BigDecimal(this).toInt() }.getOrDefault(0)

/**
 * Контракт v4 (см. `server/internal/db/models/orders.go::Order` и
 * `server/internal/service/orders.go::OrderSlim`).
 *
 * Сервер отдаёт:
 *   - flat-поля Order по json-тегам: `type`/`table_id`/`waiter_id`/
 *     `service_amount`/`total_with_service`/... — не `order_type`/`table`/
 *     `waiter`/`service_charge_amount`, как было в v3.
 *   - `items`/`voids` НЕ возвращаются в OrderDto напрямую. Они приходят
 *     отдельным envelope `{order, items, voids}` в `GET /orders/{id}`
 *     (см. `OrderDetailEnvelope`) и потом сшиваются в `OrderDetailRepository`.
 *   - `OrderSlim` (list) — компактная карточка без discount/service_amount.
 *
 * Производные поля (`tableName`/`tableZoneName`/`waiterName`/`statusDisplay`/
 * `subtotal`/`billRequestedAt`) сервер v4 НЕ возвращает — это наследие v3.
 * Они оставлены как nullable для совместимости с UI; реально вычисляются
 * клиентом по lookup'у в Tables/Users (см. репозитории в `data/tables/`).
 *
 * Имена Kotlin-полей сохранены v3-style (`orderType`, `table`, `waiter`),
 * чтобы не ломать 20+ UI-консьюмеров. JSON-теги переведены на v4.
 */
@Serializable
data class OrderDto(
    val id: String,
    @SerialName("order_number") val orderNumber: Int? = null,
    val status: String = "new",
    @SerialName("type") val orderType: String = "hall",
    @SerialName("table_id") val table: String? = null,
    @SerialName("waiter_id") val waiter: String? = null,
    @SerialName("cashier_id") val cashier: String? = null,
    @SerialName("guests_count") val guestsCount: Int = 0,
    val total: String = "0",
    @SerialName("service_percent") val servicePercent: String = "0",
    @SerialName("service_amount") val serviceChargeAmount: String = "0",
    @SerialName("total_with_service") val totalWithService: String = "0",
    @SerialName("discount_type") val discountType: String? = null,
    @SerialName("discount_value") val discountValue: String = "0",
    @SerialName("discount_amount") val discountAmount: String = "0",
    @SerialName("tip_amount") val tipAmount: String = "0",
    @SerialName("payment_method") val paymentMethod: String? = null,
    @SerialName("shift_id") val shiftId: String? = null,
    @SerialName("restaurant_id") val restaurantId: String? = null,
    @SerialName("kitchen_started_at") val kitchenStartedAt: String? = null,
    @SerialName("ready_at") val readyAt: String? = null,
    @SerialName("expected_ready_at") val expectedReadyAt: String? = null,
    @SerialName("closed_at") val closedAt: String? = null,
    @SerialName("cancelled_at") val cancelledAt: String? = null,
    @SerialName("cancel_reason") val cancelReason: String? = null,
    @SerialName("created_at") val createdAt: String,
    @SerialName("updated_at") val updatedAt: String = createdAt,
    val comment: String = "",

    // ── Поля, заполняемые клиентом (envelope-merge или enrichment),
    //    сервер их НЕ присылает. Сериализация транзитная: при retrofit'е
    //    они придут с дефолтами; затем `OrderDetailRepository` копирует
    //    в `items`/`cancelledItems` из envelope.
    val items: List<OrderItemDto> = emptyList(),
    val cancelledItems: List<CancelledItemDto> = emptyList(),

    // ── client-computed display fields (нет на сервере; UI делает lookup
    //    по tables/users/zones). Объявлены здесь, потому что UI читает
    //    `order.tableName` напрямую. Если решим почистить — нужен enrich-слой.
    val tableName: String? = null,
    val tableZoneName: String? = null,
    val waiterName: String? = null,
    val statusDisplay: String? = null,
    val billRequestedAt: String? = null,
    val subtotal: String = "0",
)

/**
 * UI-DTO отменённой позиции. Маппится из `RawOrderVoid` (см. `toDto`).
 * Сервер v4 хранит `OrderVoid` с полями `item_name`/`item_qty`/`item_price`/
 * `reason`/`created_at`/`created_by_name` — не `name_at_order`/`price_at_order`.
 */
@Serializable
data class CancelledItemDto(
    val id: String,
    val menuItem: String? = null,
    val nameAtOrder: String,
    val priceAtOrder: String,
    val qty: Int,
    val cancelReason: String = "",
    val cancelledAt: String? = null,
    val cancelledByName: String? = null,
)

/**
 * UI-DTO позиции заказа. На сетевой уровень напрямую НЕ десериализуется —
 * сервер v4 отдаёт `RawOrderItem` (поля `name`/`price`/`qty` decimal-string),
 * а маппинг в этот DTO выполняет `RawOrderItem.toDto()`.
 *
 * Имена `nameAtOrder`/`priceAtOrder` — наследие v3, сохранены ради UI.
 * `kitchenStatus`/`sentToKitchenAt` сервер v4 НЕ возвращает на уровне item;
 * UI выводит производное состояние из `servedAt`/`printedAt`.
 * `subtotal` сервер не считает per-item — оставлено для совместимости.
 *
 * TODO(api-strict): `qty: Int` срезает дробные количества (весовые блюда).
 * Для перехода на `qty: String` нужно адаптировать ~10 UI-консьюмеров.
 */
@Serializable
data class OrderItemDto(
    val id: String,
    val menuItem: String? = null,
    val nameAtOrder: String,
    val priceAtOrder: String,
    val qty: Int,
    val note: String = "",
    val cancelledAt: String? = null,
    val sentToKitchenAt: String? = null,
    val servedAt: String? = null,
    val kitchenStatus: String? = null,
    val subtotal: String = "0",
)

/** Статусы заказа — формально совпадают с v3 (бэк-портировал). */
object OrderStatus {
    // v4 бэк создаёт заказы со status='open'. Старое v3 API использовало 'new'.
    // Поддерживаем оба для совместимости с историческими записями.
    const val OPEN = "open"
    const val NEW = "new"
    const val COOKING = "cooking"
    const val READY = "ready"
    const val SERVED = "served"
    const val BILL_REQUESTED = "bill_requested"
    const val DONE = "done"
    const val CANCELLED = "cancelled"

    fun isActive(status: String): Boolean =
        status == OPEN || status == NEW || status == COOKING ||
            status == READY || status == SERVED || status == BILL_REQUESTED
}

/**
 * Хардкод-перечень причин отмены — v4 не имеет CRUD для cancel_reasons.
 * См. CancelReasons.kt.
 */
object CancelReasons {
    enum class Kind { Item, Order }

    data class Reason(val code: String, val label: String)

    private val item = listOf(
        Reason("forgot", "Забыли"),
        Reason("spoiled", "Испорчено"),
        Reason("customer_request", "По просьбе клиента"),
        Reason("wrong_order", "Ошибка заказа"),
    )

    private val order = listOf(
        Reason("customer_request", "По просьбе клиента"),
        Reason("kitchen_cancelled", "Кухня отменила"),
        Reason("waiter_mistake", "Ошибка официанта"),
        Reason("no_ingredient", "Нет ингредиента"),
    )

    fun list(kind: Kind): List<Reason> = if (kind == Kind.Item) item else order
}
