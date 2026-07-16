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
}
