package com.restos.kiosk.data.orders

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import retrofit2.http.Body
import retrofit2.http.Header
import retrofit2.http.POST

/** Значения `type` заказа, которые создаёт терминал (см. CreateOrderRequest.orderType). */
object OrderType {
    const val HALL = "hall"
    const val TAKEAWAY = "takeaway"
}

/** v4: создание заказа. `restaurant_id`/`waiter_id` (=создатель) сервер берёт из токена. */
interface CreateOrderApi {
    /**
     * `idemKey` — стабильный UUID на одно логическое создание. При retry
     * после network-сбоя нужно слать ТОТ ЖЕ ключ, иначе бэк создаст дубль.
     */
    @POST("api/v1/orders")
    suspend fun create(
        @Header("Idempotency-Key") idemKey: String,
        @Body body: CreateOrderRequest,
    ): OrderDto
}

/**
 * Body для `POST /api/v1/orders`. См.
 * `server/internal/service/orders_write.go::CreateOrderInput`:
 *   - `type` (НЕ `order_type`) — hall|takeaway. Терминал не назначает стол —
 *     "В зале" уходит как hall без table_id, гость забирает у стойки выдачи.
 *   - `waiter_id` сервер берёт из Actor (токена терминала), поле в body
 *     игнорируется, но оставлено для diagnostics-friendly traceback.
 */
@Serializable
data class CreateOrderRequest(
    @SerialName("type") val orderType: String,
    @SerialName("table_id") val tableId: String? = null,
    @SerialName("waiter_id") val waiterId: String? = null,
    @SerialName("guests_count") val guestsCount: Int = 1,
    val items: List<NewOrderItem>,
    val comment: String = "",
)

/** v4: id меню — String (UUID), qty передаём строкой decimal-safe. */
@Serializable
data class NewOrderItem(
    @SerialName("menu_item_id") val menuItemId: String,
    val qty: String,
) {
    constructor(menuItemId: String, qty: Int) : this(menuItemId = menuItemId, qty = qty.toString())
}

/** Минимальный ответ создания заказа — терминалу нужен только номер для экрана подтверждения. */
@Serializable
data class OrderDto(
    val id: String,
    @SerialName("order_number") val orderNumber: Int? = null,
    val total: String = "0",
)
