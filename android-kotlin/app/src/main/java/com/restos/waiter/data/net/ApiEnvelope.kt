package com.restos.waiter.data.net

import kotlinx.serialization.Serializable

/**
 * v4 Go-бэк отвечает:
 *   - на single-resource эндпоинтах: плоский объект (не `{data: ...}`)
 *   - на list-эндпоинтах: `{ "data": [...], "next_cursor": "" }`
 *   - на ошибках: `{ "error": { "code", "message", "detail" } }` (envelope ниже)
 *
 * Поэтому единый Envelope с `data` мы не используем для успешных ответов —
 * каждый Api-метод объявляет либо T (single), либо ListEnvelope<T> (list).
 *
 * `Envelope<T>` оставлен для случаев, где бэк всё-таки оборачивает single-payload
 * (например, обёртки кухни/принт-сервиса) — но в v4 новые эндпоинты должны
 * возвращать «голый» объект.
 */
@Serializable
data class Envelope<T>(
    val data: T? = null,
    val error: ApiError? = null,
)

@Serializable
data class ApiError(
    val code: String,
    val message: String,
    val detail: String? = null,
)

class ApiException(val apiError: ApiError) : RuntimeException(apiError.message)
