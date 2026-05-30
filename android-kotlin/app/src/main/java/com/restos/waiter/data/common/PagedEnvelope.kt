package com.restos.waiter.data.common

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * v4 Go-бэк отдаёт list-эндпоинты в формате:
 *   { "data": [...], "next_cursor": "" }
 *
 * Алиас PagedEnvelope сохранён, чтобы старые usages не переписывать.
 */
@Serializable
data class ListEnvelope<T>(
    val data: List<T> = emptyList(),
    @SerialName("next_cursor") val nextCursor: String? = null,
)

typealias PagedEnvelope<T> = ListEnvelope<T>
