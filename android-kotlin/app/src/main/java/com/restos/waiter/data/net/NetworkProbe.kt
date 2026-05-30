package com.restos.waiter.data.net

import com.restos.waiter.data.auth.TokenStore
import com.restos.waiter.data.config.ServerConfigStore
// TokenStore остаётся в сигнатуре конструктора чтобы Hilt-граф не ломался у
// мест, где Probe инжектится напрямую; полю не нужен — поэтому @Suppress.
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit
import javax.inject.Inject
import javax.inject.Singleton

enum class NetworkStatus { Unknown, Online, Offline }

/**
 * Лёгкий probe бэкенда для LanGuard. Раз в `INTERVAL_MS` дёргает
 * `GET /api/v1/license/machine-id` (публичный, не требует токена) с коротким
 * таймаутом. Любой HTTP-ответ (включая 401/403/404) = в сети;
 * connection failure / timeout = offline.
 *
 * Использует отдельный OkHttp клиент (без logging/auth-interceptor /
 * IdempotencyInterceptor), чтобы пробы не засоряли логи и не блокировали
 * основной клиент.
 */
@Singleton
class NetworkProbe @Inject constructor(
    @Suppress("UNUSED_PARAMETER") tokenStore: TokenStore,
    private val serverConfig: ServerConfigStore,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var loopJob: Job? = null

    private val _status = MutableStateFlow(NetworkStatus.Unknown)
    val status: StateFlow<NetworkStatus> = _status.asStateFlow()

    private val client: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(PROBE_TIMEOUT_MS, TimeUnit.MILLISECONDS)
            .readTimeout(PROBE_TIMEOUT_MS, TimeUnit.MILLISECONDS)
            .writeTimeout(PROBE_TIMEOUT_MS, TimeUnit.MILLISECONDS)
            .retryOnConnectionFailure(false)
            .build()
    }

    @Synchronized
    fun start() {
        if (loopJob?.isActive == true) return
        loopJob = scope.launch { runLoop() }
    }

    @Synchronized
    fun stop() {
        loopJob?.cancel()
        loopJob = null
        _status.value = NetworkStatus.Unknown
    }

    /** Принудительная проверка — для кнопки «Повторить» в LanGuard. */
    fun probeNow() {
        scope.launch { probeOnce() }
    }

    private suspend fun runLoop() {
        while (scope.isActive) {
            probeOnce()
            delay(INTERVAL_MS)
        }
    }

    private suspend fun probeOnce() {
        val base = serverConfig.current()
        if (base.isNullOrBlank()) {
            // Нет URL — не сеть «отсутствует», а онбординг не пройден.
            // Статус Unknown, чтобы LanGuard показал сплэш, а не «нет сети».
            _status.value = NetworkStatus.Unknown
            return
        }
        val request = Request.Builder()
            .url("${base}api/v1/license/machine-id")
            .get()
            .build()

        val ok = runCatching {
            client.newCall(request).execute().use { resp ->
                // Любой HTTP-статус значит «сеть доступна»: 200/401/403 — всё ок.
                resp.code in 200..599
            }
        }.getOrDefault(false)

        _status.value = if (ok) NetworkStatus.Online else NetworkStatus.Offline
    }

    private companion object {
        const val INTERVAL_MS = 15_000L
        const val PROBE_TIMEOUT_MS = 3_000L
    }
}
