package com.restos.kiosk.data.orders

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.Header
import retrofit2.http.POST
import retrofit2.http.Path

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

    /**
     * Поллинг статуса — экран подтверждения ждёт, пока кассир не закроет
     * заказ (status → closed/refunded/cancelled), и только тогда сбрасывает
     * терминал на стартовый экран для следующего гостя.
     */
    @GET("api/v1/orders/{id}")
    suspend fun get(@Path("id") id: String): OrderDetailEnvelope
}

@Serializable
data class OrderDetailEnvelope(val order: OrderDto)

/**
 * Body для `POST /api/v1/orders`. См.
 * `server/internal/service/orders_write.go::CreateOrderInput`:
 *   - `type` (НЕ `order_type`) — hall|takeaway. Терминал не назначает стол —
 *     "В зале" уходит как hall без table_id, гость забирает у стойки выдачи.
 *   - `waiter_id` сервер берёт из Actor (токена терминала), поле в body
 *     игнорируется, но оставлено для diagnostics-friendly traceback.
 *   - `shift_id` — ОБЯЗАТЕЛЕН. Бэк НЕ проставляет его сам (нет fallback на
 *     активную смену) — без него заказ создаётся, но невидим для кассы
 *     (список "Заказы" строго скоупится по shift_id) и его нельзя ни
 *     открыть, ни отменить, ни закрыть. См. MenuViewModel.submit().
 */
@Serializable
data class CreateOrderRequest(
    @SerialName("type") val orderType: String,
    @SerialName("table_id") val tableId: String? = null,
    @SerialName("waiter_id") val waiterId: String? = null,
    @SerialName("shift_id") val shiftId: String,
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

/**
 * Минимальный ответ создания/чтения заказа — терминалу нужны номер (экран
 * подтверждения) и статус (поллинг: ждём, пока кассир не закроет/оплатит).
 */
@Serializable
data class OrderDto(
    val id: String,
    @SerialName("order_number") val orderNumber: Int? = null,
    val total: String = "0",
    val status: String = "open",
)
