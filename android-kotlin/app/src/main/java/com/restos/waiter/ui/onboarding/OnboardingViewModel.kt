package com.restos.waiter.ui.onboarding

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restos.waiter.data.config.ServerConfigStore
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit
import javax.inject.Inject

data class OnboardingUiState(
    val url: String = "",
    val testing: Boolean = false,
    val error: String? = null,
    val testOk: Boolean = false,
    val done: Boolean = false,
    val restaurantName: String? = null,
)

@HiltViewModel
class OnboardingViewModel @Inject constructor(
    private val configStore: ServerConfigStore,
) : ViewModel() {

    private val _state = MutableStateFlow(OnboardingUiState())
    val state: StateFlow<OnboardingUiState> = _state.asStateFlow()

    private val probeClient = OkHttpClient.Builder()
        .connectTimeout(3, TimeUnit.SECONDS)
        .readTimeout(3, TimeUnit.SECONDS)
        .retryOnConnectionFailure(false)
        .build()

    private val json = Json { ignoreUnknownKeys = true; coerceInputValues = true }

    fun setUrl(s: String) {
        _state.update { it.copy(url = s, error = null, testOk = false) }
    }

    /** Из QR прилетает строка — может быть просто http://host:port/ либо
     *  URL вида http://host/?pair=... — нам важна только база. */
    fun onQrScanned(raw: String) {
        val cleaned = raw.trim()
        if (cleaned.isBlank()) return
        val origin = runCatching {
            val uri = java.net.URI(if (cleaned.contains("://")) cleaned else "http://$cleaned")
            val port = if (uri.port > 0) ":${uri.port}" else ""
            "${uri.scheme ?: "http"}://${uri.host}$port/"
        }.getOrNull() ?: cleaned

        _state.update { it.copy(url = origin, error = null, testOk = false) }
        testAndSave()
    }

    fun testAndSave() {
        val raw = _state.value.url
        if (!ServerConfigStore.isValid(raw)) {
            _state.update { it.copy(error = "Введите корректный адрес сервера") }
            return
        }
        val normalized = ServerConfigStore.normalize(raw)
        _state.update { it.copy(testing = true, error = null, testOk = false) }
        viewModelScope.launch {
            val result = probe(normalized)
            if (result.error != null) {
                _state.update { it.copy(testing = false, error = result.error) }
                return@launch
            }
            // v4: ресторан определяется бэком (он знает, на какой restaurant_id
            // лицензирована машина) — сохраняем оба.
            configStore.save(
                rawUrl = normalized,
                restaurantId = result.restaurantId!!,
                restaurantName = result.restaurantName,
            )
            _state.update {
                it.copy(
                    testing = false,
                    testOk = true,
                    done = true,
                    restaurantName = result.restaurantName,
                )
            }
        }
    }

    private data class ProbeResult(
        val error: String? = null,
        val restaurantId: String? = null,
        val restaurantName: String? = null,
    )

    /**
     * Дёргаем `GET /api/v1/license/machine-id` — публичный, возвращает
     * restaurant_id текущей машины. Если 200 + валидный JSON → connected.
     */
    private suspend fun probe(baseUrl: String): ProbeResult = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url("${baseUrl}api/v1/public/machine-info")
            .get()
            .build()
        try {
            probeClient.newCall(request).execute().use { resp ->
                if (resp.code !in 200..299) {
                    return@use ProbeResult(
                        error = "Сервер вернул HTTP ${resp.code}. Это адрес RestOS v4-бэка?",
                    )
                }
                val body = resp.body?.string().orEmpty()
                val parsed = runCatching {
                    json.decodeFromString(MachineIdPayload.serializer(), body)
                }.getOrNull()
                if (parsed == null || parsed.restaurantId.isBlank()) {
                    return@use ProbeResult(
                        error = "Бэк отвечает, но не вернул restaurant_id. " +
                            "Проверьте лицензию ресторана.",
                    )
                }
                ProbeResult(
                    restaurantId = parsed.restaurantId,
                    restaurantName = parsed.restaurantName,
                )
            }
        } catch (e: java.net.SocketTimeoutException) {
            ProbeResult(error = "Таймаут (3с): сервер не отвечает. Проверьте IP/порт.")
        } catch (e: java.net.ConnectException) {
            ProbeResult(error = "Connection refused: на этом IP:порте никто не слушает.")
        } catch (e: java.net.UnknownHostException) {
            ProbeResult(error = "Не удалось разрешить адрес ${e.message ?: "сервера"}.")
        } catch (e: java.net.NoRouteToHostException) {
            ProbeResult(error = "No route to host: телефон не в одной LAN с сервером.")
        } catch (e: javax.net.ssl.SSLException) {
            ProbeResult(error = "SSL ошибка: ${e.message ?: "—"}. Используйте http://, не https://.")
        } catch (e: java.io.IOException) {
            ProbeResult(error = "Сетевая ошибка: ${e.javaClass.simpleName} ${e.message ?: ""}".trim())
        } catch (e: Throwable) {
            ProbeResult(error = "${e.javaClass.simpleName}: ${e.message ?: "неизвестная ошибка"}")
        }
    }

    @Serializable
    private data class MachineIdPayload(
        @SerialName("machine_id") val machineId: String = "",
        @SerialName("restaurant_id") val restaurantId: String = "",
        @SerialName("restaurant_name") val restaurantName: String? = null,
    )
}
