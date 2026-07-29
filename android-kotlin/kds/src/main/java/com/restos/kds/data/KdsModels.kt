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
    // "g"/"kg" — весовое блюдо (qty = вес), иначе штучное (qty = количество).
    val unit: String? = null,
    val comment: String? = null,
    val station: String = "hot_kitchen",
    @SerialName("station_status") val stationStatus: String = "pending",
    @SerialName("waiter_name") val waiterName: String? = null,
    @SerialName("created_at") val createdAt: String = "",
    // Возраст блюда в секундах по часам СЕРВЕРА на момент выборки. Кухня считает
    // «сколько прошло» от него + время с момента загрузки — не завися от часов
    // планшета (они часто выставлены криво → таймер застревал на «0 мин»).
    // null = старая касса без этого поля → фолбэк на created_at + часы планшета.
    @SerialName("age_seconds") val ageSeconds: Long? = null,
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
data class CallWaiterResponse(@SerialName("waiter_name") val waiterName: String = "")

/**
 * Блюдо меню — для экрана стоп-листа кухни. Слепок нужных полей из
 * /api/v1/menu/items (остальные игнорируются: Json ignoreUnknownKeys).
 */
@Serializable
data class MenuItemDto(
    val id: String,
    val name: String? = null,
    val category: String? = null,
    val emoji: String? = null,
    val station: String? = null,
    // Стоп «галочкой» в управлении меню — кухня его не трогает, только показывает.
    @SerialName("is_available") val isAvailable: Boolean? = null,
    // Ручной стоп (в т.ч. поставленный поваром с кухни) — им и управляем.
    @SerialName("stop_list_override") val stopListOverride: Boolean? = null,
) {
    /** Блюдо недоступно для пробития (по любой ручной причине). */
    val stopped: Boolean get() = stopListOverride == true || isAvailable == false
}

@Serializable
data class MenuItemsResponse(
    val data: List<MenuItemDto> = emptyList(),
    @SerialName("next_cursor") val nextCursor: String = "",
)

@Serializable
data class StopOverrideRequest(val override: Boolean)

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
