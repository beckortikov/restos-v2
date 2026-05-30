package com.restos.waiter.data.net

import okhttp3.Interceptor
import okhttp3.Response
import java.util.UUID
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Django требует `Idempotency-Key: <uuid>` на всех write-эндпоинтах
 * (см. prd-v3/01-API-CONTRACT.md). Подставляем для POST/PUT/PATCH/DELETE,
 * если вызывающий код не прислал свой.
 */
@Singleton
class IdempotencyInterceptor @Inject constructor() : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val req = chain.request()
        val isWrite = req.method in WRITE_METHODS
        if (!isWrite || req.header(HEADER) != null) return chain.proceed(req)
        val withKey = req.newBuilder()
            .header(HEADER, UUID.randomUUID().toString())
            .build()
        return chain.proceed(withKey)
    }

    private companion object {
        const val HEADER = "Idempotency-Key"
        val WRITE_METHODS = setOf("POST", "PUT", "PATCH", "DELETE")
    }
}
