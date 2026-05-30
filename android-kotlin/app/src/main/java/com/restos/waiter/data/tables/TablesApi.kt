package com.restos.waiter.data.tables

import com.restos.waiter.data.common.PagedEnvelope
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.Path

interface TablesApi {
    @GET("api/v1/tables")
    suspend fun listTables(): PagedEnvelope<TableDto>

    @GET("api/v1/zones")
    suspend fun listZones(): PagedEnvelope<ZoneDto>

    /**
     * v4: перевод стола на другого официанта живёт здесь
     * (см. CLAUDE.md в android-kotlin/). В v3 это было
     * `POST /orders/{id}/assign_waiter/`.
     */
    @POST("api/v1/tables/{tableId}/assign-waiter")
    suspend fun assignWaiter(
        @Path("tableId") tableId: String,
        @Body body: AssignWaiterRequest,
    ): TableDto
}

@Serializable
data class AssignWaiterRequest(@SerialName("waiter_id") val waiterId: String)

@Serializable
data class ZoneDto(
    val id: String,
    val name: String,
    @SerialName("sort_order") val sortOrder: Int = 0,
)

/**
 * Контракт v4 — см. `server/internal/db/models/layout.go::Table`.
 * Сервер отдаёт `zone_id`/`waiter_id`/`current_order_id` (не `zone`/
 * `waiter`/`current_order`, как было в v3). `name`/`number` — nullable
 * на сервере, в Kotlin для удобства UI задаём ненулевые дефолты.
 *
 * Производные display-поля (`zoneName`/`waiterName`/`statusDisplay`/
 * `guestsCount`) сервер v4 НЕ возвращает — UI считает сам через
 * lookup в zones/users/orders (см. `TablesRepository.buildCards`).
 */
@Serializable
data class TableDto(
    val id: String,
    val number: Int = 0,
    val name: String = "",
    val capacity: Int = 0,
    @SerialName("zone_id") val zone: String? = null,
    val status: String = "free",
    @SerialName("waiter_id") val waiter: String? = null,
    @SerialName("current_order_id") val currentOrderId: String? = null,
    @SerialName("merged_with") val mergedWith: String? = null,
    @SerialName("original_capacity") val originalCapacity: Int? = null,
    @SerialName("opened_at") val openedAt: String? = null,
    @SerialName("restaurant_id") val restaurantId: String? = null,

    // ── client-computed (нет на сервере)
    val zoneName: String? = null,
    val statusDisplay: String? = null,
    val waiterName: String? = null,
    val guestsCount: Int = 0,
)
