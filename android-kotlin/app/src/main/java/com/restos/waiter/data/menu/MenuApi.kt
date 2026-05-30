package com.restos.waiter.data.menu

import com.restos.waiter.data.common.PagedEnvelope
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import retrofit2.http.GET
import retrofit2.http.Query

interface MenuApi {
    @GET("api/v1/menu/items")
    suspend fun listItems(
        @Query("category") categoryId: String? = null,
        @Query("is_available") isAvailable: Boolean? = null,
        @Query("limit") limit: Int = 500,
    ): PagedEnvelope<MenuItemDto>

    @GET("api/v1/menu/categories")
    suspend fun listCategories(): PagedEnvelope<CategoryDto>
}

/**
 * Контракт v4 — см. `server/internal/db/models/menu.go::MenuItem`.
 * Сервер НЕ возвращает `sort_order`, `stop_reason`, `kind` — это поля v3.
 * Они удалены, чтобы не маскировать «всё блюдо дефолтное».
 */
@Serializable
data class MenuItemDto(
    val id: String,
    val category: String? = null,
    val name: String = "",
    val price: String = "0",
    val emoji: String = "",
    @SerialName("image_url") val imageUrl: String? = null,
    @SerialName("is_available") val isAvailable: Boolean = true,
    @SerialName("stop_list_override") val stopListOverride: Boolean = false,
    val cogs: String = "0",
    val station: String = "hot_kitchen",
    val unit: String = "piece",
    @SerialName("unit_size") val unitSize: String = "1",
    @SerialName("sale_step") val saleStep: String = "0",
    @SerialName("cook_time_min") val cookTimeMin: Int? = null,
    @SerialName("is_batch_cooking") val isBatchCooking: Boolean = false,
    @SerialName("prepared_qty") val preparedQty: Int = 0,
    @SerialName("is_deleted") val isDeleted: Boolean = false,
    @SerialName("low_stock_threshold") val lowStockThreshold: Int = 5,
)

@Serializable
data class CategoryDto(
    val id: String,
    val name: String,
    @SerialName("sort_order") val sortOrder: Int = 0,
)
