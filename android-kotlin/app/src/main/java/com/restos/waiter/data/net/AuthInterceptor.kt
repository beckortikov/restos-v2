package com.restos.waiter.data.net

import com.restos.waiter.data.auth.TokenStore
import kotlinx.coroutines.runBlocking
import okhttp3.Interceptor
import okhttp3.Response
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Подкладывает `Authorization: Bearer <token>` ко всем запросам, если токен есть.
 * v4: токен один, без refresh. На 401 чистим хранилище — UI увидит
 * AuthStatus.LoggedOut и редиректнет на PIN-экран.
 *
 * Эндпоинт `/api/v1/auth/login` помечается `X-Skip-Auth: 1`.
 */
@Singleton
class AuthInterceptor @Inject constructor(
    private val tokenStore: TokenStore,
) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        if (request.header(SKIP_AUTH_HEADER) != null) {
            val cleaned = request.newBuilder().removeHeader(SKIP_AUTH_HEADER).build()
            return chain.proceed(cleaned)
        }
        val token = runBlocking { tokenStore.currentToken() }
        val withAuth = if (token != null) {
            request.newBuilder()
                .header("Authorization", "Bearer $token")
                .build()
        } else {
            request
        }
        val response = chain.proceed(withAuth)
        if (response.code == 401 && token != null) {
            // v4 не умеет refresh — единственный путь восстановить сессию это
            // повторный логин по PIN. Чистим токен и даём вызову вернуть 401.
            runBlocking { tokenStore.clear() }
        }
        return response
    }

    companion object {
        const val SKIP_AUTH_HEADER = "X-Skip-Auth"
    }
}
