package com.restos.zakup.data.stock

import com.restos.core.common.PagedEnvelope
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.Query

/**
 * Склад закупщика. Контракт — `server/api/openapi.yaml` (tag stock) и модель
 * `server/internal/db/models/stock.go`. Ответ ингредиента содержит category /
 * is_food / warehouse_id (модель сериализуется целиком; openapi-схема неполная).
 */
interface StockApi {
    @GET("api/v1/stock/ingredients")
    suspend fun listIngredients(
        @Query("q") q: String? = null,
        @Query("category") category: String? = null,
        @Query("low") low: Boolean? = null,
        @Query("limit") limit: Int = 200,
        @Query("cursor") cursor: String? = null,
    ): PagedEnvelope<IngredientDto>

    @GET("api/v1/stock/ingredient-categories")
    suspend fun listCategories(): StringListEnvelope

    /** Создать ингредиент (продукт/хозтовар). Склад назначается бэком по is_food. */
    @POST("api/v1/stock/ingredients")
    suspend fun createIngredient(@Body body: IngredientInput): IngredientDto

    @GET("api/v1/warehouses")
    suspend fun listWarehouses(): PagedEnvelope<WarehouseDto>

    @GET("api/v1/stock/movements")
    suspend fun listMovements(
        @Query("warehouse_id") warehouseId: String? = null,
        @Query("limit") limit: Int = 100,
        @Query("cursor") cursor: String? = null,
    ): PagedEnvelope<StockMovementDto>

    @GET("api/v1/stock/returns")
    suspend fun listReturns(
        @Query("limit") limit: Int = 100,
        @Query("cursor") cursor: String? = null,
    ): PagedEnvelope<StockReturnDto>
}

@Serializable
data class StockMovementDto(
    val id: String,
    val type: String = "",
    @SerialName("ingredient_name") val ingredientName: String? = null,
    val qty: String = "0",
    val unit: String? = null,
    val description: String? = null,
    @SerialName("created_at") val createdAt: String? = null,
)

@Serializable
data class StockReturnDto(
    val id: String,
    @SerialName("receipt_id") val receiptId: String? = null,
    @SerialName("supplier_name") val supplierName: String? = null,
    val date: String? = null,
    val reason: String = "",
    @SerialName("total_amount") val totalAmount: String = "0",
    @SerialName("refund_type") val refundType: String = "",
    @SerialName("cancelled_at") val cancelledAt: String? = null,
    @SerialName("created_at") val createdAt: String? = null,
)

@Serializable
data class StringListEnvelope(val data: List<String> = emptyList())

/** Тело создания ингредиента (IngredientInput в service/stock_extra.go). name обязателен. */
@Serializable
data class IngredientInput(
    val name: String,
    val category: String? = null,
    val unit: String? = null,
    @SerialName("is_food") val isFood: Boolean,
    @SerialName("min_qty") val minQty: String? = null,
    @SerialName("price_per_unit") val pricePerUnit: String? = null,
)

@Serializable
data class IngredientDto(
    val id: String,
    val name: String? = null,
    val category: String? = null,
    val qty: String = "0",
    val unit: String? = null,
    @SerialName("min_qty") val minQty: String = "0",
    @SerialName("price_per_unit") val pricePerUnit: String = "0",
    @SerialName("is_food") val isFood: Boolean = true,
    @SerialName("warehouse_id") val warehouseId: String? = null,
)

@Serializable
data class WarehouseDto(
    val id: String,
    val name: String = "",
    val kind: String = "",
)

/** Полный список ингредиентов через курсор (бэк зажимает limit до 200). */
suspend fun StockApi.listAllIngredients(
    q: String? = null,
    category: String? = null,
    low: Boolean? = null,
): List<IngredientDto> {
    val all = mutableListOf<IngredientDto>()
    var cursor: String? = null
    var guard = 0
    while (guard++ < 200) {
        val page = listIngredients(q = q, category = category, low = low, limit = 200, cursor = cursor)
        all.addAll(page.data)
        val next = page.nextCursor
        if (next.isNullOrEmpty() || page.data.isEmpty()) break
        cursor = next
    }
    return all
}
