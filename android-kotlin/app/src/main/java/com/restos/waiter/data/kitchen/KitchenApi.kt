package com.restos.waiter.data.kitchen

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import retrofit2.http.DELETE
import retrofit2.http.POST
import retrofit2.http.Path

/**
 * v4: эндпоинты привязаны к заказу — `/orders/{orderId}/items/{itemId}/served`.
 * POST = отметить поданным, DELETE = снять отметку.
 */
interface KitchenApi {
    @POST("api/v1/orders/{orderId}/items/{itemId}/served")
    suspend fun markServed(
        @Path("orderId") orderId: String,
        @Path("itemId") itemId: String,
    ): KitchenItemDto

    @DELETE("api/v1/orders/{orderId}/items/{itemId}/served")
    suspend fun unmarkServed(
        @Path("orderId") orderId: String,
        @Path("itemId") itemId: String,
    ): KitchenItemDto
}

@Serializable
data class KitchenItemDto(
    val id: String,
    @SerialName("kitchen_status") val kitchenStatus: String = "",
    @SerialName("served_at") val servedAt: String? = null,
)
