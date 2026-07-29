package com.restos.kds.data

import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class KdsRepository @Inject constructor(
    private val api: KdsApi,
) {
    suspend fun list(stations: List<String>, statuses: List<String>): List<KdsItemDto> {
        val st = stations.takeIf { it.isNotEmpty() }?.joinToString(",")
        val ss = statuses.takeIf { it.isNotEmpty() }?.joinToString(",")
        return api.list(st, ss).data
    }

    suspend fun setStatus(id: String, status: String): KdsItemDto =
        api.setStatus(id, SetStatusRequest(status))

    /** Вызвать официанта заказа на кухню. Возвращает имя официанта. */
    suspend fun callWaiter(id: String): String =
        api.callWaiter(id).waiterName

    suspend fun stations(): List<String> = api.stations().data

    /**
     * Всё меню — постранично по курсору (на странице максимум 200, см. cursor.MaxLimit).
     * Гард по числу страниц, чтобы кривой курсор не увёл в бесконечный цикл.
     */
    suspend fun menuItems(): List<MenuItemDto> {
        val out = mutableListOf<MenuItemDto>()
        var cursor: String? = null
        repeat(20) {
            val page = api.menuItems(limit = 200, cursor = cursor)
            out += page.data
            cursor = page.nextCursor.takeIf { c -> c.isNotBlank() } ?: return out
        }
        return out
    }

    /** Ручной стоп блюда: true = «закончилось» (в стоп-лист), false = снять. */
    suspend fun setStopOverride(menuItemId: String, override: Boolean): MenuItemDto =
        api.setStopOverride(menuItemId, StopOverrideRequest(override))
}
