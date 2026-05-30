package com.restos.waiter.data.orders

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import retrofit2.http.Body
import retrofit2.http.Header
import retrofit2.http.POST

/** v4: создание заказа. `restaurant_id` сервер берёт из токена. */
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

@Serializable
data class CreateOrderRequest(
    @SerialName("order_type") val orderType: String = "hall",
    @SerialName("table_id") val tableId: String? = null,
    @SerialName("waiter_id") val waiterId: String? = null,
    @SerialName("guests_count") val guestsCount: Int = 1,
    val items: List<NewOrderItem>,
    val comment: String = "",
)
