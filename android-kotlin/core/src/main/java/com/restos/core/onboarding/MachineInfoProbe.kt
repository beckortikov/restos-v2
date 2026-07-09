package com.restos.core.onboarding

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit
import javax.inject.Inject
import javax.inject.Singleton

/**
 * MachineInfoProbe — проверка сервера кассы по адресу из QR/поля и получение
 * restaurant_id этой кассы (публичный `GET /api/v1/public/machine-info`).
 *
 * Тот же путь, что и в онбординге официанта: касса сама знает свой лицензированный
 * restaurant_id. Работает и на старых версиях бэка (эндпоинт давний), в отличие от
 * /bootstrap/status. Свой OkHttp без интерцепторов — бьём по адресу напрямую,
 * до сохранения конфига.
 */
@Singleton
class MachineInfoProbe @Inject constructor() {

    data class Info(val restaurantId: String, val restaurantName: String?)

    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(10, TimeUnit.SECONDS)
        .retryOnConnectionFailure(false)
        .build()

    private val json = Json { ignoreUnknownKeys = true; coerceInputValues = true }

    suspend fun probe(baseUrl: String): Result<Info> = withContext(Dispatchers.IO) {
        runCatching {
            val req = Request.Builder().url("${baseUrl}api/v1/public/machine-info").get().build()
            client.newCall(req).execute().use { resp ->
                if (resp.code !in 200..299) {
                    error("Сервер вернул HTTP ${resp.code}. Это адрес RestOS-кассы?")
                }
                val body = resp.body?.string().orEmpty()
                val p = json.decodeFromString(Payload.serializer(), body)
                if (p.restaurantId.isBlank()) {
                    error("Касса не вернула restaurant_id — проверьте лицензию ресторана.")
                }
                Info(p.restaurantId, p.restaurantName)
            }
        }
    }

    @Serializable
    private data class Payload(
        @SerialName("restaurant_id") val restaurantId: String = "",
        @SerialName("restaurant_name") val restaurantName: String? = null,
    )
}
