package com.restos.waiter.data.orders

import com.restos.waiter.data.common.PagedEnvelope
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import retrofit2.http.Body
import retrofit2.http.GET
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

    @GET("api/v1/orders/{id}")
    suspend fun retrieve(@Path("id") id: String): OrderDto

    @POST("api/v1/orders/{id}/items")
    suspend fun addItems(
        @Path("id") id: String,
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
    ): OrderItemDto

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

@Serializable
data class OrderDto(
    val id: String,
    val status: String,
    @SerialName("status_display") val statusDisplay: String? = null,
    @SerialName("order_type") val orderType: String = "hall",
    val table: String? = null,
    @SerialName("table_name") val tableName: String? = null,
    @SerialName("table_zone_name") val tableZoneName: String? = null,
    val waiter: String? = null,
    @SerialName("waiter_name") val waiterName: String? = null,
    @SerialName("guests_count") val guestsCount: Int = 0,
    val subtotal: String = "0",
    val total: String = "0",
    @SerialName("service_charge_amount") val serviceChargeAmount: String = "0",
    @SerialName("discount_amount") val discountAmount: String = "0",
    @SerialName("tip_amount") val tipAmount: String = "0",
    val items: List<OrderItemDto> = emptyList(),
    @SerialName("cancelled_items") val cancelledItems: List<CancelledItemDto> = emptyList(),
    @SerialName("created_at") val createdAt: String,
    @SerialName("bill_requested_at") val billRequestedAt: String? = null,
    @SerialName("closed_at") val closedAt: String? = null,
    @SerialName("cancelled_at") val cancelledAt: String? = null,
    @SerialName("updated_at") val updatedAt: String = createdAt,
    val comment: String = "",
)

@Serializable
data class CancelledItemDto(
    val id: String,
    @SerialName("menu_item") val menuItem: String? = null,
    @SerialName("name_at_order") val nameAtOrder: String,
    @SerialName("price_at_order") val priceAtOrder: String,
    val qty: Int,
    @SerialName("cancel_reason") val cancelReason: String = "",
    @SerialName("cancelled_at") val cancelledAt: String? = null,
    @SerialName("cancelled_by_name") val cancelledByName: String? = null,
)

@Serializable
data class OrderItemDto(
    val id: String,
    @SerialName("menu_item") val menuItem: String? = null,
    @SerialName("name_at_order") val nameAtOrder: String,
    @SerialName("price_at_order") val priceAtOrder: String,
    val qty: Int,
    val note: String = "",
    @SerialName("cancelled_at") val cancelledAt: String? = null,
    @SerialName("sent_to_kitchen_at") val sentToKitchenAt: String? = null,
    @SerialName("served_at") val servedAt: String? = null,
    @SerialName("kitchen_status") val kitchenStatus: String? = null,
    val subtotal: String = "0",
)

/** Статусы заказа — формально совпадают с v3 (бэк-портировал). */
object OrderStatus {
    const val NEW = "new"
    const val BILL_REQUESTED = "bill_requested"
    const val DONE = "done"
    const val CANCELLED = "cancelled"

    fun isActive(status: String): Boolean = status == NEW || status == BILL_REQUESTED
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
