package com.restos.core.net

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.Interceptor
import okhttp3.Response
import javax.inject.Inject
import javax.inject.Singleton

/**
 * На не-2xx ответ разбирает тело ошибки Go-бэка `{ "error": { code, message, detail } }`
 * и бросает типизированный [ApiException] с настоящим сообщением. Без этого Retrofit
 * кидал безликий HttpException, и во всех доменных API вылезал общий фолбэк
 * («Не удалось …»), пряча реальную причину (напр. «недостаточно средств на счёте»).
 *
 * Ставится ПЕРВЫМ (внешним) интерцептором: видит финальный ответ после того, как
 * внутренние (auth/idempotency/host) отработали запрос. Тело читаем и закрываем —
 * ответ дальше не используется, т.к. бросаем исключение.
 */
@Singleton
class ErrorEnvelopeInterceptor @Inject constructor(private val json: Json) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val response = chain.proceed(chain.request())
        if (response.isSuccessful) return response

        val raw = runCatching { response.body?.string() }.getOrNull().orEmpty()
        response.close()
        val apiError = runCatching { json.decodeFromString(ErrorBody.serializer(), raw).error }
            .getOrNull()
            ?: ApiError(
                code = "HTTP_${response.code}",
                message = response.message.ifBlank { "HTTP ${response.code}" },
            )
        throw ApiException(apiError)
    }

    @Serializable
    private data class ErrorBody(val error: ApiError? = null)
}
