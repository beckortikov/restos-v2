package com.restos.waiter.data.onboarding

import com.restos.waiter.data.net.AuthInterceptor
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import retrofit2.http.GET
import retrofit2.http.Header

/**
 * Публичные онбординг-эндпоинты v4 — для discovery ресторана при сканировании
 * QR с экрана кассы. Не требуют токена.
 */
interface LicenseApi {
    @GET("api/v1/license/machine-id")
    suspend fun machineId(
        @Header(AuthInterceptor.SKIP_AUTH_HEADER) skipAuth: String = "1",
    ): MachineIdResponse
}

@Serializable
data class MachineIdResponse(
    @SerialName("machine_id") val machineId: String,
    @SerialName("restaurant_id") val restaurantId: String,
    @SerialName("restaurant_name") val restaurantName: String? = null,
)
