package com.restos.kds.data

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/** Блюдо на кухонной доске — зеркалит backend service.KDSItem. */
@Serializable
data class KdsItemDto(
    val id: String,
    @SerialName("order_id") val orderId: String = "",
    @SerialName("order_number") val orderNumber: Int = 0,
    @SerialName("order_type") val orderType: String = "hall",
    @SerialName("table_number") val tableNumber: Int? = null,
    @SerialName("table_name") val tableName: String? = null,
    val name: String = "",
    val qty: String = "1",
    val comment: String? = null,
    val station: String = "hot_kitchen",
    @SerialName("station_status") val stationStatus: String = "pending",
    @SerialName("created_at") val createdAt: String = "",
    @SerialName("status_at") val statusAt: String? = null,
    /**
     * Клиентский флаг: блюдо отменено. Сервер его не присылает (default=false);
     * KDS выставляет его при order.item.voided, чтобы держать блюдо красной
     * карточкой в «Новых», пока повар не закроет её вручную.
     */
    val cancelled: Boolean = false,
)

@Serializable
data class KdsListResponse(val data: List<KdsItemDto> = emptyList())

@Serializable
data class SetStatusRequest(val status: String)

@Serializable
data class StationsResponse(val data: List<String> = emptyList())

/** GET /bootstrap/status — для онбординга KDS (выбор ресторана). */
@Serializable
data class BootstrapStatusDto(
    val initialized: Boolean = false,
    val restaurants: List<RestaurantBrief> = emptyList(),
)

@Serializable
data class RestaurantBrief(val id: String = "", val name: String = "")
