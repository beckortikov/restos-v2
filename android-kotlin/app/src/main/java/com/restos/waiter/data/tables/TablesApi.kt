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

@Serializable
data class TableDto(
    val id: String,
    val number: Int = 0,
    val name: String,
    val capacity: Int = 0,
    val zone: String? = null,
    @SerialName("zone_name") val zoneName: String? = null,
    val status: String = "free",
    @SerialName("status_display") val statusDisplay: String? = null,
    val waiter: String? = null,
    @SerialName("waiter_name") val waiterName: String? = null,
    @SerialName("current_order") val currentOrderId: String? = null,
    @SerialName("guests_count") val guestsCount: Int = 0,
    @SerialName("opened_at") val openedAt: String? = null,
)
