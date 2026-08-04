package com.restos.kiosk.data.menu

import com.restos.core.common.PagedEnvelope
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import retrofit2.http.GET
import retrofit2.http.Query

interface MenuApi {
    @GET("api/v1/menu/items")
    suspend fun listItems(
        @Query("category") categoryId: String? = null,
        @Query("is_available") isAvailable: Boolean? = null,
        @Query("limit") limit: Int = 200,
        @Query("cursor") cursor: String? = null,
    ): PagedEnvelope<MenuItemDto>

    @GET("api/v1/menu/categories")
    suspend fun listCategories(): PagedEnvelope<CategoryDto>
}

/**
 * Полный список меню через курсор — бэк зажимает limit до 200
 * (cursor.MaxLimit), без прохода по next_cursor >200 блюд теряют «хвост».
 */
suspend fun MenuApi.listAllItems(isAvailable: Boolean? = null): List<MenuItemDto> {
    val all = mutableListOf<MenuItemDto>()
    var cursor: String? = null
    var guard = 0
    while (guard++ < 200) {
        val page = listItems(isAvailable = isAvailable, limit = 200, cursor = cursor)
        all.addAll(page.data)
        val next = page.nextCursor
        if (next.isNullOrEmpty() || page.data.isEmpty()) break
        cursor = next
    }
    return all
}

/**
 * Контракт v4 — см. `server/internal/db/models/menu.go::MenuItem`. Терминал
 * показывает только name/price/emoji/image/category/isAvailable — cogs,
 * station, batch-поля ему не нужны, но оставлены с дефолтами на случай
 * будущего переиспользования (весовые блюда, заготовки).
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
    val unit: String = "piece",
    @SerialName("unit_size") val unitSize: String = "1",
    @SerialName("is_deleted") val isDeleted: Boolean = false,
)

@Serializable
data class CategoryDto(
    val id: String,
    val name: String,
    @SerialName("sort_order") val sortOrder: Int = 0,
)
