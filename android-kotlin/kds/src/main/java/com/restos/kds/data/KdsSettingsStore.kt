package com.restos.kds.data

import android.content.Context
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import javax.inject.Inject
import javax.inject.Singleton

private val Context.kdsSettingsDataStore by preferencesDataStore(name = "kds_settings")
private val KEY_SOUND = booleanPreferencesKey("sound_enabled")
private val KEY_STATIONS = stringPreferencesKey("stations")

/** Настройки KDS-дисплея (звук, набор станций). Хранится на устройстве. */
@Singleton
class KdsSettingsStore @Inject constructor(
    @ApplicationContext private val context: Context,
) {
    val soundEnabledFlow: Flow<Boolean> =
        context.kdsSettingsDataStore.data.map { it[KEY_SOUND] ?: true }

    /** Выбранные станции; пусто = все. */
    val stationsFlow: Flow<List<String>> =
        context.kdsSettingsDataStore.data.map { prefs ->
            prefs[KEY_STATIONS]?.split(",")?.map { it.trim() }?.filter { it.isNotEmpty() } ?: emptyList()
        }

    suspend fun soundEnabled(): Boolean = soundEnabledFlow.first()

    suspend fun setSoundEnabled(v: Boolean) {
        context.kdsSettingsDataStore.edit { it[KEY_SOUND] = v }
    }

    suspend fun setStations(stations: List<String>) {
        context.kdsSettingsDataStore.edit { it[KEY_STATIONS] = stations.joinToString(",") }
    }
}
