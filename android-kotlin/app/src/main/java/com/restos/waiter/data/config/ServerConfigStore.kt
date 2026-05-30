package com.restos.waiter.data.config

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import javax.inject.Inject
import javax.inject.Singleton

private val Context.serverConfigDataStore by preferencesDataStore(name = "server_config")
private val KEY_BASE_URL = stringPreferencesKey("base_url")
private val KEY_RESTAURANT_ID = stringPreferencesKey("restaurant_id")
private val KEY_RESTAURANT_NAME = stringPreferencesKey("restaurant_name")

/**
 * Хранит привязку планшета к ресторану:
 *   - baseUrl: `http://192.168.x.y:3001/` Go-бэка (LAN-only).
 *   - restaurantId: UUID, нужен в payload `POST /auth/login` (v4 multi-tenant).
 *   - restaurantName: для подсказки на PIN-экране.
 *
 * Задаётся при онбординге: сканируем QR / вводим URL → дёргаем
 * `GET /api/v1/license/machine-id` → получаем restaurant_id + name.
 *
 * URL ВСЕГДА со слэшем в конце (нормализуется при записи).
 */
@Singleton
class ServerConfigStore @Inject constructor(
    @ApplicationContext private val context: Context,
) {
    val baseUrlFlow: Flow<String?> = context.serverConfigDataStore.data.map { prefs ->
        prefs[KEY_BASE_URL]?.takeIf { it.isNotBlank() }
    }

    val restaurantIdFlow: Flow<String?> = context.serverConfigDataStore.data.map { prefs ->
        prefs[KEY_RESTAURANT_ID]?.takeIf { it.isNotBlank() }
    }

    val restaurantNameFlow: Flow<String?> = context.serverConfigDataStore.data.map { prefs ->
        prefs[KEY_RESTAURANT_NAME]?.takeIf { it.isNotBlank() }
    }

    suspend fun current(): String? = baseUrlFlow.first()
    suspend fun currentRestaurantId(): String? = restaurantIdFlow.first()
    suspend fun currentRestaurantName(): String? = restaurantNameFlow.first()

    suspend fun save(rawUrl: String, restaurantId: String, restaurantName: String? = null) {
        val normalized = normalize(rawUrl)
        context.serverConfigDataStore.edit { prefs ->
            prefs[KEY_BASE_URL] = normalized
            prefs[KEY_RESTAURANT_ID] = restaurantId
            if (!restaurantName.isNullOrBlank()) {
                prefs[KEY_RESTAURANT_NAME] = restaurantName
            }
        }
    }

    suspend fun clear() {
        context.serverConfigDataStore.edit { it.clear() }
    }

    companion object {
        /** http://host[:port][/path]/ — обязательно со слэшем в конце. */
        fun normalize(raw: String): String {
            var u = raw.trim()
            if (!u.startsWith("http://") && !u.startsWith("https://")) {
                u = "http://$u"
            }
            if (!u.endsWith("/")) u += "/"
            return u
        }

        fun isValid(raw: String): Boolean {
            val trimmed = raw.trim()
            if (trimmed.isBlank()) return false
            return runCatching {
                val normalized = normalize(trimmed)
                val url = java.net.URI(normalized)
                url.host?.isNotBlank() == true && url.scheme in setOf("http", "https")
            }.getOrDefault(false)
        }
    }
}
