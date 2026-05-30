package com.restos.waiter.data.auth

import com.restos.waiter.data.net.AuthInterceptor
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import retrofit2.http.Body
import retrofit2.http.Header
import retrofit2.http.POST

/**
 * v4 Go backend auth contract:
 *  - `POST /api/v1/auth/login`  { pin, restaurant_id }  → { token, user, restaurant }
 *  - `POST /api/v1/auth/logout` → { ok: true }
 *
 * No `/auth/me` endpoint and no refresh — Go-бэк хранит сессии в БД, токен живёт
 * до явного logout. Кэш профиля держим локально (см. AuthRepository.cachedMe()).
 */
interface AuthApi {

    @POST("api/v1/auth/login")
    suspend fun loginWithPin(
        @Body body: PinLoginRequest,
        @Header(AuthInterceptor.SKIP_AUTH_HEADER) skipAuth: String = "1",
    ): PinLoginResponse

    @POST("api/v1/auth/logout")
    suspend fun logout(): LogoutResponse
}

@Serializable
data class PinLoginRequest(
    val pin: String,
    @SerialName("restaurant_id") val restaurantId: String,
)

/**
 * v4 возвращает плоский объект без envelope `{data: ...}`.
 * Все ID — UUID-строки.
 */
@Serializable
data class PinLoginResponse(
    val token: String,
    val user: UserDto,
    val restaurant: RestaurantDto,
)

@Serializable
data class UserDto(
    val id: String,
    val username: String,
    @SerialName("full_name") val fullName: String = "",
    val role: String,
    val permissions: List<String> = emptyList(),
) {
    val displayName: String get() = fullName.ifBlank { username }

    // Старое имя поля для обратной совместимости с UI-кодом (`u.full_name`).
    val full_name: String get() = fullName
}

@Serializable
data class RestaurantDto(
    val id: String,
    val name: String,
)

@Serializable
data class LogoutResponse(val ok: Boolean = true)

/**
 * Локально-кэшируемый аналог v3 `MeData` — на v4 он формируется из
 * PinLoginResponse в момент логина и хранится в TokenStore.
 */
data class MeData(
    val user: UserDto,
    val restaurant: RestaurantDto? = null,
)
