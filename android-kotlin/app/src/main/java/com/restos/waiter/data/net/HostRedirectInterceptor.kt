package com.restos.waiter.data.net

import com.restos.waiter.data.config.ServerConfigStore
import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Interceptor
import okhttp3.Response
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Подменяет схему/хост/порт каждого запроса на текущее значение из
 * ServerConfigStore. Retrofit видит фиксированный baseUrl
 * (BuildConfig.API_BASE_URL — он же "плейсхолдер"); реальный сервер
 * подставляется в момент отправки.
 *
 * Если URL ещё не задан — бросаем IOException, чтобы вызов закончился
 * как обычная сетевая ошибка (UI покажет «нет соединения»).
 */
@Singleton
class HostRedirectInterceptor @Inject constructor(
    private val configStore: ServerConfigStore,
) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        val targetBase = runBlocking { configStore.current() }
            ?: throw java.io.IOException("Сервер ресторана не настроен")

        val base = targetBase.toHttpUrlOrNull()
            ?: throw java.io.IOException("Некорректный URL сервера: $targetBase")

        val newUrl = request.url.newBuilder()
            .scheme(base.scheme)
            .host(base.host)
            .port(base.port)
            .build()

        return chain.proceed(request.newBuilder().url(newUrl).build())
    }
}
