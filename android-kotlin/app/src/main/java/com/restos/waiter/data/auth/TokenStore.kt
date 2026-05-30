package com.restos.waiter.data.auth

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

private val Context.tokenDataStore by preferencesDataStore(name = "auth")

private object Keys {
    val TOKEN = stringPreferencesKey("token")
    val USER_JSON = stringPreferencesKey("user_json")
    val RESTAURANT_JSON = stringPreferencesKey("restaurant_json")
}

/**
 * v4: единственный токен (без refresh). На 401 → принудительный logout +
 * редирект на PIN-экран (см. AuthInterceptor).
 */
@Singleton
class TokenStore @Inject constructor(
    @ApplicationContext private val context: Context,
    private val json: Json,
) {
    /** Эмиттит null, когда пользователь не залогинен. */
    val tokenFlow: Flow<String?> = context.tokenDataStore.data.map { prefs ->
        prefs[Keys.TOKEN]?.takeIf { it.isNotBlank() }
    }

    suspend fun currentToken(): String? = tokenFlow.first()

    /**
     * Кэшированный профиль из последнего успешного логина — заменяет
     * отсутствующий в v4 эндпоинт `/auth/me`.
     */
    val meFlow: Flow<MeData?> = context.tokenDataStore.data.map { prefs ->
        val token = prefs[Keys.TOKEN]
        if (token.isNullOrBlank()) return@map null
        val userRaw = prefs[Keys.USER_JSON] ?: return@map null
        val user = runCatching {
            json.decodeFromString(UserDto.serializer(), userRaw)
        }.getOrNull() ?: return@map null
        val restaurant = prefs[Keys.RESTAURANT_JSON]?.let { raw ->
            runCatching { json.decodeFromString(RestaurantDto.serializer(), raw) }
                .getOrNull()
        }
        MeData(user = user, restaurant = restaurant)
    }

    suspend fun currentMe(): MeData? = meFlow.first()

    suspend fun save(token: String, me: MeData) {
        context.tokenDataStore.edit { prefs ->
            prefs[Keys.TOKEN] = token
            prefs[Keys.USER_JSON] = json.encodeToString(UserDto.serializer(), me.user)
            me.restaurant?.let {
                prefs[Keys.RESTAURANT_JSON] = json.encodeToString(RestaurantDto.serializer(), it)
            }
        }
    }

    suspend fun clear() {
        context.tokenDataStore.edit { it.clear() }
    }
}
