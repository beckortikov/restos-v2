package com.restos.waiter.data.auth

import com.restos.waiter.data.config.ServerConfigStore
import com.restos.waiter.data.net.ApiError
import com.restos.waiter.data.net.ApiException
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.serialization.json.Json
import retrofit2.HttpException
import javax.inject.Inject
import javax.inject.Singleton

sealed interface AuthEvent {
    data class LoggedIn(val user: UserDto) : AuthEvent
    data object LoggedOut : AuthEvent
}

@Singleton
class AuthRepository @Inject constructor(
    private val api: AuthApi,
    private val tokenStore: TokenStore,
    private val serverConfig: ServerConfigStore,
    private val json: Json,
) {
    val isLoggedIn: Flow<Boolean> = tokenStore.tokenFlow.map { it != null }

    suspend fun loginWithPin(pin: String): Result<UserDto> = runCatching {
        val restaurantId = serverConfig.currentRestaurantId()
            ?: throw IllegalStateException("Ресторан не выбран — пройдите онбординг заново")
        val resp = api.loginWithPin(PinLoginRequest(pin = pin, restaurantId = restaurantId))
        tokenStore.save(
            token = resp.token,
            me = MeData(user = resp.user, restaurant = resp.restaurant),
        )
        resp.user
    }.recoverCatching { e -> throw mapError(e) }

    /**
     * v4 не имеет `/auth/me` — возвращаем закэшированный snapshot из
     * `PinLoginResponse`. Если кэш пустой (например, токен есть, а профиль
     * стёрт миграцией) — это аварийная ситуация, лучше force-logout.
     */
    suspend fun me(): Result<MeData> = runCatching {
        tokenStore.currentMe() ?: throw IllegalStateException(
            "Профиль отсутствует — повторите вход по PIN",
        )
    }

    suspend fun logout() {
        runCatching { api.logout() }
        tokenStore.clear()
    }

    private fun mapError(e: Throwable): Throwable {
        if (e is HttpException) {
            val raw = e.response()?.errorBody()?.string().orEmpty()
            val parsed = runCatching {
                json.decodeFromString(ErrorEnvelope.serializer(), raw)
            }.getOrNull()
            val apiError = parsed?.error
                ?: ApiError(
                    code = "HTTP_${e.code()}",
                    message = e.message().ifBlank { "HTTP ${e.code()}" },
                )
            return ApiException(apiError)
        }
        return e
    }

    @kotlinx.serialization.Serializable
    private data class ErrorEnvelope(val error: ApiError? = null)
}
